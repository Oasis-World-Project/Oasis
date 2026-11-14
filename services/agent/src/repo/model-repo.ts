import type { AiSettings, ModelTier } from '@oasis/contracts/agent';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { models, userAiSettings } from './schema.ts';

export type ModelRow = typeof models.$inferSelect;

/** 用户给 AI 们的设置，加上给各个 AI 选的档位（AI 的 key → 档位，没选过的不在里面） */
export type UserAiPrefs = AiSettings & { tiers: Record<string, ModelTier> };

export function createModelRepo(pool: pg.Pool) {
  const db = drizzle(pool);
  return {
    list: (): Promise<ModelRow[]> => db.select().from(models).orderBy(asc(models.sortOrder)),
    async find(key: string): Promise<ModelRow | undefined> {
      const [row] = await db.select().from(models).where(eq(models.key, key));
      return row;
    },
    /** 没设过就是默认设置 */
    async settings(userId: string): Promise<UserAiPrefs> {
      const [row] = await db
        .select({ domesticOnly: userAiSettings.domesticOnly, tiers: userAiSettings.tiers })
        .from(userAiSettings)
        .where(eq(userAiSettings.userId, userId));
      return { domesticOnly: row?.domesticOnly ?? false, tiers: row?.tiers ?? {} };
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
    /** 给一个 AI 选档位（别的 AI 选的不动） */
    async saveTier(userId: string, key: string, tier: ModelTier): Promise<void> {
      const choice = { [key]: tier };
      await db
        .insert(userAiSettings)
        .values({ userId, tiers: choice })
        .onConflictDoUpdate({
          target: userAiSettings.userId,
          set: {
            tiers: sql`${userAiSettings.tiers} || ${JSON.stringify(choice)}::jsonb`,
            updatedAt: new Date(),
          },
        });
    },
  };
}

export type ModelRepo = ReturnType<typeof createModelRepo>;
