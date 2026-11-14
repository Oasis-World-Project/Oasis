// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import type { RunEventKind, RunOutputFile, RunStatus } from '@oasis/contracts/harness';
import { integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const runs = pgTable('runs', {
  id: uuid('id').primaryKey(),
  payerId: uuid('payer_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  model: text('model').notNull(),
  prompt: text('prompt').notNull(),
  status: text('status').$type<RunStatus>().notNull(),
  error: text('error'),
  containerId: text('container_id'),
  runKeyId: uuid('run_key_id'),
  outputs: jsonb('outputs').$type<RunOutputFile[]>().notNull().default([]),
  outputKey: text('output_key'),
  summary: text('summary'),
  sessionId: text('session_id'),
  continueFrom: uuid('continue_from'),
  createdAt: at('created_at').notNull().defaultNow(),
  startedAt: at('started_at'),
  finishedAt: at('finished_at'),
});

export const runEvents = pgTable(
  'run_events',
  {
    runId: uuid('run_id').notNull(),
    seq: integer('seq').notNull(),
    kind: text('kind').$type<RunEventKind>().notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.seq] })],
);
