// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import type { ArtifactCategory } from '@oasis/contracts/canvas';
import { bigint, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const uploads = pgTable('uploads', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id').notNull(),
  name: text('name').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  contentType: text('content_type').notNull(),
  objectKey: text('object_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const artifacts = pgTable('artifacts', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id').notNull(),
  taskId: uuid('task_id').notNull(),
  taskTitle: text('task_title').notNull(),
  conversationId: uuid('conversation_id'),
  nodeId: uuid('node_id').notNull(),
  path: text('path').notNull(),
  name: text('name').notNull(),
  deliverable: text('deliverable').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  contentType: text('content_type').notNull(),
  category: text('category').$type<ArtifactCategory>().notNull(),
  models: jsonb('models').$type<string[]>().notNull().default([]),
  objectKey: text('object_key').notNull(),
  syncPath: text('sync_path').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});
