// 群里的席位听到什么：轮到一个 AI 时，群里有谁、它没听过的话。
import type pg from 'pg';
import type { Mention } from '@oasis/contracts/conversation';
import {
  MEMBER_NAME,
  MEMBER_ORDER,
  MESSAGE_COLUMNS,
  nameOf,
  seatsOf,
  type GroupRow,
  type MessageRow,
} from './group-rows.ts';

export function createGroupSeats(pool: pg.Pool) {
  return {
    /** 群里的席位（没被移出的），按进群先后 */
    list: (groupId: string) => seatsOf(pool, groupId),
    /** 群里这个 AI 的席位（没被移出的）；不在群里返回 undefined */
    async seat(groupId: string, key: string) {
      return (await seatsOf(pool, groupId)).find((seat) => seat.model_key === key);
    },
    /**
     * 轮到一个席位时要交给它的：群里有谁，和它没听过的话（它自己说的不算；按先后，最多 limit 条，
     * 更早的只数个数）。
     */
    async hearing(seatId: string, limit: number) {
      const seat = (
        await pool.query<{ parent_id: string; model_key: string; heard_seq: string }>(
          "select parent_id,model_key,heard_seq from conversations where id=$1 and kind='seat'",
          [seatId],
        )
      ).rows[0];
      const group = seat
        ? (
            await pool.query<GroupRow>("select * from conversations where id=$1 and kind='group'", [
              seat.parent_id,
            ])
          ).rows[0]
        : undefined;
      if (!seat || !group) return undefined;
      const members = (
        await pool.query<{ userId: string; displayName: string }>(
          `select user_id as "userId",${MEMBER_NAME} as "displayName" from group_members where conversation_id=$1 and left_at is null order by ${MEMBER_ORDER}`,
          [group.id, group.owner_id],
        )
      ).rows;
      const allSeats = await seatsOf(pool, group.id, true);
      const names = new Map([
        ...allSeats.map((item) => [item.model_key, item.title] as const),
        ...members.map((member) => [member.userId, member.displayName] as const),
      ]);
      const unheard = `conversation_id=$1 and seq>$2 and kind='text' and content<>'' and not (author_kind='ai' and author_id=$3)`;
      const args = [group.id, seat.heard_seq, seat.model_key];
      const rows = (
        await pool.query<MessageRow>(
          `select ${MESSAGE_COLUMNS} from messages where ${unheard} order by seq desc limit ${Math.trunc(limit)}`,
          args,
        )
      ).rows.reverse();
      const total = (
        await pool.query<{ n: number }>(
          `select count(*)::int n from messages where ${unheard}`,
          args,
        )
      ).rows[0]!.n;
      return {
        roster: {
          title: group.title,
          ownerId: group.owner_id,
          members,
          ais: allSeats
            .filter((item) => !item.options.removedAt)
            .map((item) => ({
              key: item.model_key,
              name: item.title,
              role: item.options.role ?? '',
            })),
        },
        heard: rows.map((row) => ({
          seq: Number(row.seq),
          authorKind: row.author_kind,
          authorId: row.author_id,
          name: nameOf(row, names),
          content: row.content,
          createdAt: row.created_at,
          mentions: (Array.isArray(row.data.mentions) ? row.data.mentions : []) as Mention[],
        })),
        skipped: total - rows.length,
      };
    },
    /** 这个席位听到了第几条（只往后挪）；顺手记下 AI 现在的名字 */
    async setHeard(seatId: string, seq: number, name?: string) {
      await pool.query(
        'update conversations set heard_seq=greatest(heard_seq,$2), title=coalesce($3,title) where id=$1',
        [seatId, seq, name ?? null],
      );
    },
    /** 群里的一条消息的序号和是谁发的；不在这个群里返回 undefined */
    async messageSeq(groupId: string, messageId: string) {
      const row = (
        await pool.query<{ seq: string; author_id: string }>(
          "select seq,author_id from messages where id=$1 and conversation_id=$2 and author_kind='user'",
          [messageId, groupId],
        )
      ).rows[0];
      return row ? { seq: Number(row.seq), authorId: row.author_id } : undefined;
    },
  };
}
export type GroupSeats = ReturnType<typeof createGroupSeats>;
