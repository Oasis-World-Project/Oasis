// 私聊的存储：对话、消息，以及正在进行的一轮（turn）。
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { and, asc, desc, eq, isNotNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { HttpError } from '@oasis/service-kit';
import { conversations, messages, type Turn } from './schema.ts';

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
/** 这个会话的消息写在哪：私聊是它自己；群里的席位写进它所在的群 */
export const roomOf = (conversation: Pick<Conversation, 'id' | 'parentId'>) =>
  conversation.parentId ?? conversation.id;
type NewMessage = Pick<
  typeof messages.$inferInsert,
  'conversationId' | 'authorKind' | 'authorId' | 'content' | 'status' | 'kind' | 'data' | 'error'
>;
type MessagePatch = Partial<Pick<Message, 'content' | 'status' | 'error' | 'data'>>;

/**
 * 租约锁的用途：处理用户的操作（开一轮、插话、开新话题、删除）；跟进一轮（同一时间只有一个实例在跟）；
 * 改一个群的分工单（assign，名下是群的 id）
 */
type LockName = 'message' | 'follow' | 'assign';

/** 画布上的一个任务：任务卡那条消息；群里的另带做它的席位和群的名字 */
interface TaskRow {
  message: Message;
  seat?: { id: string; group: string };
}
const seats = alias(conversations, 'seats');

export interface ConversationRepo {
  /** 拿到这个对话的锁才做；别人拿着时 409（跟进的锁在 follow 名下，和用户操作互不挡） */
  withLock<T>(
    name: LockName,
    conversationId: string,
    work: (repo: ConversationRepo) => Promise<T>,
  ): Promise<T>;
  upsertDm(ownerId: string, modelKey: string, title: string): Promise<Conversation>;
  listDms(ownerId: string): Promise<Conversation[]>;
  findOwned(id: string, ownerId: string): Promise<Conversation | undefined>;
  find(id: string): Promise<Conversation | undefined>;
  insertMessage(message: NewMessage): Promise<Message>;
  /** 改一条消息；消息已经不在了（被删）返回 undefined */
  updateMessage(id: string, patch: MessagePatch): Promise<Message | undefined>;
  deleteMessage(id: string): Promise<void>;
  touchConversation(id: string): Promise<void>;
  /** 最近的 limit 条消息，按先后 */
  listMessages(conversationId: string, limit: number): Promise<Message[]>;
  /**
   * 这个人的任务卡（画布按任务分），新的在前：私聊里的，和他当群主的群里的（seat 是做它的那个 AI 的席位，
   * 群的名字在 group 里；席位已经不在的不算）
   */
  listTasks(ownerId: string, limit: number): Promise<TaskRow[]>;
  findMessage(conversationId: string, id: string): Promise<Message | undefined>;
  /** AI 干活时用户发来、还排着队的话（这一轮做完接着开下一轮），按发的先后 */
  pendingMessages(conversationId: string): Promise<Message[]>;
  /** 排着队的话交给 AI 时挪到最后：聊天里按交给 AI 的先后排。消息不在了返回 undefined */
  moveToEnd(conversationId: string, id: string): Promise<Message | undefined>;
  /** 这段对话里所有消息带的附件 ID（删私聊时用） */
  attachmentIds(conversationId: string): Promise<string[]>;
  /** 删掉整段对话：消息随之级联删除 */
  deleteConversation(id: string): Promise<void>;
  /** 开一轮：这个对话没有正在进行的一轮时记下；已经有就返回 false */
  startTurn(id: string, turn: Turn): Promise<boolean>;
  /** 改正在进行的这一轮（只改给的字段；这一轮已经不是 runId 时不改，返回 false） */
  updateTurn(id: string, runId: string, patch: Partial<Turn>): Promise<boolean>;
  /** 这一轮结束：清掉，记下下一轮接着哪一轮（null：下一轮开新会话） */
  endTurn(id: string, runId: string, lastRunId: string | null): Promise<void>;
  /** 有一轮在进行的对话 */
  activeTurns(): Promise<Conversation[]>;
  /** 开新话题：下一轮开新会话 */
  newTopic(id: string): Promise<void>;
  /** 改在哪干活和权限（下一轮起用） */
  saveSetup(id: string, setup: Pick<Conversation, 'workplace' | 'permissions'>): Promise<void>;
}

/** 拿 message 锁：AI 的进度正在写进消息时锁会被占一小会儿，等一等再拿（最多约 5 秒） */
export async function withMessageLock<T>(
  repo: ConversationRepo,
  conversationId: string,
  work: (store: ConversationRepo) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await repo.withLock('message', conversationId, work);
    } catch (err) {
      if (!(err instanceof HttpError && err.code === 'conversation_busy') || attempt >= 50)
        throw err;
      await sleep(100);
    }
  }
}

/** 会话锁的租约：持有期间每 10 秒续一次；进程崩了，30 秒后别的实例就能接着处理这段对话 */
const LOCK_LEASE_SECONDS = 30;
const LOCK_RENEW_MS = 10_000;

export function createConversationRepo(
  pool: pg.Pool | pg.PoolClient,
  heldLocks: ReadonlySet<string> = new Set(),
): ConversationRepo {
  const db = drizzle(pool);
  /**
   * 锁是 conversation_locks 里的一行租约，不占着连接等别的服务
   * （以前用会话级 advisory lock，每轮要占一条连接，几个人同时用就把连接池占满）。
   */
  async function lock<T>(
    name: LockName,
    conversationId: string,
    work: (repo: ConversationRepo) => Promise<T>,
  ): Promise<T> {
    const key = `${name}:${conversationId}`;
    if (heldLocks.has(key)) return work(repo);
    const holder = randomUUID();
    const taken = await pool.query(
      `insert into conversation_locks (key, holder, expires_at)
       values ($1, $2, now() + make_interval(secs => $3))
       on conflict (key) do update set holder = excluded.holder, expires_at = excluded.expires_at
       where conversation_locks.expires_at < now()`,
      [key, holder, LOCK_LEASE_SECONDS],
    );
    if (!taken.rowCount)
      throw new HttpError(409, 'conversation_busy', '正在处理这段对话，请稍候再试');
    // 续租失败（数据库短暂不可用）不打断：下次再续，真过期了别的请求才可能接手
    const renew = setInterval(() => {
      pool
        .query(
          'update conversation_locks set expires_at = now() + make_interval(secs => $3) where key = $1 and holder = $2',
          [key, holder, LOCK_LEASE_SECONDS],
        )
        .catch(() => {});
    }, LOCK_RENEW_MS);
    renew.unref();
    try {
      return await work(createConversationRepo(pool, new Set([...heldLocks, key])));
    } finally {
      clearInterval(renew);
      // 释放失败也没关系：租约到期自动失效
      await pool
        .query('delete from conversation_locks where key = $1 and holder = $2', [key, holder])
        .catch(() => {});
    }
  }

  const repo: ConversationRepo = {
    withLock: lock,

    async upsertDm(ownerId, modelKey, title) {
      await db
        .insert(conversations)
        .values({ kind: 'dm', ownerId, modelKey, title })
        .onConflictDoNothing({
          target: [conversations.ownerId, conversations.modelKey],
          where: sql`kind = 'dm'`,
        });
      const [row] = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.ownerId, ownerId),
            eq(conversations.modelKey, modelKey),
            eq(conversations.kind, 'dm'),
          ),
        );
      return row!;
    },

    listDms: (ownerId) =>
      db
        .select()
        .from(conversations)
        .where(and(eq(conversations.ownerId, ownerId), eq(conversations.kind, 'dm')))
        .orderBy(desc(sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`)),

    async findOwned(id, ownerId) {
      const [row] = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.id, id),
            eq(conversations.ownerId, ownerId),
            eq(conversations.kind, 'dm'),
          ),
        );
      return row;
    },

    async find(id) {
      const [row] = await db.select().from(conversations).where(eq(conversations.id, id));
      return row;
    },

    async insertMessage(message) {
      const [row] = await db.insert(messages).values(message).returning();
      return row!;
    },

    async updateMessage(id, patch) {
      const [row] = await db.update(messages).set(patch).where(eq(messages.id, id)).returning();
      return row;
    },

    async deleteMessage(id) {
      await db.delete(messages).where(eq(messages.id, id));
    },

    async touchConversation(id) {
      await db
        .update(conversations)
        .set({ lastMessageAt: sql`now()` })
        .where(eq(conversations.id, id));
    },

    listMessages: async (conversationId, limit) =>
      (
        await db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
          .orderBy(desc(messages.seq))
          .limit(limit)
      ).reverse(),

    listTasks: async (ownerId, limit) =>
      (
        await db
          .select({ message: messages, group: conversations.title, seat: seats.id })
          .from(messages)
          .innerJoin(conversations, eq(conversations.id, messages.conversationId))
          .leftJoin(
            seats,
            and(
              eq(seats.parentId, conversations.id),
              eq(seats.kind, 'seat'),
              eq(seats.modelKey, messages.authorId),
            ),
          )
          .where(
            and(
              eq(conversations.ownerId, ownerId),
              eq(messages.kind, 'task'),
              or(
                eq(conversations.kind, 'dm'),
                and(eq(conversations.kind, 'group'), isNotNull(seats.id)),
              ),
            ),
          )
          .orderBy(desc(messages.createdAt))
          .limit(limit)
      ).map(({ message, group, seat }) => ({
        message,
        ...(seat ? { seat: { id: seat, group } } : {}),
      })),

    async findMessage(conversationId, id) {
      const [row] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.id, id), eq(messages.conversationId, conversationId)));
      return row;
    },

    pendingMessages: (conversationId) =>
      db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.authorKind, 'user'),
            sql`${messages.data}->>'pending' = 'true'`,
          ),
        )
        .orderBy(asc(messages.seq)),

    async moveToEnd(conversationId, id) {
      // 和新消息一样从对话的计数里取下一个序号
      const [next] = await db
        .update(conversations)
        .set({ nextMessageSeq: sql`${conversations.nextMessageSeq} + 1` })
        .where(eq(conversations.id, conversationId))
        .returning({ seq: conversations.nextMessageSeq });
      if (!next) return undefined;
      const [row] = await db
        .update(messages)
        .set({ seq: next.seq })
        .where(and(eq(messages.id, id), eq(messages.conversationId, conversationId)))
        .returning();
      return row;
    },

    async attachmentIds(conversationId) {
      const rows = await db.execute<{ id: string }>(
        sql`select distinct a->>'id' as id
              from ${messages}, jsonb_array_elements(coalesce(${messages.data}->'attachments', '[]'::jsonb)) a
             where ${messages.conversationId} = ${conversationId}`,
      );
      return rows.rows.map((r) => r.id).filter(Boolean);
    },

    async deleteConversation(id) {
      await db.delete(conversations).where(eq(conversations.id, id));
    },

    async startTurn(id, turn) {
      const rows = await db
        .update(conversations)
        .set({ turn })
        .where(and(eq(conversations.id, id), sql`${conversations.turn} is null`))
        .returning({ id: conversations.id });
      return rows.length > 0;
    },

    async updateTurn(id, runId, patch) {
      const rows = await db
        .update(conversations)
        .set({ turn: sql`${conversations.turn} || ${JSON.stringify(patch)}::jsonb` })
        .where(and(eq(conversations.id, id), sql`${conversations.turn}->>'runId' = ${runId}`))
        .returning({ id: conversations.id });
      return rows.length > 0;
    },

    async endTurn(id, runId, lastRunId) {
      await db
        .update(conversations)
        .set({ turn: null, lastRunId })
        .where(and(eq(conversations.id, id), sql`${conversations.turn}->>'runId' = ${runId}`));
    },

    activeTurns: () => db.select().from(conversations).where(isNotNull(conversations.turn)),

    async newTopic(id) {
      await db.update(conversations).set({ lastRunId: null }).where(eq(conversations.id, id));
    },

    async saveSetup(id, setup) {
      await db.update(conversations).set(setup).where(eq(conversations.id, id));
    },
  };
  return repo;
}
