// 群的邀请：一次性的邀请码，24 小时有效，库里只存摘要。
import type pg from 'pg';
import { GROUP_HISTORY_NOTICE, type GroupSnapshot } from '@oasis/contracts/group';
import { HttpError } from '@oasis/service-kit';
import type { GroupRow } from './group-rows.ts';
import type { groupInvites as invitesTable } from './schema.ts';

/** 群仓库里邀请要用到的几样 */
interface GroupShared {
  pool: pg.Pool;
  maxMembers: number;
  transaction<T>(work: (db: pg.PoolClient) => Promise<T>): Promise<T>;
  ownedByOwner(db: pg.PoolClient, id: string, userId: string, what: string): Promise<GroupRow>;
  capacity(db: pg.PoolClient, userId: string): Promise<void>;
  snapshot(db: pg.PoolClient, row: GroupRow): Promise<GroupSnapshot>;
}

export function groupInvites(shared: GroupShared) {
  const { pool, transaction, ownedByOwner, capacity, snapshot } = shared;
  return {
    invite(userId: string, id: string, hash: string, expiresAt: Date) {
      return transaction(async (db) => {
        await ownedByOwner(db, id, userId, '管理邀请');
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
        await ownedByOwner(db, id, userId, '管理邀请');
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
          await db.query<Pick<typeof invitesTable.$inferSelect, 'usedBy' | 'usedAt' | 'expiresAt'>>(
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
          if (size >= shared.maxMembers) throw new HttpError(409, 'group_full', '这个群已满');
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
  };
}
