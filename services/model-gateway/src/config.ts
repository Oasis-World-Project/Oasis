import { postgresAndEventBus } from '@oasis/service-kit';
import { z } from 'zod';

export const modelGatewayEnv = {
  ...postgresAndEventBus.env,
  BILLING_URL: z.url(),
  OPENROUTER_BASE_URL: z.url().default('https://openrouter.ai/api/v1'),
  /** 没配置时服务照常启动，但模型调用返回 503 */
  OPENROUTER_API_KEY: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  /** 调用方没给 max_tokens 时的上限（也用于估算冻结金额） */
  DEFAULT_MAX_TOKENS: z.coerce.number().int().positive().max(32_000).default(2048),
  /** 模型价格表多久刷新一次 */
  PRICING_REFRESH_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(60 * 60_000),
  /** 查不到价格时按这个金额冻结（$0.20） */
  FALLBACK_HOLD_MICRO: z.coerce.number().int().positive().default(200_000),
};
