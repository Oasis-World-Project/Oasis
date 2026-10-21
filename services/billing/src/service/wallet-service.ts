// 钱包的业务规则：注册赠送、按定价系数冻结与结算、过期冻结回收。
import type {
  CreateHoldBody,
  HoldResult,
  SettleResult,
  WalletBody,
} from '@oasis/contracts/billing';
import { HttpError, type Logger } from '@oasis/service-kit';
import type { WalletRepo } from '../repo/wallet-repo.ts';

/** 按定价系数换算向用户收取的金额；向上取整到 1 微美元，非零成本至少收 1。 */
export function applyMultiplier(costMicro: number, multiplier: number): number {
  if (costMicro <= 0) return 0;
  // 减去一个极小量，避免浮点误差（如 100 × 1.1 = 110.00000000000001）让结果多出 1
  return Math.ceil(costMicro * multiplier - 1e-9);
}

/** 本月 1 日 0 点（UTC）。 */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function createWalletService(deps: {
  repo: WalletRepo;
  signupGrantMicro: number;
  priceMultiplier: number;
  holdTtlMs: number;
  logger: Logger;
  now?: () => Date;
}) {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async grantSignup(eventId: string, userId: string): Promise<void> {
      const granted = await repo.grantSignup(eventId, userId, deps.signupGrantMicro);
      deps.logger.info({ userId, granted }, granted ? '注册赠送已到账' : '注册赠送已处理过，跳过');
    },

    async wallet(userId: string): Promise<WalletBody> {
      const wallet = await repo.findWallet(userId);
      if (!wallet) throw new HttpError(404, 'wallet_not_ready', '额度正在到账，请稍后刷新');
      return {
        availableMicro: wallet.balanceMicro - wallet.heldMicro,
        heldMicro: wallet.heldMicro,
        grantedMicro: wallet.grantedMicro,
        spentThisMonthMicro: await repo.spentSince(userId, monthStart(now())),
      };
    },

    async hold(input: CreateHoldBody): Promise<HoldResult> {
      const amountMicro = applyMultiplier(input.amountMicro, deps.priceMultiplier);
      const hold = await repo.createHold({
        ...input,
        amountMicro,
        expiresAt: new Date(now().getTime() + deps.holdTtlMs),
      });
      if (!hold) throw new HttpError(402, 'insufficient_balance', '额度不够了');
      return { holdId: hold.id, heldMicro: hold.amountMicro };
    },

    async settle(
      holdId: string,
      costMicro: number,
      detail: Record<string, unknown> = {},
    ): Promise<SettleResult> {
      const chargeMicro = applyMultiplier(costMicro, deps.priceMultiplier);
      const charged = await repo.settleHold(holdId, chargeMicro, {
        ...detail,
        costMicro,
        multiplier: deps.priceMultiplier,
      });
      if (charged === undefined) throw new HttpError(409, 'hold_closed', '这笔冻结已经结算或释放');
      return { chargedMicro: charged };
    },

    async release(holdId: string): Promise<void> {
      if (!(await repo.releaseHold(holdId)))
        throw new HttpError(409, 'hold_closed', '这笔冻结已经结算或释放');
    },

    async releaseExpired(): Promise<number> {
      const ids = await repo.expiredHoldIds(now());
      let released = 0;
      for (const id of ids) if (await repo.releaseHold(id)) released += 1;
      if (released > 0) deps.logger.warn({ released }, '已退回过期未结算的冻结');
      return released;
    },
  };
}

export type WalletService = ReturnType<typeof createWalletService>;
