// 只有人的群（群里没有 AI）的测试共用：开一轮、清理别的服务都用不上，给空的就行。
// 群里的 AI 见 group-seats-postgres.test.ts。
import type pg from 'pg';
import { pino } from 'pino';
import type { GroupOptions } from '@oasis/contracts/group';
import type { ServiceClient } from '@oasis/service-kit';
import { createConversationRepo } from '../../src/repo/conversation-repo.ts';
import { createGroupRepo } from '../../src/repo/group-repo.ts';
import { createGroupSeats } from '../../src/repo/group-seats.ts';
import { createGroupService } from '../../src/service/group-service.ts';
import type { Turns } from '../../src/service/turns.ts';

/** 建群时除了群名以外的那几项 */
export const NEW_GROUP: { displayName: string; ais: string[] } & GroupOptions = {
  displayName: '群主',
  ais: [],
  light: 'coral',
  speak: 'mention',
  assign: 'ai',
};

export const humanGroups = (pool: pg.Pool, messagesPerMinute: number) =>
  createGroupService({
    repo: createGroupRepo(pool, { members: 3, groups: 20, messagesPerMinute, ais: 8 }),
    seats: createGroupSeats(pool),
    store: createConversationRepo(pool),
    turns: { onSeatIdle: () => undefined } as unknown as Turns,
    agent: {} as ServiceClient,
    purge: { cancelTurn: async () => undefined, remote: async () => undefined },
    logger: pino({ level: 'silent' }),
  });
