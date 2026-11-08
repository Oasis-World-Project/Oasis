// 工作流方案（ADR 0004、0023、0025）：节点名、要交出的文件、关卡、三种节点（干活、讨论、工具）和连线。
// 规划员写、规划门查、task 按它建节点；从 task.ts 拆出来，task.ts 原样再导出。
import { z } from 'zod';
import { ToolSteps } from './tool-step.ts';

/** 节点名：方案里引用它，也用作下游沙箱里的目录名 in/<节点名>/ */
export const NodeKey = z
  .string()
  .regex(/^[\p{L}\p{N}_-]{1,40}$/u, '节点名只能用字母、数字、下划线和短横线，最长 40 个字符');

/** 应有的产出文件：out/ 下的相对路径，可以用 * 匹配一段里的任意字符（如 *.md） */
export const OutputPattern = z
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
      minCount: z.number().int().min(1).optional(),
      exactCount: z.number().int().min(1).optional(),
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
    text: z.string().trim().min(1),
    requirementIds: z.array(z.string().max(60)).default([]),
    files: z.array(OutputPattern).default([]),
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
  sources: z.array(RequirementSource).min(1),
});

/** 两种节点共有的部分 */
export const NodeCommon = {
  key: NodeKey,
  /** 给用户看的名字，如「写文案」 */
  title: z.string().trim().min(1).max(60),
  /** 角色说明（可选），如「资深文案」 */
  role: z.string().max(2000).default(''),
  /** 这个节点要做的事（讨论节点就是讨论的题目） */
  goal: z.string().trim().min(1).max(20_000),
  /** 交付前的自查清单（普通话）：写进节点的说明，由节点自己对照，关卡不逐条打分（ADR 0017） */
  checks: z.array(TaskCheck).default([]),
  /** 关卡的规则检查：这些文件必须在 out/ 里且不是空的 */
  expects: z.array(ExpectedFile).default([]),
  /** 规划明确依赖的本地执行能力，由运行环境目录核对。 */
  requires: z.array(z.string().min(1).max(100)).optional(),
  /** 显式选择最终交付文件；缺省保留历史任务行为。 */
  deliver: z.array(OutputPattern).optional(),
};

/** 节点要用的外部工具（ADR 0006 §5）：工具名和预计用几次（用来估算花费，不是硬上限） */
export const NodeTool = z.object({
  key: z.string().regex(/^[a-z0-9]+(\.[a-z0-9_-]+)+$/, '工具名形如 image.generate'),
  /** 批量工具按输入行计数，其余工具按目录单位计数（视频按秒）。 */
  uses: z.number().int().min(1).default(1),
  /** 打算用的型号（ADR 0016：按预算选）；不填按工具目录的默认型号估价 */
  model: z.string().min(1).max(200).optional(),
});
export type NodeTool = z.infer<typeof NodeTool>;
export const NodeTools = z.array(NodeTool);

/**
 * 做 N 版挑 1 版（ADR 0026）：同一个节点同时做 n 版，都做完后按 pick 挑一版交给下游，落选的留着，
 * 用户可以改用另一版。生图、关键帧这类看运气的步骤用。
 */
export const Variants = z.object({
  n: z.number().int().min(2).max(4),
  /** 按什么挑（普通话），如「构图最接近分镜描述、人物没有畸变」 */
  pick: z.string().trim().min(1).max(500),
});
export type Variants = z.infer<typeof Variants>;

/** 干活节点：一个 agent 完成一件事 */
export const WorkPlanNode = z.object({
  ...NodeCommon,
  kind: z.literal('work'),
  /** 供应商型号，如 deepseek/deepseek-v4.1-flash */
  model: z.string().min(1).max(200),
  /** 生图、联网搜索之类的外部工具；节点说明里只列这些 */
  tools: NodeTools.default([]),
  variants: Variants.optional(),
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
  participants: z.array(Participant).min(2),
  rounds: z.number().int().min(1).default(2),
  /** 汇总者用的型号 */
  model: z.string().min(1).max(200),
});

/**
 * 工具节点（ADR 0025）：不带 AI，在沙箱里按顺序执行写好的工具步骤（外部工具或本地操作 op.*），
 * 适合参数都能事先写死的机械步骤；每步失败自动重试 2 次。
 */
export const ToolPlanNode = z.object({
  ...NodeCommon,
  kind: z.literal('tool'),
  /** 工具节点不用 AI，不写模型；工具自己的型号写在步骤参数 model 里 */
  model: z.string().max(200).default(''),
  steps: ToolSteps,
  variants: Variants.optional(),
});

/** 一个展开节点最多展开几条（ADR 0026） */
export const FOREACH_MAX = 24;

const branchTitle = { title: z.string().trim().min(1).max(60).optional() };
/**
 * 展开的每一条做什么：一个干活节点或工具节点，不写 key（title 可以不写，用展开节点的）。
 * 字符串里的 {{index}} 换成两位数的条目号（01、02……，和下游目录名一致），{{item}} 换成这一条，
 * {{item.字段}} 换成这一条的某个字段。可以加 variants：每一条做几版挑一版。
 */
export const ForeachBranch = z.discriminatedUnion('kind', [
  WorkPlanNode.omit({ key: true }).extend(branchTitle),
  ToolPlanNode.omit({ key: true }).extend(branchTitle),
]);
export type ForeachBranch = z.infer<typeof ForeachBranch>;

/**
 * 动态展开（ADR 0026）：上游交出一份 JSON 清单（如 shots.json），有几条就开几个分支，每条一个节点，
 * 同时跑；下游拿到每条的产出 in/<key>/01/…、02/…，和一份按顺序排好的 in/<key>/index.json。
 * 条数要等上游定的时候用（按分镜逐个出镜头、按大纲逐章写）。
 */
export const ForeachPlanNode = z.object({
  ...NodeCommon,
  kind: z.literal('foreach'),
  /** 展开节点自己不用 AI，不写模型 */
  model: z.string().max(200).default(''),
  /** 清单：上游交来的 JSON 数组，写成 in/<上游 key>/<文件>.json */
  over: z
    .string()
    .regex(
      /^in\/[\p{L}\p{N}_-]{1,40}\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0\r\n*]{1,200}\.json$/u,
      'over 写上游交来的 JSON 清单的路径：in/<上游 key>/<文件>.json',
    ),
  /** 预计几条（估价用；实际按清单） */
  count: z.number().int().min(1).max(FOREACH_MAX),
  each: ForeachBranch,
});

/** 方案里的节点；用户新建节点也用它（节点名在任务里不能重复，新建的节点不会自动开跑） */
export const PlanNode = z.discriminatedUnion('kind', [
  WorkPlanNode,
  DiscussionPlanNode,
  ToolPlanNode,
  ForeachPlanNode,
]);
export type PlanNode = z.infer<typeof PlanNode>;

/** 连线：from 的产出交给 to */
export const PlanEdge = z.object({ from: NodeKey, to: NodeKey });

export const WorkflowPlan = z.object({
  nodes: z.array(PlanNode).min(1),
  edges: z.array(PlanEdge).default([]),
});
export type WorkflowPlan = z.infer<typeof WorkflowPlan>;
