// model-gateway 的内部接口：OpenAI 兼容的 chat completions、Jev 决策、沙箱运行用的临时 Key。
// 只列出 Oasis 用到的字段，其余原样透传。
import { z } from 'zod';
import type { ToolArgSpec } from './tool-args.ts';

/** 工具的一个命令行参数（定义见 tool-args.ts） */
export const ToolArgSpecSchema: z.ZodType<ToolArgSpec> = z.object({
  name: z.string(),
  kind: z.enum(['text', 'number', 'flag', 'choice', 'path', 'paths', 'dir', 'list', 'json']),
  required: z.boolean().optional(),
  choices: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  description: z.string(),
});

/** assistant 消息里的一次工具调用（OpenAI 格式）。 */
export const ToolCall = z.looseObject({
  id: z.string(),
  type: z.literal('function'),
  function: z.looseObject({ name: z.string(), arguments: z.string() }),
});

/** 多段内容里的一段（文字、图片等），按 type 区分，其余字段原样透传。 */
const ContentPart = z.looseObject({ type: z.string() });

/**
 * 一条消息。私聊只用 system/user/assistant + 字符串内容；
 * agent 运行时还会有 assistant 的 tool_calls（content 可为 null）和 role: tool 的工具结果。
 */
export const ChatMessage = z.looseObject({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(ContentPart), z.null()]).optional(),
  tool_calls: z.array(ToolCall).optional(),
  tool_call_id: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

const OutputTokens = z.number().int().positive();

/** 供应商公布的执行能力；缺失的能力不能用通用适配器的猜测补齐。 */
export const ModelCapabilities = z.object({
  id: z.string(),
  name: z.string(),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  input: z.array(z.enum(['text', 'image'])).min(1),
  reasoning: z.boolean(),
  /**
   * 最近的实测：从 agent 运行里的聊天调用记录算——每秒输出多少 token、
   * 每百万 token 实际多少钱（输入输出合计，含缓存折扣，微美元）、上游出错的比例；调用太少时不给。
   */
  measured: z
    .object({
      calls: z.number().int().positive(),
      tokensPerSecond: z.number().int().nonnegative(),
      microPerMTok: z.number().int().nonnegative(),
      failureRate: z.number().min(0).max(1),
    })
    .optional(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilities>;
export const ExecutionModels = z.object({ models: z.array(ModelCapabilities) });

export const ChatCompletionRequest = z.looseObject({
  model: z.string().min(1),
  messages: z.array(ChatMessage).min(1),
  max_tokens: OutputTokens.optional(),
  /** 新版 OpenAI 字段，与 max_tokens 同义；agent 运行时用的是这个 */
  max_completion_tokens: OutputTokens.optional(),
  stream: z.boolean().optional(),
  report_cost: z.boolean().optional(),
  /** Oasis 派发预算：预计冻结超过此值时拒绝，不透传供应商。 */
  max_cost_micro: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequest>;

/**
 * Jev 等结构化决策模型（OpenRouter Decisions API）。
 * state 是要判断的材料（文字和图片），questions 是要回答的问题（choice / noul / score / box）。
 */
export const DecisionRequest = z.looseObject({
  model: z.string().min(1),
  state: z.union([z.string(), z.array(z.unknown())]),
  questions: z.record(z.string(), z.looseObject({ type: z.string() })),
});
export type DecisionRequest = z.infer<typeof DecisionRequest>;

/** POST /internal/run-keys：为对话里的一轮（一次 agent 运行）签发临时 Key。 */
export const CreateRunKeyBody = z.object({
  runId: z.uuid(),
  payerId: z.uuid(),
  /** 这一轮属于哪个对话：调用记录按它归属，删对话时按它清理工具的结果 */
  conversationId: z.uuid().optional(),
  /** 用户打开了「只用国内模型」：这一轮的工具只给国内厂商的型号 */
  domesticOnly: z.boolean().default(false),
  /** 用户设了花钱的工具「问我」：这一轮用生图、视频这类工具前先登记一张确认卡，等用户点 */
  askPaid: z.boolean().default(false),
  /** 用户关了这段对话的联网搜索：这一轮没有联网搜索、读网页这两个工具 */
  noWeb: z.boolean().default(false),
  /** 有效期，默认 6 小时，最长 7 天 */
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .max(7 * 24 * 3600)
    .default(6 * 3600),
});
export type CreateRunKeyBody = z.input<typeof CreateRunKeyBody>;

/** 明文 Key 只在签发时返回这一次；库里只存哈希。 */
export const RunKeyCreated = z.object({
  keyId: z.uuid(),
  key: z.string(),
  expiresAt: z.iso.datetime(),
});
export type RunKeyCreated = z.infer<typeof RunKeyCreated>;

// ---- 确认卡：一轮里要用户点的确认。AI 要做超出权限的事（command，dsh 插件登记），或要用花钱的工具
// （tool，用户设了「问我」时调工具登记）。用户在聊天里点允许一次 / 以后都允许 / 拒绝 ----

export const Confirmation = z.object({
  id: z.uuid(),
  kind: z.enum(['command', 'tool']),
  /** 给人看的：要做什么、为什么（命令的理由，或工具、型号和最多花多少） */
  text: z.string(),
  /** command：要放开的那一步的工具调用编号（进度里能对上是哪条命令） */
  callId: z.string().nullable(),
  /** used：花钱的工具确认允许后已经拿去调了（一张只能用一次） */
  status: z.enum(['pending', 'allowed', 'denied', 'cancelled', 'used']),
  createdAt: z.iso.datetime(),
});
export type Confirmation = z.infer<typeof Confirmation>;

/** 运行内登记（dsh 插件，凭这一轮的 Key）：AI 要做超出权限的事 */
export const AskConfirmationBody = z.object({
  text: z.string().trim().min(1).max(4000),
  callId: z.string().max(200).optional(),
});

/** 用户的回答：允许一次 / 以后都允许（这一轮里同类的不再问，私聊的设置也跟着改）/ 拒绝 */
export const ConfirmDecision = z.enum(['once', 'always', 'deny']);
export type ConfirmDecision = z.infer<typeof ConfirmDecision>;
export const DecideConfirmationBody = z.object({ runId: z.uuid(), decision: ConfirmDecision });

// ---- 算力：harness 开沙箱前冻结、结束后按实际时长结算，和模型、工具走同一套计量 ----

/** 开沙箱前冻结：按最长运行时间算 */
export const ComputeHoldBody = z.object({
  runId: z.uuid(),
  payerId: z.uuid(),
  /** 沙箱的 CPU 核数 */
  cores: z.number().positive().max(64),
  /** 最长运行多久（毫秒） */
  maxMs: z
    .number()
    .int()
    .positive()
    .max(24 * 3600_000),
  /**
   * 一轮的沙箱、检查用的隔离浏览器，或 inspector 解码音视频的检查容器（调用记录里分开标识；
   * 检查容器由调用方冻结和结算）
   */
  purpose: z.enum(['run', 'application-check', 'media-check']).default('run'),
});
export type ComputeHoldBody = z.infer<typeof ComputeHoldBody>;

/** 冻结的结果；算力单价为 0（不计费）时 callId 为 null，之后也不用结算 */
export const ComputeHold = z.object({
  callId: z.uuid().nullable(),
  heldMicro: z.number().int().nonnegative().default(0),
});

/** 沙箱销毁后按实际时长结算 */
export const ComputeSettleBody = z.object({
  cores: z.number().positive().max(64),
  elapsedMs: z.number().int().nonnegative(),
});
export const ComputeOutcome = z.object({
  status: z.enum(['running', 'succeeded', 'failed']),
  chargedMicro: z.number().int().nonnegative().nullable(),
});

// ---- 工具：生图、配音、转写、联网搜索、网页抓取、Jev 判断……都经 model-gateway 计量 ----

/** 一个型号用一次（一个计费单位）的典型花费和用时（从调用记录算，不写死） */
export const ToolRate = z.object({
  model: z.string(),
  /** 每个计费单位大约多少钱（微美元） */
  costMicro: z.number().int().nonnegative(),
  /** 一次调用大约要等多久（秒）；不知道为 null */
  seconds: z.number().int().nonnegative().nullable(),
  /** 数据来源：history 调用记录的中位数；catalog 供应商价格目录；fallback 工具目录的兜底值 */
  basis: z.enum(['history', 'catalog', 'fallback']),
  /**
   * 单价随某个参数变（视频按清晰度）：参数值 → 每个计费单位的单价（微美元）。参数没写或值不在表里
   * 用 costMicro（参数默认值的单价）；旧版网关不返回时当作不随参数变。
   */
  by: z
    .object({
      arg: z.string(),
      costMicro: z.record(z.string(), z.number().int().nonnegative()),
    })
    .optional(),
});
export type ToolRate = z.infer<typeof ToolRate>;

/** 目录里的一个工具：给沙箱里的 AI 看（oasis-tool list） */
export const ToolEntry = z.object({
  /** 稳定的名字，如 image.generate */
  key: z.string(),
  name: z.string(),
  /** 能做什么（普通话） */
  description: z.string(),
  /** 用法：oasis-tool 命令示例 */
  usage: z.string(),
  /** 计费单位，如 张、次、千字 */
  unit: z.string(),
  /** 兜底单价（微美元）：型号既没有调用记录、供应商也没给价格时才用 */
  estimateMicro: z.number().int().nonnegative(),
  /** 每个可用型号的典型单价和用时，按 models 的顺序 */
  rates: z.array(ToolRate).default([]),
  /** 要等几十秒到几分钟的长任务 */
  long: z.boolean(),
  /** 能不能用（供应商 Key 没配就不能用） */
  available: z.boolean(),
  /** 可以指定的模型（替某个用户列时已按他的模型范围过滤）；不需要模型的工具为空 */
  models: z.array(z.string()),
  defaultModel: z.string().nullable(),
  /** 命令行参数：`oasis-tool <工具> --名字 值` 能写哪些参数 */
  args: z.array(ToolArgSpecSchema).default([]),
  /** 计费单位数写在哪个参数里（视频的秒数、生图的张数）；没有就按一次一个单位 */
  per: z.object({ arg: z.string(), default: z.number().positive() }).optional(),
  /** 沙箱里的本地操作（op.*）：不调供应商、不花工具钱，只占沙箱算力 */
  local: z.boolean().default(false),
});
export type ToolEntry = z.infer<typeof ToolEntry>;
export const ToolList = z.object({ tools: z.array(ToolEntry) });

/** 沙箱里 AI 调 oasis-tool 时，进度里给人看的说法 */
export const TOOL_LABELS: Readonly<Record<string, string>> = {
  'image.generate': '生成图片',
  'video.generate': '生成视频',
  'audio.speech': '配音',
  'audio.music': '生成音乐',
  'audio.transcribe': '转写音频',
  'media.inspect': '看图、看视频',
  '3d.generate': '生成 3D 模型',
  '3d.render': '渲染 3D',
  'web.search': '联网搜索',
  'web.fetch': '读网页',
  'model.ask': '问另一个模型',
  'jev.decide': '快速判断',
  'text.batch': '批量写文字',
  'app.check': '检查网页',
  'website.test': '测试网页',
  'android.test': '测试安卓应用',
  wait: '等长任务的结果',
  list: '看有哪些工具',
};

/** 做东西的工具（生图、视频、配音、音乐、3D、批量写文字）：用过它们的那一轮算任务 */
export const GENERATION_TOOLS: readonly string[] = [
  'image.generate',
  'video.generate',
  'audio.speech',
  'audio.music',
  '3d.generate',
  '3d.render',
  'text.batch',
];

/** 调用工具：参数按工具各自校验 */
export const ToolCallBody = z.object({
  args: z.record(z.string(), z.unknown()),
  idempotency_key: z.uuid().optional(),
  max_cost_micro: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  /** 用户点了允许的确认卡（花钱的工具设了「问我」时，第一次调用拿到它，等允许后带上重交） */
  confirmation_id: z.uuid().optional(),
});

/** 工具交回的文件（图片、音频……） */
export const ToolFile = z.object({
  name: z.string(),
  mediaType: z.string(),
  base64: z.string().default(''),
  id: z
    .string()
    .regex(/^\d{1,3}$/)
    .optional(),
  size: z.number().int().nonnegative().optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

/** 工具的结果：给 AI 看的文字、结构化数据（可选）、文件，以及这次花了多少钱 */
export const ToolResult = z.object({
  tool: z.string(),
  text: z.string(),
  data: z.unknown().optional(),
  files: z.array(ToolFile),
  costMicro: z.number().int().nonnegative(),
  /** 长任务（视频）：已提交，结果要用 GET …/tools/jobs/:id 去取 */
  job: z.object({ id: z.uuid() }).optional(),
  /** 还没调：要先等用户点这张确认卡（GET …/confirmations/:id），允许后带 confirmation_id 重交 */
  confirmation: z.object({ id: z.uuid() }).optional(),
});
export type ToolResult = z.infer<typeof ToolResult>;

/**
 * 对话里一轮在 model-gateway 这边的情况：花了多少（调模型、用工具和沙箱算力，微美元；还在做的长任务
 * 按冻结的算）、用过哪些工具、还在等用户点的确认卡
 */
export const RunActivity = z.object({
  spentMicro: z.number().int().nonnegative(),
  tools: z.array(z.string()),
  confirmations: z.array(Confirmation).default([]),
});
export type RunActivity = z.infer<typeof RunActivity>;

/** 长任务的进度：还在做 / 做好了（带结果）/ 失败了（带原因） */
export const ToolJobBody = z.object({
  status: z.enum(['pending', 'completed', 'failed', 'uncertain']),
  cancelRequested: z.boolean().optional(),
  phase: z.string().optional(),
  result: ToolResult.optional(),
  error: z.string().optional(),
});
export type ToolJobBody = z.infer<typeof ToolJobBody>;
