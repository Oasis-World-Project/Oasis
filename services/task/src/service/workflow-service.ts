// 工作流控制面（ADR 0004）：提交方案 → 调度可以跑的节点 → 收到运行结束就推进（讨论的下一轮、汇总、
// 过关卡、关卡没过改一次）→ 失败自动重做 → 卡住时交给用户处理。
// 节点真正的执行在 harness；这里只管图、状态和决定。所有决定都在锁住任务行的事务里做，
// 对外的调用（提交运行、关卡检查、通知取消）在事务之外。
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
import type { Gate } from './gate.ts';
import { planToRows, validatePlan } from './plan.ts';
import { decide } from './schedule.ts';
import { afterRound, firstStep, retryStep, reworkStep, type Step } from './steps.ts';

const iso = (d: Date | null) => d?.toISOString() ?? null;
const FINAL = ['succeeded', 'failed', 'cancelled'];

function toNodeBody(node: Node): NodeBody {
  const c = node.config;
  return {
    id: node.id,
    key: node.key,
    title: node.title,
    kind: node.kind,
    role: node.role,
    goal: node.goal,
    model: node.model,
    checks: c.checks ?? [],
    expects: c.expects ?? [],
    discussion:
      node.kind === 'discussion'
        ? {
            participants: c.participants ?? [],
            rounds: c.rounds ?? 1,
            round: c.round ?? 0,
            transcript: (c.transcript ?? []).map(({ round, name, text }) => ({
              round,
              name,
              text,
            })),
          }
        : null,
    status: node.status,
    attempts: node.attempts,
    reworks: node.reworks,
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

/** 要提交给 harness 的一次运行（在事务里决定，事务外提交） */
interface Submission {
  runId: string;
  task: Task;
  nodeId: string;
  request: NodeRun['request'];
}

/** 同一个节点里还没结束的其他运行（讨论同一轮里别人的发言） */
const siblings = (snapshot: Snapshot, node: Node, run: NodeRun) =>
  snapshot.activeRuns.filter(
    (r) =>
      r.nodeId === node.id && r.id !== run.id && (r.status === 'pending' || r.status === 'running'),
  );

/** 一个事务做完后要在事务外做的事 */
interface Effects {
  submit: Submission[];
  gate: { taskId: string; nodeId: string; runId: string }[];
  cancel: string[];
}
const noEffects = (): Effects => ({ submit: [], gate: [], cancel: [] });

export function createWorkflowService(deps: {
  store: TaskStore;
  harness: ServiceClient;
  gate: Gate;
  maxParallel: number;
  /** 失败后自动重做几次（ADR 0004：2 次，即最多跑 3 次） */
  maxRetries: number;
  /** 关卡没过时最多改几次（ADR 0004：1 次） */
  maxReworks: number;
  logger: Logger;
}) {
  const { store, harness, gate, logger } = deps;

  /** 在事务里开出一步的运行：记下运行、节点标成运行中 */
  async function openStep(snapshot: Snapshot, w: Writer, node: Node, step: Step, fx: Effects) {
    let lastRunId: string | undefined;
    for (const request of step.requests) {
      const runId = randomUUID();
      const record = {
        model: request.model,
        prompt: request.prompt,
        inputsFrom: request.inputsFrom,
        ...(request.continueFrom ? { continueFrom: request.continueFrom } : {}),
      };
      await w.addRun({
        id: runId,
        nodeId: node.id,
        attempt: node.attempts,
        purpose: request.purpose,
        status: 'pending',
        meta: request.meta,
        request: record,
      });
      fx.submit.push({ runId, task: snapshot.task, nodeId: node.id, request: record });
      lastRunId = runId;
    }
    await w.setNode(node.id, {
      status: 'running',
      currentRunId: lastRunId ?? node.currentRunId,
      startedAt: node.startedAt ?? new Date(),
      finishedAt: null,
      ...(step.config ? { config: step.config } : {}),
    });
  }

  /** 找出能跑的节点并开跑；需要时改任务状态（在事务里） */
  async function schedule(snapshot: Snapshot, w: Writer, fx: Effects) {
    const decision = decide({
      taskStatus: snapshot.task.status,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      maxParallel: deps.maxParallel,
    });
    for (const node of decision.blocked) await w.setNode(node.id, { status: 'blocked' });
    for (const node of decision.start) {
      await w.setNode(node.id, { attempts: node.attempts + 1 });
      await openStep(snapshot, w, node, firstStep(snapshot, node), fx);
    }
    if (decision.task) {
      const finished = FINAL.includes(decision.task.status);
      await w.setTask({ ...decision.task, finishedAt: finished ? new Date() : null });
    }
  }

  /** 提交给 harness。网络问题时留在 pending，等对账重交；harness 明确拒绝时按运行失败处理。 */
  async function submit(s: Submission): Promise<void> {
    try {
      await harness.json('POST', '/internal/runs', {
        body: {
          runId: s.runId,
          payerId: s.task.payerId,
          taskId: s.task.id,
          nodeId: s.nodeId,
          ...s.request,
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

  /** 关卡检查（事务外），再按结果推进：通过 → 完成；没过且还能改 → 接着原会话改一次；否则完成并留提醒 */
  async function runGate(taskId: string, nodeId: string, runId: string): Promise<void> {
    const snapshot = await store.get(taskId);
    const node = snapshot?.nodes.find((n) => n.id === nodeId);
    if (!snapshot || node?.status !== 'checking' || node.currentRunId !== runId) return;
    const { unmet } = await gate.check({
      payerId: snapshot.task.payerId,
      runId,
      goal: node.goal,
      summary: node.summary,
      outputs: node.outputs,
      checks: node.config.checks ?? [],
      expects: node.config.expects ?? [],
    });
    await transact(taskId, async (fresh, w, fx) => {
      const current = fresh.nodes.find((n) => n.id === nodeId);
      if (current?.status !== 'checking' || current.currentRunId !== runId) return;
      if (unmet.length === 0) {
        await w.setNode(nodeId, { status: 'succeeded', finishedAt: new Date() });
      } else if (current.reworks < deps.maxReworks) {
        logger.info({ nodeId, unmet }, '关卡没过，退回修改');
        await w.setNode(nodeId, { reworks: current.reworks + 1 });
        await openStep(fresh, w, current, reworkStep(current, unmet), fx);
      } else {
        await w.setNode(nodeId, {
          status: 'succeeded',
          finishedAt: new Date(),
          warning: `交付前检查没完全通过：${unmet.join('；')}`,
        });
      }
      await schedule(fresh, w, fx);
    });
  }

  /** 在事务里做决定，事务外执行副作用（提交运行、关卡检查、通知取消） */
  async function transact(
    taskId: string,
    fn: (snapshot: Snapshot, w: Writer, fx: Effects) => Promise<void>,
  ): Promise<void> {
    const fx = noEffects();
    await store.transact(taskId, (snapshot, w) => fn(snapshot, w, fx));
    for (const runId of fx.cancel) {
      await harness
        .json('POST', `/internal/runs/${runId}/cancel`, { body: {} })
        .catch((err: unknown) => logger.warn({ err, runId }, '通知 harness 取消失败'));
    }
    for (const s of fx.submit) await submit(s);
    for (const g of fx.gate) {
      await runGate(g.taskId, g.nodeId, g.runId).catch((err: unknown) =>
        logger.error({ err, ...g }, '关卡检查失败，等对账重试'),
      );
    }
  }

  /** 节点的一次运行失败：还能重做就重做同一步，否则节点失败、任务交给用户处理 */
  async function onFailure(
    snapshot: Snapshot,
    w: Writer,
    node: Node,
    run: NodeRun,
    error: string | null,
    fx: Effects,
  ) {
    if (node.attempts <= deps.maxRetries) {
      logger.info({ nodeId: node.id, attempt: node.attempts, error }, '节点失败，自动重做');
      await w.setNode(node.id, { attempts: node.attempts + 1 });
      await openStep(snapshot, w, node, retryStep(snapshot, node, run), fx);
      return;
    }
    // 讨论里其他人还在说：一起停掉
    fx.cancel.push(...siblings(snapshot, node, run).map((r) => r.id));
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

  /** 讨论的一次发言结束：记进讨论记录；这一轮都说完了就开下一轮或汇总 */
  async function onSpeech(
    snapshot: Snapshot,
    w: Writer,
    node: Node,
    run: NodeRun,
    text: string | null,
    fx: Effects,
  ) {
    const transcript = [
      ...(node.config.transcript ?? []),
      {
        round: run.meta.round ?? 0,
        name: run.meta.participant ?? '',
        text: text?.trim() || '（没有发言）',
        runId: run.id,
      },
    ];
    await w.setNode(node.id, { config: { ...node.config, transcript } });
    if (siblings(snapshot, node, run).length === 0)
      await openStep(snapshot, w, node, afterRound(snapshot, node), fx);
  }

  /** 一次运行结束（来自 harness 的事件或对账）。同一个运行重复到达时只处理一次。 */
  async function onRunFinished(
    result: Pick<RunFinishedData, 'runId' | 'status' | 'error' | 'outputs' | 'summary'>,
  ): Promise<void> {
    const found = await store.findRun(result.runId);
    if (!found) return; // 不是工作流里的运行
    await transact(found.taskId, async (snapshot, w, fx) => {
      const run = snapshot.activeRuns.find((r) => r.id === result.runId);
      if (!run) return; // 已经处理过
      await w.setRun(run.id, {
        status: result.status,
        summary: result.summary,
        error: result.error,
        outputs: result.outputs,
        finishedAt: new Date(),
      });
      const node = snapshot.nodes.find((n) => n.id === run.nodeId);
      if (node?.status !== 'running') return; // 节点已取消、已失败等：不再推进
      const current =
        run.purpose === 'speech'
          ? run.meta.round === node.config.round
          : node.currentRunId === run.id;
      if (!current) return; // 过期的运行

      if (result.status === 'cancelled') {
        fx.cancel.push(...siblings(snapshot, node, run).map((r) => r.id));
        await w.setNode(node.id, { status: 'cancelled', finishedAt: new Date() });
      } else if (result.status === 'failed') {
        await onFailure(snapshot, w, node, run, result.error, fx);
      } else if (run.purpose === 'speech') {
        await onSpeech(snapshot, w, node, run, result.summary, fx);
      } else {
        // 干活、修改、汇总交出了产出：先过关卡
        await w.setNode(node.id, {
          status: 'checking',
          summary: result.summary,
          outputs: result.outputs,
          currentRunId: run.id,
        });
        fx.gate.push({ taskId: snapshot.task.id, nodeId: node.id, runId: run.id });
      }
      await schedule(snapshot, w, fx);
    });
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

  /** 对账一次运行：harness 已经跑完就补上结局；harness 根本没收到就按原样重交 */
  async function reconcileRun(run: NodeRun): Promise<void> {
    let remote: RunBody | undefined;
    try {
      remote = await harness.json('GET', `/internal/runs/${run.id}`, { schema: RunBody });
    } catch (err) {
      if (!(err instanceof HttpError && err.statusCode === 404)) throw err;
    }
    if (remote && FINAL.includes(remote.status)) {
      await onRunFinished({
        runId: run.id,
        status: remote.status as 'succeeded' | 'failed' | 'cancelled',
        error: remote.error,
        outputs: remote.outputs,
        summary: remote.summary,
      });
    } else if (!remote) {
      const snapshot = await store.get(run.taskId);
      if (snapshot)
        await submit({
          runId: run.id,
          task: snapshot.task,
          nodeId: run.nodeId,
          request: run.request,
        });
    }
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
      await transact(id, (snapshot, w, fx) => schedule(snapshot, w, fx));
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
     * 对节点追问 / 补充要求（ADR 0004 §7），只影响这一个节点：
     * - 运行中的干活节点：直接插进它的会话；
     * - 还没开始的节点、讨论节点：记下来（讨论在下一轮和汇总时带上）；
     * - 正在过关卡、已结束的：不行。
     */
    async message(
      ownerId: string,
      taskId: string,
      nodeId: string,
      text: string,
    ): Promise<'delivered' | 'noted'> {
      await owned(ownerId, taskId);
      let deliverTo: string | undefined;
      await store.transact(taskId, async (snapshot, w) => {
        const node = nodeOf(snapshot, nodeId);
        const notable =
          ['waiting', 'blocked', 'stopped'].includes(node.status) ||
          (node.status === 'running' && node.kind === 'discussion');
        if (notable) {
          await w.setNode(node.id, { userNotes: [...node.userNotes, text] });
        } else if (node.status === 'running' && node.currentRunId) {
          deliverTo = node.currentRunId;
        } else {
          throw new HttpError(409, 'node_not_open', '这个节点现在不能追问');
        }
      });
      if (!deliverTo) return 'noted';
      try {
        await harness.json('POST', `/internal/runs/${deliverTo}/messages`, { body: { text } });
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
      await transact(taskId, async (snapshot, w, fx) => {
        if (FINAL.includes(snapshot.task.status)) return;
        const now = new Date();
        for (const node of snapshot.nodes) {
          if (!FINAL.includes(node.status))
            await w.setNode(node.id, { status: 'cancelled', finishedAt: now });
        }
        await w.setTask({ status: 'cancelled', attention: null, finishedAt: now });
        fx.cancel.push(...snapshot.activeRuns.map((r) => r.id));
      });
      return toTaskBody(await owned(ownerId, taskId));
    },

    /**
     * 对账（启动时和每分钟）：防止 harness 的结束事件丢了、运行没提交出去、关卡检查中途断了。
     */
    async reconcile(olderThanMs = 15_000): Promise<void> {
      const before = new Date(Date.now() - olderThanMs);
      for (const run of await store.listActiveRuns(before)) {
        await reconcileRun(run).catch((err: unknown) =>
          logger.warn({ err, runId: run.id }, '对账失败，下次再试'),
        );
      }
      for (const node of await store.listCheckingNodes(before)) {
        if (!node.currentRunId) continue;
        await runGate(node.taskId, node.id, node.currentRunId).catch((err: unknown) =>
          logger.warn({ err, nodeId: node.id }, '关卡重试失败，下次再试'),
        );
      }
    },
  };
}

export type WorkflowService = ReturnType<typeof createWorkflowService>;
