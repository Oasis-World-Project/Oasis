// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import type { RunOutputFile } from '@oasis/contracts/harness';
import type { Attention, NodeStatus, TaskStatus } from '@oasis/contracts/task';
import { bigint, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** 节点配置：关卡的验收点和应有文件；讨论节点还有参与者、轮数、进行到第几轮和讨论记录 */
export interface NodeConfig {
  checks?: string[];
  expects?: string[];
  participants?: { name: string; model: string; stance: string }[];
  rounds?: number;
  round?: number;
  /** 用户追加要求的前几条已经交给节点了（讨论在下一轮、停止后在继续时带上之后的新要求） */
  notesSeen?: number;
  /** 节点现在的产出是哪次运行交出来的（下游拿这次运行的产出） */
  outputsRunId?: string;
  /** 每条发言记下是哪次运行说的，下一轮这位参与者接着那次运行的会话 */
  transcript?: { round: number; name: string; text: string; runId: string }[];
}

/** 交给 harness 的完整请求（没送到时按原样重交） */
export interface RunRequestRecord {
  model: string;
  prompt: string;
  inputsFrom: { runId: string; as: string }[];
  continueFrom?: string;
}

/** 讨论发言的轮次和发言人 */
export interface RunMeta {
  round?: number;
  participant?: string;
}

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
  budgetLimitMicro: micro('budget_limit_micro'),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
  finishedAt: at('finished_at'),
});

export const nodes = pgTable('nodes', {
  id: uuid('id').primaryKey(),
  taskId: uuid('task_id').notNull(),
  key: text('key').notNull(),
  title: text('title').notNull(),
  kind: text('kind').$type<'work' | 'discussion'>().notNull(),
  role: text('role').notNull().default(''),
  goal: text('goal').notNull(),
  model: text('model').notNull(),
  config: jsonb('config').$type<NodeConfig>().notNull().default({}),
  status: text('status').$type<NodeStatus>().notNull(),
  attempts: integer('attempts').notNull().default(0),
  reworks: integer('reworks').notNull().default(0),
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

export type NodeRunStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stopped';
export type NodeRunPurpose = 'work' | 'rework' | 'speech' | 'summary';
export const nodeRuns = pgTable('node_runs', {
  id: uuid('id').primaryKey(),
  taskId: uuid('task_id').notNull(),
  nodeId: uuid('node_id').notNull(),
  attempt: integer('attempt').notNull(),
  purpose: text('purpose').$type<NodeRunPurpose>().notNull(),
  status: text('status').$type<NodeRunStatus>().notNull(),
  summary: text('summary'),
  error: text('error'),
  outputs: jsonb('outputs').$type<RunOutputFile[]>().notNull().default([]),
  meta: jsonb('meta').$type<RunMeta>().notNull().default({}),
  request: jsonb('request').$type<RunRequestRecord>().notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  finishedAt: at('finished_at'),
});

/** 已经计入花费的模型调用（结算事件按调用 ID 只算一次） */
export const spendRecords = pgTable('spend_records', {
  callId: uuid('call_id').primaryKey(),
  taskId: uuid('task_id').notNull(),
  nodeId: uuid('node_id'),
  chargedMicro: micro('charged_micro').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
});
