// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import { bigint, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const uploads = pgTable('uploads', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id').notNull(),
  name: text('name').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  contentType: text('content_type').notNull(),
  objectKey: text('object_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});
