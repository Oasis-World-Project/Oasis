import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { GROUP_HISTORY_NOTICE, type GroupSnapshot } from '@oasis/contracts/group';
import { HttpError } from '@oasis/service-kit';
import type { groupMembers, groupInvites } from './schema.ts';

type GroupRow = { id: string; title: string; owner_id: string; created_at: Date };
type Limits = { members: number; groups: number; messagesPerMinute: number };
const missing = () => new HttpError(404, 'group_not_found', '没有这个群，或你已不在群里');

export function createGroupRepo(pool: pg.Pool, limits: Limits) {
  async function transaction<T>(work: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    const db = await pool.connect();
    try {
      await db.query('begin');
      const value = await work(db);
      await db.query('commit');
      return value;
    } catch (error) {
      await db.query('rollback');
      throw error;
    } finally {
      db.release();
    }
  }
  async function owned(db: pg.PoolClient, id: string, userId: string) {
    const row = (
      await db.query<GroupRow>(
        "select * from conversations where id=$1 and kind='group' for update",
        [id],
      )
    ).rows[0];
    if (
      !row ||
      !(
        await db.query(
          'select 1 from group_members where conversation_id=$1 and user_id=$2 and left_at is null',
          [id, userId],
        )
      ).rowCount
    )
      throw missing();
    return row;
  }
  async function capacity(db: pg.PoolClient, userId: string) {
    await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`groups:${userId}`]);
    const count = (
      await db.query(
        'select count(*)::int n from group_members where user_id=$1 and left_at is null',
        [userId],
      )
    ).rows[0].n as number;
    if (count >= limits.groups) throw new HttpError(409, 'group_limit', '加入的群已达上限');
  }
  async function snapshot(
    db: pg.PoolClient,
    row: GroupRow,
    cursor?: { after?: number; before?: number },
  ): Promise<GroupSnapshot> {
    const members = (
      await db.query<Pick<typeof groupMembers.$inferSelect, 'userId' | 'displayName' | 'joinedAt'>>(
        'select user_id as "userId",display_name as "displayName",joined_at as "joinedAt" from group_members where conversation_id=$1 and left_at is null order by joined_at,user_id',
        [row.id],
      )
    ).rows;
    const after = cursor?.after,
      before = cursor?.before;
    const messages = (
      await db.query<{
        id: string;
        seq: string;
        author_id: string;
        content: string;
        created_at: Date;
        data: { displayName?: string };
      }>(
        `select id,seq,author_id,content,created_at,data from messages where conversation_id=$1 and ($2::bigint is null or seq>$2) and ($3::bigint is null or seq<$3) order by seq ${after === undefined ? 'desc' : 'asc'} limit 100`,
        [row.id, after ?? null, before ?? null],
      )
    ).rows;
    if (after === undefined) messages.reverse();
    return {
      id: row.id,
      title: row.title,
      ownerId: row.owner_id,
      createdAt: row.created_at.toISOString(),
      memberCount: members.length,
      historyNotice: GROUP_HISTORY_NOTICE,
      members: members.map((member) => ({
        userId: member.userId,
        displayName: member.displayName,
        joinedAt: member.joinedAt.toISOString(),
      })),
      messages: messages.map((message) => ({
        id: message.id,
        seq: Number(message.seq),
        authorId: message.author_id,
        content: message.content,
        createdAt: message.created_at.toISOString(),
        displayName: message.data.displayName ?? '成员',
      })),
    };
  }
  return {
    async list(userId: string) {
      const rows = (
        await pool.query<GroupRow & { member_count: number }>(
          "select c.*, (select count(*)::int from group_members m where m.conversation_id=c.id and m.left_at is null) member_count from conversations c join group_members m on m.conversation_id=c.id where c.kind='group' and m.user_id=$1 and m.left_at is null order by coalesce(c.last_message_at,c.created_at) desc,c.id",
          [userId],
        )
      ).rows;
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        ownerId: row.owner_id,
        createdAt: row.created_at.toISOString(),
        memberCount: row.member_count,
      }));
    },
    create(userId: string, title: string, displayName: string) {
      return transaction(async (db) => {
        await capacity(db, userId);
        const row = (
          await db.query<GroupRow>(
            "insert into conversations(kind,owner_id,title) values('group',$1,$2) returning *",
            [userId, title],
          )
        ).rows[0]!;
        await db.query(
          'insert into group_members(conversation_id,user_id,display_name) values($1,$2,$3)',
          [row.id, userId, displayName],
        );
        return snapshot(db, row);
      });
    },
    get(userId: string, id: string, cursor?: { after?: number; before?: number }) {
      return transaction(async (db) => snapshot(db, await owned(db, id, userId), cursor));
    },
    invite(userId: string, id: string, hash: string, expiresAt: Date) {
      return transaction(async (db) => {
        const group = await owned(db, id, userId);
        if (group.owner_id !== userId)
          throw new HttpError(403, 'owner_required', '只有群主可以管理邀请');
        // 重新生成即撤销旧邀请；删除过期/已使用行，避免邀请码记录无限增长。
        await db.query('delete from group_invites where conversation_id=$1', [id]);
        await db.query(
          'insert into group_invites(token_hash,conversation_id,expires_at) values($1,$2,$3)',
          [hash, id, expiresAt],
        );
      });
    },
    revoke(userId: string, id: string) {
      return transaction(async (db) => {
        const group = await owned(db, id, userId);
        if (group.owner_id !== userId)
          throw new HttpError(403, 'owner_required', '只有群主可以管理邀请');
        await db.query('delete from group_invites where conversation_id=$1', [id]);
      });
    },
    async preview(hash: string) {
      const row = (
        await pool.query<{ title: string }>(
          "select c.title from group_invites i join conversations c on c.id=i.conversation_id where i.token_hash=$1 and i.used_at is null and i.expires_at>now() and c.kind='group'",
          [hash],
        )
      ).rows[0];
      if (!row) throw new HttpError(410, 'invite_closed', '邀请已失效或已使用');
      return { title: row.title, historyNotice: GROUP_HISTORY_NOTICE };
    },
    redeem(userId: string, hash: string, displayName: string) {
      return transaction(async (db) => {
        const invite = (
          await db.query<{ conversation_id: string }>(
            'select conversation_id from group_invites where token_hash=$1',
            [hash],
          )
        ).rows[0];
        if (!invite) throw new HttpError(410, 'invite_closed', '邀请已失效或已使用');
        // 所有准入均先锁用户再锁群；成员修改和消息发送均锁同一群行。
        await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
          `groups:${userId}`,
        ]);
        const row = (
          await db.query<GroupRow>(
            "select * from conversations where id=$1 and kind='group' for update",
            [invite.conversation_id],
          )
        ).rows[0];
        const ticket = (
          await db.query<Pick<typeof groupInvites.$inferSelect, 'usedBy' | 'usedAt' | 'expiresAt'>>(
            'select used_by as "usedBy",used_at as "usedAt",expires_at as "expiresAt" from group_invites where token_hash=$1 for update',
            [hash],
          )
        ).rows[0];
        if (!row || !ticket || ticket.expiresAt <= new Date())
          throw new HttpError(410, 'invite_closed', '邀请已失效或已使用');
        const member = (
          await db.query(
            'select 1 from group_members where conversation_id=$1 and user_id=$2 and left_at is null',
            [row.id, userId],
          )
        ).rowCount;
        if (ticket.usedAt) {
          if (ticket.usedBy === userId && member) return snapshot(db, row);
          throw new HttpError(410, 'invite_closed', '邀请已失效或已使用');
        }
        if (!member) {
          await capacity(db, userId);
          const size = (
            await db.query(
              'select count(*)::int n from group_members where conversation_id=$1 and left_at is null',
              [row.id],
            )
          ).rows[0].n as number;
          if (size >= limits.members) throw new HttpError(409, 'group_full', '这个群已满');
          await db.query(
            'insert into group_members(conversation_id,user_id,display_name) values($1,$2,$3) on conflict(conversation_id,user_id) do update set display_name=excluded.display_name,joined_at=now(),left_at=null',
            [row.id, userId, displayName],
          );
        }
        await db.query('update group_invites set used_at=now(),used_by=$2 where token_hash=$1', [
          hash,
          userId,
        ]);
        return snapshot(db, row);
      });
    },
    remove(userId: string, id: string, target: string) {
      return transaction(async (db) => {
        const row = await owned(db, id, userId);
        if (target === row.owner_id)
          throw new HttpError(409, 'owner_cannot_leave', '群主不能退出，请解散群');
        if (userId !== row.owner_id && target !== userId)
          throw new HttpError(403, 'owner_required', '只有群主可以移除其他成员');
        await db.query(
          'update group_members set left_at=now() where conversation_id=$1 and user_id=$2 and left_at is null',
          [id, target],
        );
      });
    },
    destroy(userId: string, id: string) {
      return transaction(async (db) => {
        const row = await owned(db, id, userId);
        if (row.owner_id !== userId)
          throw new HttpError(403, 'owner_required', '只有群主可以解散群');
        await db.query('delete from conversations where id=$1', [id]);
      });
    },
    send(userId: string, id: string, content: string, requestId: string) {
      return transaction(async (db) => {
        const row = await owned(db, id, userId);
        const previous = (
          await db.query<{ content: string }>(
            "select content from messages where conversation_id=$1 and author_kind='user' and author_id=$2 and data->>'clientRequestId'=$3",
            [id, userId, requestId],
          )
        ).rows[0];
        if (previous) {
          if (previous.content !== content)
            throw new HttpError(409, 'message_conflict', '同一发送请求的内容不一致');
          return snapshot(db, row);
        }
        const count = (
          await db.query(
            "select count(*)::int n from messages where conversation_id=$1 and author_id=$2 and created_at>now()-interval '1 minute'",
            [id, userId],
          )
        ).rows[0].n as number;
        if (count >= limits.messagesPerMinute)
          throw new HttpError(429, 'message_rate', '发送太快，请稍后再试');
        const member = (
          await db.query<{ display_name: string }>(
            'select display_name from group_members where conversation_id=$1 and user_id=$2',
            [id, userId],
          )
        ).rows[0]!;
        await db.query(
          "insert into messages(id,conversation_id,author_kind,author_id,content,status,kind,data) values($1,$2,'user',$3,$4,'complete','text',$5)",
          [
            randomUUID(),
            id,
            userId,
            content,
            { clientRequestId: requestId, displayName: member.display_name },
          ],
        );
        await db.query('update conversations set last_message_at=now() where id=$1', [id]);
        return snapshot(db, row);
      });
    },
  };
}
export type GroupRepo = ReturnType<typeof createGroupRepo>;
