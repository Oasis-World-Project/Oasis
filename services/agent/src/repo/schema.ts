// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

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
  providerModel: text('provider_model'),
  versionLabel: text('version_label'),
  sortOrder: integer('sort_order').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
});

/** 用户给 AI 们的设置；没有行就是默认设置 */
export const userAiSettings = pgTable('user_ai_settings', {
  userId: uuid('user_id').primaryKey(),
  domesticOnly: boolean('domestic_only').notNull().default(false),
  updatedAt: at('updated_at').notNull().defaultNow(),
});
