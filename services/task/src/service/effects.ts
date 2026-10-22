// 事务里做决定、事务外执行的副作用，以及工作流引擎给规划模块用的接口。
import type { NodeRun, Snapshot, Task, Writer } from '../repo/task-store.ts';

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
}

export const noEffects = (): Effects => ({
  submit: [],
  plan: [],
  gate: [],
  accept: [],
  stop: [],
  cancel: [],
});

/** 工作流引擎给规划模块用的两件事：在事务里做决定，以及找出能跑的节点开跑 */
export interface Engine {
  transact(
    taskId: string,
    fn: (snapshot: Snapshot, w: Writer, fx: Effects) => Promise<void>,
  ): Promise<void>;
  schedule(snapshot: Snapshot, w: Writer, fx: Effects): Promise<void>;
}
