// 好友的存储：申请、好友关系、两个好友之间的私聊（kind = 'direct' 的一条会话，两人都是成员）。
import type pg from 'pg';
import { HttpError } from '@oasis/service-kit';
import { inTransaction } from './tx.ts';

type Limits = { friends: number; pending: number };
export interface FriendRow {
  friend_id: string;
  created_at: Date;
  chat_id: string | null;
}
export interface FriendRequestRow {
  id: string;
  from_id: string;
  to_id: string;
  message: string;
  created_at: Date;
}
/** 一对好友在库里的那一行：小的 ID 在前 */
const PAIR = 'user_a=least($1::uuid,$2::uuid) and user_b=greatest($1::uuid,$2::uuid)';
/** 两人私聊的 direct_key */
const KEY = "least($1::uuid,$2::uuid)::text||':'||greatest($1::uuid,$2::uuid)::text";

export async function areFriends(db: pg.Pool | pg.PoolClient, a: string, b: string) {
  return Boolean((await db.query(`select 1 from friendships where ${PAIR}`, [a, b])).rowCount);
}

export function createFriendRepo(pool: pg.Pool, limits: Limits) {
  /** 同一对人的操作一个个来（互相申请、同时同意） */
  const lockPair = (db: pg.PoolClient, a: string, b: string) =>
    db.query(`select pg_advisory_xact_lock(hashtextextended(${KEY},0))`, [a, b]);
  async function roomFor(db: pg.PoolClient, userId: string, what: string) {
    const count = (
      await db.query<{ n: number }>(
        'select count(*)::int n from friendships where user_a=$1 or user_b=$1',
        [userId],
      )
    ).rows[0]!.n;
    if (count >= limits.friends) throw new HttpError(409, 'friend_limit', what);
  }
  /** 成为好友：两个方向的申请都删掉 */
  async function befriend(db: pg.PoolClient, a: string, b: string) {
    await roomFor(db, a, '好友已达上限');
    await roomFor(db, b, '对方的好友已达上限');
    await db.query(
      'insert into friendships(user_a,user_b) values(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid)) on conflict do nothing',
      [a, b],
    );
    await db.query(
      'delete from friend_requests where (from_id=$1 and to_id=$2) or (from_id=$2 and to_id=$1)',
      [a, b],
    );
  }

  return {
    /** 我的好友（新加的在前），连同和他的私聊（没聊过为空） */
    async friends(userId: string) {
      return (
        await pool.query<FriendRow>(
          `select case when f.user_a=$1 then f.user_b else f.user_a end as friend_id, f.created_at,
             (select c.id from conversations c where c.kind='direct' and c.direct_key=f.user_a::text||':'||f.user_b::text) as chat_id
           from friendships f where f.user_a=$1 or f.user_b=$1 order by f.created_at desc`,
          [userId],
        )
      ).rows;
    },
    /** 和我有关的申请：别人发给我的、我发出去还没回的（新的在前） */
    async requests(userId: string) {
      return (
        await pool.query<FriendRequestRow>(
          'select id,from_id,to_id,message,created_at from friend_requests where to_id=$1 or from_id=$1 order by created_at desc',
          [userId],
        )
      ).rows;
    },
    /** 申请加好友。对方也申请过我就直接成为好友；重复申请只换验证消息 */
    async request(fromId: string, toId: string, message: string): Promise<'requested' | 'friends'> {
      if (fromId === toId) throw new HttpError(400, 'friend_self', '不能加自己为好友');
      return inTransaction(pool, async (db) => {
        await lockPair(db, fromId, toId);
        if (await areFriends(db, fromId, toId))
          throw new HttpError(409, 'already_friends', '你们已经是好友了');
        const reverse = await db.query(
          'select 1 from friend_requests where from_id=$1 and to_id=$2',
          [toId, fromId],
        );
        if (reverse.rowCount) {
          await befriend(db, fromId, toId);
          return 'friends';
        }
        await roomFor(db, fromId, '好友已达上限');
        const pending = (
          await db.query<{ n: number }>(
            'select count(*)::int n from friend_requests where from_id=$1 and to_id<>$2',
            [fromId, toId],
          )
        ).rows[0]!.n;
        if (pending >= limits.pending)
          throw new HttpError(
            429,
            'friend_request_limit',
            '还没回的好友申请太多了，等对方回了再加',
          );
        await db.query(
          `insert into friend_requests(from_id,to_id,message) values($1,$2,$3)
           on conflict (from_id,to_id) do update set message=excluded.message, created_at=now()`,
          [fromId, toId, message],
        );
        return 'requested';
      });
    },
    /** 同意别人发给我的申请 */
    accept(userId: string, requestId: string) {
      return inTransaction(pool, async (db) => {
        const request = (
          await db.query<FriendRequestRow>(
            'select id,from_id,to_id,message,created_at from friend_requests where id=$1 and to_id=$2',
            [requestId, userId],
          )
        ).rows[0];
        if (!request) throw new HttpError(404, 'friend_request_not_found', '这条好友申请不在了');
        await lockPair(db, request.from_id, userId);
        await befriend(db, userId, request.from_id);
      });
    },
    /** 拒绝别人发给我的申请，或撤回我发出去的：这一行真删除 */
    async dropRequest(userId: string, requestId: string) {
      const { rowCount } = await pool.query(
        'delete from friend_requests where id=$1 and (to_id=$2 or from_id=$2)',
        [requestId, userId],
      );
      if (!rowCount) throw new HttpError(404, 'friend_request_not_found', '这条好友申请不在了');
    },
    /** 删好友：好友关系和两人的私聊（连消息）一起真删除 */
    unfriend(userId: string, friendId: string) {
      return inTransaction(pool, async (db) => {
        await lockPair(db, userId, friendId);
        const { rowCount } = await db.query(`delete from friendships where ${PAIR}`, [
          userId,
          friendId,
        ]);
        if (!rowCount) throw new HttpError(404, 'friend_not_found', '你们不是好友');
        await db.query(`delete from conversations where kind='direct' and direct_key=${KEY}`, [
          userId,
          friendId,
        ]);
      });
    },
    /** 打开和这个好友的私聊：没有就建一个（两人都是成员），返回它的 ID */
    openChat(userId: string, friendId: string, names: { mine: string; theirs: string }) {
      return inTransaction(pool, async (db) => {
        await lockPair(db, userId, friendId);
        if (!(await areFriends(db, userId, friendId)))
          throw new HttpError(403, 'not_friends', '加为好友后才能私聊');
        const existing = (
          await db.query<{ id: string }>(
            `select id from conversations where kind='direct' and direct_key=${KEY}`,
            [userId, friendId],
          )
        ).rows[0];
        if (existing) return existing.id;
        const { id } = (
          await db.query<{ id: string }>(
            `insert into conversations(kind,owner_id,title,direct_key) values('direct',$1,'私聊',${KEY}) returning id`,
            [userId, friendId],
          )
        ).rows[0]!;
        await db.query(
          'insert into group_members(conversation_id,user_id,display_name) values($1,$2,$3),($1,$4,$5)',
          [id, userId, names.mine, friendId, names.theirs],
        );
        return id;
      });
    },
  };
}
export type FriendRepo = ReturnType<typeof createFriendRepo>;
