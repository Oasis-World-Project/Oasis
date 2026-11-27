// 群里各人的家：每个成员在这个群里叫 AI 干活的地方（他的电脑上给这个群选的文件夹，或云端）和动手前问不问，
// 各人各管各的；他叫的那一轮在等他点的确认卡也在这里点。家那几行在 group-sessions.ts。
import { isDeepStrictEqual } from 'node:util';
import type { SetupBody } from '@oasis/contracts/conversation';
import type { ConfirmDecision } from '@oasis/contracts/model-gateway';
import { HttpError, type Logger } from '@oasis/service-kit';
import type { ConversationRepo } from '../repo/conversation-repo.ts';
import type { GroupRepo } from '../repo/group-repo.ts';
import type { GroupSessions } from '../repo/group-sessions.ts';
import type { Confirmations } from './confirmations.ts';

/** 只核对是不是群成员时用的游标：不取消息 */
const NO_MESSAGES = { after: Number.MAX_SAFE_INTEGER };

export function createGroupHomes(deps: {
  repo: GroupRepo;
  sessions: GroupSessions;
  store: ConversationRepo;
  confirmations: Confirmations;
  logger: Logger;
}) {
  const { repo, sessions } = deps;
  /** 只有群里有各人的家：不是群、不是成员一律 404 */
  async function member(userId: string, id: string) {
    if ((await repo.get(userId, id, NO_MESSAGES)).kind !== 'group')
      throw new HttpError(404, 'group_not_found', '没有这个群，或你已不在群里');
  }

  return {
    /**
     * 改我在这个群的家（在哪干活、权限），下一轮起生效。换了地方 AI 的会话记录在原来那边接不上，
     * 我和各个 AI 的家下一轮都从头开始；我叫的 AI 还在做时不能换地方。
     */
    async setHome(userId: string, id: string, body: SetupBody) {
      await member(userId, id);
      const before = await sessions.setup(id, userId);
      if (
        !isDeepStrictEqual(before?.workplace, body.workplace) &&
        (await sessions.ofMember(id, userId)).some((home) => home.turn)
      )
        throw new HttpError(409, 'turn_active', '你叫的 AI 还在做，先停下再换干活的地方');
      await sessions.saveSetup(id, userId, body);
      deps.logger.info({ groupId: id, userId, workplace: body.workplace.kind }, '改了在群里的家');
    },

    /**
     * 点确认卡：我叫的那一轮在等我点的。「以后都允许」记进我在这个群的家的权限，下一轮起不再问。
     */
    async confirm(input: {
      userId: string;
      groupId: string;
      confirmationId: string;
      decision: ConfirmDecision;
      requestId: string;
    }) {
      await member(input.userId, input.groupId);
      const homeId = await sessions.asking(input.groupId, input.userId, input.confirmationId);
      const home = homeId ? await deps.store.find(homeId) : undefined;
      if (!home) throw new HttpError(409, 'turn_not_active', '这一轮已经结束，不用再确认了');
      return deps.confirmations.decide(home, input, async (_store, kind) => {
        const setup = await sessions.setup(input.groupId, input.userId);
        if (!setup) return;
        await sessions.saveSetup(input.groupId, input.userId, {
          ...setup,
          permissions: {
            ...setup.permissions,
            always: [...new Set([...(setup.permissions.always ?? []), kind])],
          },
        });
      });
    },
  };
}
export type GroupHomes = ReturnType<typeof createGroupHomes>;
