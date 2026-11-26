// 群里的云端任务：每个任务有自己的一份会话（挂在群下面的一行，kind = 'task'），和 AI 在群里的席位互不挡。
// 人把一件事「作为任务发布」时给负责的 AI 开一份；之后有人 @ 它、点名这个任务让它改、让它继续，
// 就接着这一份做（算在原来那张任务卡上）。分工单的每一项也是一个任务，在 group-assign.ts。
import { HttpError, type Logger } from '@oasis/service-kit';
import {
  withMessageLock,
  type Conversation,
  type ConversationRepo,
} from '../repo/conversation-repo.ts';
import type { GroupSeats } from '../repo/group-seats.ts';
import { seatBrief, type SeatBrief } from './group-hearing.ts';
import type { Turns } from './turns.ts';

/** 一次从群里取多少条没听过的话（交给 AI 的条数和字数另有上限） */
const HEARING_LIMIT = 200;

export function createGroupTasks(deps: {
  store: ConversationRepo;
  seats: GroupSeats;
  turns: Turns;
  /** 开一轮前给这份会话带上群文件 */
  attach(seat: Conversation, brief: SeatBrief): Promise<SeatBrief>;
  logger: Logger;
}) {
  const { store, seats, turns, logger } = deps;

  /** 这份会话有空时开一轮：given 是交给它的话；不给就把它没听过的话交给它（这些话里没有叫它的就不开） */
  async function begin(taskId: string, requestId: string, given?: SeatBrief) {
    await withMessageLock(store, taskId, async (locked) => {
      const task = await locked.find(taskId);
      if (!task?.modelKey || task.turn) return;
      let brief = given;
      if (!brief) {
        const hearing = await seats.hearing(task.id, HEARING_LIMIT);
        const last = hearing?.heard.at(-1);
        brief = hearing && seatBrief(task.modelKey, hearing.roster, hearing.heard, hearing.skipped);
        if (!last || !brief) return;
        await seats.setHeard(task.id, last.seq);
      }
      await turns.begin(locked, task, [], requestId, await deps.attach(task, brief));
    });
  }

  return {
    /**
     * 一件事作为任务发到了群里、由这个 AI 负责：给它开一个云端任务（新的一份会话），
     * 交给它的是它的席位没听过的群聊；席位那边算听过了，不会再因为这句话开工。
     */
    async publish(groupId: string, key: string, requestId: string) {
      const seat = await seats.seat(groupId, key);
      const group = seat && (await store.find(groupId));
      if (!seat || !group) return;
      const hearing = await seats.hearing(seat.id, HEARING_LIMIT);
      const last = hearing?.heard.at(-1);
      const brief = hearing && seatBrief(key, hearing.roster, hearing.heard, hearing.skipped);
      if (!last || !brief) return;
      const task = await store.createTask({
        room: group,
        modelKey: key,
        title: brief.title,
        heardSeq: last.seq,
      });
      await seats.setHeard(seat.id, last.seq);
      await begin(task.id, requestId, brief).catch((err: unknown) =>
        logger.warn({ err, groupId, taskId: task.id }, '没能给这个任务开一轮'),
      );
    },

    /**
     * 这句话点名了一个云端任务的会话（让 AI 接着做、改这个任务），而且 @ 了做它的 AI：返回那个 AI 的 key。
     * 点名的不是这个群里的云端任务（比如是 AI 的席位）就不算，照平常 @ 它；它还在做这个任务时 409。
     */
    async toRevise(groupId: string, keys: Set<string>, seatId: string | undefined) {
      const task = seatId ? await store.find(seatId) : undefined;
      if (task?.kind !== 'task' || task.parentId !== groupId || !keys.has(task.modelKey ?? ''))
        return undefined;
      if (task.turn) throw new HttpError(409, 'task_running', '它还在做这个任务，做完再让它改');
      return task.modelKey ?? undefined;
    },

    /** 让 AI 接着做一个任务：那句话点名交给这个任务的会话（席位只当背景听），接着这份会话开一轮 */
    async revise(groupId: string, seq: number, taskId: string, requestId: string) {
      await seats.claim(groupId, seq, taskId);
      await begin(taskId, requestId).catch((err: unknown) =>
        logger.warn({ err, groupId, taskId }, '没能接着这个任务开一轮'),
      );
    },
  };
}
export type GroupTasks = ReturnType<typeof createGroupTasks>;
