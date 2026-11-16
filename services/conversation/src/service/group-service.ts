// 群：建群、成员（群主直接拉好友）、群里的 AI、发消息。两个好友的私聊读消息、发消息也走这里（它没有 AI）。群里的 AI 怎么接话：一句话进群后，@ 了谁谁开一轮
// （@ 全体就是每个 AI 各开一轮）；被 @ 的 AI 正忙，这句话就排着，它这一轮做完接着开下一轮，
// 也可以「现在告诉它」作为插话送进去。交给 AI 的是群里它没听过的话（group-hearing.ts）。
// 群里 AI 花的钱都由群主付。
import { ModelRoute } from '@oasis/contracts/agent';
import type { Mention } from '@oasis/contracts/conversation';
import type { GroupOptions, GroupSnapshot } from '@oasis/contracts/group';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import {
  withMessageLock,
  type Conversation,
  type ConversationRepo,
} from '../repo/conversation-repo.ts';
import type { GroupRepo } from '../repo/group-repo.ts';
import type { GroupSeats } from '../repo/group-seats.ts';
import { calls, hearingText, seatBrief } from './group-hearing.ts';
import type { Profiles } from './profiles.ts';
import type { Purge } from './purge.ts';
import type { Turns } from './turns.ts';

/** 一次从群里取多少条没听过的话（交给 AI 的条数和字数另有上限） */
const HEARING_LIMIT = 200;
/** 只核对是不是群成员、看看群现在的样子时用的游标：不取消息 */
const NO_MESSAGES = { after: Number.MAX_SAFE_INTEGER };

export function createGroupService(deps: {
  repo: GroupRepo;
  seats: GroupSeats;
  store: ConversationRepo;
  turns: Turns;
  agent: ServiceClient;
  /** 账号的名字和头像（在 identity） */
  profiles: Profiles;
  /** 群里有了新的话：没人 @ 的时候谁接话（group-speak.ts） */
  speak: { nudge(groupId: string): void };
  purge: Purge;
  logger: Logger;
}) {
  const { repo, seats, store, turns, profiles } = deps;

  /** 给群现在的样子补上成员的头像（名字在库里记着，账号改名时 profiles 会让它跟着改） */
  async function seen(snapshot: GroupSnapshot): Promise<GroupSnapshot> {
    const people = await profiles.get(snapshot.members.map((member) => member.userId));
    return {
      ...snapshot,
      members: snapshot.members.map((member) => ({
        ...member,
        avatarVersion: people.get(member.userId)?.avatarVersion ?? 0,
      })),
    };
  }

  /** 这个 AI 现在的名字（群主给它起了名字就是那个）；不是能聊天的 AI 就 400 */
  async function aiName(ownerId: string, key: string, requestId: string): Promise<string> {
    try {
      const route = await deps.agent.json(
        'GET',
        `/internal/models/${encodeURIComponent(key)}/route?userId=${ownerId}`,
        { requestId, schema: ModelRoute },
      );
      return route.name;
    } catch (err) {
      if (err instanceof HttpError && err.statusCode < 500)
        throw new HttpError(400, 'group_ai_unavailable', '这个 AI 现在不能进群');
      throw err;
    }
  }

  /**
   * 席位有空时：群里有它没听过的、叫它的话就开一轮（调用方拿着这个席位的 message 锁）。
   * 先记下听到哪了再开：开不成也不重来，原因写在群里它的那条消息上。
   */
  async function next(locked: ConversationRepo, seat: Conversation, requestId: string) {
    if (seat.kind !== 'seat' || seat.turn || seat.options.removedAt) return;
    const hearing = await seats.hearing(seat.id, HEARING_LIMIT);
    const last = hearing?.heard.at(-1);
    const brief =
      hearing && seatBrief(seat.modelKey ?? '', hearing.roster, hearing.heard, hearing.skipped);
    if (!last || !brief) {
      // 没有人叫它：它刚说完的话，别的 AI 可能想接
      if (seat.parentId) deps.speak.nudge(seat.parentId);
      return;
    }
    await seats.setHeard(seat.id, last.seq);
    await turns.begin(locked, seat, [], requestId, brief);
  }
  turns.onSeatIdle(next);

  /** 一句话进群后：被 @ 的 AI 里有空的各开一轮；忙着的不动，它做完这一轮自己接着开 */
  async function dispatch(groupId: string, mentions: Mention[], requestId: string) {
    const everyone = mentions.some((m) => m.kind === 'all');
    const keys = new Set(mentions.flatMap((m) => (m.kind === 'ai' ? [m.key] : [])));
    if (!everyone && !keys.size) return;
    const targets = (await seats.list(groupId)).filter(
      (seat) => everyone || keys.has(seat.model_key),
    );
    await Promise.all(
      targets.map((target) =>
        withMessageLock(store, target.id, async (locked) => {
          const seat = await locked.find(target.id);
          if (seat) await next(locked, seat, requestId);
        }).catch((err: unknown) =>
          deps.logger.warn({ err, groupId, seatId: target.id }, '没能给这个 AI 开一轮'),
        ),
      ),
    );
  }

  /** 取消这个席位正在做的一轮，清掉它在别的服务里的东西 */
  async function purgeSeat(seatId: string, ownerId: string, requestId: string, keep: boolean) {
    const seat = await store.find(seatId);
    if (seat) await deps.purge.cancelTurn(seat);
    await deps.purge.remote(seatId, ownerId, requestId, keep);
  }

  return {
    list: repo.list,
    get: async (...args: Parameters<GroupRepo['get']>) => seen(await repo.get(...args)),
    remove: repo.remove,
    setOptions: async (...args: Parameters<GroupRepo['setOptions']>) =>
      seen(await repo.setOptions(...args)),
    setRole: async (...args: Parameters<GroupRepo['setRole']>) => seen(await repo.setRole(...args)),
    setNickname: async (...args: Parameters<GroupRepo['setNickname']>) =>
      seen(await repo.setNickname(...args)),

    /**
     * 建群：建的人是群主，叫进来的 AI 各有一个席位（用群主给它们的名字和设定），
     * members 里的好友一起拉进来（不用对方同意）。在群里都显示账号的名字。
     */
    async create(
      userId: string,
      body: { title: string; ais: string[]; members: string[] } & GroupOptions,
      requestId: string,
    ) {
      const friends = [...new Set(body.members)].filter((id) => id !== userId);
      const [ais, people] = await Promise.all([
        Promise.all(
          [...new Set(body.ais)].map(async (key) => ({
            key,
            name: await aiName(userId, key, requestId),
          })),
        ),
        profiles.get([userId, ...friends], requestId),
      ]);
      const nameOf = (id: string) => {
        const name = people.get(id)?.name;
        if (!name) throw new HttpError(404, 'user_not_found', '没有这个人');
        return name;
      };
      const { light, speak, assign } = body;
      return seen(
        await repo.create(
          userId,
          body.title,
          nameOf(userId),
          { light, speak, assign },
          ais,
          friends.map((id) => ({ userId: id, name: nameOf(id) })),
        ),
      );
    },

    /** 群主把一个好友直接拉进群 */
    async addMember(userId: string, id: string, target: string, requestId: string) {
      const { name } = await profiles.one(target, requestId);
      return seen(await repo.addMember(userId, id, target, name));
    },

    /** 群主叫一个 AI 进群 */
    addAi: async (userId: string, id: string, key: string, requestId: string) =>
      seen(await repo.addAi(userId, id, key, await aiName(userId, key, requestId))),

    /**
     * 群主把一个 AI 移出群：它不再接话，正在做的一轮取消；它在这个群的记忆和工作目录删掉，
     * 交过的文件还是群的（解散群时一起删）。
     */
    async removeAi(userId: string, id: string, key: string, requestId: string) {
      const seat = await repo.removeAi(userId, id, key);
      await purgeSeat(seat.id, userId, requestId, true);
    },

    /** 解散群（真删除）：每个 AI 正在做的一轮取消，它们的会话、工作目录、成果都删掉，再删群和消息 */
    async destroy(userId: string, id: string, requestId: string) {
      for (const seat of await repo.seatsToPurge(userId, id))
        await purgeSeat(seat.id, userId, requestId, false);
      await repo.destroy(userId, id);
      deps.logger.info({ groupId: id }, '群已解散');
    },

    /** 发一句话；@ 了 AI 的，那些 AI 各开一轮（见 dispatch）。返回这句话和刚开的那几轮里 AI 的消息 */
    async send(
      userId: string,
      id: string,
      content: string,
      requestId: string,
      mentions: Mention[],
    ) {
      const sent = await repo.send(userId, id, content, requestId, mentions);
      if (sent.seq === undefined) return seen(sent.snapshot);
      if (!mentions.some((m) => m.kind !== 'user')) {
        // 没 @ AI：等群里安静一会儿，看有没有 AI 想接话
        deps.speak.nudge(id);
        return seen(sent.snapshot);
      }
      await dispatch(id, mentions, requestId);
      return seen(await repo.get(userId, id, { after: sent.seq - 1 }));
    },

    /**
     * 「现在告诉它」：@ 了这个 AI、它还没看到的一句，现在作为插话送进它正在做的一轮（连同这句之前
     * 它没听过的话）。发这句话的人和群主可以点。
     */
    async steer(userId: string, id: string, messageId: string, key: string) {
      const group = await repo.get(userId, id, NO_MESSAGES);
      const message = await seats.messageSeq(id, messageId);
      const target = await seats.seat(id, key);
      if (!message || !target)
        throw new HttpError(404, 'group_message_not_found', '没有这句话，或这个 AI 不在群里');
      if (message.authorId !== userId && group.ownerId !== userId)
        throw new HttpError(403, 'steer_not_allowed', '只有发这句话的人和群主可以现在告诉它');
      await withMessageLock(store, target.id, async (locked) => {
        const seat = await locked.find(target.id);
        if (!seat?.turn)
          throw new HttpError(409, 'turn_not_active', '它已经有空了，马上就会看到这句');
        const hearing = await seats.hearing(target.id, HEARING_LIMIT);
        const heard = hearing?.heard.filter((item) => item.seq <= message.seq) ?? [];
        const last = heard.at(-1);
        if (!hearing || last?.seq !== message.seq || !calls(last, key))
          throw new HttpError(409, 'already_heard', '它已经看到这句了');
        await turns.interject(
          locked,
          seat,
          hearingText(heard, hearing.roster, hearing.skipped, `${last.name} 让你现在就看这句话。`),
        );
        await seats.setHeard(target.id, message.seq);
      });
    },

    /** 停下这个 AI 正在做的一轮（已经做出来的会存下）：群主和引来这一轮的人可以 */
    async stopAi(userId: string, id: string, key: string) {
      const group = await repo.get(userId, id, NO_MESSAGES);
      const seat = await seats.seat(id, key);
      if (!seat?.turn) return;
      if (group.ownerId !== userId && !(seat.turn.callers ?? []).includes(userId))
        throw new HttpError(403, 'stop_not_allowed', '只有群主和叫它做这件事的人可以停下');
      await turns.stop(seat.turn);
    },
  };
}
export type GroupService = ReturnType<typeof createGroupService>;
