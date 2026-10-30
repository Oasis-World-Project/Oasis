// task 的接口：提交工作流方案（内部）；查看、运行、停止、取消任务，编辑节点和连线，追问节点（对外，经 gateway 的 /api/task/v1/*）。
// 设计见 ADR 0004。
import { z } from 'zod';
import { Material } from './canvas.ts';
import { RunOutputFile } from './harness.ts';

/** 节点名：方案里引用它，也用作下游沙箱里的目录名 in/<节点名>/ */
export const NodeKey = z
  .string()
  .regex(/^[\p{L}\p{N}_-]{1,40}$/u, '节点名只能用字母、数字、下划线和短横线，最长 40 个字符');

/** 一个任务最多带几个素材 */
export const MAX_MATERIALS = 20;

/** 应有的产出文件：out/ 下的相对路径，可以用 * 匹配一段里的任意字符（如 *.md） */
const OutputPattern = z
  .string()
  .regex(
    /^(?!\/)(?!.*\.\.)(?!.*[\\:\r\n])[^\n]{1,200}$/,
    '必须是 out/ 下的相对路径，不能有 ..、反斜线或冒号',
  );
export const ExpectedFile = z.union([
  OutputPattern,
  z
    .object({
      pattern: OutputPattern,
      minCount: z.number().int().min(1).max(1000).optional(),
      exactCount: z.number().int().min(1).max(1000).optional(),
      width: z.number().int().min(1).max(30000).optional(),
      height: z.number().int().min(1).max(30000).optional(),
    })
    .refine(
      (r) => r.minCount === undefined || r.exactCount === undefined,
      'minCount 与 exactCount 不能同时设置',
    ),
]);
export type ExpectedFile = z.infer<typeof ExpectedFile>;

/** 新检查显式声明所需文件；旧字符串仍可读取。文件模式仅指本节点/最终清单。 */
export const TaskCheck = z.union([
  z.string().trim().min(1).max(300),
  z.object({
    id: z.string().regex(/^[\w-]{1,60}$/),
    text: z.string().trim().min(1).max(300),
    requirementIds: z.array(z.string().max(60)).max(32).default([]),
    files: z.array(OutputPattern).max(20).default([]),
  }),
]);
export type TaskCheck = z.infer<typeof TaskCheck>;

export const RequirementSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('request'), quote: z.string().min(1).max(2000) }),
  z.object({
    kind: z.literal('user'),
    turn: z.number().int().nonnegative(),
    quote: z.string().min(1).max(2000),
  }),
  z.object({
    kind: z.literal('answer'),
    round: z.number().int().positive(),
    questionId: z.string().max(60),
    optionId: z.string().max(1000),
    quote: z.string().min(1).max(2000),
  }),
  z.object({
    kind: z.literal('material'),
    uploadId: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    quote: z.string().min(1).max(2000),
  }),
  /** 修改成果时用户写的修改意见（ADR 0012 §3） */
  z.object({ kind: z.literal('revision'), quote: z.string().min(1).max(2000) }),
]);
export const TaskRequirement = z.object({
  id: z.string().regex(/^[\w-]{1,60}$/),
  text: z.string().trim().min(1).max(1000),
  sources: z.array(RequirementSource).min(1).max(8),
});
export const CheckResult = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(['passed', 'unmet', 'unchecked']),
  reason: z.string(),
  evidence: z.array(z.string()),
});
export type CheckResult = z.infer<typeof CheckResult>;

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
  checks: z.array(TaskCheck).max(5).default([]),
  /** 关卡的规则检查：这些文件必须在 out/ 里且不是空的 */
  expects: z.array(ExpectedFile).max(10).default([]),
  /** 显式选择最终交付文件；缺省保留历史任务行为。 */
  deliver: z.array(OutputPattern).max(20).optional(),
};

/** 节点要用的外部工具（ADR 0006 §5）：工具名和预计用几次（用来估算花费，不是硬上限） */
export const NodeTool = z.object({
  key: z.string().regex(/^[a-z0-9]+(\.[a-z0-9_-]+)+$/, '工具名形如 image.generate'),
  /** 批量工具按输入行计数，其余工具按目录单位计数。 */
  uses: z.number().int().min(1).max(1000).default(1),
});
export type NodeTool = z.infer<typeof NodeTool>;
const NodeTools = z.array(NodeTool).max(6);

/** 干活节点：一个 agent 完成一件事 */
export const WorkPlanNode = z.object({
  ...NodeCommon,
  kind: z.literal('work'),
  /** 供应商型号，如 deepseek/deepseek-v4.1-flash */
  model: z.string().min(1).max(200),
  /** 生图、联网搜索之类的外部工具；节点说明里只列这些 */
  tools: NodeTools.default([]),
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

/** 方案里的节点；用户新建节点也用它（节点名在任务里不能重复，新建的节点不会自动开跑） */
export const PlanNode = z.discriminatedUnion('kind', [WorkPlanNode, DiscussionPlanNode]);
export type PlanNode = z.infer<typeof PlanNode>;

/** 连线：from 的产出交给 to */
export const PlanEdge = z.object({ from: NodeKey, to: NodeKey });

export const WorkflowPlan = z.object({
  nodes: z.array(PlanNode).min(1).max(50),
  edges: z.array(PlanEdge).max(200).default([]),
});
export type WorkflowPlan = z.infer<typeof WorkflowPlan>;

/**
 * 任务单（ADR 0005 §3）：私聊里的 AI 问完需求后给出，用户确认后交给规划员，也会交给每个节点。
 * 「怎么算做好」会变成节点关卡和整体验收的验收点。
 */
export const TaskSheet = z.object({
  title: z.string().trim().min(1).max(60),
  /** 要交付的东西：名称和形式，如「首页文案」「Markdown」 */
  deliverables: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        form: z.string().trim().min(1).max(60),
      }),
    )
    .min(1)
    .max(10),
  /** 怎么算做好（普通话） */
  criteria: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
  /** 风格与限制 */
  style: z.array(z.string().trim().min(1).max(200)).max(8).default([]),
  /** 用户自己设的花费上限（微美元）；没设为 null */
  budgetMicro: z.number().int().positive().nullable().default(null),
  /** AI 自己定的事（技术假设），让用户知道，不用确认 */
  assumptions: z.array(z.string().trim().min(1).max(200)).max(8).default([]),
  /** 用户给的素材（文件名） */
  materials: z.array(z.string().max(300)).max(50).default([]),
  /** 有来源的有效用户要求；缺省为历史任务，不能补造来源。 */
  requirements: z.array(TaskRequirement).max(32).optional(),
  /** 仅说明素材读取覆盖，不表示已理解图片/视频内容。 */
  materialWarnings: z.array(z.string().max(500)).max(20).optional(),
});
export type TaskSheet = z.infer<typeof TaskSheet>;

/**
 * POST /internal/tasks：建任务。两种方式，只能选一种：
 * - sheet：用户确认的任务单（私聊接需求），由规划员排出工作流再开跑（ADR 0005）；
 * - plan：直接给出工作流方案，校验后立即开跑（测试和联调用）。
 */
export const CreateTaskBody = z
  .object({
    ownerId: z.uuid(),
    payerId: z.uuid(),
    conversationId: z.uuid().optional(),
    title: z.string().trim().min(1).max(100),
    /** 任务说明，交给规划员和每个节点 */
    brief: z.string().trim().min(1).max(20_000),
    sheet: TaskSheet.optional(),
    plan: WorkflowPlan.optional(),
    /** 预估花费（微美元）；有它才做「超过 3 倍暂停」检查。给任务单时由 task 自己算 */
    estimateMicro: z.number().int().nonnegative().optional(),
    /** 用户给的素材（存在 canvas）：规划员和每个节点都能在沙箱的 materials/ 下看到 */
    materials: z.array(Material).max(MAX_MATERIALS).default([]),
    /** 修改成果：这是哪个任务的新版（ADR 0012）。新版交付后整体替换上一版 */
    revisionOf: z.uuid().optional(),
  })
  .refine((body) => Number(Boolean(body.sheet)) + Number(Boolean(body.plan)) === 1, {
    message: '要么给出任务单，要么给出工作流方案',
  });
export type CreateTaskBody = z.input<typeof CreateTaskBody>;
/** 校验后（默认值已补上）的提交内容 */
export type CreateTaskInput = z.infer<typeof CreateTaskBody>;

export const TaskStatus = z.enum([
  /** 规划员正在按任务单排工作流（ADR 0005 §4） */
  'planning',
  'running',
  /** 工作流跑完了，正在对照任务单整体验收（ADR 0005 §5） */
  'accepting',
  'stopped',
  /** 需要用户处理：节点重做超过上限、工作流断开、花费超过上限 */
  'needs_attention',
  'succeeded',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const NodeStatus = z.enum([
  /** 用户新建的节点：不会自动开跑，点「运行」（整体或单个）后才加入 */
  'draft',
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
  /**
   * node_failed 节点重做用完还失败；workflow_broken 连线断开；over_budget 花费超过上限；
   * plan_failed 规划员没排出合格的方案；over_estimate 预估超过了用户在任务单里设的上限
   */
  reason: z.enum(['node_failed', 'workflow_broken', 'over_budget', 'plan_failed', 'over_estimate']),
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
  checks: z.array(TaskCheck),
  gateChecks: z.array(CheckResult).optional(),
  expects: z.array(ExpectedFile),
  deliver: z.array(OutputPattern).optional(),
  /** 要用的外部工具（讨论节点没有；旧版 task 不返回时当作没有） */
  tools: z.array(NodeTool).default([]),
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
  /** 花到这么多就暂停问用户（预估的 3 倍；用户选择继续后再加 3 倍预估）；没有预估时为 null */
  budgetLimitMicro: z.number().int().nonnegative().nullable(),
  /** 用户确认的任务单（直接给方案建的任务没有） */
  sheet: TaskSheet.nullable(),
  /** 整体验收的结果：没满足的地方（没满足也照样交付）；还没验收时为 null */
  acceptance: z
    .object({
      unmet: z.array(z.string()),
      unchecked: z.array(z.string()).optional(),
      checks: z.array(CheckResult).optional(),
    })
    .nullable(),
  /** task 生成的统一清单；缺省表示旧任务，空数组不能回退到所有产出。 */
  deliveryFiles: z
    .array(
      z.object({
        deliverable: z.string(),
        nodeId: z.uuid(),
        path: z.string(),
        size: z.number().int().nonnegative(),
        sha256: RunOutputFile.shape.sha256,
        runId: z.uuid().optional(),
      }),
    )
    .optional(),
  /** 用户给的素材（旧版 task 不返回时当作没有） */
  materials: z.array(Material).default([]),
  /** 修改成果：这是哪个任务的新版（ADR 0012）；旧版 task 不返回时当作不是 */
  revisionOf: z.uuid().nullable().default(null),
  /** 每样交付物由哪个节点交出（规划员定） */
  deliverables: z.array(
    z.object({ name: z.string(), form: z.string(), nodeId: z.uuid().nullable() }),
  ),
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
  /** 修改成果：这是哪个任务的新版（前端据此知道某份成果正在修改） */
  revisionOf: z.uuid().nullable().default(null),
  createdAt: z.iso.datetime(),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

export const TaskList = z.object({ tasks: z.array(TaskSummary) });

/** 对节点追问 / 补充要求 */
export const NodeMessageBody = z.object({ text: z.string().trim().min(1).max(20_000) });

/** 修改还没开始的节点：只改给出的字段；类型不能改，参与者和轮数只对讨论节点有效，工具只对干活节点有效 */
export const UpdateNodeBody = z
  .object({
    title: NodeCommon.title,
    role: z.string().max(2000),
    goal: NodeCommon.goal,
    model: z.string().min(1).max(200),
    checks: z.array(TaskCheck).max(5),
    expects: z.array(ExpectedFile).max(10),
    deliver: z.array(OutputPattern).max(20),
    participants: z.array(Participant).min(2).max(5),
    rounds: z.number().int().min(1).max(5),
    tools: NodeTools,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, '至少要改一项');
export type UpdateNodeBody = z.infer<typeof UpdateNodeBody>;

/** 新建连线：from 的产出交给 to */
export const CreateEdgeBody = z.object({ from: z.uuid(), to: z.uuid() });

/** 接上线头 / 改连线的一端 */
export const UpdateEdgeBody = z
  .object({ from: z.uuid(), to: z.uuid() })
  .partial()
  .refine((body) => body.from !== undefined || body.to !== undefined, '要给出起点或终点');
export type UpdateEdgeBody = z.infer<typeof UpdateEdgeBody>;

/**
 * 任务「需要处理」时用户的选择：
 * - continue：用现在的结果继续往下做（节点失败时跳过它；花费超限时提高上限接着做）
 * - retry：让失败的节点再试（重做次数重新算）
 * - cancel：取消任务
 */
export const DecisionBody = z.object({ choice: z.enum(['continue', 'retry', 'cancel']) });
export type DecisionBody = z.infer<typeof DecisionBody>;

/**
 * 节点的一次运行（ADR 0007 §6）：节点详情里按时间列出，点开看这次的运行过程。
 * work 第一次做或失败后重做；rework 关卡没过后接着原会话改；speech 讨论里一位参与者的一次发言；summary 汇总。
 * 停止后继续也是一次新运行（接着原会话）。
 */
export const NodeRunBody = z.object({
  id: z.uuid(),
  purpose: z.enum(['work', 'rework', 'speech', 'summary']),
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled', 'stopped']),
  /** 第几次（含重做） */
  attempt: z.number().int().nonnegative(),
  /** 讨论：第几轮、谁 */
  round: z.number().int().nullable(),
  participant: z.string().nullable(),
  /** 这次运行接着哪次运行的会话（停止后继续、关卡退回修改） */
  continued: z.boolean(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type NodeRunBody = z.infer<typeof NodeRunBody>;
export const NodeRunList = z.object({ runs: z.array(NodeRunBody) });

/** 编辑节点时能选的模型和工具（ADR 0007 §6）：和规划员看到的一样，只列现在能用的 */
export const WorkflowOptions = z.object({
  models: z.array(
    z.object({
      /** 模型目录里的 key，如 deepseek（前端用它找头像） */
      key: z.string(),
      name: z.string(),
      vendor: z.string(),
      /** 节点里写的供应商型号 */
      providerModel: z.string(),
    }),
  ),
  tools: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      description: z.string(),
      unit: z.string(),
      estimateMicro: z.number().int().nonnegative(),
    }),
  ),
});
export type WorkflowOptions = z.infer<typeof WorkflowOptions>;
