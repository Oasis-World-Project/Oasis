// 群的存储：成员、群里的 AI（席位：挂在群下面的一条会话）、群的设置、群消息。邀请在 group-invites.ts，
// 席位听到什么在 group-seats.ts。
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Mention } from '@oasis/contracts/conversation';
import {
  GROUP_HISTORY_NOTICE,
  GroupOptions,
  type GroupMessage,
  type GroupSnapshot,
} from '@oasis/contracts/group';
import { HttpError } from '@oasis/service-kit';
import { groupInvites } from './group-invites.ts';
import {
  IN_FLUX,
  MESSAGE_COLUMNS,
  nameOf,
  seatsOf,
  type GroupRow,
  type MessageRow,
} from './group-rows.ts';
import type { groupMembers } from './schema.ts';

type Limits = { members: number; groups: number; messagesPerMinute: number; ais: number };
type Cursor = { after?: number; before?: number };
const missing = () => new HttpError(404, 'group_not_found', '没有这个群，或你已不在群里');
const ownerOnly = (what: string) => new HttpError(403, 'owner_required', `只有群主可以${what}`);

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
  /** 群主才能做的事：先核对是成员，再核对是群主 */
  async function ownedByOwner(db: pg.PoolClient, id: string, userId: string, what: string) {
    const row = await owned(db, id, userId);
    if (row.owner_id !== userId) throw ownerOnly(what);
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
  const toMessage = (row: MessageRow, names: Map<string, string>): GroupMessage =>
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
  /**
   * 群现在的样子。cursor 之后（或之前）的一页消息；watch 是上次还在变的消息：这次连同还在变的一起
   * 给出最新的样子，已经不在的列在 gone 里。
   */
  async function snapshot(
    db: pg.PoolClient,
    row: GroupRow,
    cursor?: Cursor,
    watch: string[] = [],
  ): Promise<GroupSnapshot> {
    const members = (
      await db.query<Pick<typeof groupMembers.$inferSelect, 'userId' | 'displayName' | 'joinedAt'>>(
        'select user_id as "userId",display_name as "displayName",joined_at as "joinedAt" from group_members where conversation_id=$1 and left_at is null order by joined_at,user_id',
        [row.id],
      )
    ).rows;
    const allSeats = await seatsOf(db, row.id, true);
    const seats = allSeats.filter((seat) => !seat.options.removedAt);
    const names = new Map(allSeats.map((seat) => [seat.model_key, seat.title]));
    const after = cursor?.after,
      before = cursor?.before;
    const messages = (
      await db.query<MessageRow>(
        `select ${MESSAGE_COLUMNS} from messages where conversation_id=$1 and ($2::bigint is null or seq>$2) and ($3::bigint is null or seq<$3) order by seq ${after === undefined ? 'desc' : 'asc'} limit 100`,
        [row.id, after ?? null, before ?? null],
      )
    ).rows;
    if (after === undefined) messages.reverse();
    const live = (
      await db.query<MessageRow>(
        `select ${MESSAGE_COLUMNS} from messages where conversation_id=$1 and (${IN_FLUX} or id = any($2::uuid[])) order by seq`,
        [row.id, watch],
      )
    ).rows;
    const options = GroupOptions.parse(row.options);
    return {
      id: row.id,
      title: row.title,
      ownerId: row.owner_id,
      createdAt: row.created_at.toISOString(),
      memberCount: members.length,
      aiCount: seats.length,
      light: options.light,
      options,
      historyNotice: GROUP_HISTORY_NOTICE,
      members: members.map((member) => ({
        userId: member.userId,
        displayName: member.displayName,
        joinedAt: member.joinedAt.toISOString(),
      })),
      ais: seats.map((seat) => ({
        key: seat.model_key,
        role: seat.options.role ?? '',
        runId: seat.turn?.runId ?? null,
        startedAt: seat.turn?.startedAt ?? null,
        callers: seat.turn?.callers ?? [],
        heardSeq: Number(seat.heard_seq),
      })),
      messages: messages.map((message) => toMessage(message, names)),
      live: live.map((message) => toMessage(message, names)),
      gone: watch.filter((id) => !live.some((message) => message.id === id)),
    };
  }
  return {
    async list(userId: string) {
      const rows = (
        await pool.query<GroupRow & { member_count: number; ai_count: number }>(
          `select c.*,
             (select count(*)::int from group_members m where m.conversation_id=c.id and m.left_at is null) member_count,
             (select count(*)::int from conversations s where s.parent_id=c.id and s.kind='seat' and not (s.options ? 'removedAt')) ai_count
           from conversations c join group_members m on m.conversation_id=c.id
           where c.kind='group' and m.user_id=$1 and m.left_at is null
           order by coalesce(c.last_message_at,c.created_at) desc,c.id`,
          [userId],
        )
      ).rows;
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        ownerId: row.owner_id,
        createdAt: row.created_at.toISOString(),
        memberCount: row.member_count,
        aiCount: row.ai_count,
        light: GroupOptions.parse(row.options).light,
      }));
    },
    /** 建群：建的人是群主；ais 是叫进群的 AI（key 和名字），各有一个席位 */
    create(
      userId: string,
      title: string,
      displayName: string,
      options: GroupOptions,
      ais: { key: string; name: string }[],
    ) {
      return transaction(async (db) => {
        await capacity(db, userId);
        const row = (
          await db.query<GroupRow>(
            "insert into conversations(kind,owner_id,title,options) values('group',$1,$2,$3) returning *",
            [userId, title, options],
          )
        ).rows[0]!;
        await db.query(
          'insert into group_members(conversation_id,user_id,display_name) values($1,$2,$3)',
          [row.id, userId, displayName],
        );
        for (const ai of ais)
          await db.query(
            // 同一个事务里 now() 都一样：用 clock_timestamp() 让席位按叫进群的先后排
            "insert into conversations(kind,owner_id,model_key,title,parent_id,created_at) values('seat',$1,$2,$3,$4,clock_timestamp())",
            [userId, ai.key, ai.name, row.id],
          );
        return snapshot(db, row);
      });
    },
    get(userId: string, id: string, cursor?: Cursor, watch?: string[]) {
      return transaction(async (db) => snapshot(db, await owned(db, id, userId), cursor, watch));
    },
    ...groupInvites({
      pool,
      maxMembers: limits.members,
      transaction,
      ownedByOwner,
      capacity,
      snapshot,
    }),
    remove(userId: string, id: string, target: string) {
      return transaction(async (db) => {
        const row = await owned(db, id, userId);
        if (target === row.owner_id)
          throw new HttpError(409, 'owner_cannot_leave', '群主不能退出，请解散群');
        if (userId !== row.owner_id && target !== userId) throw ownerOnly('移除其他成员');
        await db.query(
          'update group_members set left_at=now() where conversation_id=$1 and user_id=$2 and left_at is null',
          [id, target],
        );
      });
    },
    /** 群主改群的设置（光色、发言方式、分工方式）：只改给的那几项 */
    setOptions(userId: string, id: string, patch: Partial<GroupOptions>) {
      return transaction(async (db) => {
        const row = await ownedByOwner(db, id, userId, '改群的设置');
        const options = { ...row.options, ...patch };
        await db.query('update conversations set options=$2 where id=$1', [id, options]);
        return snapshot(db, { ...row, options });
      });
    },
    /** 群主叫一个 AI 进群：给它一个席位；之前被移出过的回来（它不记得之前的事） */
    addAi(userId: string, id: string, key: string, name: string) {
      return transaction(async (db) => {
        const row = await ownedByOwner(db, id, userId, '叫 AI 进群');
        const seats = await seatsOf(db, id);
        if (seats.some((seat) => seat.model_key === key)) return snapshot(db, row);
        if (seats.length >= limits.ais)
          throw new HttpError(409, 'group_ai_limit', `一个群最多 ${limits.ais} 个 AI`);
        await db.query(
          `insert into conversations(kind,owner_id,model_key,title,parent_id,created_at) values('seat',$1,$2,$3,$4,clock_timestamp())
           on conflict (parent_id,model_key) where kind='seat'
           do update set title=excluded.title, options=conversations.options - 'removedAt', heard_seq=0, last_run_id=null, created_at=excluded.created_at`,
          [row.owner_id, key, name, id],
        );
        return snapshot(db, row);
      });
    },
    /**
     * 群主把一个 AI 移出群：标上移出的时间（它交过的成果还是群的，解散群时一起清），返回这个席位。
     * 它正在做的那一轮记在 forget 里：那一轮收尾时不留会话（见 turns 的 finish），再叫回来从头开始。
     */
    removeAi(userId: string, id: string, key: string) {
      return transaction(async (db) => {
        await ownedByOwner(db, id, userId, '把 AI 移出群');
        const seat = (await seatsOf(db, id)).find((item) => item.model_key === key);
        if (!seat) throw new HttpError(404, 'group_ai_not_found', '这个 AI 不在群里');
        await db.query(
          "update conversations set options=options || jsonb_build_object('removedAt', now(), 'forget', turn->>'runId'), last_run_id=null where id=$1",
          [seat.id],
        );
        return seat;
      });
    },
    /** 群主写这个 AI 在群里负责什么 */
    setRole(userId: string, id: string, key: string, role: string) {
      return transaction(async (db) => {
        const row = await ownedByOwner(db, id, userId, '改 AI 在群里负责什么');
        const seat = (await seatsOf(db, id)).find((item) => item.model_key === key);
        if (!seat) throw new HttpError(404, 'group_ai_not_found', '这个 AI 不在群里');
        await db.query(
          "update conversations set options=options || jsonb_build_object('role', $2::text) where id=$1",
          [seat.id, role],
        );
        return snapshot(db, row);
      });
    },
    /** 解散群之前：核对是群主，给出群里所有的席位（连被移出的），由调用方清它们在别的服务里的东西 */
    seatsToPurge(userId: string, id: string) {
      return transaction(async (db) => {
        await ownedByOwner(db, id, userId, '解散群');
        return seatsOf(db, id, true);
      });
    },
    destroy(userId: string, id: string) {
      return transaction(async (db) => {
        await ownedByOwner(db, id, userId, '解散群');
        await db.query('delete from conversations where id=$1', [id]);
      });
    },
    /**
     * 发一句话。mentions 里的 AI 要在群里、人要是成员。返回群现在的样子，和这句话的序号
     * （同一个请求号重发时没有：这句之前已经收下了）。
     */
    send(userId: string, id: string, content: string, requestId: string, mentions: Mention[]) {
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
          return { snapshot: await snapshot(db, row), seq: undefined };
        }
        const count = (
          await db.query(
            "select count(*)::int n from messages where conversation_id=$1 and author_id=$2 and created_at>now()-interval '1 minute'",
            [id, userId],
          )
        ).rows[0].n as number;
        if (count >= limits.messagesPerMinute)
          throw new HttpError(429, 'message_rate', '发送太快，请稍后再试');
        const keys = new Set((await seatsOf(db, id)).map((seat) => seat.model_key));
        const people = new Set(
          (
            await db.query<{ user_id: string }>(
              'select user_id from group_members where conversation_id=$1 and left_at is null',
              [id],
            )
          ).rows.map((member) => member.user_id),
        );
        for (const mention of mentions)
          if (
            (mention.kind === 'ai' && !keys.has(mention.key)) ||
            (mention.kind === 'user' && !people.has(mention.userId))
          )
            throw new HttpError(400, 'mention_not_found', '@ 的人或 AI 不在群里');
        const member = (
          await db.query<{ display_name: string }>(
            'select display_name from group_members where conversation_id=$1 and user_id=$2',
            [id, userId],
          )
        ).rows[0]!;
        const inserted = (
          await db.query<{ seq: string }>(
            "insert into messages(id,conversation_id,author_kind,author_id,content,status,kind,data) values($1,$2,'user',$3,$4,'complete','text',$5) returning seq",
            [
              randomUUID(),
              id,
              userId,
              content,
              {
                clientRequestId: requestId,
                displayName: member.display_name,
                ...(mentions.length ? { mentions } : {}),
              },
            ],
          )
        ).rows[0]!;
        await db.query('update conversations set last_message_at=now() where id=$1', [id]);
        return { snapshot: await snapshot(db, row), seq: Number(inserted.seq) };
      });
    },
  };
}
export type GroupRepo = ReturnType<typeof createGroupRepo>;
