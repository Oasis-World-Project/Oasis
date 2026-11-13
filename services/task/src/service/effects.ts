// 事务里做决定、事务外执行的副作用，以及工作流引擎给规划模块用的接口。
import type { PlanNode } from '@oasis/contracts/task';
import type { Node, NodeRun, Snapshot, Task, Writer } from '../repo/task-store.ts';

/** 要提交给 harness 的一次节点运行 */
export interface Submission {
  runId: string;
  task: Task;
  nodeId: string;
  request: NodeRun['request'];
}

/** 要开的一次规划员运行；revise = 规划门没过，接着原会话改 */
export interface PlannerJob {
  task: Task;
  runId: string;
  revise?: { continueFrom: string; problems: string[] };
}

/** 一个事务做完后要在事务外做的事 */
export interface Effects {
  submit: Submission[];
  plan: PlannerJob[];
  gate: { taskId: string; nodeId: string; runId: string }[];
  /** 要做整体验收的任务 */
  accept: string[];
  stop: string[];
  cancel: string[];
  abortChecks: { taskId: string; nodeId?: string }[];
  /** 要读清单、展开的展开节点（ADR 0026） */
  expand: { taskId: string; nodeId: string }[];
}

export const noEffects = (): Effects => ({
  submit: [],
  plan: [],
  gate: [],
  accept: [],
  stop: [],
  cancel: [],
  abortChecks: [],
  expand: [],
});

/** 规划员同意的一次中途调整（ADR 0030 §3.7），已经对上了工作流里的节点 */
export interface Adjustment {
  /** 规划员给提出调整的 AI 的答复 */
  reply: string;
  /** 要加的成果：落成的节点和连线，以及成果的标题 */
  added: { nodes: PlanNode[]; edges: { from: string; to: string }[]; titles: string[] };
  /** 补说明的成果 */
  instructed: { node: Node; text: string }[];
  /** 停掉的节点（整条生产线时是线上的每个节点） */
  stopped: Node[];
  /** 任务单上的交付物改由谁交付：交付物名 → 节点 key */
  deliverables: Record<string, string>;
}

/** 工作流引擎给规划模块用的几件事：在事务里做决定、找出能跑的节点开跑、把中途调整落到工作流上 */
export interface Engine {
  transact(
    taskId: string,
    fn: (snapshot: Snapshot, w: Writer, fx: Effects) => Promise<void>,
  ): Promise<void>;
  schedule(snapshot: Snapshot, w: Writer, fx: Effects): Promise<void>;
  /** deliver：要马上送进正在做的 AI 会话里的说明，事务提交后再发 */
  applyAdjust(
    snapshot: Snapshot,
    w: Writer,
    fx: Effects,
    adjustment: Adjustment,
    deliver: { runId: string; text: string }[],
  ): Promise<void>;
}
