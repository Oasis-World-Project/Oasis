// 群的几种行，和几处都要用的查询：群、席位（群里的一个 AI）、云端任务的会话、消息。
import type pg from 'pg';
import type { GroupMessage } from '@oasis/contracts/group';
import type { Permissions, Workplace } from '@oasis/contracts/harness';
import type { Turn } from './schema.ts';

export type GroupRow = {
  id: string;
  /** 群，两个好友的私聊，或和一个 AI 的私聊（读消息和推送是同一套） */
  kind: 'group' | 'direct' | 'dm';
  title: string;
  owner_id: string;
  created_at: Date;
  options: Record<string, unknown>;
  /** 下面几样只有和 AI 的私聊用：它自己就是那个 AI 的席位 */
  model_key: string | null;
  turn: Turn | null;
  heard_seq: string;
  workplace: Workplace | null;
  permissions: Permissions | null;
};
/** 群里一个 AI 的席位 */
export interface SeatRow {
  id: string;
  model_key: string;
  /** AI 的名字（进群时、每次开一轮时记下） */
  title: string;
  /**
   * role：在群里负责什么；removedAt：什么时候被移出的；warmth：判断出来它平时有多爱说话（0 到 1）；
   * filesSeen：群文件它拿到第几版了（group_files.rev）；assignedSeq：最近一次被派活时群里到第几条了
   * （它的「越聊越低」从那里重新算）
   */
  options: {
    role?: string;
    removedAt?: string;
    warmth?: number;
    filesSeen?: number;
    assignedSeq?: number;
  };
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
/** 还在变的消息：AI 正在写的话、进行中的任务卡、没关上的分工单、私聊里排着队还没交给 AI 的话 */
export const IN_FLUX =
  "(status='streaming' or (kind='task' and data->>'status'='running') or (kind='assign' and data->>'status'='open') or data->>'pending'='true')";

/** 群里的席位，按进群先后；all：连被移出的也算（解散群时要清它们留下的成果） */
export async function seatsOf(db: pg.Pool | pg.PoolClient, groupId: string, all = false) {
  const { rows } = await db.query<SeatRow>(
    `select ${SEAT_COLUMNS} from conversations where parent_id=$1 and kind='seat' order by created_at,id`,
    [groupId],
  );
  return all ? rows : rows.filter((seat) => !seat.options.removedAt);
}

/** 挂在一个房间（群、和 AI 的私聊）下面的会话：席位和云端任务各一行，按建的先后 */
export async function sessionsOf(db: pg.Pool | pg.PoolClient, roomId: string) {
  const { rows } = await db.query<SeatRow & { kind: 'seat' | 'task' }>(
    `select kind,${SEAT_COLUMNS} from conversations where parent_id=$1 and kind in ('seat','task') order by created_at,id`,
    [roomId],
  );
  return rows;
}

/** 这个房间里正在云端做的任务，按 AI 分（每个任务有自己的会话） */
export async function runningTasks(db: pg.Pool | pg.PoolClient, roomId: string) {
  const { rows } = await db.query<{ model_key: string; turn: Turn }>(
    "select model_key,turn from conversations where parent_id=$1 and kind='task' and turn is not null order by created_at,id",
    [roomId],
  );
  return (key: string) =>
    rows
      .filter((row) => row.model_key === key)
      .map(({ turn }) => ({
        runId: turn.runId,
        startedAt: turn.startedAt,
        callers: turn.callers ?? [],
      }));
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

/** 库里的一行消息 → 给网页的群消息 */
export const toMessage = (row: MessageRow, names: Map<string, string>): GroupMessage =>
  ({
    id: row.id,
    seq: Number(row.seq),
    authorId: row.author_id,
    displayName: nameOf(row, names),
    role: row.author_kind === 'user' ? 'user' : 'assistant',
    content: row.content,
    status: row.status,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    // data 按 kind 存的就是对应的内容（写入时已经是契约里的形状）
    kind: row.kind,
    data: row.data,
  }) as GroupMessage;

/** 成员在群里叫什么：设了群昵称用群昵称，没设用账号的名字 */
export const MEMBER_NAME = 'coalesce(nickname,display_name)';
/** 成员的先后：群主在前，其余按进群的先后（$2 是群主的用户 ID） */
export const MEMBER_ORDER = '(user_id=$2) desc,joined_at,user_id';
