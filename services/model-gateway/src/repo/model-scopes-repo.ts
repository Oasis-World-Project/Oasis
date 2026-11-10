import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { modelScopes } from './schema.ts';

export interface ModelScopesRepo {
  /** 这个用户是不是只用国内模型；没设过算没开 */
  domesticOnly(userId: string): Promise<boolean>;
  setDomesticOnly(userId: string, domesticOnly: boolean): Promise<void>;
}

export function createModelScopesRepo(pool: pg.Pool): ModelScopesRepo {
  const db = drizzle(pool);
  return {
    async domesticOnly(userId) {
      const [row] = await db
        .select({ domesticOnly: modelScopes.domesticOnly })
        .from(modelScopes)
        .where(eq(modelScopes.userId, userId))
        .limit(1);
      return row?.domesticOnly ?? false;
    },
    async setDomesticOnly(userId, domesticOnly) {
      await db
        .insert(modelScopes)
        .values({ userId, domesticOnly })
        .onConflictDoUpdate({
          target: modelScopes.userId,
          set: { domesticOnly, updatedAt: new Date() },
        });
    },
  };
}
