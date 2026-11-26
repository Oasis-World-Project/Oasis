// 钱包的业务规则：注册赠送、按定价系数冻结与结算、过期冻结回收。
import type {
  CreateHoldBody,
  HoldResult,
  SettleResult,
  TreasuryBody,
  TreasuryRefunds,
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
function monthStart(now: Date): Date {
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
    async renew(id: string, ttlMs: number) {
      const instant = now();
      if (!(await repo.renewHold(id, instant, new Date(instant.getTime() + ttlMs))))
        throw new HttpError(409, 'hold_closed', '冻结已关闭或过期，不能续期');
    },
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
      const { ttlMs, ...fields } = input;
      const amountMicro = applyMultiplier(fields.amountMicro, deps.priceMultiplier);
      const hold = await repo.createHold({
        ...fields,
        amountMicro,
        expiresAt: new Date(now().getTime() + (ttlMs ?? deps.holdTtlMs)),
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

    /** 往群的金库里存：从这个人自己的钱包转进去，存进去就是群的 */
    async deposit(treasuryId: string, userId: string, amountMicro: number): Promise<TreasuryBody> {
      if (!(await repo.deposit(userId, treasuryId, amountMicro)))
        throw new HttpError(402, 'insufficient_balance', '钱包里的额度不够存这么多');
      return this.treasury(treasuryId);
    },

    /** 群的金库：现在有多少、每个人存了多少、叫 AI 花了多少（还没人存过就是空的） */
    async treasury(treasuryId: string): Promise<TreasuryBody> {
      const [wallet, members] = await Promise.all([
        repo.findWallet(treasuryId),
        repo.treasuryMembers(treasuryId),
      ]);
      return {
        availableMicro: wallet ? wallet.balanceMicro - wallet.heldMicro : 0,
        depositedMicro: members.reduce((sum, m) => sum + m.depositedMicro, 0),
        spentMicro: members.reduce((sum, m) => sum + m.spentMicro, 0),
        // 没记是谁叫的花费（比如判断谁想接话）算在总数里，不单列一个人
        members: members.flatMap(({ userId, depositedMicro, spentMicro }) =>
          userId ? [{ userId, depositedMicro, spentMicro }] : [],
        ),
      };
    },

    /**
     * 解散群：金库里剩下的按各人累计存入的比例退回各自的钱包（除不尽的零头给存得最多的人），
     * 其中算送的额度的份额和他存入时一样。解散后这个金库不能再花；可以重复调用
     * （解散时还冻结着的钱，结算、退回之后由 releaseExpired 接着退）。
     */
    async dissolve(treasuryId: string): Promise<TreasuryRefunds> {
      const savers = (await repo.treasuryMembers(treasuryId))
        .filter((m) => m.userId && m.depositedMicro > 0)
        .sort((a, b) => b.depositedMicro - a.depositedMicro);
      const total = savers.reduce((sum, m) => sum + m.depositedMicro, 0);
      const refunds = await repo.refund(treasuryId, (available) => {
        const parts = savers.map((m) => Math.floor((available * m.depositedMicro) / total));
        const rest = available - parts.reduce((sum, part) => sum + part, 0);
        return savers.map((m, index) => {
          const amountMicro = parts[index]! + (index === 0 ? rest : 0);
          return {
            userId: m.userId!,
            amountMicro,
            giftedMicro: Math.round((amountMicro * m.giftedMicro) / m.depositedMicro),
          };
        });
      });
      if (refunds.length) deps.logger.info({ treasuryId, refunds }, '金库解散，剩下的已退回');
      return { refunds: refunds.map(({ userId, amountMicro }) => ({ userId, amountMicro })) };
    },

    async releaseExpired(): Promise<number> {
      const ids = await repo.expiredHoldIds(now());
      let released = 0;
      for (const id of ids) if (await repo.releaseHold(id, now())) released += 1;
      if (released > 0) deps.logger.warn({ released }, '已退回过期未结算的冻结');
      // 解散时还冻结着的钱后来结算、退回了：剩下的接着按比例退给各人
      for (const id of await repo.closedWithMoney()) await this.dissolve(id);
      return released;
    },
  };
}

export type WalletService = ReturnType<typeof createWalletService>;
