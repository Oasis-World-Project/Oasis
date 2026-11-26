// 群文件的存储：一个群里同一个路径只有一份（group_files），指向 canvas 里的成果或上传文件。
// 还有工作台要的那些消息、消息带的文件，和席位拿到第几版了。
import type pg from 'pg';
import type { FileAuthor } from '@oasis/contracts/group';
import { HttpError } from '@oasis/service-kit';
import {
  MEMBER_NAME,
  MESSAGE_COLUMNS,
  seatsOf,
  sessionsOf,
  toMessage,
  type MessageRow,
} from './group-rows.ts';
import { inTransaction } from './tx.ts';

export interface FileRow {
  id: string;
  path: string;
  name: string;
  size: string;
  version: string;
  source: 'artifact' | 'upload';
  ref_id: string;
  ref_owner: string;
  made_kind: FileAuthor['kind'];
  made_by: string;
  changed_kind: FileAuthor['kind'];
  changed_by: string;
  run_id: string | null;
  rev: string;
  seen: Record<string, string>;
  updated_at: Date;
}

/** 交上来的一版：在 canvas 里是哪一份、谁交的 */
export interface FileVersion {
  path: string;
  name: string;
  size: number;
  /** 这一版内容的记号（sha256，没有时是大小） */
  version: string;
  source: FileRow['source'];
  refId: string;
  refOwner: string;
  by: FileAuthor;
  runId: string | null;
}

const COLUMNS =
  'id,path,name,size,version,source,ref_id,ref_owner,made_kind,made_by,changed_kind,changed_by,run_id,rev,seen,updated_at';
const missing = () => new HttpError(404, 'group_not_found', '没有这个群，或你已不在群里');

export function createGroupFilesRepo(pool: pg.Pool) {
  /** 群文件变了：群上的记号往后走（网页据此重新读群文件） */
  const bump = (db: pg.PoolClient, groupId: string, rev: string) =>
    db.query(
      "update conversations set options=options || jsonb_build_object('filesRev', $2::bigint) where id=$1",
      [groupId, rev],
    );
  const nextRev = async (db: pg.PoolClient) =>
    (await db.query<{ rev: string }>("select nextval('group_files_rev') rev")).rows[0]!.rev;

  return {
    /** 核对是成员，拿到这是群还是两个好友的私聊、群主是谁 */
    async room(userId: string, id: string) {
      const row = (
        await pool.query<{ kind: 'group' | 'direct'; owner_id: string }>(
          `select c.kind,c.owner_id from conversations c join group_members m on m.conversation_id=c.id
           where c.id=$1 and c.kind in ('group','direct') and m.user_id=$2 and m.left_at is null`,
          [id, userId],
        )
      ).rows[0];
      if (!row) throw missing();
      return { kind: row.kind, ownerId: row.owner_id };
    },
    /** 群文件，新改的在前 */
    async list(groupId: string) {
      return (
        await pool.query<FileRow>(
          `select ${COLUMNS} from group_files where group_id=$1 order by rev desc`,
          [groupId],
        )
      ).rows;
    },
    async find(groupId: string, fileId: string) {
      return (
        await pool.query<FileRow>(
          `select ${COLUMNS} from group_files where group_id=$1 and id=$2`,
          [groupId, fileId],
        )
      ).rows[0];
    },
    async byPaths(groupId: string, paths: string[]) {
      return (
        await pool.query<FileRow>(
          `select ${COLUMNS} from group_files where group_id=$1 and path = any($2::text[])`,
          [groupId, paths],
        )
      ).rows;
    },
    /**
     * 交上来一版。这个路径还没有就加一个；有了，内容和现在的不一样就换成这一版（返回被换下的那一行）。
     * 同一来源的同一版再登记一遍、内容和现在的一样，都不算新版本。群文件满了（max）不再加。
     */
    put(groupId: string, next: FileVersion, max: number) {
      return inTransaction(pool, async (db) => {
        // 锁住群这一行：同一个路径同时交上来两版时一个一个来
        const group = await db.query(
          "select 1 from conversations where id=$1 and kind='group' for update",
          [groupId],
        );
        if (!group.rowCount) return { status: 'gone' as const };
        const old = (
          await db.query<FileRow>(
            `select ${COLUMNS} from group_files where group_id=$1 and path=$2 for update`,
            [groupId, next.path],
          )
        ).rows[0];
        const source = `${next.source}:${next.refId}`;
        const seen = JSON.stringify({ [source]: next.version });
        if (old && (old.seen[source] === next.version || old.version === next.version)) {
          await db.query('update group_files set seen=seen || $2::jsonb where id=$1', [
            old.id,
            seen,
          ]);
          return { status: 'same' as const };
        }
        if (!old) {
          const count = (
            await db.query<{ n: number }>(
              'select count(*)::int n from group_files where group_id=$1',
              [groupId],
            )
          ).rows[0]!.n;
          if (count >= max) return { status: 'full' as const };
        }
        const rev = await nextRev(db);
        await db.query(
          `insert into group_files(group_id,path,name,size,version,source,ref_id,ref_owner,made_kind,made_by,changed_kind,changed_by,run_id,rev,seen)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,$10,$11,$12,$13::jsonb)
           on conflict (group_id,path) do update set name=excluded.name, size=excluded.size, version=excluded.version,
             source=excluded.source, ref_id=excluded.ref_id, ref_owner=excluded.ref_owner,
             changed_kind=excluded.changed_kind, changed_by=excluded.changed_by, run_id=excluded.run_id,
             rev=excluded.rev, seen=group_files.seen || excluded.seen, updated_at=now()`,
          [
            groupId,
            next.path,
            next.name,
            next.size,
            next.version,
            next.source,
            next.refId,
            next.refOwner,
            next.by.kind,
            next.by.id,
            next.runId,
            rev,
            seen,
          ],
        );
        await bump(db, groupId, rev);
        return old ? { status: 'changed' as const, replaced: old } : { status: 'added' as const };
      });
    },
    /** 从群文件里拿掉一个；不在了返回 undefined */
    remove(groupId: string, fileId: string) {
      return inTransaction(pool, async (db) => {
        const row = (
          await db.query<FileRow>(
            `delete from group_files where group_id=$1 and id=$2 returning ${COLUMNS}`,
            [groupId, fileId],
          )
        ).rows[0];
        if (row) await bump(db, groupId, await nextRev(db));
        return row;
      });
    },
    /** 这一轮的任务卡：是哪条消息、卡上记着它交了哪些成果；没有这张卡返回 undefined */
    async taskCard(groupId: string, runId: string) {
      return (
        await pool.query<{ id: string; artifacts: string[] }>(
          `select id, array(select f->>'artifactId' from jsonb_array_elements(coalesce(data->'files','[]'::jsonb)) f) as artifacts
             from messages where conversation_id=$1 and kind='task' and data->>'runId'=$2`,
          [groupId, runId],
        )
      ).rows[0];
    },
    /** 删任务：任务卡那条消息，和群文件里现在这一版是这一轮交的那些（卡上记着的成果也算） */
    removeTask(groupId: string, card: { id: string; artifacts: string[] }, runId: string) {
      return inTransaction(pool, async (db) => {
        const files = await db.query(
          `delete from group_files where group_id=$1 and source='artifact'
             and (run_id=$2 or ref_id = any($3::uuid[]))`,
          [groupId, runId, card.artifacts],
        );
        await db.query('delete from messages where conversation_id=$1 and id=$2', [
          groupId,
          card.id,
        ]);
        if (files.rowCount) await bump(db, groupId, await nextRev(db));
      });
    },
    /** 这份会话（席位或云端任务）拿到群文件的第几版了（只往后挪） */
    async setSeen(seatId: string, rev: number) {
      await pool.query(
        `update conversations set options=options || jsonb_build_object('filesSeen',
           greatest(coalesce((options->>'filesSeen')::bigint,0), $2::bigint)) where id=$1`,
        [seatId, rev],
      );
    },
    /** 群里的人和 AI 叫什么（AI 的 key、用户 ID → 名字；退群的人、被移出的 AI 也算），和正在进行的那几轮 */
    async people(groupId: string) {
      const seats = await seatsOf(pool, groupId, true);
      const members = (
        await pool.query<{ user_id: string; name: string }>(
          `select user_id,${MEMBER_NAME} as name from group_members where conversation_id=$1`,
          [groupId],
        )
      ).rows;
      return {
        names: new Map([
          ...seats.map((seat) => [seat.model_key, seat.title] as const),
          ...members.map((member) => [member.user_id, member.name] as const),
        ]),
        running: new Set(
          (await sessionsOf(pool, groupId)).flatMap((row) => (row.turn ? [row.turn.runId] : [])),
        ),
      };
    },
    /** 这段聊天里的一条消息带的文件：是谁发的；没有这个文件返回 undefined */
    async attachment(roomId: string, uploadId: string) {
      return (
        await pool.query<{ owner_id: string; name: string }>(
          `select m.author_id as owner_id, a->>'name' as name
             from messages m, jsonb_array_elements(coalesce(m.data->'attachments','[]'::jsonb)) a
            where m.conversation_id=$1 and m.author_kind='user' and a->>'id'=$2 limit 1`,
          [roomId, uploadId],
        )
      ).rows[0];
    },
    /** 这段聊天里所有消息带的文件，和各是谁传的（解散群、删好友时清 canvas 用） */
    async uploads(roomId: string) {
      return (
        await pool.query<{ owner_id: string; id: string }>(
          `select distinct m.author_id as owner_id, a->>'id' as id
             from messages m, jsonb_array_elements(coalesce(m.data->'attachments','[]'::jsonb)) a
            where m.conversation_id=$1 and m.author_kind='user' and a->>'id' is not null`,
          [roomId],
        )
      ).rows;
    },
    /**
     * 工作台「任务」页签要的消息：最近 limit 轮里动过手（有步骤）或带着问卷、任务单的 AI 的话，
     * 和这些轮的任务卡，按先后。
     */
    async work(groupId: string, limit: number) {
      const rows = (
        await pool.query<MessageRow>(
          `with runs as (
             select data->>'runId' as run_id, max(seq) as last from messages
              where conversation_id=$1 and author_kind='ai' and kind='text' and data ? 'runId'
                and (content like '%\`\`\`oasis-%' or exists (
                  select 1 from jsonb_array_elements(coalesce(data->'parts','[]'::jsonb)) p where p->>'type'='step'))
              group by 1 order by last desc limit ${Math.trunc(limit)})
           select ${MESSAGE_COLUMNS} from messages
            where conversation_id=$1 and author_kind='ai' and data->>'runId' in (select run_id from runs)
            order by seq`,
          [groupId],
        )
      ).rows;
      const names = new Map(
        (await seatsOf(pool, groupId, true)).map((seat) => [seat.model_key, seat.title] as const),
      );
      return rows.map((row) => toMessage(row, names));
    },
  };
}
export type GroupFilesRepo = ReturnType<typeof createGroupFilesRepo>;
