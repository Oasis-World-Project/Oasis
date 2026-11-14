// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import { bigint, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** 正在进行的一轮：harness 的一次运行，以及跟进它写消息时要记住的位置 */
export interface Turn {
  runId: string;
  startedAt: string;
  /** 已经写进消息的最后一个运行事件序号（从 -1 开始） */
  cursor: number;
  /** 正在写的那条 AI 消息（AI 看到插话后换一条新的） */
  segmentId: string;
  /** 送进这一轮、AI 还没看到的插话条数 */
  unheard?: number;
  /** 任务卡消息：这一轮用了生图、视频这类工具或交了文件才有 */
  cardId?: string;
}

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind', { enum: ['dm', 'group'] }).notNull(),
  ownerId: uuid('owner_id').notNull(),
  modelKey: text('model_key'),
  title: text('title').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  lastMessageAt: at('last_message_at'),
  nextMessageSeq: bigint('next_message_seq', { mode: 'number' }).notNull().default(0),
  /** 正在进行的一轮；没有为 null */
  turn: jsonb('turn').$type<Turn>(),
  /** 当前会话最近的一轮：下一轮接着它的会话做；开新话题后为 null */
  lastRunId: uuid('last_run_id'),
  /** 当前话题的名字：成果在电脑上按它放文件夹 */
  topic: text('topic'),
});

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull(),
  seq: bigint('seq', { mode: 'number' }).notNull().default(0),
  authorKind: text('author_kind', { enum: ['user', 'ai'] }).notNull(),
  authorId: text('author_id').notNull(),
  content: text('content').notNull(),
  status: text('status', { enum: ['complete', 'streaming', 'failed'] }).notNull(),
  error: text('error'),
  kind: text('kind', { enum: ['text', 'task', 'topic'] })
    .notNull()
    .default('text'),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const groupMembers = pgTable(
  'group_members',
  {
    conversationId: uuid('conversation_id').notNull(),
    userId: uuid('user_id').notNull(),
    displayName: text('display_name').notNull(),
    joinedAt: at('joined_at').notNull().defaultNow(),
    leftAt: at('left_at'),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.userId] })],
);
export const groupInvites = pgTable('group_invites', {
  tokenHash: text('token_hash').primaryKey(),
  conversationId: uuid('conversation_id').notNull(),
  expiresAt: at('expires_at').notNull(),
  usedBy: uuid('used_by'),
  usedAt: at('used_at'),
  createdAt: at('created_at').notNull().defaultNow(),
});
