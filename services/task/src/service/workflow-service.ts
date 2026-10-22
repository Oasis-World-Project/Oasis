// 工作流控制面（ADR 0004、0005）：任务单 → 规划（planning-service）或直接提交方案 → 调度可以跑的节点 → 收到运行结束就推进（讨论的下一轮、汇总、
// 过关卡、关卡没过改一次）→ 失败自动重做 → 卡住、花费超限时交给用户处理。
// 用户可以随时停止 / 继续、运行整个工作流或单个节点、改还没开始的节点和连线。
// 节点真正的执行在 harness；这里只管图、状态和决定。所有决定都在锁住任务行的事务里做，
// 对外的调用（提交运行、关卡检查、通知停止或取消）在事务之外。
import { randomUUID } from 'node:crypto';
import type { CallSettledData, RunFinishedData } from '@oasis/contracts/events';
import { RunBody, RunEventList } from '@oasis/contracts/harness';
import type {
  Attention,
  CreateTaskInput,
  DecisionBody,
  EdgeBody,
  NodeBody,
  PlanNode,
  TaskBody,
  TaskSummary,
  UpdateEdgeBody,
  UpdateNodeBody,
} from '@oasis/contracts/task';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import type { Node, NodeRun, Snapshot, Task, TaskStore, Writer } from '../repo/task-store.ts';
import { noEffects, type Effects, type Submission } from './effects.ts';
import type { Gate } from './gate.ts';
import {
  checkDeleteEdge,
  checkNewEdge,
  checkNewNode,
  edgeChanges,
  edgeOf,
  graphProblems,
  nodeChanges,
  nodeOf,
  requireNotStarted,
} from './graph.ts';
import { nodeRow, planToRows, validatePlan } from './plan.ts';
import { createPlanning, dollars, type PlanningConfig } from './planning-service.ts';
import { decide } from './schedule.ts';
import { afterRound, firstStep, resumeStep, retryStep, reworkStep, type Step } from './steps.ts';

const iso = (d: Date | null) => d?.toISOString() ?? null;
/** 任务、节点不会再变的状态 */
const FINAL = ['succeeded', 'failed', 'cancelled'];
/** 运行已经结束的状态 */
const RUN_FINAL = ['succeeded', 'failed', 'cancelled', 'stopped'];
/** 占着并发名额的节点状态 */
const ACTIVE = ['running', 'checking'];

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
    budgetLimitMicro: task.budgetLimitMicro,
    sheet: task.sheet,
    acceptance: task.acceptance,
    deliverables: task.deliverables,
    nodes: nodes.map(toNodeBody),
    edges: edges.map((e): EdgeBody => ({ id: e.id, from: e.fromNodeId, to: e.toNodeId })),
    createdAt: task.createdAt.toISOString(),
    finishedAt: iso(task.finishedAt),
  };
}

/** 「需要处理」时某个选择不适用的说明 */
const UNAVAILABLE: Record<Attention['reason'], string> = {
  node_failed: '节点失败时可以继续、再试或取消',
  over_budget: '花费超过上限时只能继续或取消',
  over_estimate: '预估超过你设的上限时只能照做或取消',
  plan_failed: '工作流没排好时只能重新规划或取消',
  workflow_broken: '工作流的连线断开了：先把线接好再点运行，或者取消任务',
};

const isOpen = (r: NodeRun) => r.status === 'pending' || r.status === 'running';

/** 节点还没结束的运行（讨论同一轮里的几条发言可能同时在跑） */
const openRuns = (snapshot: Snapshot, nodeId: string) =>
  snapshot.activeRuns.filter((r) => r.nodeId === nodeId && isOpen(r));

export function createWorkflowService(deps: {
  store: TaskStore;
  harness: ServiceClient;
  gate: Gate;
  maxParallel: number;
  /** 失败后自动重做几次（ADR 0004：2 次，即最多跑 3 次） */
  maxRetries: number;
  /** 关卡没过时最多改几次（ADR 0004：1 次） */
  maxReworks: number;
  /** 花费超过预估的几倍时暂停问用户（ADR 0004：3） */
  budgetMultiplier: number;
  /** 规划员要查模型目录 */
  agent: ServiceClient;
  planning: Omit<PlanningConfig, 'budgetMultiplier'>;
  logger: Logger;
}) {
  const { store, harness, gate, logger } = deps;
  const planning = createPlanning({
    store,
    harness,
    agent: deps.agent,
    engine: { transact, schedule },
    config: { ...deps.planning, budgetMultiplier: deps.budgetMultiplier },
    logger,
  });

  // ---------------------------------------------------------------- 事务里的推进

  /** 开出一步的运行：记下运行、节点标成运行中 */
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

  /**
   * 结束节点还没结束的运行：还没交给 harness 的直接记下结局（对账不会再重交），
   * 已经交出去的通知 harness 停止（存下产出和会话）或取消。
   */
  async function endRuns(w: Writer, runs: NodeRun[], how: 'stop' | 'cancel', fx: Effects) {
    for (const run of runs) {
      if (run.status === 'pending') {
        await w.setRun(run.id, {
          status: how === 'stop' ? 'stopped' : 'cancelled',
          finishedAt: new Date(),
        });
      }
      fx[how].push(run.id);
    }
  }

  /** 停下一个运行中或检查中的节点（之后可以接着做） */
  async function halt(snapshot: Snapshot, w: Writer, node: Node, fx: Effects) {
    await endRuns(w, openRuns(snapshot, node.id), 'stop', fx);
    await w.setNode(node.id, { status: 'stopped' });
  }

  /** 让一个节点开跑：新建 / 等待的从头做，停下的接着做，失败的重新算重做次数再做 */
  async function startNode(snapshot: Snapshot, w: Writer, node: Node, fx: Effects) {
    if (node.status === 'stopped') {
      await openStep(snapshot, w, node, resumeStep(snapshot, node), fx);
      return;
    }
    if (node.status === 'failed') {
      await w.setNode(node.id, { attempts: 0, reworks: 0, warning: null });
    }
    await w.setNode(node.id, { attempts: node.attempts + 1 });
    await openStep(snapshot, w, node, firstStep(snapshot, node), fx);
  }

  /** 找出能跑的节点并开跑；需要时改任务状态 */
  async function schedule(snapshot: Snapshot, w: Writer, fx: Effects) {
    const decision = decide({
      taskStatus: snapshot.task.status,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      maxParallel: deps.maxParallel,
    });
    for (const node of decision.blocked) await w.setNode(node.id, { status: 'blocked' });
    for (const node of decision.unblocked) await w.setNode(node.id, { status: 'waiting' });
    for (const node of decision.start) await startNode(snapshot, w, node, fx);
    if (decision.task?.status === 'succeeded' && snapshot.task.sheet) {
      // 从任务单来的任务：先对照任务单整体验收，再算完成
      await w.setTask({ status: 'accepting', attention: null });
      fx.accept.push(snapshot.task.id);
    } else if (decision.task) {
      const finished = FINAL.includes(decision.task.status);
      await w.setTask({ ...decision.task, finishedAt: finished ? new Date() : null });
    }
  }

  /**
   * 整体验收（事务外，ADR 0005 §5）：负责交付物的节点交出的东西一起交给关卡，对照任务单的「怎么算做好」。
   * 没满足的地方记下来，照样交付（用户定）。
   */
  async function runAcceptance(taskId: string): Promise<void> {
    const snapshot = await store.get(taskId);
    if (snapshot?.task.status !== 'accepting' || !snapshot.task.sheet) return;
    const { task } = snapshot;
    const { sheet } = snapshot.task;
    const missing: string[] = [];
    const runs = task.deliverables.flatMap((d) => {
      const node = snapshot.nodes.find((n) => n.id === d.nodeId);
      const runId = node?.config.outputsRunId;
      if (!node || !runId || node.outputs.length === 0) {
        missing.push(`「${d.name}」没有交出文件`);
        return [];
      }
      return [{ runId, summary: node.summary, outputs: node.outputs, label: d.name }];
    });
    const { unmet } =
      runs.length > 0
        ? await gate.check({
            payerId: task.payerId,
            taskId,
            nodeId: null,
            goal: task.brief,
            runs,
            checks: sheet.criteria,
            expects: [],
          })
        : { unmet: [] };
    await store.transact(taskId, async (fresh, w) => {
      if (fresh.task.status !== 'accepting') return;
      await w.setTask({
        acceptance: { unmet: [...missing, ...unmet] },
        status: 'succeeded',
        finishedAt: new Date(),
      });
    });
  }

  /**
   * 运行整个工作流：先检查整张图（断开的线头、环），有问题就列出来、不开跑；
   * 没问题就把新建的节点加进来、停下的接着做、失败的再试，然后一路往下跑。
   */
  async function runAll(snapshot: Snapshot, w: Writer, fx: Effects) {
    const problems = graphProblems(snapshot);
    if (problems.length > 0) {
      throw new HttpError(409, 'workflow_invalid', `工作流有错误：${problems.join('；')}`);
    }
    const { task } = snapshot;
    // 用户明确要接着跑：花费已经到上限的，上限再加一份
    if (task.budgetLimitMicro !== null && task.spentMicro >= task.budgetLimitMicro) {
      await w.setTask({ budgetLimitMicro: nextLimit(task) });
    }
    await w.setTask({ status: 'running', attention: null, finishedAt: null });
    for (const node of snapshot.nodes) {
      if (node.status === 'draft') await w.setNode(node.id, { status: 'waiting' });
      if (node.status === 'failed') {
        await w.setNode(node.id, { status: 'waiting', attempts: 0, reworks: 0, warning: null });
      }
      if (node.status === 'stopped') await startNode(snapshot, w, node, fx);
    }
    await schedule(snapshot, w, fx);
  }

  /** 花费上限再加一份：当前花费 + 预估 × 倍数 */
  const nextLimit = (task: Task) =>
    task.spentMicro + (task.estimateMicro ?? 0) * deps.budgetMultiplier;

  // ---------------------------------------------------------------- 事务外的副作用

  /** 在事务里做决定，事务外执行副作用（通知停止或取消、提交运行、关卡检查） */
  async function transact(
    taskId: string,
    fn: (snapshot: Snapshot, w: Writer, fx: Effects) => Promise<void>,
  ): Promise<void> {
    const fx = noEffects();
    await store.transact(taskId, (snapshot, w) => fn(snapshot, w, fx));
    for (const how of ['stop', 'cancel'] as const) {
      for (const runId of fx[how]) {
        await harness
          .json('POST', `/internal/runs/${runId}/${how}`, { body: {} })
          .catch((err: unknown) => logger.warn({ err, runId, how }, '通知 harness 失败'));
      }
    }
    for (const s of fx.submit) await submit(s);
    for (const job of fx.plan) await planning.submit(job);
    for (const id of fx.accept) {
      await runAcceptance(id).catch((err: unknown) =>
        logger.error({ err, taskId: id }, '整体验收失败，等对账重试'),
      );
    }
    for (const g of fx.gate) {
      await runGate(g.taskId, g.nodeId, g.runId).catch((err: unknown) =>
        logger.error({ err, ...g }, '关卡检查失败，等对账重试'),
      );
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
      taskId,
      nodeId,
      goal: node.goal,
      runs: [{ runId, summary: node.summary, outputs: node.outputs }],
      checks: node.config.checks ?? [],
      expects: node.config.expects ?? [],
    });
    await transact(taskId, async (fresh, w, fx) => {
      // 检查期间节点被停止、任务被取消：结果作废
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

  // ---------------------------------------------------------------- 运行结束

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
    await endRuns(w, openRuns(snapshot, node.id), 'cancel', fx);
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
    if (openRuns(snapshot, node.id).length === 0) {
      await openStep(snapshot, w, node, afterRound(snapshot, node), fx);
    }
  }

  /** 一次运行结束（来自 harness 的事件或对账）。同一个运行重复到达时只处理一次。 */
  async function onRunFinished(
    result: Pick<RunFinishedData, 'runId' | 'status' | 'error' | 'outputs' | 'summary'>,
  ): Promise<void> {
    const found = await store.findRun(result.runId);
    if (!found) return planning.onFinished(result); // 不是节点的运行：可能是规划员
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
      if (node?.status !== 'running') return; // 节点已停止、已取消、已失败等：不再推进
      const current =
        run.purpose === 'speech'
          ? run.meta.round === node.config.round
          : node.currentRunId === run.id;
      if (!current) return; // 过期的运行

      if (result.status === 'cancelled' || result.status === 'stopped') {
        // 不是这里发起的停止或取消（如 harness 被关掉）：整个节点跟着停
        await endRuns(
          w,
          openRuns(snapshot, node.id),
          result.status === 'stopped' ? 'stop' : 'cancel',
          fx,
        );
        await w.setNode(node.id, {
          status: result.status,
          ...(result.status === 'cancelled' ? { finishedAt: new Date() } : {}),
        });
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
          config: { ...node.config, outputsRunId: run.id },
        });
        fx.gate.push({ taskId: snapshot.task.id, nodeId: node.id, runId: run.id });
      }
      await schedule(snapshot, w, fx);
    });
  }

  // ---------------------------------------------------------------- 对外接口的公共部分

  async function owned(ownerId: string, taskId: string): Promise<Snapshot> {
    const snapshot = await store.get(taskId);
    if (!snapshot || snapshot.task.ownerId !== ownerId) {
      throw new HttpError(404, 'task_not_found', '没有这个任务');
    }
    return snapshot;
  }

  /** 改任务（还没结束的）：确认归属 → 在事务里改 → 返回最新的任务 */
  async function change(
    ownerId: string,
    taskId: string,
    fn: (snapshot: Snapshot, w: Writer, fx: Effects) => Promise<void>,
  ): Promise<TaskBody> {
    await owned(ownerId, taskId);
    await transact(taskId, async (snapshot, w, fx) => {
      if (FINAL.includes(snapshot.task.status)) {
        throw new HttpError(409, 'task_finished', '任务已经结束了；要改的话请发起一个新任务');
      }
      if (snapshot.task.status === 'planning') {
        throw new HttpError(409, 'task_planning', 'AI 团队还在搭建工作流，请稍等');
      }
      if (snapshot.task.status === 'accepting') {
        throw new HttpError(409, 'task_accepting', '工作流已经跑完，正在做最后的验收，请稍等');
      }
      await fn(snapshot, w, fx);
    });
    return toTaskBody(await owned(ownerId, taskId));
  }

  /** 取消整个任务（在事务里） */
  async function cancelAll(snapshot: Snapshot, w: Writer, fx: Effects) {
    const now = new Date();
    await endRuns(w, snapshot.activeRuns.filter(isOpen), 'cancel', fx);
    if (snapshot.task.status === 'planning' && snapshot.task.plannerRunId) {
      fx.cancel.push(snapshot.task.plannerRunId);
    }
    for (const node of snapshot.nodes) {
      if (!FINAL.includes(node.status)) {
        await w.setNode(node.id, { status: 'cancelled', finishedAt: now });
      }
    }
    await w.setTask({ status: 'cancelled', attention: null, finishedAt: now });
  }

  /** 对账一次运行：harness 已经跑完就补上结局；harness 根本没收到就按原样重交 */
  async function reconcileRun(run: NodeRun): Promise<void> {
    let remote: RunBody | undefined;
    try {
      remote = await harness.json('GET', `/internal/runs/${run.id}`, { schema: RunBody });
    } catch (err) {
      if (!(err instanceof HttpError && err.statusCode === 404)) throw err;
    }
    if (remote && RUN_FINAL.includes(remote.status)) {
      await onRunFinished({
        runId: run.id,
        status: remote.status as RunFinishedData['status'],
        error: remote.error,
        outputs: remote.outputs,
        summary: remote.summary,
      });
    } else if (!remote) {
      const snapshot = await store.get(run.taskId);
      if (snapshot) {
        await submit({
          runId: run.id,
          task: snapshot.task,
          nodeId: run.nodeId,
          request: run.request,
        });
      }
    }
  }

  return {
    onRunFinished,

    /**
     * 一次属于任务的模型调用结算了：累加到任务和节点上（同一次调用只算一次）。
     * 任务在跑、且花费超过上限时，停下所有在跑的节点，交给用户决定。
     */
    async onCallSettled(
      data: Pick<CallSettledData, 'callId' | 'taskId' | 'nodeId' | 'chargedMicro'>,
    ) {
      if (!(await store.get(data.taskId))) return;
      await transact(data.taskId, async (snapshot, w, fx) => {
        const node = data.nodeId ? snapshot.nodes.find((n) => n.id === data.nodeId) : undefined;
        const counted = await w.addSpend({
          callId: data.callId,
          nodeId: node?.id ?? null,
          chargedMicro: data.chargedMicro,
        });
        if (!counted) return;
        const { task } = snapshot;
        await w.setTask({ spentMicro: task.spentMicro + data.chargedMicro });
        if (node) await w.setNode(node.id, { spentMicro: node.spentMicro + data.chargedMicro });
        const limit = task.budgetLimitMicro;
        if (task.status !== 'running' || limit === null || task.spentMicro <= limit) return;
        logger.info({ taskId: task.id, spent: task.spentMicro, limit }, '花费超过上限，暂停任务');
        for (const n of snapshot.nodes.filter((x) => ACTIVE.includes(x.status))) {
          await halt(snapshot, w, n, fx);
        }
        await w.setTask({
          status: 'needs_attention',
          attention: {
            reason: 'over_budget',
            nodeId: null,
            message: `已经花了 ${dollars(task.spentMicro)}，超过了预估（${dollars(task.estimateMicro ?? 0)}）的 ${deps.budgetMultiplier} 倍`,
          },
        });
      });
    },

    /**
     * 建任务：给任务单的先规划（规划员排出方案后自动开跑）；
     * 直接给方案的校验后立即开跑。
     */
    async create(body: CreateTaskInput): Promise<TaskBody> {
      const id = randomUUID();
      const base = {
        id,
        ownerId: body.ownerId,
        payerId: body.payerId,
        conversationId: body.conversationId ?? null,
        title: body.title,
        brief: body.brief,
      };
      if (body.sheet) {
        await store.create({
          task: {
            ...base,
            status: 'planning',
            estimateMicro: null,
            budgetLimitMicro: body.sheet.budgetMicro,
            sheet: body.sheet,
          },
          nodes: [],
          edges: [],
        });
        await transact(id, (snapshot, w, fx) => planning.begin(snapshot, w, fx));
        return toTaskBody((await store.get(id)) as Snapshot);
      }
      const plan = body.plan as NonNullable<typeof body.plan>;
      validatePlan(plan);
      const rows = planToRows(plan);
      const estimate = body.estimateMicro ?? null;
      await store.create({
        task: {
          ...base,
          status: 'running',
          estimateMicro: estimate,
          budgetLimitMicro: estimate === null ? null : estimate * deps.budgetMultiplier,
          sheet: null,
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

    /** 内部（conversation 发交付消息用）：不查归属 */
    async getInternal(taskId: string): Promise<TaskBody> {
      const snapshot = await store.get(taskId);
      if (!snapshot) throw new HttpError(404, 'task_not_found', '没有这个任务');
      return toTaskBody(snapshot);
    },

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
     * - 还没开始、已停止的节点和讨论节点：记下来（开跑、继续、讨论的下一轮时带上）；
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
          ['draft', 'waiting', 'blocked', 'stopped'].includes(node.status) ||
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

    /** 下载节点交出的一个文件（交付消息和画布用） */
    async file(ownerId: string, taskId: string, nodeId: string, path: string) {
      const node = nodeOf(await owned(ownerId, taskId), nodeId);
      const runId = node.config.outputsRunId;
      if (!runId || !node.outputs.some((f) => f.path === path)) {
        throw new HttpError(404, 'file_not_found', '没有这个文件');
      }
      const response = await harness.stream(
        'GET',
        `/internal/runs/${runId}/files/${path.split('/').map(encodeURIComponent).join('/')}`,
      );
      return {
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        content: Buffer.from(await response.arrayBuffer()),
      };
    },

    /** 运行整个工作流（先检查整张图） */
    run: (ownerId: string, taskId: string) =>
      change(ownerId, taskId, (snapshot, w, fx) => runAll(snapshot, w, fx)),

    /** 停止整个任务：在跑的节点都停下（存下产出和会话），之后点运行接着做 */
    stop: (ownerId: string, taskId: string) =>
      change(ownerId, taskId, async (snapshot, w, fx) => {
        for (const node of snapshot.nodes.filter((n) => ACTIVE.includes(n.status))) {
          await halt(snapshot, w, node, fx);
        }
        if (snapshot.task.status === 'running') {
          await w.setTask({ status: 'stopped', attention: null });
        }
      }),

    /** 取消整个任务：还没结束的节点全部取消，正在跑的运行通知 harness 停下 */
    async cancel(ownerId: string, taskId: string): Promise<TaskBody> {
      await owned(ownerId, taskId);
      await transact(taskId, async (snapshot, w, fx) => {
        if (!FINAL.includes(snapshot.task.status)) await cancelAll(snapshot, w, fx);
      });
      return toTaskBody(await owned(ownerId, taskId));
    },

    /** 「需要处理」时的三选一（ADR 0004 §8） */
    decide: (ownerId: string, taskId: string, { choice }: DecisionBody) =>
      change(ownerId, taskId, async (snapshot, w, fx) => {
        const { task } = snapshot;
        if (task.status !== 'needs_attention' || !task.attention) {
          throw new HttpError(409, 'nothing_to_decide', '这个任务现在不需要你处理');
        }
        if (choice === 'cancel') return cancelAll(snapshot, w, fx);
        const { reason, nodeId } = task.attention;
        if (reason === 'node_failed') {
          const failed = snapshot.nodes.find((n) => n.id === nodeId && n.status === 'failed');
          if (failed) {
            await w.setNode(
              failed.id,
              choice === 'continue'
                ? {
                    // 用现在的结果继续：这个节点算完成，有产出就交给下游，没有就不交
                    status: 'succeeded',
                    finishedAt: new Date(),
                    warning: '没能完成，按你的选择用现有的结果继续往下做',
                  }
                : { status: 'waiting', attempts: 0, reworks: 0, warning: null },
            );
          }
          await w.setTask({ status: 'running', attention: null });
          return schedule(snapshot, w, fx);
        }
        if (reason === 'over_budget' && choice === 'continue') {
          await w.setTask({ budgetLimitMicro: nextLimit(task) });
          return runAll(snapshot, w, fx);
        }
        if (reason === 'over_estimate' && choice === 'continue') {
          // 用户看了预估决定照做：上限按预估的倍数算
          await w.setTask({
            budgetLimitMicro: (task.estimateMicro ?? 0) * deps.budgetMultiplier,
            status: 'running',
            attention: null,
          });
          return schedule(snapshot, w, fx);
        }
        if (reason === 'plan_failed' && choice === 'retry') return planning.retry(snapshot, w, fx);
        throw new HttpError(409, 'choice_unavailable', UNAVAILABLE[reason]);
      }),

    /** 新建节点：先是「新建」状态，不会自动开跑 */
    createNode: (ownerId: string, taskId: string, body: PlanNode) =>
      change(ownerId, taskId, async (snapshot, w) => {
        checkNewNode(snapshot, body);
        await w.addNode(nodeRow(body, randomUUID(), 'draft'));
      }),

    /** 改还没开始的节点 */
    updateNode: (ownerId: string, taskId: string, nodeId: string, body: UpdateNodeBody) =>
      change(ownerId, taskId, async (snapshot, w) => {
        const node = nodeOf(snapshot, nodeId);
        requireNotStarted(node, '修改');
        await w.setNode(node.id, nodeChanges(node, body));
      }),

    /** 删还没开始的节点：它的进出连线留下断开的线头 */
    deleteNode: (ownerId: string, taskId: string, nodeId: string) =>
      change(ownerId, taskId, async (snapshot, w, fx) => {
        const node = nodeOf(snapshot, nodeId);
        requireNotStarted(node, '删除');
        await w.deleteNode(node.id);
        await schedule(snapshot, w, fx);
      }),

    /** 只运行这一个节点：跑完不自动往下（任务在整体运行时除外） */
    runNode: (ownerId: string, taskId: string, nodeId: string) =>
      change(ownerId, taskId, async (snapshot, w, fx) => {
        const node = nodeOf(snapshot, nodeId);
        if (!['draft', 'waiting', 'stopped', 'failed'].includes(node.status)) {
          throw new HttpError(
            409,
            'node_not_runnable',
            node.status === 'blocked'
              ? `「${node.title}」前面的连线没接上`
              : `「${node.title}」现在不能运行`,
          );
        }
        if (node.status !== 'stopped') {
          const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
          const notReady = snapshot.edges
            .filter((e) => e.toNodeId === node.id)
            .some((e) => byId.get(e.fromNodeId ?? '')?.status !== 'succeeded');
          if (notReady) {
            throw new HttpError(409, 'upstream_not_ready', `「${node.title}」的上游还没完成`);
          }
        }
        const active = snapshot.nodes.filter((n) => ACTIVE.includes(n.status)).length;
        if (active >= deps.maxParallel) {
          throw new HttpError(
            409,
            'too_many_running',
            `一个任务同时最多跑 ${deps.maxParallel} 个节点，请等一会儿`,
          );
        }
        if (snapshot.task.status === 'needs_attention') {
          await w.setTask({ status: 'stopped', attention: null });
        }
        await startNode(snapshot, w, node, fx);
      }),

    /** 停止一个节点；其他支路照常跑 */
    stopNode: (ownerId: string, taskId: string, nodeId: string) =>
      change(ownerId, taskId, async (snapshot, w, fx) => {
        const node = nodeOf(snapshot, nodeId);
        if (!ACTIVE.includes(node.status)) {
          throw new HttpError(409, 'node_not_running', `「${node.title}」没有在跑`);
        }
        await halt(snapshot, w, node, fx);
        await schedule(snapshot, w, fx);
      }),

    createEdge: (ownerId: string, taskId: string, from: string, to: string) =>
      change(ownerId, taskId, async (snapshot, w, fx) => {
        checkNewEdge(snapshot, from, to);
        await w.addEdge({ id: randomUUID(), fromNodeId: from, toNodeId: to });
        await schedule(snapshot, w, fx);
      }),

    /** 接上线头 / 改连线的一端 */
    updateEdge: (ownerId: string, taskId: string, edgeId: string, body: UpdateEdgeBody) =>
      change(ownerId, taskId, async (snapshot, w, fx) => {
        const edge = edgeOf(snapshot, edgeId);
        await w.setEdge(edge.id, edgeChanges(snapshot, edge, body));
        await schedule(snapshot, w, fx);
      }),

    deleteEdge: (ownerId: string, taskId: string, edgeId: string) =>
      change(ownerId, taskId, async (snapshot, w, fx) => {
        const edge = edgeOf(snapshot, edgeId);
        checkDeleteEdge(snapshot, edge);
        await w.deleteEdge(edge.id);
        await schedule(snapshot, w, fx);
      }),

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
      await planning.reconcile(before);
      for (const task of await store.listStale('accepting', before)) {
        await runAcceptance(task.id).catch((err: unknown) =>
          logger.warn({ err, taskId: task.id }, '整体验收重试失败，下次再试'),
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
