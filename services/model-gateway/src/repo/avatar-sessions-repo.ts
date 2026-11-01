// 实时数字人会话表（ADR 0013）。状态只往前走：starting → live → ended；结束、结算、清理各只发生一次。
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import type { AvatarTurn } from '@oasis/contracts/avatar';
import { avatarSessions, type AvatarResources } from './schema.ts';

export type AvatarSession = typeof avatarSessions.$inferSelect;
type NewAvatarSession = Pick<
  typeof avatarSessions.$inferInsert,
  | 'id'
  | 'payerId'
  | 'artifactId'
  | 'taskId'
  | 'sandbox'
  | 'maxSeconds'
  | 'pricePerMinuteMicro'
  | 'spec'
>;

/** 一个会话最多记这么多轮（再多页面也看不过来） */
const MAX_TURNS = 200;

export interface AvatarSessionsRepo {
  create(session: NewAvatarSession): Promise<void>;
  get(id: string): Promise<AvatarSession | undefined>;
  /** 记下新建好的资源（和已有的合并） */
  addResources(id: string, resources: AvatarResources): Promise<void>;
  setCall(id: string, callId: string): Promise<void>;
  markLive(id: string, startedAt: Date): Promise<void>;
  /** 套餐不允许那么长时，改成实际允许的单次最长时长 */
  setMaxSeconds(id: string, maxSeconds: number): Promise<void>;
  /** 结束；只有第一次结束会返回会话（之后返回 undefined） */
  end(id: string, reason: string, endedAt: Date): Promise<AvatarSession | undefined>;
  appendTurn(id: string, turn: AvatarTurn): Promise<void>;
  /** 用 LiveAvatar 记录的结束原因更正（页面收到的事件可能不带原因） */
  setEndReason(id: string, reason: string): Promise<void>;
  /** 记结算结果；只有第一次会成功 */
  markSettled(id: string, chargedMicro: number, at: Date): Promise<boolean>;
  markCleaned(id: string, at: Date): Promise<void>;
  /** 还没收尾的会话：进行中、已结束但没结算或没清理、开始了太久还没开成 */
  unfinished(limit: number): Promise<AvatarSession[]>;
}

export function createAvatarSessionsRepo(pool: pg.Pool): AvatarSessionsRepo {
  const db = drizzle(pool);
  const t = avatarSessions;
  return {
    async create(session) {
      await db.insert(t).values({ ...session, status: 'starting' });
    },
    async get(id) {
      const [row] = await db.select().from(t).where(eq(t.id, id));
      return row;
    },
    async addResources(id, resources) {
      await db
        .update(t)
        .set({ resources: sql`${t.resources} || ${JSON.stringify(resources)}::jsonb` })
        .where(eq(t.id, id));
    },
    async setCall(id, callId) {
      await db.update(t).set({ callId }).where(eq(t.id, id));
    },
    async setMaxSeconds(id, maxSeconds) {
      await db.update(t).set({ maxSeconds }).where(eq(t.id, id));
    },
    async markLive(id, startedAt) {
      await db
        .update(t)
        .set({ status: 'live', startedAt })
        .where(and(eq(t.id, id), eq(t.status, 'starting')));
    },
    async end(id, reason, endedAt) {
      const [row] = await db
        .update(t)
        .set({ status: 'ended', endReason: reason, endedAt })
        .where(and(eq(t.id, id), ne(t.status, 'ended')))
        .returning();
      return row;
    },
    async appendTurn(id, turn) {
      await db
        .update(t)
        .set({ turns: sql`${t.turns} || jsonb_build_array(${JSON.stringify(turn)}::jsonb)` })
        .where(and(eq(t.id, id), sql`jsonb_array_length(${t.turns}) < ${MAX_TURNS}`));
    },
    async setEndReason(id, reason) {
      await db.update(t).set({ endReason: reason }).where(eq(t.id, id));
    },
    async markSettled(id, chargedMicro, at) {
      const rows = await db
        .update(t)
        .set({ settledAt: at, chargedMicro })
        .where(and(eq(t.id, id), isNull(t.settledAt)))
        .returning({ id: t.id });
      return rows.length > 0;
    },
    async markCleaned(id, at) {
      await db.update(t).set({ cleanedAt: at }).where(eq(t.id, id));
    },
    async unfinished(limit) {
      return db
        .select()
        .from(t)
        .where(or(ne(t.status, 'ended'), isNull(t.settledAt), isNull(t.cleanedAt)))
        .orderBy(t.createdAt)
        .limit(limit);
    },
  };
}
