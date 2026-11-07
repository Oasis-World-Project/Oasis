// 工作流控制面（ADR 0004、0005）：任务单 → 规划（planning-service）或直接提交方案 → 调度可以跑的节点 → 收到运行结束就推进（讨论的下一轮、汇总、
// 过关卡、原会话修复、最终验收）→ 实际失败或证据不足时明确交给用户处理。
// 用户可以随时停止 / 继续、运行整个工作流或单个节点、改还没开始的节点和连线。
// 节点真正的执行在 harness；这里只管图、状态和决定。所有决定都在锁住任务行的事务里做，
// 对外的调用（提交运行、关卡检查、通知停止或取消）在事务之外。
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Material } from '@oasis/contracts/canvas';
import type { CallSettledData, RunFinishedData } from '@oasis/contracts/events';
import { RunBody, RunEventList } from '@oasis/contracts/harness';
import type {
  Attention,
  CreateTaskInput,
  DecisionBody,
  EdgeBody,
  NodeBody,
  NodeRunBody,
  PlanNode,
  TaskBody,
  TaskSummary,
  UpdateEdgeBody,
  UpdateNodeBody,
  WorkflowVersionBody,
} from '@oasis/contracts/task';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import type { Node, NodeRun, Snapshot, TaskStore, Writer } from '../repo/task-store.ts';
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
import { materialPaths } from './materials.ts';
import { deliveryManifest, selectDeliverables, missingDeliveryFiles } from './output-files.ts';
import { nodeRow, planToRows, validatePlan } from './plan.ts';
import { createPlanning, type PlanningConfig } from './planning-service.ts';
import { decide } from './schedule.ts';
import { afterRound, firstStep, resumeStep, retryStep, reworkStep, type Step } from './steps.ts';

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** 节点花费到份额的这些倍数时各提醒一次收尾（用户 2026-11-07 同意 1.5 倍、2 倍） */
const NUDGE_AT = [1.5, 2];

/**
 * 运行中的干活节点花费刚越过一个提醒线：返回要发的提醒。节点只在开工时看到一次预算，
 * 之后看不到花了多少、跑了多久，靠这条消息知道该收手了。
 */
function budgetNudge(
  node: Pick<Node, 'kind' | 'status' | 'currentRunId' | 'config' | 'startedAt'>,
  spentMicro: number,
  now = new Date(),
): { count: number; text: string } | undefined {
  const share = node.config.budgetMicro;
  if (node.kind !== 'work' || node.status !== 'running' || !node.currentRunId || !share) return;
  const sent = node.config.budgetNudges ?? 0;
  const crossed = NUDGE_AT.filter((times) => spentMicro >= share * times).length;
  if (crossed <= sent) return;
  const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
  const minutes = node.startedAt
    ? Math.max(0, Math.round((now.getTime() - node.startedAt.getTime()) / 60_000))
    : undefined;
  return {
    count: crossed,
    text: `【系统提醒】这一步已花 ${usd(spentMicro)}（分到约 ${usd(share)}）${minutes === undefined ? '' : `，已经跑了 ${minutes} 分钟`}。请收尾：把现有成果整理好交出来，别再打磨。`,
  };
}
/** 任务、节点不会再变的状态 */
const FINAL = ['succeeded', 'failed', 'cancelled'];
/** 运行已经结束的状态 */
const RUN_FINAL = ['succeeded', 'failed', 'cancelled', 'stopped'];
/**
 * 检查明确没满足时最多自动改几次（ADR 0004 §2，2026-11-05 用户重申）：改过之后照常往下走、带提醒交付。
 * 检查只提醒、不拦截——任务只会因为用户停止或网络长时间连不上而停下。
 */
const MAX_REWORKS = 1;
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
    ...(c.gateChecks ? { gateChecks: c.gateChecks } : {}),
    expects: c.expects ?? [],
    ...(c.requires ? { requires: c.requires } : {}),
    ...(c.deliver === undefined ? {} : { deliver: c.deliver }),
    tools: c.tools ?? [],
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

function toRunBody(run: NodeRun): NodeRunBody {
  return {
    id: run.id,
    purpose: run.purpose,
    status: run.status,
    attempt: run.attempt,
    round: run.meta.round ?? null,
    participant: run.meta.participant ?? null,
    continued: Boolean(run.request.continueFrom),
    summary: run.summary,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    finishedAt: iso(run.finishedAt),
  };
}

/** 修改中：规划员在排修改方案、等用户确认，或确认后新版还没结束（停下的也算，ADR 0022） */
const isRevising = (task: Snapshot['task']) =>
  !!task.revision || (!FINAL.includes(task.status) && !!task.acceptance?.revision);

/** 进行中的修改给前端看的样子（ADR 0022） */
function toRevisionBody(task: Snapshot['task']): TaskBody['revision'] {
  const r = task.revision;
  if (!r) return null;
  return {
    version: r.version,
    stage: r.plan ? 'confirm' : 'planning',
    request: r.request,
    summary: r.plan?.summary ?? null,
    estimateMicro: r.estimateMicro ?? null,
    changes: r.changes ?? [],
  };
}

const toEdgeBody = (e: Snapshot['edges'][number]): EdgeBody => ({
  id: e.id,
  from: e.fromNodeId,
  to: e.toNodeId,
});

function toTaskBody({ task, nodes, edges, versions }: Snapshot): TaskBody {
  const deliveryFiles = deliveryManifest(task.deliverables, nodes);
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
    materials: task.materials,
    revisionOf: task.revisionOf,
    // 验收返工次数、这轮的修改意见只给控制面用，不返回；修改还没验收时没有验收记录
    acceptance:
      task.acceptance &&
      (({ repairs: _repairs, revision, ...rest }) =>
        revision !== undefined && !FINAL.includes(task.status) ? null : rest)(task.acceptance),
    deliverables: task.deliverables,
    ...(deliveryFiles === undefined ? {} : { deliveryFiles }),
    nodes: nodes.map(toNodeBody),
    edges: edges.map(toEdgeBody),
    version: task.version,
    versions: versions.map((v) => ({
      version: v.version,
      request: v.request,
      createdAt: v.createdAt.toISOString(),
      frozenAt: v.frozenAt.toISOString(),
    })),
    revision: toRevisionBody(task),
    revising: isRevising(task),
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
  checks_incomplete: '检查停下了，可以继续、跳过检查或取消',
  revision_plan: '修改方案只能确认，或者不改了',
};

const revising = () =>
  new HttpError(409, 'task_revising', '这份成果正在修改，等这次修改结束后再操作');

/** 上游拒绝「地区不可用」时运行的错误里带的代码（model-gateway 给的） */
const REGION_UNAVAILABLE = 'provider_region_unavailable';

const isOpen = (r: NodeRun) => r.status === 'pending' || r.status === 'running';

/** 节点还没结束的运行（讨论同一轮里的几条发言可能同时在跑） */
const openRuns = (snapshot: Snapshot, nodeId: string) =>
  snapshot.activeRuns.filter((r) => r.nodeId === nodeId && isOpen(r));

export function createWorkflowService(deps: {
  store: TaskStore;
  harness: ServiceClient;
  gate: Gate;
  maxParallel: number;
  /** 规划员要查模型目录 */
  agent: ServiceClient;
  /** 规划员要排除在当前网络用不了的模型 */
  modelGateway: ServiceClient;
  planning: PlanningConfig;
  logger: Logger;
}) {
  const { store, harness, gate, logger } = deps;
  const checksInFlight = new Map<
    string,
    { taskId: string; nodeId?: string; abort: AbortController; pending: Promise<void> }
  >();
  function checkOnce(
    key: string,
    owner: { taskId: string; nodeId?: string },
    check: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const existing = checksInFlight.get(key);
    if (existing) return existing.pending;
    const abort = new AbortController();
    const pending = Promise.resolve()
      .then(() => check(abort.signal))
      .finally(() => checksInFlight.delete(key));
    checksInFlight.set(key, { ...owner, abort, pending });
    return pending;
  }
  const planning = createPlanning({
    store,
    harness,
    agent: deps.agent,
    modelGateway: deps.modelGateway,
    engine: { transact, schedule },
    config: deps.planning,
    logger,
  });

  // ---------------------------------------------------------------- 事务里的推进

  /** 开出一步的运行：记下运行、节点标成运行中 */
  async function openStep(snapshot: Snapshot, w: Writer, node: Node, step: Step, fx: Effects) {
    let lastRunId: string | undefined;
    for (const request of step.requests) {
      const runId = randomUUID();
      const record = {
        ...(node.config.requires ? { requires: node.config.requires } : {}),
        ...(request.goal ? { goal: true } : {}),
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
    fx.abortChecks.push({ taskId: snapshot.task.id, nodeId: node.id });
    await endRuns(w, openRuns(snapshot, node.id), 'stop', fx);
    await w.setNode(node.id, { status: 'stopped' });
  }

  /** 让一个节点开跑：新建 / 等待的从头做，停下的接着做，失败的重新算重做次数再做 */
  async function startNode(snapshot: Snapshot, w: Writer, node: Node, fx: Effects) {
    if (node.config.repairChecks?.length || node.config.revision) {
      const { repairChecks = [], revision, ...config } = node.config;
      const clean = { ...node, config };
      const previous = node.currentRunId ? await store.findRun(node.currentRunId) : undefined;
      const canResume = previous && (previous.status === 'succeeded' || previous.meta.resumable);
      const step = canResume
        ? reworkStep(clean, repairChecks, revision)
        : previous
          ? retryStep(snapshot, clean, previous)
          : firstStep(snapshot, clean);
      if (canResume) {
        const latest = firstStep(snapshot, node).requests[0]?.inputsFrom ?? [];
        for (const request of step.requests) request.inputsFrom = latest;
      }
      await w.setNode(node.id, { config, reworks: node.reworks + 1 });
      await openStep(snapshot, w, node, step, fx);
      return;
    }
    if (node.status === 'stopped') {
      const completed = node.currentRunId ? await store.findRun(node.currentRunId) : undefined;
      if (
        node.kind === 'work' &&
        completed?.status === 'succeeded' &&
        node.config.outputsRunId === completed.id &&
        (node.config.notesSeen ?? 0) === node.userNotes.length
      ) {
        await w.setNode(node.id, { status: 'checking' });
        fx.gate.push({ taskId: snapshot.task.id, nodeId: node.id, runId: completed.id });
        return;
      }
      await openStep(snapshot, w, node, resumeStep(snapshot, node), fx);
      return;
    }
    if (node.status === 'failed') {
      await w.setNode(node.id, { attempts: 0, reworks: 0, warning: null });
    }
    await w.setNode(node.id, { attempts: node.attempts + 1 });
    const previous = node.currentRunId ? await store.findRun(node.currentRunId) : undefined;
    const step =
      previous?.status === 'failed' && previous.meta.resumable
        ? retryStep(snapshot, node, previous)
        : firstStep(snapshot, node);
    await openStep(snapshot, w, node, step, fx);
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
   * 整体验收（ADR 0005 §5，ADR 0017 起只查交付文件齐不齐）：缺文件的交付节点接着原会话补一次，
   * 补过仍缺就带着记录交付。
   */
  async function runAcceptance(taskId: string): Promise<void> {
    return checkOnce(`accept:${taskId}`, { taskId }, () => checkDelivery(taskId));
  }

  async function checkDelivery(taskId: string): Promise<void> {
    const snapshot = await store.get(taskId);
    if (snapshot?.task.status !== 'accepting' || !snapshot.task.sheet) return;
    const { task } = snapshot;
    // 整体验收只核对交付文件齐不齐（ADR 0017）：节点关卡已经跑过文件、网页和音视频检查，
    // 任务单的要求由节点自己对照，不再逐条打分
    const missing: string[] = [];
    /** 交付不齐的节点：只让它们补，交齐了的不动 */
    const short = new Set<string>();
    const deliverables = selectDeliverables(task.deliverables, snapshot.nodes);
    for (const owner of new Set(deliverables.map((d) => d.nodeId))) {
      const node = snapshot.nodes.find((n) => n.id === owner);
      const lacking = node ? missingDeliveryFiles(node.outputs, node.config.deliver) : [];
      if (lacking.length) short.add(node!.id);
      missing.push(...lacking);
    }
    for (const d of deliverables) {
      const node = snapshot.nodes.find((n) => n.id === d.nodeId);
      if (!node?.config.outputsRunId || (d.files ?? node.outputs).length === 0) {
        missing.push(`「${d.name}」没有交出文件`);
        if (node) short.add(node.id);
      }
    }
    const revision = task.acceptance?.revision;
    await transact(taskId, async (fresh, w, fx) => {
      if (fresh.task.status !== 'accepting') return;
      const repairs = fresh.task.acceptance?.repairs ?? 0;
      await w.setTask({
        acceptance: {
          unmet: missing,
          ...(repairs ? { repairs } : {}),
          ...(revision !== undefined ? { revision } : {}),
        },
        deliverables,
        finishedAt: null,
      });
      // 交付文件不齐：缺文件的交付节点接着原会话补一次；补过之后照常交付，缺的记在验收记录里
      const targets = fresh.nodes.filter((n) => short.has(n.id) && n.currentRunId);
      if (missing.length && repairs < MAX_REWORKS && targets.length) {
        await w.setTask({
          status: 'running',
          attention: null,
          acceptance: { ...fresh.task.acceptance!, repairs: repairs + 1 },
        });
        const affected = withDownstream(fresh, targets);
        for (const node of fresh.nodes.filter((n) => affected.has(n.id)))
          await w.setNode(node.id, {
            status: 'waiting',
            finishedAt: null,
            config: {
              ...node.config,
              repairChecks: missing,
            },
          });
        await schedule(fresh, w, fx);
      } else await w.setTask({ status: 'succeeded', attention: null, finishedAt: new Date() });
    });
  }

  /** 这些节点和它们所有的下游（交付节点改了，下游要基于新产出跟着更新） */
  function withDownstream(snapshot: Snapshot, nodes: Node[]): Set<string> {
    const affected = new Set(nodes.map((n) => n.id));
    for (;;) {
      const size = affected.size;
      for (const edge of snapshot.edges)
        if (edge.fromNodeId && affected.has(edge.fromNodeId) && edge.toNodeId)
          affected.add(edge.toNodeId);
      if (size === affected.size) return affected;
    }
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

  // ---------------------------------------------------------------- 事务外的副作用

  /** 在事务里做决定，事务外执行副作用（通知停止或取消、提交运行、关卡检查） */
  async function transact(
    taskId: string,
    fn: (snapshot: Snapshot, w: Writer, fx: Effects) => Promise<void>,
  ): Promise<void> {
    const fx = noEffects();
    await store.transact(taskId, (snapshot, w) => fn(snapshot, w, fx));
    await runEffects(fx);
  }

  /** 事务提交后执行副作用（通知 harness、提交运行、规划、验收、关卡）；各自的失败等对账重试 */
  async function runEffects(fx: Effects): Promise<void> {
    for (const intent of fx.abortChecks)
      for (const check of checksInFlight.values())
        if (check.taskId === intent.taskId && (!intent.nodeId || check.nodeId === intent.nodeId))
          check.abort.abort();
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
          // 每次运行都放一份（接着原会话做时 harness 不会放回上次的素材）
          materials: materialPaths(s.task.materials),
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
    return checkOnce(`node:${taskId}:${nodeId}:${runId}`, { taskId, nodeId }, (signal) =>
      checkNode(taskId, nodeId, runId, signal),
    );
  }

  async function checkNode(
    taskId: string,
    nodeId: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const snapshot = await store.get(taskId);
    const node = snapshot?.nodes.find((n) => n.id === nodeId);
    if (!snapshot || node?.status !== 'checking' || node.currentRunId !== runId) return;
    if (
      snapshot.task.status === 'needs_attention' &&
      snapshot.task.attention?.reason === 'checks_incomplete'
    )
      return;
    // 检查轻量化（ADR 0017）：只挡明显坏掉的成果，任务单要求由节点自己对照
    const { unmet, unchecked } = await gate.check({
      signal,
      payerId: snapshot.task.payerId,
      taskId,
      nodeId,
      runId,
      outputs: node.outputs,
      expects: [...(node.config.expects ?? []), ...(node.config.deliver ?? [])],
    });
    await transact(taskId, async (fresh, w, fx) => {
      // 检查期间节点被停止、任务被取消：结果作废
      const current = fresh.nodes.find((n) => n.id === nodeId);
      if (current?.status !== 'checking' || current.currentRunId !== runId) return;
      // 明确没满足：接着原会话改，最多 MAX_REWORKS 次；其余（改过仍没满足、没检查到）都记成提醒往下走
      if (unmet.length && current.reworks < MAX_REWORKS) {
        logger.info({ nodeId, unmet }, '关卡没过，接着原会话修改一次');
        await w.setNode(nodeId, { reworks: current.reworks + 1 });
        await openStep(fresh, w, current, reworkStep(current, unmet), fx);
      } else {
        const reminders = [
          ...(unmet.length ? [`改过一次仍可能没满足：${unmet.join('；')}`] : []),
          ...(unchecked?.length ? [`没检查到：${unchecked.join('；')}`] : []),
        ];
        await w.setNode(nodeId, {
          status: 'succeeded',
          finishedAt: new Date(),
          warning: reminders.length ? reminders.join('\n') : null,
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
    if (error?.includes(REGION_UNAVAILABLE) && run.request.model !== deps.planning.defaultModel) {
      // 模型在当前网络用不了：重试也没用，换默认模型接着做，不算一次重做
      logger.info(
        { nodeId: node.id, model: run.request.model },
        '模型在当前网络用不了，换默认模型',
      );
      await switchModel(w, node, run, deps.planning.defaultModel);
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
        message: `「${node.title}」未完成：${error ?? '执行器未能完成任务'}`,
      },
    });
  }

  /** 把这次运行用的模型换掉：讨论发言换那位参与者的，其余换节点的；节点上留一条提醒 */
  async function switchModel(w: Writer, node: Node, run: NodeRun, model: string) {
    const who = run.meta.participant;
    const note = `${who ? `「${who}」` : ''}原定的模型 ${run.request.model} 在当前网络用不了，改用 ${model}`;
    const warning = [node.warning, note].filter(Boolean).join('；');
    if (run.purpose === 'speech' && who) {
      const participants = (node.config.participants ?? []).map((p) =>
        p.name === who ? { ...p, model } : p,
      );
      await w.setNode(node.id, { config: { ...node.config, participants }, warning });
    } else {
      await w.setNode(node.id, { model, warning });
    }
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
    result: Pick<
      RunFinishedData,
      'runId' | 'status' | 'error' | 'outputs' | 'summary' | 'resumable'
    >,
  ): Promise<void> {
    const found = await store.findRun(result.runId);
    if (!found) return planning.onFinished(result); // 不是节点的运行：可能是规划员
    await transact(found.taskId, async (snapshot, w, fx) => {
      const run = snapshot.activeRuns.find((r) => r.id === result.runId);
      if (!run) return; // 已经处理过
      await w.setRun(run.id, {
        status: result.status,
        meta: { ...run.meta, resumable: result.resumable ?? false },
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
        await onFailure(
          snapshot,
          w,
          node,
          { ...run, meta: { ...run.meta, resumable: result.resumable ?? false } },
          result.error,
          fx,
        );
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

  /** 调用方给定 ID 的任务已经建过：同一个人的原样返回；ID 被别人的任务占着就拒绝 */
  async function sameTask(body: CreateTaskInput): Promise<TaskBody | undefined> {
    const snapshot = body.id ? await store.get(body.id) : undefined;
    if (!snapshot) return undefined;
    if (snapshot.task.ownerId !== body.ownerId)
      throw new HttpError(409, 'task_id_taken', '这个任务 ID 已经被占用');
    return toTaskBody(snapshot);
  }

  /** 节点交出的一个文件：只能是它产出清单里有的（经 harness 读对象存储） */
  async function readFile(snapshot: Snapshot, nodeId: string, path: string) {
    const node = nodeOf(snapshot, nodeId);
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
      size: node.outputs.find((file) => file.path === path)!.size,
      sha256: response.headers.get('x-oasis-file-sha256'),
      content: response.body ? Readable.fromWeb(response.body) : Readable.from([]),
    };
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

  /** 能不能修改这个任务的成果：是这个人的、已经交付、没有正在进行的修改（ADR 0012） */
  async function checkRevisable(ownerId: string, taskId: string): Promise<void> {
    const previous = await store.get(taskId);
    if (previous?.task.ownerId !== ownerId)
      throw new HttpError(404, 'task_not_found', '没有这个任务');
    if (previous.task.status !== 'succeeded')
      throw new HttpError(409, 'task_not_delivered', '这个任务还没有交付成果，不能修改');
    if (await store.findActiveRevision(taskId)) throw revising();
  }

  /**
   * 用户确认修改方案（ADR 0022）：先把当前工作流冻结成一版，再按方案改——沿用的原样留下，
   * 带 from 的保留原节点 ID（成果、同步路径、运行记录接得上），新节点新 ID，没出现的移出工作流；然后开跑。
   */
  async function applyRevision(snapshot: Snapshot, w: Writer, fx: Effects) {
    const { task } = snapshot;
    const revision = task.revision!;
    const plan = revision.plan!;
    const before = [...snapshot.nodes];
    await w.addVersion({
      version: task.version,
      request: task.acceptance?.revision ?? null,
      nodes: before.map(toNodeBody),
      edges: snapshot.edges.map(toEdgeBody),
      deliverables: task.deliverables,
      spentMicro: before.reduce((sum, n) => sum + n.spentMicro, 0),
      createdAt: snapshot.versions.at(-1)?.frozenAt ?? task.createdAt,
    });
    const byKey = new Map(before.map((n) => [n.key, n]));
    const idOf = new Map<string, string>();
    for (const entry of plan.nodes) {
      if ('reuse' in entry) {
        const node = byKey.get(entry.reuse)!;
        idOf.set(entry.key, node.id);
        // 上一轮修改留下的修改意见、修复项不再带着（产出照旧交给下游）
        const { revision: _revision, repairChecks: _repairs, ...config } = node.config;
        await w.setNode(node.id, {
          status: 'succeeded',
          config,
          warning: null,
          finishedAt: node.finishedAt ?? new Date(),
        });
        continue;
      }
      const { from, mode, ...planNode } = entry;
      const source = from ? byKey.get(from) : undefined;
      const row = nodeRow(planNode as PlanNode, source?.id ?? randomUUID(), 'waiting');
      idOf.set(entry.key, row.id);
      if (!source) {
        await w.addNode(row);
        continue;
      }
      const outputsRunId = source.config.outputsRunId;
      await w.setNode(source.id, {
        key: row.key,
        title: row.title,
        role: row.role,
        goal: row.goal,
        model: row.model,
        // 接着改：接着上一版的会话，按意见和这次的安排改；重新做：新会话，上一版产出放进 in/_previous/
        config:
          mode === 'continue'
            ? {
                ...row.config,
                ...(outputsRunId ? { outputsRunId } : {}),
                revision: revision.request,
              }
            : { ...row.config, ...(outputsRunId ? { previousRunId: outputsRunId } : {}) },
        status: 'waiting',
        attempts: 0,
        reworks: 0,
        userNotes: [],
        warning: null,
        spentMicro: 0,
        startedAt: null,
        finishedAt: null,
        ...(mode === 'continue' ? {} : { currentRunId: null, outputs: [], summary: null }),
      });
    }
    const kept = new Set(idOf.values());
    for (const edge of [...snapshot.edges]) await w.deleteEdge(edge.id);
    for (const node of before.filter((n) => !kept.has(n.id)))
      await w.retireNode(node.id, revision.version);
    for (const edge of plan.edges)
      await w.addEdge({
        id: randomUUID(),
        fromNodeId: idOf.get(edge.from)!,
        toNodeId: idOf.get(edge.to)!,
      });
    await w.setTask({
      version: revision.version,
      revision: null,
      deliverables: task.sheet!.deliverables.map((d) => ({
        name: d.name,
        form: d.form,
        nodeId: idOf.get(plan.deliverables[d.name] ?? '') ?? null,
      })),
      // 这一轮按修改意见验收（只查意见改好没有，ADR 0012）
      acceptance: { unmet: [], revision: revision.request },
      status: 'running',
      attention: null,
      finishedAt: null,
    });
    logger.info({ taskId: task.id, version: revision.version }, '用户确认了修改方案，开跑');
    await schedule(snapshot, w, fx);
  }

  /** 用户不改了（规划中或待确认）：回到修改前的样子，成果不变（ADR 0022） */
  async function cancelRevision(snapshot: Snapshot, w: Writer, fx: Effects) {
    const { task } = snapshot;
    if (task.status === 'planning' && task.plannerRunId) fx.cancel.push(task.plannerRunId);
    await w.setTask({
      status: task.revision!.previousStatus,
      attention: null,
      revision: null,
      plannerRunId: null,
    });
    logger.info({ taskId: task.id }, '用户不改了');
  }

  /** 取消整个任务（在事务里） */
  async function cancelAll(snapshot: Snapshot, w: Writer, fx: Effects) {
    fx.abortChecks.push({ taskId: snapshot.task.id });
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
        resumable: remote.resumable,
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
      data: Pick<CallSettledData, 'callId' | 'taskId' | 'nodeId' | 'chargedMicro'> & {
        model?: string;
      },
    ) {
      // 成果预览在任务完成后单独付费；账单保留 taskId 关联，但不回写生成任务的花费。
      if (data.model === 'preview') return;
      if (!(await store.get(data.taskId))) return;
      let nudge: { runId: string; text: string } | undefined;
      await transact(data.taskId, async (snapshot, w) => {
        const node = data.nodeId ? snapshot.nodes.find((n) => n.id === data.nodeId) : undefined;
        const counted = await w.addSpend({
          callId: data.callId,
          nodeId: node?.id ?? null,
          chargedMicro: data.chargedMicro,
        });
        if (!counted) return;
        const { task } = snapshot;
        await w.setTask({ spentMicro: task.spentMicro + data.chargedMicro });
        if (!node) return;
        const spent = node.spentMicro + data.chargedMicro;
        await w.setNode(node.id, { spentMicro: spent });
        // 预算只是参考，花完照样做（ADR 0016 §2）；但节点在运行中看不到花费，超过份额时提醒它收尾
        const due = budgetNudge(node, spent);
        if (due) {
          await w.setNode(node.id, { config: { ...node.config, budgetNudges: due.count } });
          nudge = { runId: node.currentRunId!, text: due.text };
        }
      });
      if (nudge)
        await harness
          .json('POST', `/internal/runs/${nudge.runId}/messages`, { body: { text: nudge.text } })
          .catch((err: unknown) =>
            // 运行正在启动或收尾：这次提醒就不发了，不影响记账
            logger.warn({ err, runId: nudge!.runId }, '超预算提醒没发出去'),
          );
    },

    /**
     * 建任务：给任务单的先规划（规划员排出方案后自动开跑）；
     * 直接给方案的校验后立即开跑。
     */
    async create(body: CreateTaskInput): Promise<TaskBody> {
      const id = body.id ?? randomUUID();
      // 同一个 ID 已经建过（确认任务单超时后重试）：原样返回，不建第二个
      const existing = body.id ? await sameTask(body) : undefined;
      if (existing) return existing;
      if (body.revisionOf) await checkRevisable(body.ownerId, body.revisionOf);
      const base = {
        id,
        ownerId: body.ownerId,
        payerId: body.payerId,
        conversationId: body.conversationId ?? null,
        title: body.title,
        brief: body.brief,
        materials: body.materials,
        revisionOf: body.revisionOf ?? null,
      };
      if (body.sheet) {
        try {
          await store.create({
            task: {
              ...base,
              status: 'planning',
              estimateMicro: null,
              budgetLimitMicro: null,
              sheet: body.sheet,
            },
            nodes: [],
            edges: [],
          });
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            // 同一个 ID 的两次请求同时到达：主键只放进一个，另一个返回它
            const raced = body.id ? await sameTask(body) : undefined;
            if (raced) return raced;
            // 两个修改请求同时到达：数据库的部分唯一索引只放进一个
            if (body.revisionOf) throw revising();
          }
          throw err;
        }
        // 规划员的提交（读经验手册、模型和工具目录）放到返回之后：建任务只等数据库，
        // 确认任务单不会因为它超时；提交失败由对账重试。
        const fx = noEffects();
        await store.transact(id, (snapshot, w) => planning.begin(snapshot, w, fx));
        void runEffects(fx).catch((err: unknown) =>
          logger.error({ err, taskId: id }, '提交规划员失败，等对账重试'),
        );
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
          budgetLimitMicro: null,
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
        revisionOf: task.revisionOf,
        // 从发出修改到新版交付（或不改了）都算修改中（ADR 0022）
        revising: isRevising(task),
        createdAt: task.createdAt.toISOString(),
      }));
    },

    /** 这些上传文件里，哪些是这个人某个任务的素材（conversation 删私聊时留着它们） */
    materialsInUse: (ownerId: string, uploadIds: string[]) =>
      store.materialsInUse(ownerId, uploadIds),

    get: async (ownerId: string, taskId: string) => toTaskBody(await owned(ownerId, taskId)),

    /** 内部（conversation 发交付消息用）：不查归属 */
    async getInternal(taskId: string): Promise<TaskBody> {
      const snapshot = await store.get(taskId);
      if (!snapshot) throw new HttpError(404, 'task_not_found', '没有这个任务');
      return toTaskBody(snapshot);
    },

    /**
     * 用户删除成果（ADR 0012）：连同工作流和中间产物一起删，不可恢复。
     * 只能删已经结束的任务；成果正在修改时先取消那次修改。
     */
    /** 删除任务：还没结束的先取消（停掉正在跑的运行），再连同成果、工作流和中间产物一起删 */
    async remove(ownerId: string, taskId: string): Promise<void> {
      await owned(ownerId, taskId);
      if (await store.findActiveRevision(taskId)) throw revising();
      await transact(taskId, async (snapshot, w, fx) => {
        if (!FINAL.includes(snapshot.task.status)) await cancelAll(snapshot, w, fx);
      });
      await store.remove(taskId, null);
      logger.info({ taskId }, '用户删除了任务和它的成果');
    },

    /**
     * 内部（canvas 换好新版后调用）：新版已交付，删除被它替换的上一版。
     * 已经删过的直接返回（事件重投时会再调一次）。
     */
    /**
     * 修改成果（ADR 0022，取代 0012 的「交付节点接着原会话改」）：在原任务里改，但先交给规划员看上一版
     * 决定怎么改（沿用 / 接着改 / 重新做 / 加减节点），排好后等用户确认才开跑；附件并进任务素材。
     * 新版交付后 canvas 原地更新成果，链接不变。
     */
    async revise(
      taskId: string,
      body: { ownerId: string; request: string; materials: Material[]; nodeIds?: string[] },
    ): Promise<TaskBody> {
      await transact(taskId, async (snapshot, w, fx) => {
        const { task } = snapshot;
        if (task.ownerId !== body.ownerId)
          throw new HttpError(404, 'task_not_found', '没有这个任务');
        if (task.revision) throw revising();
        // 已结束或已停下的任务都能接着改（修改中途停下、取消后，成果还是上一版）
        if (!FINAL.includes(task.status) && task.status !== 'stopped')
          throw new HttpError(
            409,
            'task_not_delivered',
            '这个任务还没交付或正在修改，等它结束后再改',
          );
        // 旧流程建的修订任务还没结束（2026-11-05 之前发起的）
        if (await store.findActiveRevision(taskId)) throw revising();
        if (!task.sheet || snapshot.nodes.length === 0)
          throw new HttpError(409, 'task_not_revisable', '这个任务没有可以接着改的工作流');
        const known = new Set(task.materials.map((m) => m.uploadId));
        await w.setTask({
          materials: [...task.materials, ...body.materials.filter((m) => !known.has(m.uploadId))],
          revision: {
            version: task.version + 1,
            request: body.request,
            nodeIds: body.nodeIds ?? [],
            previousStatus: task.status,
          },
          planAttempts: 0,
        });
        // 交给规划员看上一版决定怎么改，排好后先给用户确认（ADR 0022）
        await planning.begin(snapshot, w, fx);
      });
      logger.info({ taskId }, '修改交给规划员');
      return toTaskBody(await owned(body.ownerId, taskId));
    },

    async retire(taskId: string, replacedBy: string): Promise<void> {
      const next = await store.get(replacedBy);
      if (next?.task.revisionOf !== taskId || next.task.status !== 'succeeded')
        throw new HttpError(409, 'not_replaced', '新版还没交付，不能替换上一版');
      if (await store.remove(taskId, replacedBy))
        logger.info({ taskId, replacedBy }, '上一版已被新版替换并删除');
    },

    /** 节点的运行过程：转发它最近一次运行的事件 */
    /** 节点的全部运行（第一次、重做、关卡退回修改、停止后继续、讨论的每次发言） */
    async nodeRuns(ownerId: string, taskId: string, nodeId: string): Promise<NodeRunBody[]> {
      // 修改时移出工作流的节点也能看（旧版查看，ADR 0022）：运行按任务过滤，归属已经核对
      await owned(ownerId, taskId);
      return (await store.listNodeRuns(taskId, nodeId)).map(toRunBody);
    },

    /** 冻结的某一版工作流（ADR 0022） */
    async version(ownerId: string, taskId: string, version: number): Promise<WorkflowVersionBody> {
      await owned(ownerId, taskId);
      const row = await store.getVersion(taskId, version);
      if (!row) throw new HttpError(404, 'version_not_found', '没有这一版');
      return {
        version: row.version,
        request: row.request,
        createdAt: row.createdAt.toISOString(),
        frozenAt: row.frozenAt.toISOString(),
        nodes: row.nodes,
        edges: row.edges,
        spentMicro: row.spentMicro,
      };
    },

    /** 一次运行的过程（按序号增量拉取）；不指定运行时看节点当前这次 */
    async nodeEvents(
      ownerId: string,
      taskId: string,
      nodeId: string,
      after: number,
      runId?: string,
    ) {
      const snapshot = await owned(ownerId, taskId);
      // 指定了运行时（旧版查看）不要求节点还在工作流里，下面核对运行属于这个节点
      const target = runId ?? nodeOf(snapshot, nodeId).currentRunId;
      if (!target) return { events: [] };
      if (runId) {
        const run = await store.findRun(runId);
        if (run?.taskId !== taskId || run.nodeId !== nodeId) {
          throw new HttpError(404, 'run_not_found', '这个节点没有这次运行');
        }
      }
      return harness.json('GET', `/internal/runs/${target}/events?after=${after}`, {
        schema: RunEventList,
      });
    },

    /** 编辑节点时能选的模型和工具 */
    options: () => planning.options(),
    /** 报价用的单价：带单价的模型目录和工具目录（ADR 0016 §4） */
    pricing: () => planning.pricing(),

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

    /** 下载节点交出的一个文件（交付消息、工作流视图用） */
    async applicationReport(ownerId: string, taskId: string, nodeId: string) {
      const snapshot = await owned(ownerId, taskId);
      const node = nodeOf(snapshot, nodeId);
      const runId = node.config.outputsRunId ?? node.currentRunId;
      if (!runId) throw new HttpError(404, 'check_not_found', '节点还没有可检查的产出');
      const response = await harness.stream(
        'POST',
        `/internal/runs/${runId}/application-check/report`,
        {
          body: { payerId: ownerId, taskId },
        },
      );
      return response.body ? Readable.fromWeb(response.body) : Readable.from([]);
    },
    async file(ownerId: string, taskId: string, nodeId: string, path: string) {
      return readFile(await owned(ownerId, taskId), nodeId, path);
    },

    /** 内部：取节点交出的一个文件（画布登记成果时复制，ADR 0007 §8） */
    async fileInternal(taskId: string, nodeId: string, path: string) {
      const snapshot = await store.get(taskId);
      if (!snapshot) throw new HttpError(404, 'task_not_found', '没有这个任务');
      return readFile(snapshot, nodeId, path);
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
        // 修改还在规划或等确认：取消的是这次修改，不是整个任务（ADR 0022）
        if (snapshot.task.revision) await cancelRevision(snapshot, w, fx);
        else if (!FINAL.includes(snapshot.task.status)) await cancelAll(snapshot, w, fx);
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
        // 修改方案等确认、或修改没排出方案时：「不改了」只取消这次修改；「确认修改」按方案开跑（ADR 0022）
        if (task.revision && choice === 'cancel') return cancelRevision(snapshot, w, fx);
        if (choice === 'cancel') return cancelAll(snapshot, w, fx);
        const { reason, nodeId } = task.attention;
        if (reason === 'revision_plan' && choice === 'continue' && task.revision?.plan)
          return applyRevision(snapshot, w, fx);
        // 「继续」：从停下的地方接着检查——记下的检查结果和已保存的浏览器报告接着用（2026-11-05 用户决定）
        if (reason === 'checks_incomplete' && choice === 'retry') {
          await w.setTask({ status: nodeId ? 'running' : 'accepting', attention: null });
          if (nodeId) {
            const node = snapshot.nodes.find((n) => n.id === nodeId);
            if (node?.status === 'checking' && node.currentRunId)
              fx.gate.push({ taskId, nodeId, runId: node.currentRunId });
          } else fx.accept.push(taskId);
          return;
        }
        if (reason === 'checks_incomplete' && choice === 'continue') {
          // 用户看过没做完的检查，决定跳过检查（2026-11-04 用户决定，2026-11-05 改名「跳过检查」）：
          // 未检查项原样留在节点提醒和验收记录里，不冒充通过。
          if (nodeId) {
            const node = snapshot.nodes.find((n) => n.id === nodeId);
            if (node?.status === 'checking')
              await w.setNode(node.id, {
                status: 'succeeded',
                finishedAt: new Date(),
                warning: `你选择了跳过检查。${node.warning ?? task.attention.message}`,
              });
            await w.setTask({ status: 'running', attention: null });
            return schedule(snapshot, w, fx);
          }
          await w.setTask({ status: 'succeeded', attention: null, finishedAt: new Date() });
          return;
        }
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
          await w.setTask({ budgetLimitMicro: null });
          return runAll(snapshot, w, fx);
        }
        if (reason === 'over_estimate' && choice === 'continue') {
          // 用户看了预估决定照做：估价不转为预算。
          await w.setTask({
            budgetLimitMicro: null,
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
