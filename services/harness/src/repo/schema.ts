// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import type { RunEventKind, RunOutputFile, RunStatus, Workplace } from '@oasis/contracts/harness';
import { integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const runs = pgTable('runs', {
  id: uuid('id').primaryKey(),
  /** 花哪个账户的钱：个人的账户号是用户 ID，群的金库是群的 ID */
  payerId: uuid('payer_id').notNull(),
  /** 这一轮替谁做的（他的电脑、他名下的文件）；空就是付钱的那个人自己 */
  actorId: uuid('actor_id'),
  conversationId: uuid('conversation_id').notNull(),
  model: text('model').notNull(),
  prompt: text('prompt').notNull(),
  status: text('status').$type<RunStatus>().notNull(),
  error: text('error'),
  containerId: text('container_id'),
  runKeyId: uuid('run_key_id'),
  outputs: jsonb('outputs').$type<RunOutputFile[]>().notNull().default([]),
  /** 以前每轮把 out/ 打包存一份的对象键（2026-11-26 起不再写；旧的一轮删对话时照删，之后收缩掉这一列） */
  outputKey: text('output_key'),
  summary: text('summary'),
  sessionId: text('session_id'),
  continueFrom: uuid('continue_from'),
  /** 在用户的哪台电脑、哪个项目文件夹里跑；空是云端沙箱 */
  workplace: jsonb('workplace').$type<Extract<Workplace, { kind: 'device' }>>(),
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
