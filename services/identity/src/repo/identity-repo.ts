// identity 的数据访问：只做读写，不含业务规则。
import type { EventEnvelope } from '@oasis/contracts/events';
import { and, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
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
      /** 挑一个账号 ID（8 位数字）；撞上已有的会再挑 */
      accountNo: () => string;
    }): Promise<{ user: User; isNewUser: boolean } | undefined> {
      return db.transaction(async (tx) => {
        const consumed = await tx
          .update(emailCodes)
          .set({ consumedAt: new Date() })
          .where(and(eq(emailCodes.id, input.codeId), isNull(emailCodes.consumedAt)))
          .returning({ id: emailCodes.id });
        if (consumed.length === 0) return undefined;

        let [user] = await tx.select().from(users).where(eq(users.email, input.email));
        let created: User | undefined;
        if (!user) {
          // 新用户：挑一个没人用的账号 ID，名字先叫「用户」加它的后四位
          let accountNo = '';
          for (let attempt = 0; attempt < 8 && !accountNo; attempt += 1) {
            const candidate = input.accountNo();
            const taken = await tx
              .select({ id: users.id })
              .from(users)
              .where(eq(users.accountNo, candidate));
            if (!taken.length) accountNo = candidate;
          }
          if (!accountNo) throw new Error('没挑到没人用的账号 ID');
          [created] = await tx
            .insert(users)
            .values({ email: input.email, accountNo, name: `用户${accountNo.slice(-4)}` })
            .onConflictDoNothing({ target: users.email })
            .returning();
          user = created ?? (await tx.select().from(users).where(eq(users.email, input.email)))[0]!;
        }
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

    /**
     * 记一次「按账号 ID 查人」：这个人从 since 起查的次数还没到 limit 就记下这一次、返回 true，到了返回 false。
     * 同一个人的几次请求排着队算（事务里的 advisory 锁），开几份服务都只认库里这一份。
     */
    takeLookup(userId: string, at: Date, since: Date, limit: number): Promise<boolean> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
        await tx.execute(
          sql`delete from profile_lookups where user_id = ${userId} and at <= ${since.toISOString()}`,
        );
        const { rows } = await tx.execute<{ count: string }>(
          sql`select count(*) as count from profile_lookups where user_id = ${userId}`,
        );
        if (Number(rows[0]?.count ?? 0) >= limit) return false;
        await tx.execute(
          sql`insert into profile_lookups (user_id, at) values (${userId}, ${at.toISOString()})`,
        );
        return true;
      });
    },

    async findByAccountNo(accountNo: string): Promise<User | undefined> {
      const [row] = await db.select().from(users).where(eq(users.accountNo, accountNo));
      return row;
    },

    findUsers(ids: string[]): Promise<User[]> {
      return ids.length
        ? db.select().from(users).where(inArray(users.id, ids))
        : Promise.resolve([]);
    },

    async updateProfile(
      id: string,
      profile: Pick<User, 'name' | 'bio' | 'gender' | 'region'>,
    ): Promise<User | undefined> {
      const [row] = await db.update(users).set(profile).where(eq(users.id, id)).returning();
      return row;
    },

    /** 换头像（content 为 null 是去掉头像）；版本加一，头像地址跟着变 */
    async setAvatar(
      id: string,
      avatar: { content: Buffer; type: string } | null,
    ): Promise<User | undefined> {
      await pool.query(
        'update users set avatar=$2, avatar_type=$3, avatar_version=avatar_version+1 where id=$1',
        [id, avatar?.content ?? null, avatar?.type ?? null],
      );
      const [row] = await db.select().from(users).where(eq(users.id, id));
      return row;
    },

    async avatar(id: string): Promise<{ content: Buffer; type: string } | undefined> {
      const { rows } = await pool.query<{ avatar: Buffer | null; avatar_type: string | null }>(
        'select avatar, avatar_type from users where id=$1',
        [id],
      );
      const row = rows[0];
      return row?.avatar && row.avatar_type
        ? { content: row.avatar, type: row.avatar_type }
        : undefined;
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
