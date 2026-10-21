// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import { bigint, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const micro = (name: string) => bigint(name, { mode: 'number' });

export const wallets = pgTable('wallets', {
  userId: uuid('user_id').primaryKey(),
  balanceMicro: micro('balance_micro').notNull(),
  heldMicro: micro('held_micro').notNull(),
  grantedMicro: micro('granted_micro').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

export const holds = pgTable('holds', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
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
  kind: text('kind', { enum: ['grant', 'charge'] }).notNull(),
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
