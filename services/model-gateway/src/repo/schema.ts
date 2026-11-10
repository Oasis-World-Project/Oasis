// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AvatarSpec, AvatarTurn } from '@oasis/contracts/avatar';
import type { ToolResult } from '@oasis/contracts/model-gateway';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const calls = pgTable('calls', {
  id: uuid('id').primaryKey(),
  kind: text('kind', { enum: ['chat', 'decision', 'tool', 'compute', 'avatar'] }).notNull(),
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

/** 事务发件箱（列名由 service-kit 的 startOutboxRelay 约定） */
export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey(),
  subject: text('subject').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  publishedAt: at('published_at'),
});

/** 长任务（视频）：供应商的任务号、进度，以及结算时要用的调用信息 */
export const toolJobs = pgTable('tool_jobs', {
  id: uuid('id').primaryKey(),
  tool: text('tool').notNull(),
  providerJobId: text('provider_job_id').notNull(),
  requestKey: uuid('request_key').unique(),
  requestHash: text('request_hash'),
  phase: text('phase').notNull().default('pending'),
  result: jsonb('result').$type<ToolResult>(),
  cost: jsonb('cost').$type<{ costMicro: number; source: 'provider' | 'estimate' | 'tokens' }>(),
  leaseToken: uuid('lease_token'),
  leaseUntil: at('lease_until'),
  expiresAt: at('expires_at'),
  status: text('status', { enum: ['pending', 'completed', 'failed'] }).notNull(),
  call: jsonb('call').$type<Record<string, unknown>>().notNull(),
  error: text('error'),
  createdAt: at('created_at').notNull().defaultNow(),
  finishedAt: at('finished_at'),
});

/** 一个用户让 AI 团队用哪些模型（ADR 0027）；没有行就是不限制 */
export const modelScopes = pgTable('model_scopes', {
  userId: uuid('user_id').primaryKey(),
  domesticOnly: boolean('domestic_only').notNull(),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

export const toolRunControls = pgTable('tool_run_controls', {
  runId: uuid('run_id').primaryKey(),
  payerId: uuid('payer_id').notNull(),
  taskId: uuid('task_id'),
  cancelledAt: at('cancelled_at'),
});
/** 任务级删除围栏，与按 run 的取消不同；阻止删除事件之后的迟到提交。 */
export const toolTaskDeletions = pgTable('tool_task_deletions', {
  taskId: uuid('task_id').primaryKey(),
  deletedAt: at('deleted_at').notNull().defaultNow(),
});

/** 在 LiveAvatar 上建的资源和临时 Key，边建边记（清扫按它拆） */
export interface AvatarResources {
  runKeyId?: string;
  secretId?: string;
  llmConfigurationId?: string;
  contextId?: string;
  providerSessionId?: string;
}

export const avatarSessions = pgTable('avatar_sessions', {
  id: uuid('id').primaryKey(),
  payerId: uuid('payer_id').notNull(),
  artifactId: uuid('artifact_id'),
  taskId: uuid('task_id'),
  status: text('status', { enum: ['starting', 'live', 'ended'] }).notNull(),
  sandbox: boolean('sandbox').notNull(),
  maxSeconds: integer('max_seconds').notNull(),
  pricePerMinuteMicro: bigint('price_per_minute_micro', { mode: 'number' }).notNull(),
  spec: jsonb('spec').$type<AvatarSpec>().notNull(),
  resources: jsonb('resources').$type<AvatarResources>().notNull().default({}),
  callId: uuid('call_id'),
  turns: jsonb('turns').$type<AvatarTurn[]>().notNull().default([]),
  startedAt: at('started_at'),
  endedAt: at('ended_at'),
  endReason: text('end_reason'),
  settledAt: at('settled_at'),
  chargedMicro: bigint('charged_micro', { mode: 'number' }),
  cleanedAt: at('cleaned_at'),
  createdAt: at('created_at').notNull().defaultNow(),
});
