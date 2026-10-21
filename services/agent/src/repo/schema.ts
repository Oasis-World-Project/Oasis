// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

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
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});
