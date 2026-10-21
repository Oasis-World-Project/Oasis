// model-gateway 的内部接口：OpenAI 兼容的 chat completions（只列出 Oasis 用到的字段，其余原样透传）。
import { z } from 'zod';

export const ChatMessage = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatCompletionRequest = z.looseObject({
  model: z.string().min(1),
  messages: z.array(ChatMessage).min(1),
  max_tokens: z.number().int().positive().max(32_000).optional(),
  stream: z.boolean().optional(),
});
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequest>;
