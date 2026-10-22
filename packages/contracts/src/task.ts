// task 的接口：提交工作流方案（内部），查看任务、取消、追问节点（对外，经 gateway 的 /api/task/v1/*）。
// 设计见 ADR 0004。
import { z } from 'zod';
import { RunOutputFile } from './harness.ts';

/** 节点名：方案里引用它，也用作下游沙箱里的目录名 in/<节点名>/ */
export const NodeKey = z
  .string()
  .regex(/^[\p{L}\p{N}_-]{1,40}$/u, '节点名只能用字母、数字、下划线和短横线，最长 40 个字符');

/** 应有的产出文件：out/ 下的相对路径，可以用 * 匹配一段里的任意字符（如 *.md） */
const ExpectedFile = z
  .string()
  .regex(/^(?!\/)(?!.*\.\.)[^\n]{1,200}$/, '必须是 out/ 下的相对路径，不能有 ..');

/** 两种节点共有的部分 */
const NodeCommon = {
  key: NodeKey,
  /** 给用户看的名字，如「写文案」 */
  title: z.string().trim().min(1).max(60),
  /** 角色说明（可选），如「资深文案」 */
  role: z.string().max(2000).default(''),
  /** 这个节点要做的事（讨论节点就是讨论的题目） */
  goal: z.string().trim().min(1).max(20_000),
  /** 关卡的验收点（普通话，最多 5 条）：交出产出前由 Jev 逐条判断 */
  checks: z.array(z.string().trim().min(1).max(300)).max(5).default([]),
  /** 关卡的规则检查：这些文件必须在 out/ 里且不是空的 */
  expects: z.array(ExpectedFile).max(10).default([]),
};

/** 干活节点：一个 agent 完成一件事 */
export const WorkPlanNode = z.object({
  ...NodeCommon,
  kind: z.literal('work'),
  /** 供应商型号，如 deepseek/deepseek-v4.1-flash */
  model: z.string().min(1).max(200),
});

export const Participant = z.object({
  /** 参与者的名字，讨论记录里用 */
  name: z.string().trim().min(1).max(30),
  model: z.string().min(1).max(200),
  /** 立场或视角，如「从预算角度挑毛病」 */
  stance: z.string().max(1000).default(''),
});

/** 讨论节点：几个参与者来回几轮，最后由汇总者写出结论 */
export const DiscussionPlanNode = z.object({
  ...NodeCommon,
  kind: z.literal('discussion'),
  participants: z.array(Participant).min(2).max(5),
  rounds: z.number().int().min(1).max(5).default(2),
  /** 汇总者用的型号 */
  model: z.string().min(1).max(200),
});

export const PlanNode = z.discriminatedUnion('kind', [WorkPlanNode, DiscussionPlanNode]);
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
  kind: z.enum(['work', 'discussion']),
  role: z.string(),
  goal: z.string(),
  model: z.string(),
  checks: z.array(z.string()),
  expects: z.array(z.string()),
  /** 讨论节点的参与者、轮数和讨论记录；干活节点为 null */
  discussion: z
    .object({
      participants: z.array(Participant),
      rounds: z.number().int(),
      round: z.number().int(),
      transcript: z.array(
        z.object({ round: z.number().int(), name: z.string(), text: z.string() }),
      ),
    })
    .nullable(),
  status: NodeStatus,
  /** 已经跑了几次（含重做） */
  attempts: z.number().int().nonnegative(),
  /** 用户在节点开跑前追加的要求 */
  userNotes: z.array(z.string()),
  /** 关卡退回修改过几次（最多 1 次） */
  reworks: z.number().int().nonnegative(),
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
