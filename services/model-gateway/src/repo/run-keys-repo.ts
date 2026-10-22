import { and, eq, gt, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { runKeys } from './schema.ts';

export type NewRunKey = Omit<typeof runKeys.$inferInsert, 'revokedAt' | 'createdAt'>;
export type RunKey = typeof runKeys.$inferSelect;

export interface RunKeysRepo {
  insert(key: NewRunKey): Promise<void>;
  /** 按哈希找仍然有效（未作废、未过期）的 Key */
  findActive(keyHash: string, now: Date): Promise<RunKey | undefined>;
  /** 作废；返回是否真的作废了一个原本有效的 Key */
  revoke(id: string, now: Date): Promise<boolean>;
}

export function createRunKeysRepo(pool: pg.Pool): RunKeysRepo {
  const db = drizzle(pool);
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
        .returning({ id: runKeys.id });
      return rows.length > 0;
    },
  };
}
