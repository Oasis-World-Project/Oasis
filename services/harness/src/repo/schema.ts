// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import type { RunEventKind, RunOutputFile, RunStatus } from '@oasis/contracts/harness';
import {
  bigint,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const runs = pgTable('runs', {
  id: uuid('id').primaryKey(),
  payerId: uuid('payer_id').notNull(),
  taskId: uuid('task_id'),
  nodeId: uuid('node_id'),
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
  inputsFrom: jsonb('inputs_from').$type<{ runId: string; as: string }[]>().notNull().default([]),
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

export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey(),
  subject: text('subject').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  publishedAt: at('published_at'),
});

/** 检查用的隔离浏览器（ADR 0009、0021），不是 agent run：一次检查开一个，用完即停、按实际时长结算。 */
export const checkBrowsers = pgTable('check_browsers', {
  id: uuid('id').primaryKey(),
  payerId: uuid('payer_id').notNull(),
  taskId: uuid('task_id').notNull(),
  status: text('status')
    .$type<'starting' | 'running' | 'stopping' | 'stopped' | 'failed'>()
    .notNull(),
  containerId: text('container_id'),
  computeCallId: uuid('compute_call_id'),
  heldMicro: bigint('held_micro', { mode: 'number' }).notNull().default(0),
  spentMicro: bigint('spent_micro', { mode: 'number' }),
  startedAt: at('started_at'),
  stoppedAt: at('stopped_at'),
  error: text('error'),
  createdAt: at('created_at').notNull().defaultNow(),
});
