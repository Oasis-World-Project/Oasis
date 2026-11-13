// task 的接口：提交任务单或工作流方案（内部）；查看、运行、停止、取消任务，给一样成果发话、停止和继续它（对外，经 gateway 的 /api/task/v1/*）。
import { z } from 'zod';
import { Material } from './canvas.ts';
import { RunOutputFile } from './harness.ts';
import { ToolStep } from './tool-step.ts';
import {
  ExpectedFile,
  NodeCommon,
  OutputPattern,
  Participant,
  TaskRequirement,
  WorkflowPlan,
} from './workflow-plan.ts';

export * from './workflow-edit.ts';
export * from './workflow-plan.ts';

/**
 * 任务单：私聊里的 AI 问完需求后给出，用户确认后交给规划员，也会交给每个节点。
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
    .min(1),
  /** 怎么算做好（普通话） */
  criteria: z.array(z.string().trim().min(1).max(200)).min(1),
  /** 风格与限制 */
  style: z.array(z.string().trim().min(1).max(200)).default([]),
  /** AI 自己定的事（技术假设），让用户知道，不用确认 */
  assumptions: z.array(z.string().trim().min(1).max(200)).default([]),
  /** 用户给的素材（文件名） */
  materials: z.array(z.string().max(300)).default([]),
  /** 有来源的有效用户要求；缺省为历史任务，不能补造来源。 */
  requirements: z.array(TaskRequirement).optional(),
  /** 仅说明素材读取覆盖，不表示已理解图片/视频内容。 */
  materialWarnings: z.array(z.string().max(500)).optional(),
});
export type TaskSheet = z.infer<typeof TaskSheet>;

/**
 * POST /internal/tasks：建任务。两种方式，只能选一种：
 * - sheet：用户确认的任务单（私聊接需求），由规划员排出工作流再开跑；
 * - plan：直接给出工作流方案，校验后立即开跑（测试和联调用）。
 */
export const CreateTaskBody = z
  .object({
    /**
     * 调用方事先定好的任务 ID：同一个 ID 再提交一次直接返回已经建好的任务，
     * 确认任务单超时后重试不会建出第二个。
     */
    id: z.uuid().optional(),
    ownerId: z.uuid(),
    payerId: z.uuid(),
    conversationId: z.uuid().optional(),
    title: z.string().trim().min(1).max(100),
    /** 任务说明，交给规划员和每个节点 */
    brief: z.string().trim().min(1).max(20_000),
    sheet: TaskSheet.optional(),
    plan: WorkflowPlan.optional(),
    /** 用户给的素材（存在 canvas）：规划员和每个节点都能在沙箱的 materials/ 下看到 */
    materials: z.array(Material).default([]),
  })
  .refine((body) => Number(Boolean(body.sheet)) + Number(Boolean(body.plan)) === 1, {
    message: '要么给出任务单，要么给出工作流方案',
  });
export type CreateTaskBody = z.input<typeof CreateTaskBody>;

/** 修改时带上的一条批注：在哪个文件、哪里、什么意见，见哪张标注截图 */
export const RevisionNote = z.object({
  file: z.string().trim().min(1).max(200),
  number: z.number().int().min(1).max(99),
  /** 给人看的位置，如「第 2 页」「0:12」「画面左上」 */
  where: z.string().trim().max(120).default(''),
  note: z.string().trim().min(1).max(500),
  quote: z.string().trim().max(300).optional(),
  /** 随修改上传的标注截图的文件名 */
  snapshot: z.string().trim().max(200).optional(),
});
export type RevisionNote = z.infer<typeof RevisionNote>;

/** 参数面板里改的一项成品参数，如「字幕字号：大」 */
export const RevisionParameter = z.object({
  file: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(40),
  value: z.string().trim().min(1).max(200),
});
export type RevisionParameter = z.infer<typeof RevisionParameter>;

/**
 * 修改成果（2026-11-05 起直接交给 AI 团队）：在原任务里接着改，交付节点带着修改意见
 * 接着原会话改、下游跟着更新；附件（参考图、标注截图）并进任务素材。不经过任何私聊，
 * 私聊删了也照样能改。只有已结束的任务能改。
 */
export const TaskRevisionBody = z
  .object({
    /** 修改意见；带了批注或参数时可以不写 */
    request: z.string().trim().max(8000).default(''),
    annotations: z.array(RevisionNote).max(100).default([]),
    parameters: z.array(RevisionParameter).max(40).default([]),
    /** 先传到 canvas 的文件 id（参考图、标注截图）；和任务素材同一个上限 */
    attachments: z.array(z.uuid()).max(20).default([]),
    /**
     * 意见针对的成果是哪些节点交出的（批注所在成果、当前打开的成果）。
     * 只让这些交付节点接着改；没给或都不是交付节点时，只改最下游的交付节点。
     */
    nodeIds: z.array(z.uuid()).max(50).default([]),
  })
  .refine(
    (body) => body.request.length > 0 || body.annotations.length > 0 || body.parameters.length > 0,
    { message: '写下修改意见，或者带上批注、参数' },
  );
export type TaskRevisionBody = z.input<typeof TaskRevisionBody>;
/** 校验后（默认值已补上）的提交内容 */
export type CreateTaskInput = z.infer<typeof CreateTaskBody>;

export const TaskStatus = z.enum([
  /** 规划员正在按任务单排工作流 */
  'planning',
  'running',
  /** 工作流跑完了，正在对照任务单整体验收 */
  'accepting',
  'stopped',
  /** 需要用户处理：节点重做超过上限、工作流断开、没排出方案、修改方案等确认 */
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
  'cancelled',
]);
export type NodeStatus = z.infer<typeof NodeStatus>;

export const Attention = z.object({
  /** node_failed 节点重做用完还失败；workflow_broken 上游没完成、走不下去了；plan_failed 规划员没排出合格的方案 */
  reason: z.enum([
    'node_failed',
    'workflow_broken',
    'plan_failed',
    /** 修改方案排好了，等用户确认 */
    'revision_plan',
  ]),
  nodeId: z.uuid().nullable(),
  message: z.string(),
});
export type Attention = z.infer<typeof Attention>;

export const NodeBody = z.object({
  id: z.uuid(),
  key: z.string(),
  title: z.string(),
  kind: z.enum(['work', 'discussion', 'tool', 'foreach']),
  /**
   * 子节点：展开出来的一条、或做几版里的一版，属于哪个节点、第几条 / 第几版；
   * 工作流图里的节点为 null（旧版 task 不返回时当作 null）
   */
  parentId: z.uuid().nullable().optional(),
  slot: z.number().int().positive().nullable().optional(),
  /** 展开节点：按哪份清单、预计几条、实际几条（还没展开为 null）、每条做什么 */
  foreach: z
    .object({
      over: z.string(),
      count: z.number().int(),
      items: z.number().int().nullable(),
      each: z.object({ kind: z.enum(['work', 'tool']), title: z.string() }),
    })
    .nullable()
    .optional(),
  /** 做几版挑一版：几版、按什么挑、选了第几版和理由（还没挑为 null） */
  variants: z
    .object({
      n: z.number().int(),
      pick: z.string(),
      chosen: z.number().int().nullable(),
      reason: z.string().nullable(),
    })
    .nullable()
    .optional(),
  role: z.string(),
  goal: z.string(),
  /** 用的模型；工具节点不用模型，为空字符串 */
  model: z.string(),
  expects: z.array(ExpectedFile),
  requires: NodeCommon.requires,
  deliver: z.array(OutputPattern).optional(),
  /** 属于哪条生产线（画布把同一条生产线的节点框在一起）；一个 AI 做的成果为 null */
  line: z.object({ key: z.string(), title: z.string() }).nullable().default(null),
  /**
   * 中途调整：这样成果提出了调整（asking：规划员还在答复，note 是它要什么），
   * 或被调整过（note 是改了什么）；没有为 null
   */
  adjust: z.object({ asking: z.boolean(), note: z.string() }).nullable().default(null),
  /** 工具节点要执行的步骤；其他节点为 null */
  steps: z.array(ToolStep).nullable().default(null),
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
  /** 用户追加的要求 */
  userNotes: z.array(z.string()),
  /** 关卡退回修改过几次（观测指标，不是限额） */
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

/** 一版工作流的概况 */
export const WorkflowVersionMeta = z.object({
  version: z.number().int().positive(),
  /** 这一版是按哪条修改意见做出来的；第 1 版为 null */
  request: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** 被下一版取代、冻结的时间：节点运行记录只显示这之前的 */
  frozenAt: z.iso.datetime(),
});
export type WorkflowVersionMeta = z.infer<typeof WorkflowVersionMeta>;

/** 修改方案里一个节点怎么处理 */
export const RevisionChange = z.enum(['reuse', 'continue', 'fresh', 'new', 'remove']);
export type RevisionChange = z.infer<typeof RevisionChange>;

/** 进行中的修改：规划员在排方案，或方案排好了等用户确认 */
export const PendingRevision = z.object({
  /** 确认后会成为第几版 */
  version: z.number().int().positive(),
  stage: z.enum(['planning', 'confirm']),
  request: z.string(),
  /** 规划员给用户的一两句说明 */
  summary: z.string().nullable(),
  changes: z.array(z.object({ key: z.string(), title: z.string(), change: RevisionChange })),
});
export type PendingRevision = z.infer<typeof PendingRevision>;

export const TaskBody = z.object({
  id: z.uuid(),
  title: z.string(),
  brief: z.string(),
  status: TaskStatus,
  attention: Attention.nullable(),
  /** 已经花了多少（只显示；没有预算、预估和上限） */
  spentMicro: z.number().int().nonnegative(),
  /** 用户确认的任务单（直接给方案建的任务没有） */
  sheet: TaskSheet.nullable(),
  /**
   * 整体验收结果（只核对交付文件齐不齐）：unmet 是补过一次仍缺的文件，unchecked 是没检查到的；
   * 都只是提醒，照样交付。还没验收时为 null。
   */
  acceptance: z
    .object({
      unmet: z.array(z.string()),
      unchecked: z.array(z.string()).optional(),
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
  /** 每样交付物由哪个节点交出（规划员定） */
  deliverables: z.array(
    z.object({ name: z.string(), form: z.string(), nodeId: z.uuid().nullable() }),
  ),
  nodes: z.array(NodeBody),
  edges: z.array(EdgeBody),
  /** 当前是第几版工作流；旧版 task 不返回时当作第 1 版 */
  version: z.number().int().positive().default(1),
  /** 冻结的旧版工作流（只读查看） */
  versions: z.array(WorkflowVersionMeta).default([]),
  /** 进行中的修改：规划中、待确认；没有时为 null */
  revision: PendingRevision.nullable().default(null),
  /** 修改中：在排修改方案、等确认，或新版还没做完（含中途停下） */
  revising: z.boolean().default(false),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type TaskBody = z.infer<typeof TaskBody>;

/** 冻结的一版工作流：节点和连线照冻结时的样子，只读 */
export const WorkflowVersionBody = WorkflowVersionMeta.extend({
  nodes: z.array(NodeBody),
  edges: z.array(EdgeBody),
  spentMicro: z.number().int().nonnegative(),
});
export type WorkflowVersionBody = z.infer<typeof WorkflowVersionBody>;

export const TaskSummary = z.object({
  id: z.uuid(),
  title: z.string(),
  status: TaskStatus,
  nodesDone: z.number().int().nonnegative(),
  nodesTotal: z.number().int().nonnegative(),
  spentMicro: z.number().int().nonnegative(),
  /** 修改中（在原任务里改） */
  revising: z.boolean().default(false),
  createdAt: z.iso.datetime(),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

export const TaskList = z.object({ tasks: z.array(TaskSummary) });

/**
 * 节点的一次运行：节点详情里按时间列出，点开看这次的运行过程。
 * work 第一次做或失败后重做；rework 关卡没过后接着原会话改；speech 讨论里一位参与者的一次发言；summary 汇总；
 * pick 做几版挑一版时挑选的那次。停止后继续也是一次新运行（接着原会话）。
 */
export const NodeRunBody = z.object({
  id: z.uuid(),
  /** adjust：这样成果的 AI 提出了调整，规划员答复的那次 */
  purpose: z.enum(['work', 'rework', 'speech', 'summary', 'pick', 'adjust']),
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
