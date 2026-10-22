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

export const ChatCompletionRequest = z.looseObject({
  model: z.string().min(1),
  messages: z.array(ChatMessage).min(1),
  max_tokens: OutputTokens.optional(),
  /** 新版 OpenAI 字段，与 max_tokens 同义；agent 运行时用的是这个 */
  max_completion_tokens: OutputTokens.optional(),
  stream: z.boolean().optional(),
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

// ---- 工具（ADR 0006）：生图、配音、转写、联网搜索、网页抓取、Jev 判断……都经 model-gateway 计量 ----

/** 目录里的一个工具：给规划员和节点里的 AI 看 */
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
  /** 用一次大约多少钱（微美元），规划时估算用 */
  estimateMicro: z.number().int().nonnegative(),
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
export const ToolCallBody = z.object({ args: z.record(z.string(), z.unknown()) });

/** 工具交回的文件（图片、音频……） */
export const ToolFile = z.object({
  name: z.string(),
  mediaType: z.string(),
  base64: z.string(),
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
  status: z.enum(['pending', 'completed', 'failed']),
  result: ToolResult.optional(),
  error: z.string().optional(),
});
export type ToolJobBody = z.infer<typeof ToolJobBody>;
