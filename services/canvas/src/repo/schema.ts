// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import type { ApplicationSpec, ArtifactCategory } from '@oasis/contracts/canvas';
import { bigint, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const uploads = pgTable('uploads', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id').notNull(),
  state: text('state').notNull().default('ready'),
  name: text('name').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  sha256: text('sha256'),
  contentType: text('content_type').notNull(),
  objectKey: text('object_key').notNull(),
  /** 修订任务的素材来自哪个任务的成果（ADR 0012）；用户自己上传的为空 */
  sourceTaskId: uuid('source_task_id'),
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
  sha256: text('sha256'),
  size: bigint('size', { mode: 'number' }).notNull(),
  contentType: text('content_type').notNull(),
  category: text('category').$type<ArtifactCategory>().notNull(),
  appSpec: jsonb('app_spec').$type<ApplicationSpec>(),
  models: jsonb('models').$type<string[]>().notNull().default([]),
  objectKey: text('object_key').notNull(),
  syncPath: text('sync_path').notNull(),
  /** 新版替换旧版时，同一同步路径上旧文件的摘要 */
  replacesSha256: text('replaces_sha256'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});
