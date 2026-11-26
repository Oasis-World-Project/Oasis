// 每一轮的临时 Key，以及这一轮的确认卡（要用户点的：超出权限的命令、花钱的工具）。
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { confirmations, runKeys } from './schema.ts';

export type NewRunKey = Omit<typeof runKeys.$inferInsert, 'revokedAt' | 'createdAt' | 'autoAllow'>;
export type RunKey = typeof runKeys.$inferSelect;
export type ConfirmationRow = typeof confirmations.$inferSelect;
type Kind = ConfirmationRow['kind'];
type Status = ConfirmationRow['status'];

export interface RunKeysRepo {
  insert(key: NewRunKey): Promise<void>;
  /** 按哈希找仍然有效（未作废、未过期）的 Key */
  findActive(keyHash: string, now: Date): Promise<RunKey | undefined>;
  /** 作废；返回是否真的作废了一个原本有效的 Key（这一轮还没点的确认卡一起收回） */
  revoke(id: string, now: Date): Promise<boolean>;
  renew(id: string, now: Date, expiresAt: Date): Promise<boolean>;
  /** 仍然有效的 Key 改归到新的一轮；原来那一轮还没点的确认卡收回。Key 已作废或过期返回 false */
  rebind(
    id: string,
    now: Date,
    next: Pick<RunKey, 'runId' | 'actorId' | 'domesticOnly' | 'askPaid' | 'noWeb' | 'expiresAt'>,
  ): Promise<boolean>;
  /** 这一轮里这一类确认以后都允许 */
  allowAlways(runId: string, kind: Kind): Promise<void>;
  addConfirmation(
    row: Pick<ConfirmationRow, 'id' | 'runId' | 'kind' | 'text' | 'callId' | 'status'>,
  ): Promise<ConfirmationRow>;
  confirmation(id: string): Promise<ConfirmationRow | undefined>;
  /** 这一轮最近一张同样内容、还没用掉的工具确认（待定或已允许） */
  openToolConfirmation(runId: string, text: string): Promise<ConfirmationRow | undefined>;
  pendingConfirmations(runId: string): Promise<ConfirmationRow[]>;
  /** 从 from 里的状态改成 to（别人先改了就不改，返回 undefined） */
  settle(id: string, from: Status[], to: Status, now: Date): Promise<ConfirmationRow | undefined>;
  /** 这一轮还没点的这一类确认一起改成 to */
  settleKind(runId: string, kind: Kind, to: Status, now: Date): Promise<void>;
  /** 删对话（真删除）：这个对话各轮的确认卡 */
  deleteConfirmations(conversationId: string): Promise<void>;
}

export function createRunKeysRepo(pool: pg.Pool): RunKeysRepo {
  const db = drizzle(pool);
  const pendingOf = (runId: string, kind?: Kind) =>
    and(
      eq(confirmations.runId, runId),
      eq(confirmations.status, 'pending'),
      kind ? eq(confirmations.kind, kind) : undefined,
    );
  return {
    async insert(key) {
      await db.insert(runKeys).values(key);
    },
    async findActive(keyHash, now) {
      const [row] = await db
        .select()
        .from(runKeys)
        .where(
          and(eq(runKeys.keyHash, keyHash), isNull(runKeys.revokedAt), gt(runKeys.expiresAt, now)),
        )
        .limit(1);
      return row;
    },
    async revoke(id, now) {
      const rows = await db
        .update(runKeys)
        .set({ revokedAt: now })
        .where(and(eq(runKeys.id, id), isNull(runKeys.revokedAt)))
        .returning({ runId: runKeys.runId });
      for (const { runId } of rows)
        await db
          .update(confirmations)
          .set({ status: 'cancelled', decidedAt: now })
          .where(pendingOf(runId));
      return rows.length > 0;
    },
    async renew(id, now, expiresAt) {
      const rows = await db
        .update(runKeys)
        .set({ expiresAt })
        .where(and(eq(runKeys.id, id), isNull(runKeys.revokedAt), gt(runKeys.expiresAt, now)))
        .returning({ id: runKeys.id });
      return rows.length > 0;
    },
    async rebind(id, now, next) {
      const active = and(eq(runKeys.id, id), isNull(runKeys.revokedAt), gt(runKeys.expiresAt, now));
      const [before] = await db.select({ runId: runKeys.runId }).from(runKeys).where(active);
      if (!before) return false;
      const rows = await db.update(runKeys).set(next).where(active).returning({ id: runKeys.id });
      if (rows.length && before.runId !== next.runId)
        await db
          .update(confirmations)
          .set({ status: 'cancelled', decidedAt: now })
          .where(pendingOf(before.runId));
      return rows.length > 0;
    },
    async allowAlways(runId, kind) {
      await db
        .update(runKeys)
        .set({ autoAllow: sql`array_append(${runKeys.autoAllow}, ${kind})` })
        .where(and(eq(runKeys.runId, runId), sql`not (${kind} = any(${runKeys.autoAllow}))`));
    },
    async addConfirmation(row) {
      const [inserted] = await db.insert(confirmations).values(row).returning();
      return inserted!;
    },
    async confirmation(id) {
      const [row] = await db.select().from(confirmations).where(eq(confirmations.id, id));
      return row;
    },
    async openToolConfirmation(runId, text) {
      const [row] = await db
        .select()
        .from(confirmations)
        .where(
          and(
            eq(confirmations.runId, runId),
            eq(confirmations.kind, 'tool'),
            eq(confirmations.text, text),
            inArray(confirmations.status, ['pending', 'allowed']),
          ),
        )
        .orderBy(desc(confirmations.createdAt))
        .limit(1);
      return row;
    },
    pendingConfirmations: (runId) =>
      db.select().from(confirmations).where(pendingOf(runId)).orderBy(asc(confirmations.createdAt)),
    async settle(id, from, to, now) {
      const [row] = await db
        .update(confirmations)
        .set({ status: to, decidedAt: now })
        .where(and(eq(confirmations.id, id), inArray(confirmations.status, from)))
        .returning();
      return row;
    },
    async settleKind(runId, kind, to, now) {
      await db
        .update(confirmations)
        .set({ status: to, decidedAt: now })
        .where(pendingOf(runId, kind));
    },
    async deleteConfirmations(conversationId) {
      await db
        .delete(confirmations)
        .where(
          inArray(
            confirmations.runId,
            db
              .select({ runId: runKeys.runId })
              .from(runKeys)
              .where(eq(runKeys.conversationId, conversationId)),
          ),
        );
    },
  };
}
