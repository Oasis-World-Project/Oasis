import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { HttpError } from '@oasis/service-kit';
import { conversations, intakes, messages } from './schema.ts';

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Intake = typeof intakes.$inferSelect;
type NewMessage = Pick<
  typeof messages.$inferInsert,
  'conversationId' | 'authorKind' | 'authorId' | 'content' | 'status' | 'kind' | 'data'
>;
type IntakePatch = Partial<
  Pick<Intake, 'status' | 'round' | 'turns' | 'cardMessageId' | 'sheet' | 'taskId' | 'materials'>
>;

export interface ConversationRepo {
  saveIntakeAnswers(
    id: string,
    cardId: string,
    turns: Intake['turns'],
    answers: Record<string, string>,
  ): Promise<Intake>;
  commitIntakeReply(id: string, message: NewMessage, patch: IntakePatch): Promise<Message>;
  withIntakeLock<T>(
    conversationId: string,
    work: (repo: ConversationRepo) => Promise<T>,
  ): Promise<T>;
  findQuestionCard(
    conversationId: string,
    intakeId: string,
    round: number,
  ): Promise<Message | undefined>;
  upsertDm(ownerId: string, modelKey: string, title: string): Promise<Conversation>;
  listDms(ownerId: string): Promise<Conversation[]>;
  findOwned(id: string, ownerId: string): Promise<Conversation | undefined>;
  insertMessage(message: NewMessage): Promise<Message>;
  /** 由事件触发的消息（data.eventId）：同一个事件只插一次，重复时返回 undefined */
  insertMessageOnce(
    message: NewMessage & { data: { eventId: string } },
  ): Promise<Message | undefined>;
  finishMessage(
    id: string,
    update: { content: string; status: 'complete' | 'failed'; error?: string },
  ): Promise<Message>;
  touchConversation(id: string): Promise<void>;
  /** 最近的已完成消息（不含 excludeId），按时间正序 */
  recentComplete(conversationId: string, limit: number, excludeId: string): Promise<Message[]>;
  listMessages(conversationId: string, limit: number): Promise<Message[]>;
  findMessage(conversationId: string, id: string): Promise<Message | undefined>;
  setMessageData(id: string, data: Record<string, unknown>): Promise<Message>;
  /** 这个任务的任务卡、交付消息和提醒标上「已替换 / 已删除」（ADR 0012）；返回改了几条 */
  markTaskRemoved(
    conversationId: string,
    taskId: string,
    removed: { replacedBy: string | null },
  ): Promise<number>;
  /** 开始接需求；这个会话已经有进行中的就返回 undefined */
  createIntake(
    intake: Pick<Intake, 'id' | 'conversationId' | 'request' | 'context' | 'materials'>,
  ): Promise<Intake | undefined>;
  /** 这个会话进行中的接需求（在问或等确认） */
  findOpenIntake(conversationId: string): Promise<Intake | undefined>;
  updateIntake(id: string, patch: IntakePatch): Promise<Intake>;
}

export function createConversationRepo(pool: pg.Pool | pg.PoolClient): ConversationRepo {
  const db = drizzle(pool);
  const repo: ConversationRepo = {
    saveIntakeAnswers: (id, cardId, turns, answers) =>
      db.transaction(async (tx) => {
        await tx
          .update(messages)
          .set({ data: sql`${messages.data} || ${JSON.stringify({ answers })}::jsonb` })
          .where(eq(messages.id, cardId));
        const [updated] = await tx
          .update(intakes)
          .set({ turns, cardMessageId: cardId, updatedAt: new Date() })
          .where(eq(intakes.id, id))
          .returning();
        if (!updated) throw new HttpError(404, 'intake_not_found', '没有这件任务');
        return updated;
      }),
    commitIntakeReply: (id, message, patch) =>
      db.transaction(async (tx) => {
        const [previous] = await tx.select().from(intakes).where(eq(intakes.id, id));
        if (!previous) throw new HttpError(404, 'intake_not_found', '没有这件任务');
        if (previous.status === 'sheet' && previous.cardMessageId)
          await tx
            .update(messages)
            .set({ data: sql`${messages.data} || '{"status":"superseded"}'::jsonb` })
            .where(eq(messages.id, previous.cardMessageId));
        const [row] = await tx.insert(messages).values(message).returning();
        await tx
          .update(intakes)
          .set({ ...patch, cardMessageId: row!.id, updatedAt: new Date() })
          .where(eq(intakes.id, id));
        return row!;
      }),
    async withIntakeLock(conversationId, work) {
      if ('release' in pool) return work(repo);
      const client = await pool.connect();
      const key = `intake:${conversationId}`;
      let locked = false,
        broken = false;
      try {
        locked = (
          await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) locked', [key])
        ).rows[0].locked;
        if (!locked)
          throw new HttpError(409, 'intake_busy', '正在整理这件任务，请稍候，不要重复提交');
        return await work(createConversationRepo(client));
      } finally {
        if (locked) {
          try {
            await client.query('select pg_advisory_unlock(hashtextextended($1,0))', [key]);
          } catch {
            broken = true;
          }
        }
        client.release(broken);
      }
    },
    async findQuestionCard(conversationId, intakeId, round) {
      const [row] = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.kind, 'questions'),
            sql`${messages.data}->>'intakeId' = ${intakeId}`,
            sql`${messages.data}->>'round' = ${String(round)}`,
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(1);
      return row;
    },
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

    async insertMessage(message) {
      const [row] = await db.insert(messages).values(message).returning();
      return row!;
    },

    async insertMessageOnce(message) {
      const [row] = await db.insert(messages).values(message).onConflictDoNothing().returning();
      return row;
    },

    async finishMessage(id, update) {
      const [row] = await db
        .update(messages)
        .set({ content: update.content, status: update.status, error: update.error ?? null })
        .where(eq(messages.id, id))
        .returning();
      return row!;
    },

    async touchConversation(id) {
      await db
        .update(conversations)
        .set({ lastMessageAt: sql`now()` })
        .where(eq(conversations.id, id));
    },

    async recentComplete(conversationId, limit, excludeId) {
      const rows = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.status, 'complete'),
            ne(messages.id, excludeId),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(limit);
      return rows.reverse();
    },

    async findMessage(conversationId, id) {
      const [row] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.id, id), eq(messages.conversationId, conversationId)));
      return row;
    },

    async setMessageData(id, data) {
      const [row] = await db.update(messages).set({ data }).where(eq(messages.id, id)).returning();
      return row!;
    },

    async markTaskRemoved(conversationId, taskId, removed) {
      const rows = await db
        .update(messages)
        .set({
          data: sql`${messages.data} || jsonb_build_object('removed', ${JSON.stringify(removed)}::jsonb)`,
        })
        .where(
          and(
            eq(messages.conversationId, conversationId),
            inArray(messages.kind, ['task', 'delivery', 'notice']),
            sql`${messages.data}->>'taskId' = ${taskId}`,
          ),
        )
        .returning({ id: messages.id });
      return rows.length;
    },

    async createIntake(intake) {
      const [row] = await db
        .insert(intakes)
        .values({ ...intake, status: 'asking' })
        .onConflictDoNothing()
        .returning();
      return row;
    },

    async findOpenIntake(conversationId) {
      const [row] = await db
        .select()
        .from(intakes)
        .where(
          and(
            eq(intakes.conversationId, conversationId),
            inArray(intakes.status, ['asking', 'sheet']),
          ),
        );
      return row;
    },

    async updateIntake(id, patch) {
      const [row] = await db
        .update(intakes)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(intakes.id, id))
        .returning();
      return row!;
    },

    listMessages: (conversationId, limit) =>
      db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt))
        .limit(limit),
  };
  return repo;
}
