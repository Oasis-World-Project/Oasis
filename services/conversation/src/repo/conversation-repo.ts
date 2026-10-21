import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { conversations, messages } from './schema.ts';

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
type NewMessage = Pick<
  typeof messages.$inferInsert,
  'conversationId' | 'authorKind' | 'authorId' | 'content' | 'status'
>;

export interface ConversationRepo {
  upsertDm(ownerId: string, modelKey: string, title: string): Promise<Conversation>;
  listDms(ownerId: string): Promise<Conversation[]>;
  findOwned(id: string, ownerId: string): Promise<Conversation | undefined>;
  insertMessage(message: NewMessage): Promise<Message>;
  finishMessage(
    id: string,
    update: { content: string; status: 'complete' | 'failed'; error?: string },
  ): Promise<Message>;
  touchConversation(id: string): Promise<void>;
  /** 最近的已完成消息（不含 excludeId），按时间正序 */
  recentComplete(conversationId: string, limit: number, excludeId: string): Promise<Message[]>;
  listMessages(conversationId: string, limit: number): Promise<Message[]>;
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

    listMessages: (conversationId, limit) =>
      db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt))
        .limit(limit),
  };
}
