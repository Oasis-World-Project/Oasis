// billing 的对外接口（/api/billing/v1/*）与内部接口（/internal/*）。金额一律是微美元整数（1 USD = 1_000_000）。
import { z } from 'zod';

const Micro = z.number().int().nonnegative();

export const WalletBody = z.object({
  /** 可用余额（已扣除冻结中的金额） */
  availableMicro: Micro,
  /** 正在进行的调用冻结的金额 */
  heldMicro: Micro,
  /** 累计赠送和充值 */
  grantedMicro: Micro,
  /** 本月已花费 */
  spentThisMonthMicro: Micro,
});
export type WalletBody = z.infer<typeof WalletBody>;

/** 内部：调用模型前按最大可能花费冻结额度。amountMicro 是上游原价，billing 会乘以定价系数。 */
export const CreateHoldBody = z.object({
  userId: z.uuid(),
  amountMicro: z.number().int().positive(),
  reason: z.string().min(1).max(100),
  ref: z.string().min(1).max(200),
});
export type CreateHoldBody = z.infer<typeof CreateHoldBody>;

export const HoldResult = z.object({ holdId: z.uuid(), heldMicro: Micro });
export type HoldResult = z.infer<typeof HoldResult>;

/** 内部：调用结束后按上游实际花费结算；多冻结的部分自动退回。 */
export const SettleHoldBody = z.object({
  costMicro: Micro,
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type SettleHoldBody = z.infer<typeof SettleHoldBody>;

export const SettleResult = z.object({ chargedMicro: Micro });
export type SettleResult = z.infer<typeof SettleResult>;
