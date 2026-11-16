// 群里现在在聊什么：判断「谁想接话」时要看的东西（群的设置、有空的 AI、最近的话），和判断到第几条了。
import type pg from 'pg';
import { MEMBER_NAME, MESSAGE_COLUMNS, nameOf, seatsOf, type MessageRow } from './group-rows.ts';

export interface TalkLine {
  seq: number;
  /** 这句是 AI 说的 */
  ai: boolean;
  name: string;
  content: string;
  at: Date;
}

export function createGroupTalk(pool: pg.Pool) {
  return {
    /** 群的设置、群里的席位（没被移出的）、最近的 limit 句话（只算说完了的）；群不在了返回 undefined */
    async state(groupId: string, limit: number) {
      const group = (
        await pool.query<{ owner_id: string; title: string; options: Record<string, unknown> }>(
          "select owner_id,title,options from conversations where id=$1 and kind='group'",
          [groupId],
        )
      ).rows[0];
      if (!group) return undefined;
      const seats = await seatsOf(pool, groupId);
      const members = (
        await pool.query<{ user_id: string; name: string }>(
          `select user_id,${MEMBER_NAME} as name from group_members where conversation_id=$1 and left_at is null`,
          [groupId],
        )
      ).rows;
      const names = new Map([
        ...seats.map((seat) => [seat.model_key, seat.title] as const),
        ...members.map((member) => [member.user_id, member.name] as const),
      ]);
      const rows = (
        await pool.query<MessageRow>(
          `select ${MESSAGE_COLUMNS} from messages where conversation_id=$1 and kind='text' and content<>'' and status='complete' order by seq desc limit ${Math.trunc(limit)}`,
          [groupId],
        )
      ).rows.reverse();
      return {
        ownerId: group.owner_id,
        title: group.title,
        options: group.options,
        seats,
        lines: rows.map((row): TalkLine => ({
          seq: Number(row.seq),
          ai: row.author_kind === 'ai',
          name: nameOf(row, names),
          content: row.content,
          at: row.created_at,
        })),
      };
    },
    /** 认领「判断到第 seq 条」：同一条只有一个实例判断；已经有人判断过就返回 false */
    async claim(groupId: string, seq: number) {
      const { rowCount } = await pool.query(
        `update conversations set options=options || jsonb_build_object('judgedSeq',$2::bigint)
         where id=$1 and coalesce((options->>'judgedSeq')::bigint,0) < $2`,
        [groupId, seq],
      );
      return Boolean(rowCount);
    },
    /** 记下判断出来的这个 AI 平时有多爱说话（群里安静时它会不会起话头要用） */
    async remember(seatId: string, warmth: number) {
      await pool.query(
        "update conversations set options=options || jsonb_build_object('warmth',$2::float8) where id=$1",
        [seatId, warmth],
      );
    },
    /** AI 会自己开口的群（不是「只在被 @ 时」） */
    async lively() {
      return (
        await pool.query<{ id: string }>(
          "select id from conversations where kind='group' and coalesce(options->>'speak','mention') <> 'mention'",
        )
      ).rows.map((row) => row.id);
    },
  };
}
export type GroupTalk = ReturnType<typeof createGroupTalk>;
