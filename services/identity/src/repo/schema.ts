// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准，这里只是查询用的类型描述）。
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const emailCodes = pgTable('email_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: at('expires_at').notNull(),
  consumedAt: at('consumed_at'),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: uuid('user_id').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  expiresAt: at('expires_at').notNull(),
  lastSeenAt: at('last_seen_at').notNull().defaultNow(),
});

export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey(),
  subject: text('subject').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  publishedAt: at('published_at'),
});
