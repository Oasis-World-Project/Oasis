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
import type { Confirmation, ToolResult } from '@oasis/contracts/model-gateway';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const calls = pgTable('calls', {
  id: uuid('id').primaryKey(),
  kind: text('kind', { enum: ['chat', 'decision', 'tool', 'compute', 'avatar'] }).notNull(),
  payerId: uuid('payer_id').notNull(),
  /** 对话里的一轮（沙箱里的 agent 运行）；这一轮的花费按它汇总 */
  runId: uuid('run_id'),
  conversationId: uuid('conversation_id'),
  model: text('model').notNull(),
  /** 工具调用：哪个工具（如 image.generate） */
  tool: text('tool'),
  requestId: text('request_id'),
  status: text('status', { enum: ['running', 'succeeded', 'failed'] }).notNull(),
  holdId: uuid('hold_id'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  cachedTokens: integer('cached_tokens'),
  cacheWriteTokens: integer('cache_write_tokens'),
  /** OpenRouter 把这次请求转给了哪家（它回的名字，如 Amazon Bedrock） */
  provider: text('provider'),
  /** 发出去的消息有多少字符（不含工具定义和多媒体）：对着 prompt_tokens 看供应商有没有丢内容 */
  inputChars: integer('input_chars'),
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
  /** 花金库的钱时：这一轮是谁叫的 */
  actorId: uuid('actor_id'),
  runId: uuid('run_id').notNull(),
  conversationId: uuid('conversation_id'),
  /** 用户打开了「只用国内模型」：这一轮的工具只给国内厂商的型号 */
  domesticOnly: boolean('domestic_only').notNull().default(false),
  /** 花钱的工具要先问（用户设了「问我」） */
  askPaid: boolean('ask_paid').notNull().default(false),
  /** 用户关了这段对话的联网搜索 */
  noWeb: boolean('no_web').notNull().default(false),
  /** 用户点过「以后都允许」的确认种类（command、tool）：这一轮里不再问 */
  autoAllow: text('auto_allow').array().$type<ConfirmationKind[]>().notNull().default([]),
  expiresAt: at('expires_at').notNull(),
  revokedAt: at('revoked_at'),
  createdAt: at('created_at').notNull().defaultNow(),
});

type ConfirmationKind = Confirmation['kind'];

/** 一轮里要用户点的确认卡 */
export const confirmations = pgTable('confirmations', {
  id: uuid('id').primaryKey(),
  runId: uuid('run_id').notNull(),
  kind: text('kind').$type<ConfirmationKind>().notNull(),
  text: text('text').notNull(),
  callId: text('call_id'),
  status: text('status').$type<Confirmation['status']>().notNull().default('pending'),
  createdAt: at('created_at').notNull().defaultNow(),
  decidedAt: at('decided_at'),
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

export const toolRunControls = pgTable('tool_run_controls', {
  runId: uuid('run_id').primaryKey(),
  payerId: uuid('payer_id').notNull(),
  conversationId: uuid('conversation_id'),
  cancelledAt: at('cancelled_at'),
});
/** 对话级删除围栏，与按运行的取消不同：拦住删对话之后才到的工具提交。 */
export const toolConversationDeletions = pgTable('tool_conversation_deletions', {
  conversationId: uuid('conversation_id').primaryKey(),
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
