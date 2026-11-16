// 群的测试共用：假的账号资料（名字按用户 ID 编）、直接在库里结成好友、只有人的群（群里没有 AI）用的服务。
// 群里的 AI 见 group-seats-postgres.test.ts，好友见 friends-postgres.test.ts。
import type pg from 'pg';
import { pino } from 'pino';
import type { GroupOptions } from '@oasis/contracts/group';
import type { PublicProfile } from '@oasis/contracts/identity';
import { HttpError, type ServiceClient } from '@oasis/service-kit';
import { createConversationRepo } from '../../src/repo/conversation-repo.ts';
import { createGroupRepo } from '../../src/repo/group-repo.ts';
import { createGroupSeats } from '../../src/repo/group-seats.ts';
import { createGroupService } from '../../src/service/group-service.ts';
import type { Profiles } from '../../src/service/profiles.ts';
import type { Turns } from '../../src/service/turns.ts';

/** 建群时除了群名以外的那几项 */
export const NEW_GROUP: { ais: string[]; members: string[] } & GroupOptions = {
  ais: [],
  members: [],
  light: 'coral',
  speak: 'mention',
  assign: 'ai',
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

export const humanGroups = (pool: pg.Pool, messagesPerMinute: number) =>
  createGroupService({
    repo: createGroupRepo(pool, { members: 3, groups: 20, messagesPerMinute, ais: 8 }),
    seats: createGroupSeats(pool),
    store: createConversationRepo(pool),
    turns: { onSeatIdle: () => undefined } as unknown as Turns,
    agent: {} as ServiceClient,
    profiles: fakeProfiles(),
    speak: { nudge: () => undefined },
    purge: { cancelTurn: async () => undefined, remote: async () => undefined },
    logger: pino({ level: 'silent' }),
  });
