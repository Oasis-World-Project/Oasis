// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import { bigint, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const calls = pgTable('calls', {
  id: uuid('id').primaryKey(),
  kind: text('kind', { enum: ['chat', 'decision'] }).notNull(),
  payerId: uuid('payer_id').notNull(),
  runId: uuid('run_id'),
  taskId: uuid('task_id'),
  nodeId: uuid('node_id'),
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

export const runKeys = pgTable('run_keys', {
  id: uuid('id').primaryKey(),
  keyHash: text('key_hash').notNull().unique(),
  payerId: uuid('payer_id').notNull(),
  runId: uuid('run_id').notNull(),
  taskId: uuid('task_id'),
  nodeId: uuid('node_id'),
  expiresAt: at('expires_at').notNull(),
  revokedAt: at('revoked_at'),
  createdAt: at('created_at').notNull().defaultNow(),
});
