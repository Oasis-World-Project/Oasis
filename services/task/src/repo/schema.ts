// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import type { RunOutputFile } from '@oasis/contracts/harness';
import type { Attention, NodeStatus, TaskStatus } from '@oasis/contracts/task';
import { bigint, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const micro = (name: string) => bigint(name, { mode: 'number' });

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id').notNull(),
  payerId: uuid('payer_id').notNull(),
  conversationId: uuid('conversation_id'),
  title: text('title').notNull(),
  brief: text('brief').notNull(),
  status: text('status').$type<TaskStatus>().notNull(),
  attention: jsonb('attention').$type<Attention>(),
  estimateMicro: micro('estimate_micro'),
  spentMicro: micro('spent_micro').notNull().default(0),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
  finishedAt: at('finished_at'),
});

export const nodes = pgTable('nodes', {
  id: uuid('id').primaryKey(),
  taskId: uuid('task_id').notNull(),
  key: text('key').notNull(),
  title: text('title').notNull(),
  kind: text('kind').$type<'work'>().notNull(),
  role: text('role').notNull().default(''),
  goal: text('goal').notNull(),
  model: text('model').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').$type<NodeStatus>().notNull(),
  attempts: integer('attempts').notNull().default(0),
  userNotes: jsonb('user_notes').$type<string[]>().notNull().default([]),
  warning: text('warning'),
  summary: text('summary'),
  outputs: jsonb('outputs').$type<RunOutputFile[]>().notNull().default([]),
  currentRunId: uuid('current_run_id'),
  spentMicro: micro('spent_micro').notNull().default(0),
  createdAt: at('created_at').notNull().defaultNow(),
  startedAt: at('started_at'),
  finishedAt: at('finished_at'),
});

export const edges = pgTable('edges', {
  id: uuid('id').primaryKey(),
  taskId: uuid('task_id').notNull(),
  fromNodeId: uuid('from_node_id'),
  toNodeId: uuid('to_node_id'),
});

export type NodeRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export const nodeRuns = pgTable('node_runs', {
  id: uuid('id').primaryKey(),
  taskId: uuid('task_id').notNull(),
  nodeId: uuid('node_id').notNull(),
  attempt: integer('attempt').notNull(),
  purpose: text('purpose').$type<'work'>().notNull(),
  status: text('status').$type<NodeRunStatus>().notNull(),
  summary: text('summary'),
  error: text('error'),
  outputs: jsonb('outputs').$type<RunOutputFile[]>().notNull().default([]),
  createdAt: at('created_at').notNull().defaultNow(),
  finishedAt: at('finished_at'),
});
