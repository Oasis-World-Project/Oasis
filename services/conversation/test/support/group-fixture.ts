// 群的测试共用：假的账号资料（名字按用户 ID 编）、直接在库里结成好友、只有人的群（群里没有 AI）用的服务。
// 群里的 AI 见 group-seats-postgres.test.ts，好友见 friends-postgres.test.ts。
import type pg from 'pg';
import { pino } from 'pino';
import type { GroupOptions } from '@oasis/contracts/group';
import type { PublicProfile } from '@oasis/contracts/identity';
import { HttpError, type ServiceClient } from '@oasis/service-kit';
import { createConversationRepo } from '../../src/repo/conversation-repo.ts';
import type { ConversationRepo } from '../../src/repo/conversation-repo.ts';
import { createGroupAssignRepo } from '../../src/repo/group-assign-repo.ts';
import { createGroupFilesRepo } from '../../src/repo/group-files-repo.ts';
import { createGroupRepo } from '../../src/repo/group-repo.ts';
import { createGroupSeats } from '../../src/repo/group-seats.ts';
import { createGroupAssign } from '../../src/service/group-assign.ts';
import { createGroupFiles } from '../../src/service/group-files.ts';
import { createGroupService } from '../../src/service/group-service.ts';
import type { Profiles } from '../../src/service/profiles.ts';
import type { Turns } from '../../src/service/turns.ts';

/** 建群时除了群名以外的那几项 */
export const NEW_GROUP: { ais: string[]; members: string[] } & GroupOptions = {
  ais: [],
  members: [],
  light: 'coral',
  speak: 'mention',
};

/** 测试里一个人账号的名字：按用户 ID 编 */
export const nameOf = (id: string) => `人${id.slice(0, 4)}`;
const profileOf = (id: string, name = nameOf(id)): PublicProfile => ({
  id,
  accountNo: '10000001',
  name,
  bio: '',
  gender: '',
  region: '',
  avatarVersion: 3,
});
/** 假的账号资料：谁都查得到（named 里的人用给的名字）；missing 里的人不存在 */
export const fakeProfiles = (
  named = new Map<string, string>(),
  missing = new Set<string>(),
): Profiles => ({
  get: async (ids) =>
    new Map(
      ids.filter((id) => !missing.has(id)).map((id) => [id, profileOf(id, named.get(id))] as const),
    ),
  one: async (id) => {
    if (missing.has(id)) throw new HttpError(404, 'user_not_found', '没有这个人');
    return profileOf(id, named.get(id));
  },
});

/** 直接在库里把两个人结成好友（好友申请那一套见 friends-postgres.test.ts） */
export const befriend = (pool: pg.Pool, a: string, b: string) =>
  pool.query(
    'insert into friendships(user_a,user_b) values(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid)) on conflict do nothing',
    [a, b],
  );

/** 群文件：真的存储；canvas 不给时是空的（没人发文件、没 AI 交文件的测试用不到它） */
export const groupFiles = (pool: pg.Pool, canvas = {} as ServiceClient) =>
  createGroupFiles({
    repo: createGroupFilesRepo(pool),
    canvas,
    logger: pino({ level: 'silent' }),
    maxFiles: 5,
    handoverBytes: 10 * 1024 * 1024,
  });

/** 分工单：真的存储；speak 不给就不让别的 AI 补话 */
export const groupAssign = (
  pool: pg.Pool,
  deps: {
    store: ConversationRepo;
    turns: Turns;
    speak?: { nudge(id: string, force?: boolean): void };
  },
) =>
  createGroupAssign({
    repo: createGroupAssignRepo(pool),
    seats: createGroupSeats(pool),
    store: deps.store,
    turns: deps.turns,
    brief: groupFiles(pool),
    speak: deps.speak ?? { nudge: () => undefined },
    logger: pino({ level: 'silent' }),
  });

/** 假的金库：记着每个群有多少钱、谁存过、哪些群解散退过（没存过的群算有钱，不挡别的测试） */
export function fakeVault() {
  const balances = new Map<string, number>();
  const dissolved: string[] = [];
  const get = async (groupId: string) => ({
    availableMicro: balances.get(groupId) ?? 1_000_000,
    depositedMicro: 0,
    spentMicro: 0,
    members: [],
  });
  return {
    balances,
    dissolved,
    get,
    async deposit(groupId: string, _userId: string, amountMicro: number) {
      balances.set(groupId, (balances.get(groupId) ?? 0) + amountMicro);
      return get(groupId);
    },
    async dissolve(groupId: string) {
      dissolved.push(groupId);
      return { refunds: [] };
    },
    async funded(groupId: string) {
      if ((await get(groupId)).availableMicro <= 0)
        throw new HttpError(402, 'vault_empty', '金库空了，存入后群里的 AI 才能用');
    },
  };
}

export const humanGroups = (pool: pg.Pool, messagesPerMinute: number) =>
  createGroupService({
    repo: createGroupRepo(pool, { members: 3, groups: 20, messagesPerMinute, ais: 8 }),
    seats: createGroupSeats(pool),
    store: createConversationRepo(pool),
    turns: { onSeatIdle: () => undefined } as unknown as Turns,
    agent: {} as ServiceClient,
    profiles: fakeProfiles(),
    files: groupFiles(pool),
    speak: { nudge: () => undefined },
    purge: { cancelTurn: async () => undefined, remote: async () => undefined },
    vault: fakeVault(),
    logger: pino({ level: 'silent' }),
  });
