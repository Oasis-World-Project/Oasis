// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import type { ModelOption, ModelTier } from '@oasis/contracts/agent';
import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** 库里存的可选型号：比对外的多一个上游型号（如 deepseek/deepseek-v4-pro） */
export type StoredOption = ModelOption & { model: string };

export const models = pgTable('models', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  vendor: text('vendor').notNull(),
  category: text('category', {
    enum: ['llm', 'image', 'vision', 'video', 'audio', 'embedding', '3d', 'other'],
  }).notNull(),
  tags: text('tags').array().notNull(),
  mono: text('mono').notNull(),
  glow: text('glow').notNull(),
  /** 可选的型号，第一个是默认；空的是还没接入 */
  options: jsonb('options').$type<StoredOption[]>().notNull().default([]),
  sortOrder: integer('sort_order').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
});

/** 用户给 AI 们的设置；没有行就是默认设置 */
export const userAiSettings = pgTable('user_ai_settings', {
  userId: uuid('user_id').primaryKey(),
  domesticOnly: boolean('domestic_only').notNull().default(false),
  /** 给各个 AI 选的档位（AI 的 key → 档位）；没选的用默认 */
  tiers: jsonb('tiers').$type<Record<string, ModelTier>>().notNull().default({}),
  updatedAt: at('updated_at').notNull().defaultNow(),
});
