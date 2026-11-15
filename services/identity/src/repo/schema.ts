// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准，这里只是查询用的类型描述）。
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: at('created_at').notNull().defaultNow(),
  /** 账号 ID：系统发的 8 位数字，不能改 */
  accountNo: text('account_no').notNull().unique(),
  name: text('name').notNull(),
  bio: text('bio').notNull().default(''),
  gender: text('gender').$type<'' | 'male' | 'female' | 'other'>().notNull().default(''),
  region: text('region').notNull().default(''),
  /** 头像是哪种图片；没有头像为空（头像本身不在这里读，见 identity-repo 的 avatar） */
  avatarType: text('avatar_type'),
  /** 头像换过几次（去掉也算一次） */
  avatarVersion: integer('avatar_version').notNull().default(0),
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
