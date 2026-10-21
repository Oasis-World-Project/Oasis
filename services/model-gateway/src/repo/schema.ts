// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import { bigint, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const calls = pgTable('calls', {
  id: uuid('id').primaryKey(),
  payerId: uuid('payer_id').notNull(),
  model: text('model').notNull(),
  requestId: text('request_id'),
  status: text('status', { enum: ['running', 'succeeded', 'failed'] }).notNull(),
  holdId: uuid('hold_id'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  upstreamCostMicro: bigint('upstream_cost_micro', { mode: 'number' }),
  chargedMicro: bigint('charged_micro', { mode: 'number' }),
  costSource: text('cost_source', { enum: ['provider', 'tokens', 'estimate'] }),
  error: text('error'),
  createdAt: at('created_at').notNull().defaultNow(),
  finishedAt: at('finished_at'),
});
