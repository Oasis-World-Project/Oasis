// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind', { enum: ['dm', 'group'] }).notNull(),
  ownerId: uuid('owner_id').notNull(),
  modelKey: text('model_key'),
  title: text('title').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  lastMessageAt: at('last_message_at'),
});

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull(),
  authorKind: text('author_kind', { enum: ['user', 'ai'] }).notNull(),
  authorId: text('author_id').notNull(),
  content: text('content').notNull(),
  status: text('status', { enum: ['complete', 'streaming', 'failed'] }).notNull(),
  error: text('error'),
  createdAt: at('created_at').notNull().defaultNow(),
});
