import type { AiSettings } from '@oasis/contracts/agent';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { models, userAiSettings } from './schema.ts';

export type ModelRow = typeof models.$inferSelect;

export function createModelRepo(pool: pg.Pool) {
  const db = drizzle(pool);
  return {
    list: (): Promise<ModelRow[]> => db.select().from(models).orderBy(asc(models.sortOrder)),
    async find(key: string): Promise<ModelRow | undefined> {
      const [row] = await db.select().from(models).where(eq(models.key, key));
      return row;
    },
    /** 用户给 AI 们的设置；没设过就是默认设置 */
    async settings(userId: string): Promise<AiSettings> {
      const [row] = await db
        .select({ domesticOnly: userAiSettings.domesticOnly })
        .from(userAiSettings)
        .where(eq(userAiSettings.userId, userId));
      return { domesticOnly: row?.domesticOnly ?? false };
    },
    async saveSettings(userId: string, settings: AiSettings): Promise<void> {
      await db
        .insert(userAiSettings)
        .values({ userId, ...settings })
        .onConflictDoUpdate({
          target: userAiSettings.userId,
          set: { ...settings, updatedAt: new Date() },
        });
    },
  };
}

export type ModelRepo = ReturnType<typeof createModelRepo>;
