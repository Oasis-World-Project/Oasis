import { postgresAndEventBus } from '@oasis/service-kit';
import { z } from 'zod';

export const conversationEnv = {
  ...postgresAndEventBus.env,
  AGENT_URL: z.url(),
  MODEL_GATEWAY_URL: z.url(),
  /** 每次回复带上最近多少条消息作为上下文 */
  HISTORY_LIMIT: z.coerce.number().int().min(1).max(200).default(20),
  /** 一次回复最多多少 token */
  REPLY_MAX_TOKENS: z.coerce.number().int().min(64).max(32_000).default(1024),
};
