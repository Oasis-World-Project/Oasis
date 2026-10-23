import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
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
  /** 开始接需求；这个会话已经有进行中的就返回 undefined */
  createIntake(
    intake: Pick<Intake, 'id' | 'conversationId' | 'request' | 'context' | 'materials'>,
  ): Promise<Intake | undefined>;
  /** 这个会话进行中的接需求（在问或等确认） */
  findOpenIntake(conversationId: string): Promise<Intake | undefined>;
  updateIntake(id: string, patch: IntakePatch): Promise<Intake>;
}

export function createConversationRepo(pool: pg.Pool): ConversationRepo {
  const db = drizzle(pool);
  return {
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
        .where(and(eq(conversations.id, id), eq(conversations.ownerId, ownerId)));
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
}
