// 工作流引擎（ADR 0004、0005）分成几块：事务里的推进（advance）、运行结束（finish）、关卡与整体验收（checks）、
// 事务和事务外的副作用（outside）、修改（revisions）。各块通过同一个 Engine 对象互相调用（在 index.ts 组装），
// 这里只放它们共用的接口和常量，免得文件之间循环 import。引擎不认识具体的节点种类，种类相关的都交给 kinds/。
import type { RunFinishedData } from '@oasis/contracts/events';
import type { Logger, ServiceClient } from '@oasis/service-kit';
import type { Node, NodeRun, Snapshot, TaskStore, Writer } from '../../repo/task-store.ts';
import type { Effects, Submission } from '../effects.ts';
import type { Gate } from '../gate.ts';
import type { Step } from '../kinds/index.ts';
import type { createPlanning, PlanningConfig } from '../planning-service.ts';

export interface EngineDeps {
  store: TaskStore;
  harness: ServiceClient;
  gate: Gate;
  maxParallel: number;
  /** 工具子节点的并发池（ADR 0026）；不给时同 maxParallel */
  maxToolChildren?: number;
  /** 规划员要查模型目录 */
  agent: ServiceClient;
  /** 规划员要查这个用户能用的模型和工具（按他的模型范围，ADR 0027） */
  modelGateway: ServiceClient;
  planning: PlanningConfig;
  logger: Logger;
}

type Planning = ReturnType<typeof createPlanning>;

/** 一次运行的结局（harness 的事件，或对账时查到的） */
type RunResult = Pick<
  RunFinishedData,
  'runId' | 'status' | 'error' | 'outputs' | 'summary' | 'resumable'
>;

/** 在锁住任务行的事务里做决定；对外的调用记进 fx，事务提交后再做 */
type Decision = (snapshot: Snapshot, w: Writer, fx: Effects) => Promise<void>;

export interface Engine {
  deps: EngineDeps;
  /** 规划员（建任务、修改时排方案）；它也通过这个引擎做决定 */
  planning: Planning;

  // ---- 事务和事务外（outside.ts）
  /** 在事务里做决定，事务提交后执行副作用（通知停止或取消、提交运行、规划、验收、关卡） */
  transact(taskId: string, decide: Decision): Promise<void>;
  /** 执行一个事务攒下的副作用；各自的失败等对账重试 */
  runEffects(fx: Effects): Promise<void>;
  /** 把运行交给 harness */
  submit(s: Submission): Promise<void>;
  /** 对账一次运行：harness 已经跑完就补上结局；harness 根本没收到就按原样重交 */
  reconcileRun(run: NodeRun): Promise<void>;

  // ---- 事务里的推进（advance.ts）
  /** 开出一步的运行：记下运行、节点标成运行中 */
  openStep(snapshot: Snapshot, w: Writer, node: Node, step: Step, fx: Effects): Promise<void>;
  /** 结束这些运行：还没交出去的直接记下结局，交出去的通知 harness 停止或取消 */
  endRuns(w: Writer, runs: NodeRun[], how: 'stop' | 'cancel', fx: Effects): Promise<void>;
  /** 停下一个运行中或检查中的节点（之后可以接着做） */
  halt(snapshot: Snapshot, w: Writer, node: Node, fx: Effects): Promise<void>;
  /** 让一个节点开跑：新建 / 等待的从头做，停下的接着做，失败的重新算重做次数再做 */
  startNode(snapshot: Snapshot, w: Writer, node: Node, fx: Effects): Promise<void>;
  /** 找出能跑的节点并开跑；需要时改任务状态 */
  schedule: Decision;
  /** 运行整个工作流（先检查整张图） */
  runAll: Decision;
  /** 取消整个任务 */
  cancelAll: Decision;
  /** 这些节点和它们所有的下游 */
  withDownstream(snapshot: Snapshot, nodes: Node[]): Set<string>;

  // ---- 运行结束（finish.ts）
  /** 一次运行结束（来自 harness 的事件或对账）；同一个运行重复到达时只处理一次 */
  onRunFinished(result: RunResult): Promise<void>;

  // ---- 关卡与整体验收（checks.ts）
  runGate(taskId: string, nodeId: string, runId: string): Promise<void>;
  runAcceptance(taskId: string): Promise<void>;
  /** 停掉进行中的检查（节点被停止、任务被取消时结果作废） */
  abortChecks(intent: { taskId: string; nodeId?: string }): void;

  // ---- 修改（revisions.ts，ADR 0022）
  applyRevision: Decision;
  cancelRevision: Decision;

  // ---- 子节点（groups.ts、expand.ts，ADR 0026）
  /** 组节点开跑：展开节点去读清单，做几版的节点开出各版；停下、失败过的子节点重新排队 */
  startGroup(snapshot: Snapshot, w: Writer, node: Node, fx: Effects): Promise<void>;
  /** 子节点都结束了：展开节点汇总，做几版的节点开挑选运行（每次调度前做） */
  settleGroups: Decision;
  /** 读清单、开出每一条（事务外读文件，事务里改图） */
  expand(intent: { taskId: string; nodeId: string }): Promise<void>;
  /** 挑选运行结束（text：它写的 pick.txt，读不到为 undefined） */
  finishPick(
    w: Writer,
    node: Node,
    children: Node[],
    result: RunResult,
    text: string | undefined,
  ): Promise<void>;
  /** 做几版的节点用第 k 版：产出换成那一版的；在展开里时展开节点重新汇总 */
  useVersion(snapshot: Snapshot, w: Writer, node: Node, k: number, reason: string): Promise<void>;
}

/** 任务、节点不会再变的状态 */
export const FINAL = ['succeeded', 'failed', 'cancelled'];
/** 运行已经结束的状态 */
export const RUN_FINAL = ['succeeded', 'failed', 'cancelled', 'stopped'];
/** 占着并发名额的节点状态 */
export const ACTIVE = ['running', 'checking'];
