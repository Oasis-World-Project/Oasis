// 挂在群下面、不是席位的那几种会话：一个成员和一个 AI 的家（他 @ 它时在那做）、云端任务。
// 家在哪、动手前问不问按成员记在 group_members.home 上，他在这个群里的每个家都用它。
import type pg from 'pg';
import type { SetupBody } from '@oasis/contracts/conversation';
import { defaultPermissions } from '@oasis/contracts/harness';
import { sessionsOf, type SeatRow } from './group-rows.ts';

const setupOf = (home: SetupBody | null): SetupBody =>
  home ?? {
    workplace: { kind: 'cloud' },
    permissions: defaultPermissions({ kind: 'cloud' }),
  };

/** 这个人在这个群里的样子：他和各个 AI 的家，他的家定在哪（没定过是云端，unset 为 true） */
export async function viewerHomes(db: pg.Pool | pg.PoolClient, groupId: string, viewer: string) {
  const homes = (
    await db.query<SeatRow>(
      "select id,model_key,title,options,turn,heard_seq from conversations where parent_id=$1 and kind='home' and options->>'member'=$2",
      [groupId, viewer],
    )
  ).rows;
  const member = (
    await db.query<{ home: SetupBody | null }>(
      'select home from group_members where conversation_id=$1 and user_id=$2 and left_at is null',
      [groupId, viewer],
    )
  ).rows[0];
  return {
    homes,
    ...(member ? { home: setupOf(member.home), homeUnset: member.home === null } : {}),
  };
}

export function createGroupSessions(pool: pg.Pool) {
  return {
    /**
     * 这个成员和这个 AI 在群里的家：没有就建一行（主人是群主，在哪干活、权限照他在这个群定的），返回它的 ID
     */
    async home(group: { id: string; ownerId: string }, key: string, userId: string, name: string) {
      const { home } = await viewerHomes(pool, group.id, userId);
      const setup = home ?? setupOf(null);
      const { rows } = await pool.query<{ id: string }>(
        `insert into conversations(kind,owner_id,model_key,title,parent_id,options,workplace,permissions)
         values('home',$1,$2,$3,$4,jsonb_build_object('room','group','member',$5::text),$6,$7)
         on conflict (parent_id,model_key,(options->>'member')) where kind='home' do update set title=excluded.title
         returning id`,
        [
          group.ownerId,
          key,
          name,
          group.id,
          userId,
          setup.workplace.kind === 'cloud' ? null : setup.workplace,
          setup.permissions,
        ],
      );
      return rows[0]!.id;
    },
    /** 这个成员和这个 AI 的家（没叫过它就没有） */
    async homeOf(groupId: string, key: string, userId: string) {
      const { homes } = await viewerHomes(pool, groupId, userId);
      return homes.find((home) => home.model_key === key);
    },
    /** 这个成员在这个群里正等着他点这张确认卡的那个家 */
    async asking(groupId: string, userId: string, confirmationId: string) {
      const { homes } = await viewerHomes(pool, groupId, userId);
      return homes.find((home) =>
        (home.turn?.confirmations ?? []).some((card) => card.id === confirmationId),
      )?.id;
    },
    /** 这个成员在这个群的家定在哪（没定过是云端） */
    async setup(groupId: string, userId: string) {
      return (await viewerHomes(pool, groupId, userId)).home;
    },
    /** 改这个成员在这个群的家（在哪干活、权限）：记在成员上，他已有的每个家跟着改，下一轮起用 */
    async saveSetup(groupId: string, userId: string, setup: SetupBody) {
      await pool.query(
        'update group_members set home=$3 where conversation_id=$1 and user_id=$2 and left_at is null',
        [groupId, userId, setup],
      );
      await pool.query(
        "update conversations set workplace=$3, permissions=$4 where parent_id=$1 and kind='home' and options->>'member'=$2",
        [
          groupId,
          userId,
          setup.workplace.kind === 'cloud' ? null : setup.workplace,
          setup.permissions,
        ],
      );
    },
    /** 这个 AI 在群里除了席位以外的会话：它做过的云端任务、各个成员和它的家（把它移出群时清掉） */
    async ofAi(groupId: string, key: string) {
      return (await sessionsOf(pool, groupId)).filter(
        (row) => row.kind !== 'seat' && row.model_key === key,
      );
    },
    /** 这个成员和各个 AI 的家（他退群、被移出时清掉） */
    async ofMember(groupId: string, userId: string) {
      return (await sessionsOf(pool, groupId)).filter(
        (row) => row.kind === 'home' && row.options.member === userId,
      );
    },
    /** 删掉一份会话那一行（它在别的服务里的东西已经清了） */
    async drop(sessionId: string) {
      await pool.query("delete from conversations where id=$1 and kind in ('task','home')", [
        sessionId,
      ]);
    },
  };
}
export type GroupSessions = ReturnType<typeof createGroupSessions>;
