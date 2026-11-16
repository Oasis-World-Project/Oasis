// 群的几种行，和几处都要用的查询：群、席位（群里的一个 AI）、消息。
import type pg from 'pg';
import type { Turn } from './schema.ts';

export type GroupRow = {
  id: string;
  /** 群，或两个好友的私聊（消息和推送是同一套） */
  kind: 'group' | 'direct';
  title: string;
  owner_id: string;
  created_at: Date;
  options: Record<string, unknown>;
};
/** 群里一个 AI 的席位 */
export interface SeatRow {
  id: string;
  model_key: string;
  /** AI 的名字（进群时、每次开一轮时记下） */
  title: string;
  /** role：在群里负责什么；removedAt：什么时候被移出的；warmth：判断出来它平时有多爱说话（0 到 1） */
  options: { role?: string; removedAt?: string; warmth?: number };
  turn: Turn | null;
  heard_seq: string;
}
export type MessageRow = {
  id: string;
  seq: string;
  author_kind: 'user' | 'ai';
  author_id: string;
  content: string;
  status: string;
  error: string | null;
  kind: string;
  data: Record<string, unknown>;
  created_at: Date;
};
export const MESSAGE_COLUMNS =
  'id,seq,author_kind,author_id,content,status,error,kind,data,created_at';
const SEAT_COLUMNS = 'id,model_key,title,options,turn,heard_seq';
/** 还在变的消息：AI 正在写的话、进行中的任务卡 */
export const IN_FLUX = "(status='streaming' or (kind='task' and data->>'status'='running'))";

/** 群里的席位，按进群先后；all：连被移出的也算（解散群时要清它们留下的成果） */
export async function seatsOf(db: pg.Pool | pg.PoolClient, groupId: string, all = false) {
  const { rows } = await db.query<SeatRow>(
    `select ${SEAT_COLUMNS} from conversations where parent_id=$1 and kind='seat' order by created_at,id`,
    [groupId],
  );
  return all ? rows : rows.filter((seat) => !seat.options.removedAt);
}

/**
 * 一条消息是谁说的。names：AI 的 key → 名字，还在群里的人的用户 ID → 现在在群里叫什么。
 * 已经不在群里的人，用发这句时的名字。
 */
export const nameOf = (row: MessageRow, names: Map<string, string>) =>
  names.get(row.author_id) ??
  (row.author_kind === 'ai'
    ? row.author_id
    : typeof row.data.displayName === 'string'
      ? row.data.displayName
      : '成员');

/** 成员在群里叫什么：设了群昵称用群昵称，没设用账号的名字 */
export const MEMBER_NAME = 'coalesce(nickname,display_name)';
/** 成员的先后：群主在前，其余按进群的先后（$2 是群主的用户 ID） */
export const MEMBER_ORDER = '(user_id=$2) desc,joined_at,user_id';
