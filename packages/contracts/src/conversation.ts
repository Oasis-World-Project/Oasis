// conversation 的对外接口：私聊（群聊在后续阶段）。
import { z } from 'zod';

export const ConversationBody = z.object({
  id: z.uuid(),
  kind: z.enum(['dm', 'group']),
  title: z.string(),
  modelKey: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastMessageAt: z.iso.datetime().nullable(),
});
export type ConversationBody = z.infer<typeof ConversationBody>;

export const ConversationList = z.object({ conversations: z.array(ConversationBody) });

export const CreateDmBody = z.object({ modelKey: z.string().min(1).max(50) });

export const MessageBody = z.object({
  id: z.uuid(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  status: z.enum(['complete', 'streaming', 'failed']),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type MessageBody = z.infer<typeof MessageBody>;

export const MessageList = z.object({ messages: z.array(MessageBody) });

export const SendMessageBody = z.object({ content: z.string().trim().min(1).max(8000) });

/**
 * 发消息的响应是 SSE 流，每个事件的 data 是下面三种之一：
 * accepted（用户消息已存）→ 若干 delta（AI 回复片段）→ done（AI 回复完整存库）或 error。
 */
export const StreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('accepted'), userMessage: MessageBody }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('done'), message: MessageBody }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type StreamEvent = z.infer<typeof StreamEvent>;
