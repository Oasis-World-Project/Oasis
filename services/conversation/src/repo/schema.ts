// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import type { TaskCard, TaskFile } from '@oasis/contracts/conversation';
import type { Permissions, Workplace } from '@oasis/contracts/harness';
import type { Confirmation } from '@oasis/contracts/model-gateway';
import { bigint, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** 正在进行的一轮：harness 的一次运行，以及跟进它写消息时要记住的位置 */
export interface Turn {
  runId: string;
  startedAt: string;
  /** 任务名：画布上任务框的标题、成果在电脑上的文件夹名（以前开的轮没有） */
  title?: string;
  /** 已经写进消息的最后一个运行事件序号（从 -1 开始） */
  cursor: number;
  /** 正在写的那条 AI 消息（AI 看到插话后换一条新的） */
  segmentId: string;
  /** 送进这一轮、AI 还没看到的插话条数 */
  unheard?: number;
  /** 任务卡消息：这一轮用了生图、视频这类工具或交了文件才有；改一个任务的那一轮一开始就是那个任务的卡 */
  cardId?: string;
  /** 这一轮是在改一个已有的任务：那张卡在这一轮之前的样子（名字、做过的每一轮、成果、已经花的） */
  revises?: Pick<TaskCard, 'title' | 'spentMicro' | 'files'> & {
    runs: string[];
    revision: number;
  };
  /** 这一轮在等用户点的确认卡（跟进时从 model-gateway 拿来） */
  confirmations?: Confirmation[];
  /** 做好了、还没登记进画布的文件（out/ 下，相对工作目录）：跟进时登记，做好一个进一个 */
  delivering?: string[];
  /** 这一轮已经登记进画布的成果 */
  files?: TaskFile[];
  /** 群里的一轮：是谁的话引来的（用户 ID）。他们和群主能停下这一轮 */
  callers?: string[];
}

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  /**
   * dm 和 AI 的私聊；group 群；seat 群里一个 AI 的席位（parentId 指向群，一轮和私聊的一样跑，消息写进群里）；
   * direct 两个好友的私聊（两人都是成员，消息和推送用群的那一套）；task 一个云端任务自己的会话
   *（parentId 指向群或和 AI 的私聊，一个任务一行，消息写进那个房间）
   */
  kind: text('kind', { enum: ['dm', 'group', 'seat', 'direct', 'task'] }).notNull(),
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
  /** 在哪干活：空是云端沙箱 */
  workplace: jsonb('workplace').$type<Workplace>(),
  /** 权限：空按在哪干活的默认 */
  permissions: jsonb('permissions').$type<Permissions>(),
  /** 席位挂在哪个群 */
  parentId: uuid('parent_id'),
  /** 席位听到群里第几条消息了 */
  heardSeq: bigint('heard_seq', { mode: 'number' }).notNull().default(0),
  /** 群：光色、发言方式、分工方式；席位：在群里负责什么、什么时候被移出 */
  options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
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
  kind: text('kind', { enum: ['text', 'task', 'topic', 'assign'] })
    .notNull()
    .default('text'),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: at('created_at').notNull().defaultNow(),
});

// 群成员（group_members）、好友申请和好友关系（friend_requests、friendships）只用手写 SQL 读写
// （group-repo.ts、friend-repo.ts），表结构见 migrations。
