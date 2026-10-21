// identity 的数据访问：只做读写，不含业务规则。
import type { EventEnvelope } from '@oasis/contracts/events';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { emailCodes, outbox, sessions, users } from './schema.ts';

export type User = typeof users.$inferSelect;
export type EmailCode = typeof emailCodes.$inferSelect;

export function createIdentityRepo(pool: pg.Pool) {
  const db = drizzle(pool);

  return {
    recentCodes(email: string, since: Date): Promise<EmailCode[]> {
      return db
        .select()
        .from(emailCodes)
        .where(and(eq(emailCodes.email, email), gt(emailCodes.createdAt, since)))
        .orderBy(desc(emailCodes.createdAt));
    },

    async insertCode(values: {
      email: string;
      codeHash: string;
      expiresAt: Date;
    }): Promise<string> {
      const [row] = await db.insert(emailCodes).values(values).returning({ id: emailCodes.id });
      return row!.id;
    },

    async deleteCode(id: string): Promise<void> {
      await db.delete(emailCodes).where(eq(emailCodes.id, id));
    },

    async latestActiveCode(email: string, now: Date): Promise<EmailCode | undefined> {
      const [row] = await db
        .select()
        .from(emailCodes)
        .where(
          and(
            eq(emailCodes.email, email),
            isNull(emailCodes.consumedAt),
            gt(emailCodes.expiresAt, now),
          ),
        )
        .orderBy(desc(emailCodes.createdAt))
        .limit(1);
      return row;
    },

    async addAttempt(id: string): Promise<void> {
      await db
        .update(emailCodes)
        .set({ attempts: sql`${emailCodes.attempts} + 1` })
        .where(eq(emailCodes.id, id));
    },

    /**
     * 用掉验证码并登录：同一个事务里完成「标记已用 → 找到或建用户（新用户写发件箱事件）→ 建会话」。
     * 验证码已被并发请求用掉时返回 undefined。
     */
    async consumeCodeAndSignIn(input: {
      codeId: string;
      email: string;
      session: { tokenHash: string; expiresAt: Date };
      registeredEvent: (userId: string, registeredAt: Date) => EventEnvelope;
    }): Promise<{ user: User; isNewUser: boolean } | undefined> {
      return db.transaction(async (tx) => {
        const consumed = await tx
          .update(emailCodes)
          .set({ consumedAt: new Date() })
          .where(and(eq(emailCodes.id, input.codeId), isNull(emailCodes.consumedAt)))
          .returning({ id: emailCodes.id });
        if (consumed.length === 0) return undefined;

        const [created] = await tx
          .insert(users)
          .values({ email: input.email })
          .onConflictDoNothing({ target: users.email })
          .returning();
        const user =
          created ?? (await tx.select().from(users).where(eq(users.email, input.email)))[0]!;
        if (created) {
          const event = input.registeredEvent(created.id, created.createdAt);
          await tx.insert(outbox).values({ id: event.id, subject: event.type, payload: event });
        }
        await tx.insert(sessions).values({ ...input.session, userId: user.id });
        return { user, isNewUser: Boolean(created) };
      });
    },

    async findUser(id: string): Promise<User | undefined> {
      const [row] = await db.select().from(users).where(eq(users.id, id));
      return row;
    },

    async findSession(tokenHash: string, now: Date) {
      const [row] = await db
        .select({ userId: sessions.userId, lastSeenAt: sessions.lastSeenAt })
        .from(sessions)
        .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)));
      return row;
    },

    async touchSession(tokenHash: string, now: Date, olderThan: Date): Promise<void> {
      await db
        .update(sessions)
        .set({ lastSeenAt: now })
        .where(and(eq(sessions.tokenHash, tokenHash), lt(sessions.lastSeenAt, olderThan)));
    },

    async deleteSession(tokenHash: string): Promise<void> {
      await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    },
  };
}

export type IdentityRepo = ReturnType<typeof createIdentityRepo>;
