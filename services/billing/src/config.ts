import { postgresAndEventBus } from '@oasis/service-kit';
import { z } from 'zod';

export const billingEnv = {
  ...postgresAndEventBus.env,
  /** 注册赠送额度，默认 $30 */
  SIGNUP_GRANT_MICRO: z.coerce.number().int().nonnegative().default(30_000_000),
  /** 定价系数：向用户收取 = 上游成本 × 系数（MVP 默认按成本价） */
  BILLING_PRICE_MULTIPLIER: z.coerce.number().positive().max(100).default(1),
  /** 冻结多久没结算就自动退回 */
  HOLD_TTL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(10 * 60_000),
};
