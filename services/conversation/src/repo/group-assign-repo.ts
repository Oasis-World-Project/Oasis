// 分工单的存储：分工单是群里的一条消息（kind = 'assign'），进行中原地更新。
// 还有一轮里 AI 说的话（找分工单、推辞的代码块）、对全体说的话挑中了谁先出来。
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AssignCard } from '@oasis/contracts/conversation';

export interface AssignRow {
  id: string;
  groupId: string;
  /** 发分工单的 AI */
  key: string;
  card: AssignCard;
}

export function createGroupAssignRepo(pool: pg.Pool) {
  const rows = async (where: string, args: unknown[]): Promise<AssignRow[]> =>
    (
      await pool.query<{
        id: string;
        conversation_id: string;
        author_id: string;
        data: AssignCard;
      }>(
        `select id,conversation_id,author_id,data from messages where kind='assign' and data->>'status'='open' and ${where} order by seq`,
        args,
      )
    ).rows.map((row) => ({
      id: row.id,
      groupId: row.conversation_id,
      key: row.author_id,
      card: row.data,
    }));
  return {
    /** 这一轮里这个 AI 在群里说的话：说完了的那几段的文字，这一轮是不是出错了、被停下了 */
    async said(groupId: string, runId: string) {
      const found = (
        await pool.query<{ content: string; status: string; stopped: boolean }>(
          `select content,status,coalesce((data->>'stopped')::boolean,false) as stopped from messages
            where conversation_id=$1 and author_kind='ai' and kind='text' and data->>'runId'=$2 order by seq`,
          [groupId, runId],
        )
      ).rows;
      return {
        text: found.map((row) => row.content).join('\n\n'),
        failed: found.some((row) => row.status === 'failed'),
        stopped: found.some((row) => row.stopped),
      };
    },
    /** 群里还没关上的分工单，按先后 */
    open: (groupId: string) => rows('conversation_id=$1', [groupId]),
    /** 有没关上的分工单的群（服务重启后接着推进用） */
    async openGroups() {
      return [...new Set((await rows('true', [])).map((row) => row.groupId))];
    },
    /** 发一份分工单：群里多一条消息 */
    async create(groupId: string, key: string, card: AssignCard) {
      await pool.query(
        "insert into messages(id,conversation_id,author_kind,author_id,content,status,kind,data) values($1,$2,'ai',$3,$4,'complete','assign',$5)",
        [randomUUID(), groupId, key, `分工单：${card.title}`, card],
      );
      await pool.query('update conversations set last_message_at=now() where id=$1', [groupId]);
    },
    async save(id: string, card: AssignCard) {
      await pool.query('update messages set data=$2 where id=$1', [id, card]);
    },
    /** 被派了活：记下这时群里到第几条了（它的「越聊越低」从这里重新算） */
    async assigned(seatId: string) {
      await pool.query(
        `update conversations s set options=s.options || jsonb_build_object('assignedSeq',
           (select coalesce(max(seq),0) from messages where conversation_id=s.parent_id)) where s.id=$1`,
        [seatId],
      );
    },
    /** 对全体 AI 说的这句话（群里第 seq 条），挑中这个 AI 先出来负责 */
    async setLead(groupId: string, seq: number, key: string) {
      await pool.query(
        "update messages set data=data || jsonb_build_object('lead',$3::text) where conversation_id=$1 and seq=$2 and author_kind='user'",
        [groupId, seq, key],
      );
    },
    /**
     * 先出来负责的那个 AI 说完了（它听到的序号已经过了那句话）：记下「别的 AI 可以接话了」，
     * 返回有没有这样的话（同一句只算一次）
     */
    async leadSpoke(groupId: string, key: string, heardSeq: number) {
      const { rowCount } = await pool.query(
        `update messages set data=data || '{"followed":true}'::jsonb
          where conversation_id=$1 and author_kind='user' and data->>'lead'=$2 and seq<=$3 and not data ? 'followed'`,
        [groupId, key, heardSeq],
      );
      return Boolean(rowCount);
    },
  };
}
export type GroupAssignRepo = ReturnType<typeof createGroupAssignRepo>;
