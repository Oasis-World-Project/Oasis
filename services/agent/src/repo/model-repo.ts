import type { AiProfile, AiSettings, ModelTier } from '@oasis/contracts/agent';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { userAiSettings } from './schema.ts';

/** 用户给 AI 们的设置，加上给各个 AI 选的档位和定的设定（AI 的 key → …，没动过的不在里面） */
export type UserAiPrefs = AiSettings & {
  tiers: Record<string, ModelTier>;
  profiles: Record<string, AiProfile>;
};

export function createModelRepo(pool: pg.Pool) {
  const db = drizzle(pool);
  /** 只改一个 AI 的那一项（别的 AI 的不动） */
  const merge = (
    column: typeof userAiSettings.tiers | typeof userAiSettings.profiles,
    key: string,
    value: unknown,
  ) => sql`${column} || ${JSON.stringify({ [key]: value })}::jsonb`;
  return {
    /** 没设过就是默认设置 */
    async settings(userId: string): Promise<UserAiPrefs> {
      const [row] = await db
        .select({
          domesticOnly: userAiSettings.domesticOnly,
          tiers: userAiSettings.tiers,
          profiles: userAiSettings.profiles,
        })
        .from(userAiSettings)
        .where(eq(userAiSettings.userId, userId));
      return {
        domesticOnly: row?.domesticOnly ?? false,
        tiers: row?.tiers ?? {},
        profiles: row?.profiles ?? {},
      };
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
    /** 给一个 AI 选档位、定设定（别的 AI 的不动；设定整份替换） */
    async saveAi(userId: string, key: string, tier: ModelTier, profile: AiProfile): Promise<void> {
      await db
        .insert(userAiSettings)
        .values({ userId, tiers: { [key]: tier }, profiles: { [key]: profile } })
        .onConflictDoUpdate({
          target: userAiSettings.userId,
          set: {
            tiers: merge(userAiSettings.tiers, key, tier),
            profiles: merge(userAiSettings.profiles, key, profile),
            updatedAt: new Date(),
          },
        });
    },
  };
}

export type ModelRepo = ReturnType<typeof createModelRepo>;
