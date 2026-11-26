// 群里的会话（席位、云端任务）听到什么：轮到一个 AI 时，群里有谁、它没听过的话。
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

/** 一句话带的文件、引用的群文件叫什么 */
const fileNames = (data: Record<string, unknown>): string[] =>
  [data.attachments, data.refs].flatMap((list) =>
    Array.isArray(list)
      ? list.flatMap((item: { name?: unknown }) =>
          typeof item.name === 'string' ? [item.name] : [],
        )
      : [],
  );

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
        await pool.query<{ kind: string; parent_id: string; model_key: string; heard_seq: string }>(
          "select kind,parent_id,model_key,heard_seq from conversations where id=$1 and kind in ('seat','task')",
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
      // 只带文件、没写字的话也算
      const unheard = `conversation_id=$1 and seq>$2 and kind='text' and (content<>'' or data ? 'attachments' or data ? 'refs') and not (author_kind='ai' and author_id=$3)`;
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
          files: fileNames(row.data),
          ...(row.data.task === true ? { task: true } : {}),
          ...(typeof row.data.lead === 'string' ? { lead: row.data.lead } : {}),
          // 交给了哪份会话：是这一份就是点名给它的；是别的，或者这是云端任务而这句没点名给它，只当背景
          ...(row.data.seat === seatId
            ? { mine: true }
            : row.data.seat || seat.kind === 'task'
              ? { aside: true }
              : {}),
        })),
        skipped: total - rows.length,
      };
    },
    /** 群里正在做 runId 这一轮的那份会话（席位或云端任务）；没有返回 undefined */
    async running(groupId: string, runId: string) {
      return (
        await pool.query<{ id: string }>(
          "select id from conversations where parent_id=$1 and kind in ('seat','task') and turn->>'runId'=$2",
          [groupId, runId],
        )
      ).rows[0]?.id;
    },
    /** 这个席位听到了第几条（只往后挪）；顺手记下 AI 现在的名字 */
    async setHeard(seatId: string, seq: number, name?: string) {
      await pool.query(
        'update conversations set heard_seq=greatest(heard_seq,$2), title=coalesce($3,title) where id=$1',
        [seatId, seq, name ?? null],
      );
    },
    /** 群里第 seq 条（人说的话）点名交给这份会话：这个 AI 别的会话只当背景听 */
    async claim(groupId: string, seq: number, seatId: string) {
      await pool.query(
        "update messages set data=data || jsonb_build_object('seat',$3::text) where conversation_id=$1 and seq=$2 and author_kind='user'",
        [groupId, seq, seatId],
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
