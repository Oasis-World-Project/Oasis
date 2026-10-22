// task 的接口：提交工作流方案（内部），查看任务、取消、追问节点（对外，经 gateway 的 /api/task/v1/*）。
// 设计见 ADR 0004。
import { z } from 'zod';
import { RunOutputFile } from './harness.ts';

/** 节点名：方案里引用它，也用作下游沙箱里的目录名 in/<节点名>/ */
export const NodeKey = z
  .string()
  .regex(/^[\p{L}\p{N}_-]{1,40}$/u, '节点名只能用字母、数字、下划线和短横线，最长 40 个字符');

export const PlanNode = z.object({
  key: NodeKey,
  /** 给用户看的名字，如「写文案」 */
  title: z.string().trim().min(1).max(60),
  kind: z.literal('work'),
  /** 角色说明（可选），如「资深文案」 */
  role: z.string().max(2000).default(''),
  /** 这个节点要做的事 */
  goal: z.string().trim().min(1).max(20_000),
  /** 供应商型号，如 deepseek/deepseek-v4.1-flash */
  model: z.string().min(1).max(200),
});
export type PlanNode = z.infer<typeof PlanNode>;

/** 连线：from 的产出交给 to */
export const PlanEdge = z.object({ from: NodeKey, to: NodeKey });

export const WorkflowPlan = z.object({
  nodes: z.array(PlanNode).min(1).max(50),
  edges: z.array(PlanEdge).max(200).default([]),
});
export type WorkflowPlan = z.infer<typeof WorkflowPlan>;

/** POST /internal/tasks：提交任务和工作流方案（5.3 的规划、测试用），校验后立即开跑 */
export const CreateTaskBody = z.object({
  ownerId: z.uuid(),
  payerId: z.uuid(),
  conversationId: z.uuid().optional(),
  title: z.string().trim().min(1).max(100),
  /** 任务单摘要，交给每个节点 */
  brief: z.string().trim().min(1).max(20_000),
  plan: WorkflowPlan,
  /** 预估花费（微美元）；有它才做「超过 3 倍暂停」检查 */
  estimateMicro: z.number().int().nonnegative().optional(),
});
export type CreateTaskBody = z.input<typeof CreateTaskBody>;
/** 校验后（默认值已补上）的提交内容 */
export type CreateTaskInput = z.infer<typeof CreateTaskBody>;

export const TaskStatus = z.enum([
  'running',
  'stopped',
  /** 需要用户处理：节点重做超过上限、工作流断开、花费超过上限 */
  'needs_attention',
  'succeeded',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const NodeStatus = z.enum([
  'waiting',
  'running',
  /** 过关卡中（5.2b） */
  'checking',
  'succeeded',
  'failed',
  /** 用户点了停止（5.2c） */
  'stopped',
  /** 有进来的连线是空的，不会自动开跑 */
  'blocked',
  'cancelled',
]);
export type NodeStatus = z.infer<typeof NodeStatus>;

export const Attention = z.object({
  reason: z.enum(['node_failed', 'workflow_broken', 'over_budget']),
  nodeId: z.uuid().nullable(),
  message: z.string(),
});
export type Attention = z.infer<typeof Attention>;

export const NodeBody = z.object({
  id: z.uuid(),
  key: z.string(),
  title: z.string(),
  kind: z.literal('work'),
  role: z.string(),
  goal: z.string(),
  model: z.string(),
  status: NodeStatus,
  /** 已经跑了几次（含重做） */
  attempts: z.number().int().nonnegative(),
  /** 用户在节点开跑前追加的要求 */
  userNotes: z.array(z.string()),
  /** 给用户看的提醒（如关卡没过） */
  warning: z.string().nullable(),
  /** AI 最后说的一句话 */
  summary: z.string().nullable(),
  outputs: z.array(RunOutputFile),
  spentMicro: z.number().int().nonnegative(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type NodeBody = z.infer<typeof NodeBody>;

/** 连线的任一端可以是空的（删了节点留下的断口） */
export const EdgeBody = z.object({
  id: z.uuid(),
  from: z.uuid().nullable(),
  to: z.uuid().nullable(),
});
export type EdgeBody = z.infer<typeof EdgeBody>;

export const TaskBody = z.object({
  id: z.uuid(),
  title: z.string(),
  brief: z.string(),
  status: TaskStatus,
  attention: Attention.nullable(),
  estimateMicro: z.number().int().nonnegative().nullable(),
  spentMicro: z.number().int().nonnegative(),
  nodes: z.array(NodeBody),
  edges: z.array(EdgeBody),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type TaskBody = z.infer<typeof TaskBody>;

export const TaskSummary = z.object({
  id: z.uuid(),
  title: z.string(),
  status: TaskStatus,
  nodesDone: z.number().int().nonnegative(),
  nodesTotal: z.number().int().nonnegative(),
  spentMicro: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

export const TaskList = z.object({ tasks: z.array(TaskSummary) });

/** 对节点追问 / 补充要求 */
export const NodeMessageBody = z.object({ text: z.string().trim().min(1).max(20_000) });
