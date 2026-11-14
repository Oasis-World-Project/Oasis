// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。AI 们和各档型号不在库里，在型号清单
// （@oasis/contracts/lineup）里。
import type { AiProfile, ModelTier } from '@oasis/contracts/agent';
import { boolean, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** 用户给 AI 们的设置；没有行就是默认设置 */
export const userAiSettings = pgTable('user_ai_settings', {
  userId: uuid('user_id').primaryKey(),
  domesticOnly: boolean('domestic_only').notNull().default(false),
  /** 给各个 AI 选的档位（AI 的 key → 档位）；没选的用默认 */
  tiers: jsonb('tiers').$type<Record<string, ModelTier>>().notNull().default({}),
  /** 给各个 AI 定的设定（AI 的 key → 名字、人格……）；没定的用系统默认 */
  profiles: jsonb('profiles').$type<Record<string, AiProfile>>().notNull().default({}),
  updatedAt: at('updated_at').notNull().defaultNow(),
});
