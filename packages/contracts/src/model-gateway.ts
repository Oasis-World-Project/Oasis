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
