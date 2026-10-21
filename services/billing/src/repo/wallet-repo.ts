// 钱包的数据访问。每个改余额的操作都在一个事务里完成，并靠行锁和表约束防止并发出错。
import { and, eq, gte, lt, sql, sum } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { holds, ledgerEntries, processedEvents, wallets } from './schema.ts';

export function createWalletRepo(pool: pg.Pool) {
  const db = drizzle(pool);

  return {
    /** 处理注册事件：同一事件只处理一次；同一用户的注册赠送也只有一次（唯一索引兜底）。 */
    async grantSignup(eventId: string, userId: string, amountMicro: number): Promise<boolean> {
      return db.transaction(async (tx) => {
        const fresh = await tx
          .insert(processedEvents)
          .values({ eventId })
          .onConflictDoNothing()
          .returning({ eventId: processedEvents.eventId });
        if (fresh.length === 0) return false;
        const granted = await tx
          .insert(ledgerEntries)
          .values({ userId, kind: 'grant', amountMicro, ref: 'signup' })
          .onConflictDoNothing()
          .returning({ id: ledgerEntries.id });
        if (granted.length === 0) return false;
        await tx
          .insert(wallets)
          .values({ userId, balanceMicro: amountMicro, heldMicro: 0, grantedMicro: amountMicro })
          .onConflictDoUpdate({
            target: wallets.userId,
            set: {
              balanceMicro: sql`${wallets.balanceMicro} + ${amountMicro}`,
              grantedMicro: sql`${wallets.grantedMicro} + ${amountMicro}`,
              updatedAt: sql`now()`,
            },
          });
        return true;
      });
    },

    /** 可用余额够才冻结；不够返回 undefined。 */
    async createHold(input: {
      userId: string;
      amountMicro: number;
      reason: string;
      ref: string;
      expiresAt: Date;
    }) {
      return db.transaction(async (tx) => {
        const reserved = await tx
          .update(wallets)
          .set({
            heldMicro: sql`${wallets.heldMicro} + ${input.amountMicro}`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(wallets.userId, input.userId),
              sql`${wallets.balanceMicro} - ${wallets.heldMicro} >= ${input.amountMicro}`,
            ),
          )
          .returning({ userId: wallets.userId });
        if (reserved.length === 0) return undefined;
        const [hold] = await tx
          .insert(holds)
          .values({ ...input, status: 'open' })
          .returning({ id: holds.id, amountMicro: holds.amountMicro });
        return hold!;
      });
    },

    /**
     * 结算：按 chargeMicro 扣款（最多扣到余额为 0），解除冻结并记流水。
     * 冻结不存在或已关闭时返回 undefined。
     */
    async settleHold(holdId: string, chargeMicro: number, detail: Record<string, unknown>) {
      return db.transaction(async (tx) => {
        const [hold] = await tx
          .select()
          .from(holds)
          .where(and(eq(holds.id, holdId), eq(holds.status, 'open')))
          .for('update');
        if (!hold) return undefined;
        const [wallet] = await tx
          .select()
          .from(wallets)
          .where(eq(wallets.userId, hold.userId))
          .for('update');
        const charged = Math.min(chargeMicro, wallet!.balanceMicro);
        await tx
          .update(wallets)
          .set({
            balanceMicro: sql`${wallets.balanceMicro} - ${charged}`,
            heldMicro: sql`${wallets.heldMicro} - ${hold.amountMicro}`,
            updatedAt: sql`now()`,
          })
          .where(eq(wallets.userId, hold.userId));
        await tx
          .update(holds)
          .set({ status: 'settled', chargedMicro: charged, closedAt: sql`now()` })
          .where(eq(holds.id, holdId));
        await tx.insert(ledgerEntries).values({
          userId: hold.userId,
          kind: 'charge',
          amountMicro: charged,
          holdId,
          ref: hold.ref,
          detail:
            charged < chargeMicro ? { ...detail, uncollectedMicro: chargeMicro - charged } : detail,
        });
        return charged;
      });
    },

    async releaseHold(holdId: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [hold] = await tx
          .update(holds)
          .set({ status: 'released', closedAt: sql`now()` })
          .where(and(eq(holds.id, holdId), eq(holds.status, 'open')))
          .returning({ userId: holds.userId, amountMicro: holds.amountMicro });
        if (!hold) return false;
        await tx
          .update(wallets)
          .set({
            heldMicro: sql`${wallets.heldMicro} - ${hold.amountMicro}`,
            updatedAt: sql`now()`,
          })
          .where(eq(wallets.userId, hold.userId));
        return true;
      });
    },

    async expiredHoldIds(now: Date, limit = 100): Promise<string[]> {
      const rows = await db
        .select({ id: holds.id })
        .from(holds)
        .where(and(eq(holds.status, 'open'), lt(holds.expiresAt, now)))
        .limit(limit);
      return rows.map((row) => row.id);
    },

    async findWallet(userId: string) {
      const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, userId));
      return wallet;
    },

    async spentSince(userId: string, since: Date): Promise<number> {
      const [row] = await db
        .select({ total: sum(ledgerEntries.amountMicro) })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.userId, userId),
            eq(ledgerEntries.kind, 'charge'),
            gte(ledgerEntries.createdAt, since),
          ),
        );
      return Number(row?.total ?? 0);
    },
  };
}

export type WalletRepo = ReturnType<typeof createWalletRepo>;
