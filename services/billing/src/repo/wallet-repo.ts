// 钱包的数据访问。每个改余额的操作都在一个事务里完成，并靠行锁和表约束防止并发出错。
import { and, eq, gte, isNotNull, isNull, lt, sql, sum } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { holds, ledgerEntries, processedEvents, wallets } from './schema.ts';

export function createWalletRepo(pool: pg.Pool) {
  const db = drizzle(pool);

  return {
    async renewHold(id: string, now: Date, until: Date) {
      const rows = await db
        .update(holds)
        .set({ expiresAt: until })
        .where(and(eq(holds.id, id), eq(holds.status, 'open'), gte(holds.expiresAt, now)))
        .returning({ id: holds.id });
      return rows.length > 0;
    },
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

    /** 可用余额够才冻结；不够（或是解散了的金库）返回 undefined。 */
    async createHold(input: {
      userId: string;
      actorId?: string | undefined;
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
              isNull(wallets.closedAt),
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
        const [hold] = await tx.select().from(holds).where(eq(holds.id, holdId)).for('update');
        if (!hold) return undefined;
        if (hold.status === 'settled') {
          const [entry] = await tx
            .select()
            .from(ledgerEntries)
            .where(eq(ledgerEntries.holdId, holdId));
          return (entry?.detail as Record<string, unknown> | undefined)?.costMicro ===
            detail.costMicro
            ? (hold.chargedMicro ?? undefined)
            : undefined;
        }
        if (hold.status !== 'open') return undefined;
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
          actorId: hold.actorId,
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

    async releaseHold(holdId: string, expiredBefore?: Date): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [hold] = await tx
          .update(holds)
          .set({ status: 'released', closedAt: sql`now()` })
          .where(
            and(
              eq(holds.id, holdId),
              eq(holds.status, 'open'),
              ...(expiredBefore ? [lt(holds.expiresAt, expiredBefore)] : []),
            ),
          )
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

    /**
     * 往金库里存：从这个人的钱包转进金库（没有金库就建）。可用余额不够返回 undefined。
     * 其中有多少是注册送的额度记在两条流水上（送的先花、先存）：退回时仍算送的。
     */
    async deposit(userId: string, treasuryId: string, amountMicro: number) {
      return db.transaction(async (tx) => {
        const [wallet] = await tx
          .select()
          .from(wallets)
          .where(eq(wallets.userId, userId))
          .for('update');
        if (!wallet || wallet.balanceMicro - wallet.heldMicro < amountMicro) return undefined;
        const [moved] = await tx
          .select({
            spent: sql<string>`coalesce(sum(${ledgerEntries.amountMicro}) filter (where ${ledgerEntries.kind} = 'charge'), 0)`,
            giftedOut: sql<string>`coalesce(sum((${ledgerEntries.detail}->>'giftedMicro')::bigint) filter (where ${ledgerEntries.kind} = 'transfer_out'), 0)`,
            giftedIn: sql<string>`coalesce(sum((${ledgerEntries.detail}->>'giftedMicro')::bigint) filter (where ${ledgerEntries.kind} = 'transfer_in'), 0)`,
          })
          .from(ledgerEntries)
          .where(eq(ledgerEntries.userId, userId));
        const giftedLeft = Math.max(
          0,
          wallet.grantedMicro -
            Number(moved?.spent ?? 0) -
            Number(moved?.giftedOut ?? 0) +
            Number(moved?.giftedIn ?? 0),
        );
        const giftedMicro = Math.min(amountMicro, giftedLeft, wallet.balanceMicro);
        await tx
          .update(wallets)
          .set({
            balanceMicro: sql`${wallets.balanceMicro} - ${amountMicro}`,
            updatedAt: sql`now()`,
          })
          .where(eq(wallets.userId, userId));
        await tx
          .insert(wallets)
          .values({ userId: treasuryId, balanceMicro: amountMicro, heldMicro: 0, grantedMicro: 0 })
          .onConflictDoUpdate({
            target: wallets.userId,
            set: {
              balanceMicro: sql`${wallets.balanceMicro} + ${amountMicro}`,
              updatedAt: sql`now()`,
            },
          });
        await tx.insert(ledgerEntries).values([
          {
            userId,
            actorId: treasuryId,
            kind: 'transfer_out',
            amountMicro,
            ref: 'deposit',
            detail: { giftedMicro },
          },
          {
            userId: treasuryId,
            actorId: userId,
            kind: 'transfer_in',
            amountMicro,
            ref: 'deposit',
            detail: { giftedMicro },
          },
        ]);
        return true;
      });
    },

    /** 金库的账：每个人存了多少（连其中送的额度）、叫 AI 花了多少 */
    async treasuryMembers(treasuryId: string) {
      const rows = await db
        .select({
          userId: ledgerEntries.actorId,
          deposited: sql<string>`coalesce(sum(${ledgerEntries.amountMicro}) filter (where ${ledgerEntries.kind} = 'transfer_in'), 0)`,
          gifted: sql<string>`coalesce(sum((${ledgerEntries.detail}->>'giftedMicro')::bigint) filter (where ${ledgerEntries.kind} = 'transfer_in'), 0)`,
          spent: sql<string>`coalesce(sum(${ledgerEntries.amountMicro}) filter (where ${ledgerEntries.kind} = 'charge'), 0)`,
        })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.userId, treasuryId),
            sql`${ledgerEntries.kind} in ('transfer_in', 'charge')`,
          ),
        )
        .groupBy(ledgerEntries.actorId);
      return rows.map((row) => ({
        userId: row.userId,
        depositedMicro: Number(row.deposited),
        giftedMicro: Number(row.gifted),
        spentMicro: Number(row.spent),
      }));
    },

    /**
     * 解散：金库记成已解散，里面没被冻结的钱按 shares 退回各人的钱包（shares 由调用方按存入比例算好），
     * 金库清到只剩冻结着的。没钱可退时只记已解散，可以重复调用。
     */
    async refund(
      treasuryId: string,
      shares: (available: number) => { userId: string; amountMicro: number; giftedMicro: number }[],
    ) {
      return db.transaction(async (tx) => {
        const [wallet] = await tx
          .select()
          .from(wallets)
          .where(eq(wallets.userId, treasuryId))
          .for('update');
        if (!wallet) return [];
        const available = wallet.balanceMicro - wallet.heldMicro;
        const refunds = available > 0 ? shares(available).filter((r) => r.amountMicro > 0) : [];
        const total = refunds.reduce((sum, r) => sum + r.amountMicro, 0);
        await tx
          .update(wallets)
          .set({
            balanceMicro: sql`${wallets.balanceMicro} - ${total}`,
            closedAt: sql`coalesce(${wallets.closedAt}, now())`,
            updatedAt: sql`now()`,
          })
          .where(eq(wallets.userId, treasuryId));
        for (const { userId, amountMicro, giftedMicro } of refunds) {
          await tx
            .insert(wallets)
            .values({ userId, balanceMicro: amountMicro, heldMicro: 0, grantedMicro: 0 })
            .onConflictDoUpdate({
              target: wallets.userId,
              set: {
                balanceMicro: sql`${wallets.balanceMicro} + ${amountMicro}`,
                updatedAt: sql`now()`,
              },
            });
          await tx.insert(ledgerEntries).values([
            {
              userId: treasuryId,
              actorId: userId,
              kind: 'transfer_out',
              amountMicro,
              ref: 'dissolve',
              detail: { giftedMicro },
            },
            {
              userId,
              actorId: treasuryId,
              kind: 'transfer_in',
              amountMicro,
              ref: 'dissolve',
              detail: { giftedMicro },
            },
          ]);
        }
        return refunds;
      });
    },

    /** 解散了、里面又有了能退的钱的金库（解散时还冻结着的，后来退回来了） */
    async closedWithMoney(limit = 100): Promise<string[]> {
      const rows = await db
        .select({ id: wallets.userId })
        .from(wallets)
        .where(
          and(isNotNull(wallets.closedAt), sql`${wallets.balanceMicro} - ${wallets.heldMicro} > 0`),
        )
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
