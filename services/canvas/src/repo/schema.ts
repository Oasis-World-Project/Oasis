// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import type { AvatarSpec } from '@oasis/contracts/avatar';
import type { Annotation, ApplicationSpec, ArtifactCategory } from '@oasis/contracts/canvas';
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
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  /** 被消息、批注用上的时间；一直为空的上传 24 小时后由清扫删除（2026-11-05 真删除） */
  claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'date' }),
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
  avatarSpec: jsonb('avatar_spec').$type<AvatarSpec>(),
  models: jsonb('models').$type<string[]>().notNull().default([]),
  objectKey: text('object_key').notNull(),
  syncPath: text('sync_path').notNull(),
  /** 新版替换旧版时，同一同步路径上旧文件的摘要 */
  replacesSha256: text('replaces_sha256'),
  /** 用户的批注（ADR 0012 §9） */
  annotations: jsonb('annotations').$type<Annotation[]>().notNull().default([]),
  /** 用户点了「批准」的时间 */
  approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});
