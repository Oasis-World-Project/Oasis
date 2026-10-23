// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import type { IntakeQuestion } from '@oasis/contracts/conversation';
import type { Material } from '@oasis/contracts/canvas';
import type { TaskSheet } from '@oasis/contracts/task';
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind', { enum: ['dm', 'group'] }).notNull(),
  ownerId: uuid('owner_id').notNull(),
  modelKey: text('model_key'),
  title: text('title').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  lastMessageAt: at('last_message_at'),
});

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull(),
  authorKind: text('author_kind', { enum: ['user', 'ai'] }).notNull(),
  authorId: text('author_id').notNull(),
  content: text('content').notNull(),
  status: text('status', { enum: ['complete', 'streaming', 'failed'] }).notNull(),
  error: text('error'),
  kind: text('kind', { enum: ['text', 'questions', 'sheet', 'task', 'delivery', 'notice'] })
    .notNull()
    .default('text'),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: at('created_at').notNull().defaultNow(),
});

/** 接需求过程中的一步 */
export type IntakeTurn =
  | {
      kind: 'questions';
      round: number;
      questions: IntakeQuestion[];
      /** 用户的回答；skipped = 用户点了直接开始 */
      answers: Record<string, string> | null;
      skipped?: boolean;
    }
  | { kind: 'sheet'; sheet: TaskSheet }
  /** 接需求期间用户在对话里说的话（补充、修改意见） */
  | { kind: 'user'; text: string };

export const intakes = pgTable('intakes', {
  id: uuid('id').primaryKey(),
  conversationId: uuid('conversation_id').notNull(),
  status: text('status', { enum: ['asking', 'sheet', 'confirmed', 'cancelled'] }).notNull(),
  round: integer('round').notNull().default(0),
  request: text('request').notNull(),
  context: jsonb('context')
    .$type<{ role: 'user' | 'assistant'; content: string }[]>()
    .notNull()
    .default([]),
  turns: jsonb('turns').$type<IntakeTurn[]>().notNull().default([]),
  cardMessageId: uuid('card_message_id'),
  sheet: jsonb('sheet').$type<TaskSheet>(),
  taskId: uuid('task_id'),
  materials: jsonb('materials').$type<Material[]>().notNull().default([]),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
});
