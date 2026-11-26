// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import { bigint, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const micro = (name: string) => bigint(name, { mode: 'number' });

/** 钱包按账户算：个人的账户号是用户 ID，群的金库是群的 ID（user_id 这一列就是账户号） */
export const wallets = pgTable('wallets', {
  userId: uuid('user_id').primaryKey(),
  balanceMicro: micro('balance_micro').notNull(),
  heldMicro: micro('held_micro').notNull(),
  grantedMicro: micro('granted_micro').notNull(),
  /** 金库：群解散的时间（之后不能再冻结，退回来的钱按比例退给各人） */
  closedAt: at('closed_at'),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

export const holds = pgTable('holds', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  /** 花金库的钱时：是谁叫 AI 花的 */
  actorId: uuid('actor_id'),
  amountMicro: micro('amount_micro').notNull(),
  status: text('status', { enum: ['open', 'settled', 'released'] }).notNull(),
  reason: text('reason').notNull(),
  ref: text('ref').notNull(),
  chargedMicro: micro('charged_micro'),
  createdAt: at('created_at').notNull().defaultNow(),
  expiresAt: at('expires_at').notNull(),
  closedAt: at('closed_at'),
});

export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  /** charge：是谁叫 AI 花的（花金库的钱时）；transfer_out / transfer_in：对方是谁 */
  actorId: uuid('actor_id'),
  kind: text('kind', { enum: ['grant', 'charge', 'transfer_out', 'transfer_in'] }).notNull(),
  amountMicro: micro('amount_micro').notNull(),
  holdId: uuid('hold_id'),
  ref: text('ref').notNull(),
  detail: jsonb('detail'),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const processedEvents = pgTable('processed_events', {
  eventId: uuid('event_id').primaryKey(),
  processedAt: at('processed_at').notNull().defaultNow(),
});
