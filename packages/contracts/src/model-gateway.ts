// model-gateway 的内部接口：OpenAI 兼容的 chat completions、Jev 决策、沙箱运行用的临时 Key。
// 只列出 Oasis 用到的字段，其余原样透传。
import { z } from 'zod';

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
   * 这个型号负责一个干活节点的典型花费和用时（ADR 0016 §4）：有调用记录用记录的中位数，
   * 没有就按价格表 × 所有节点的典型 token 用量估；都没有时不给。
   */
  node: z
    .object({
      costMicro: z.number().int().nonnegative(),
      seconds: z.number().int().nonnegative().nullable(),
      basis: z.enum(['history', 'catalog']),
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

/** POST /internal/run-keys：为一次 agent 运行签发临时 Key。 */
export const CreateRunKeyBody = z.object({
  runId: z.uuid(),
  payerId: z.uuid(),
  taskId: z.uuid().optional(),
  nodeId: z.uuid().optional(),
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

// ---- 算力（ADR 0006 §6）：harness 开沙箱前冻结、结束后按实际时长结算，和模型、工具走同一套计量 ----

/** 开沙箱前冻结：按最长运行时间算 */
export const ComputeHoldBody = z.object({
  runId: z.uuid(),
  payerId: z.uuid(),
  taskId: z.uuid().nullable(),
  nodeId: z.uuid().nullable(),
  /** 沙箱的 CPU 核数 */
  cores: z.number().positive().max(64),
  /** 最长运行多久（毫秒） */
  maxMs: z
    .number()
    .int()
    .positive()
    .max(24 * 3600_000),
  purpose: z.enum(['run', 'preview', 'application-check']).default('run'),
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

// ---- 工具（ADR 0006）：生图、配音、转写、联网搜索、网页抓取、Jev 判断……都经 model-gateway 计量 ----

/** 目录里的一个工具：给规划员和节点里的 AI 看 */
/** 一个型号用一次（一个计费单位）的典型花费和用时（ADR 0016 §4：估价不写死单价） */
export const ToolRate = z.object({
  model: z.string(),
  /** 每个计费单位大约多少钱（微美元） */
  costMicro: z.number().int().nonnegative(),
  /** 一次调用大约要等多久（秒）；不知道为 null */
  seconds: z.number().int().nonnegative().nullable(),
  /** 数据来源：history 调用记录的中位数；catalog 供应商价格目录；fallback 工具目录的兜底值 */
  basis: z.enum(['history', 'catalog', 'fallback']),
});
export type ToolRate = z.infer<typeof ToolRate>;

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
  /** 可以指定的模型（已去掉当前网络用不了的）；不需要模型的工具为空 */
  models: z.array(z.string()),
  defaultModel: z.string().nullable(),
});
export type ToolEntry = z.infer<typeof ToolEntry>;
export const ToolList = z.object({ tools: z.array(ToolEntry) });

/** 调用工具：参数按工具各自校验 */
export const ToolCallBody = z.object({
  args: z.record(z.string(), z.unknown()),
  idempotency_key: z.uuid().optional(),
  max_cost_micro: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
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
});
export type ToolResult = z.infer<typeof ToolResult>;

/** 长任务的进度：还在做 / 做好了（带结果）/ 失败了（带原因） */
export const ToolJobBody = z.object({
  status: z.enum(['pending', 'completed', 'failed', 'uncertain']),
  cancelRequested: z.boolean().optional(),
  phase: z.string().optional(),
  result: ToolResult.optional(),
  error: z.string().optional(),
});
export type ToolJobBody = z.infer<typeof ToolJobBody>;
