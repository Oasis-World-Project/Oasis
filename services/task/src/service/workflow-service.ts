// 工作流控制面（ADR 0004）：提交方案 → 调度可以跑的节点 → 收到运行结束就推进 → 失败自动重做 →
// 卡住时交给用户处理。节点真正的执行在 harness；这里只管图、状态和决定。
import { randomUUID } from 'node:crypto';
import type { RunFinishedData } from '@oasis/contracts/events';
import { RunBody, RunEventList } from '@oasis/contracts/harness';
import type {
  CreateTaskInput,
  EdgeBody,
  NodeBody,
  TaskBody,
  TaskSummary,
} from '@oasis/contracts/task';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import type { Node, NodeRun, Snapshot, Task, TaskStore, Writer } from '../repo/task-store.ts';
import { planToRows, validatePlan } from './plan.ts';
import { buildPrompt } from './prompt.ts';
import { decide, incoming } from './schedule.ts';

const iso = (d: Date | null) => d?.toISOString() ?? null;

function toNodeBody(node: Node): NodeBody {
  return {
    id: node.id,
    key: node.key,
    title: node.title,
    kind: node.kind,
    role: node.role,
    goal: node.goal,
    model: node.model,
    status: node.status,
    attempts: node.attempts,
    userNotes: node.userNotes,
    warning: node.warning,
    summary: node.summary,
    outputs: node.outputs,
    spentMicro: node.spentMicro,
    startedAt: iso(node.startedAt),
    finishedAt: iso(node.finishedAt),
  };
}

function toTaskBody({ task, nodes, edges }: Snapshot): TaskBody {
  return {
    id: task.id,
    title: task.title,
    brief: task.brief,
    status: task.status,
    attention: task.attention,
    estimateMicro: task.estimateMicro,
    spentMicro: task.spentMicro,
    nodes: nodes.map(toNodeBody),
    edges: edges.map((e): EdgeBody => ({ id: e.id, from: e.fromNodeId, to: e.toNodeId })),
    createdAt: task.createdAt.toISOString(),
    finishedAt: iso(task.finishedAt),
  };
}

/** 交给节点的说明和上游产出（开新运行、对账重交时都用这一份） */
function handoff(snapshot: Snapshot, node: Node) {
  const upstream = incoming(node, snapshot.edges)
    .map((e) => snapshot.nodes.find((n) => n.id === e.fromNodeId))
    .filter((n): n is Node => n !== undefined);
  const prompt = buildPrompt({
    brief: snapshot.task.brief,
    title: node.title,
    role: node.role,
    goal: node.goal,
    upstream: upstream.map((u) => ({
      key: u.key,
      title: u.title,
      summary: u.summary,
      outputs: u.outputs,
    })),
    userNotes: node.userNotes,
  });
  const inputsFrom = upstream
    .filter((u) => u.currentRunId)
    .map((u) => ({ runId: u.currentRunId as string, as: u.key }));
  return { prompt, inputsFrom };
}

/** 要提交给 harness 的一次运行（在事务里决定，事务外提交） */
interface Submission {
  runId: string;
  task: Task;
  node: Node;
  prompt: string;
  inputsFrom: { runId: string; as: string }[];
}

export function createWorkflowService(deps: {
  store: TaskStore;
  harness: ServiceClient;
  maxParallel: number;
  /** 失败后自动重做几次（ADR 0004：2 次，即最多跑 3 次） */
  maxRetries: number;
  logger: Logger;
}) {
  const { store, harness, logger } = deps;

  /** 在事务里为一个节点开一次新运行：记下运行、把节点标成运行中、拼好说明 */
  async function open(snapshot: Snapshot, w: Writer, node: Node): Promise<Submission> {
    const runId = randomUUID();
    const attempt = node.attempts + 1;
    await w.addRun({ id: runId, nodeId: node.id, attempt, purpose: 'work', status: 'pending' });
    await w.setNode(node.id, {
      status: 'running',
      attempts: attempt,
      currentRunId: runId,
      startedAt: node.startedAt ?? new Date(),
      finishedAt: null,
    });
    return { runId, task: snapshot.task, node, ...handoff(snapshot, node) };
  }

  /** 提交给 harness。网络问题时留在 pending，等对账重交；harness 明确拒绝时按运行失败处理。 */
  async function submit(s: Submission): Promise<void> {
    try {
      await harness.json('POST', '/internal/runs', {
        body: {
          runId: s.runId,
          payerId: s.task.payerId,
          taskId: s.task.id,
          nodeId: s.node.id,
          model: s.node.model,
          prompt: s.prompt,
          inputsFrom: s.inputsFrom,
        },
        requestId: s.runId,
        schema: RunBody,
      });
    } catch (err) {
      if (err instanceof HttpError && err.statusCode >= 400 && err.statusCode < 500) {
        logger.warn({ err, runId: s.runId }, 'harness 拒绝了运行');
        await onRunFinished({
          runId: s.runId,
          status: 'failed',
          error: err.message,
          outputs: [],
          summary: null,
        });
        return;
      }
      logger.warn({ err, runId: s.runId }, '提交运行失败，等对账重交');
      return;
    }
    await store.transact(s.task.id, async (snapshot, w) => {
      const run = snapshot.activeRuns.find((r) => r.id === s.runId);
      if (run?.status === 'pending') await w.setRun(s.runId, { status: 'running' });
    });
  }

  /** 看一眼整张图，启动能跑的节点；需要时改任务状态 */
  async function advance(taskId: string): Promise<void> {
    const submissions = await store.transact(taskId, async (snapshot, w) => {
      const decision = decide({
        taskStatus: snapshot.task.status,
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        maxParallel: deps.maxParallel,
      });
      for (const node of decision.blocked) await w.setNode(node.id, { status: 'blocked' });
      const opened: Submission[] = [];
      for (const node of decision.start) opened.push(await open(snapshot, w, node));
      if (decision.task) {
        const finished = ['succeeded', 'failed', 'cancelled'].includes(decision.task.status);
        await w.setTask({ ...decision.task, finishedAt: finished ? new Date() : null });
      }
      return opened;
    });
    for (const s of submissions) await submit(s);
  }

  /** 一次运行结束（来自 harness 的事件或对账）。同一个运行重复到达时只处理一次。 */
  async function onRunFinished(
    result: Pick<RunFinishedData, 'runId' | 'status' | 'error' | 'outputs' | 'summary'>,
  ): Promise<void> {
    const run = await store.findRun(result.runId);
    if (!run) return; // 不是工作流里的运行
    await store.transact(run.taskId, async (snapshot, w) => {
      const active = snapshot.activeRuns.find((r) => r.id === result.runId);
      if (!active) return; // 已经处理过
      await w.setRun(result.runId, {
        status: result.status,
        summary: result.summary,
        error: result.error,
        outputs: result.outputs,
        finishedAt: new Date(),
      });
      const node = snapshot.nodes.find((n) => n.id === run.nodeId);
      if (!node || node.currentRunId !== result.runId || node.status !== 'running') return;

      if (result.status === 'succeeded') {
        await w.setNode(node.id, {
          status: 'succeeded',
          summary: result.summary,
          outputs: result.outputs,
          finishedAt: new Date(),
        });
      } else if (result.status === 'cancelled') {
        await w.setNode(node.id, { status: 'cancelled', finishedAt: new Date() });
      } else if (node.attempts <= deps.maxRetries) {
        // 自动重做：回到等待，下面的 advance 会马上重新开跑
        await w.setNode(node.id, { status: 'waiting' });
        logger.info(
          { nodeId: node.id, attempt: node.attempts, error: result.error },
          '节点失败，自动重做',
        );
      } else {
        await w.setNode(node.id, { status: 'failed', finishedAt: new Date() });
        await w.setTask({
          status: 'needs_attention',
          attention: {
            reason: 'node_failed',
            nodeId: node.id,
            message: `「${node.title}」试了 ${node.attempts} 次都没成功`,
          },
        });
      }
    });
    await advance(run.taskId);
  }

  async function owned(ownerId: string, taskId: string): Promise<Snapshot> {
    const snapshot = await store.get(taskId);
    if (!snapshot || snapshot.task.ownerId !== ownerId) {
      throw new HttpError(404, 'task_not_found', '没有这个任务');
    }
    return snapshot;
  }

  function nodeOf(snapshot: Snapshot, nodeId: string): Node {
    const node = snapshot.nodes.find((n) => n.id === nodeId);
    if (!node) throw new HttpError(404, 'node_not_found', '没有这个节点');
    return node;
  }

  return {
    onRunFinished,

    /** 提交任务和工作流方案：校验 → 入库 → 立即开跑 */
    async create(body: CreateTaskInput): Promise<TaskBody> {
      validatePlan(body.plan);
      const id = randomUUID();
      const rows = planToRows(body.plan);
      await store.create({
        task: {
          id,
          ownerId: body.ownerId,
          payerId: body.payerId,
          conversationId: body.conversationId ?? null,
          title: body.title,
          brief: body.brief,
          status: 'running',
          estimateMicro: body.estimateMicro ?? null,
        },
        nodes: rows.nodes,
        edges: rows.edges,
      });
      await advance(id);
      return toTaskBody((await store.get(id)) as Snapshot);
    },

    async list(ownerId: string): Promise<TaskSummary[]> {
      const rows = await store.listByOwner(ownerId, 50);
      return rows.map(({ task, nodes }) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        nodesDone: nodes.filter((n) => n.status === 'succeeded').length,
        nodesTotal: nodes.length,
        spentMicro: task.spentMicro,
        createdAt: task.createdAt.toISOString(),
      }));
    },

    get: async (ownerId: string, taskId: string) => toTaskBody(await owned(ownerId, taskId)),

    /** 节点的运行过程：转发它最近一次运行的事件 */
    async nodeEvents(ownerId: string, taskId: string, nodeId: string, after: number) {
      const node = nodeOf(await owned(ownerId, taskId), nodeId);
      if (!node.currentRunId) return { events: [] };
      return harness.json('GET', `/internal/runs/${node.currentRunId}/events?after=${after}`, {
        schema: RunEventList,
      });
    },

    /**
     * 对节点追问 / 补充要求（ADR 0004 §7）：运行中的直接插进它的会话；还没开始的记下来，开跑时带上；
     * 已完成、已取消的不行。只影响这一个节点。
     */
    async message(
      ownerId: string,
      taskId: string,
      nodeId: string,
      text: string,
    ): Promise<'delivered' | 'noted'> {
      await owned(ownerId, taskId);
      const outcome = await store.transact(taskId, async (snapshot, w) => {
        const node = nodeOf(snapshot, nodeId);
        if (['waiting', 'blocked', 'stopped'].includes(node.status)) {
          await w.setNode(node.id, { userNotes: [...node.userNotes, text] });
          return { kind: 'noted' as const };
        }
        if (node.status === 'running' && node.currentRunId) {
          return { kind: 'deliver' as const, runId: node.currentRunId };
        }
        throw new HttpError(409, 'node_not_open', '这个节点已经结束，不能再追问');
      });
      if (outcome.kind === 'noted') return 'noted';
      try {
        await harness.json('POST', `/internal/runs/${outcome.runId}/messages`, { body: { text } });
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 409) {
          throw new HttpError(409, 'node_not_ready', '这个节点正在启动或正在收尾，请稍后再说');
        }
        throw err;
      }
      return 'delivered';
    },

    /** 取消整个任务：还没结束的节点全部取消，正在跑的运行通知 harness 停下 */
    async cancel(ownerId: string, taskId: string): Promise<TaskBody> {
      await owned(ownerId, taskId);
      const runIds = await store.transact(taskId, async (snapshot, w) => {
        if (['succeeded', 'failed', 'cancelled'].includes(snapshot.task.status)) return [];
        const now = new Date();
        for (const node of snapshot.nodes) {
          if (!['succeeded', 'failed', 'cancelled'].includes(node.status)) {
            await w.setNode(node.id, { status: 'cancelled', finishedAt: now });
          }
        }
        await w.setTask({ status: 'cancelled', attention: null, finishedAt: now });
        return snapshot.activeRuns.map((r) => r.id);
      });
      for (const runId of runIds) {
        await harness
          .json('POST', `/internal/runs/${runId}/cancel`, { body: {} })
          .catch((err: unknown) => logger.warn({ err, runId }, '通知 harness 取消失败'));
      }
      return toTaskBody(await owned(ownerId, taskId));
    },

    /**
     * 对账（启动时和每分钟）：防止 harness 的结束事件丢了、或运行没提交出去。
     * 运行中的去 harness 查结局；pending 的重新提交（harness 对同一运行 ID 幂等）。
     */
    async reconcile(olderThanMs = 15_000): Promise<void> {
      const runs = await store.listActiveRuns(new Date(Date.now() - olderThanMs));
      for (const run of runs) {
        try {
          await reconcileRun(run);
        } catch (err) {
          logger.warn({ err, runId: run.id }, '对账失败，下次再试');
        }
      }
    },
  };

  async function reconcileRun(run: NodeRun): Promise<void> {
    let remote: RunBody | undefined;
    try {
      remote = await harness.json('GET', `/internal/runs/${run.id}`, { schema: RunBody });
    } catch (err) {
      if (!(err instanceof HttpError && err.statusCode === 404)) throw err;
    }
    if (remote && ['succeeded', 'failed', 'cancelled'].includes(remote.status)) {
      await onRunFinished({
        runId: run.id,
        status: remote.status as 'succeeded' | 'failed' | 'cancelled',
        error: remote.error,
        outputs: remote.outputs,
        summary: remote.summary,
      });
      return;
    }
    if (!remote) {
      // harness 没收到：按当时的图重新拼说明再交一次
      const snapshot = await store.get(run.taskId);
      const node = snapshot?.nodes.find((n) => n.id === run.nodeId);
      if (!snapshot || node?.currentRunId !== run.id) return;
      await submit({ runId: run.id, task: snapshot.task, node, ...handoff(snapshot, node) });
    }
  }
}

export type WorkflowService = ReturnType<typeof createWorkflowService>;
