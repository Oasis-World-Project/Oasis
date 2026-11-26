// 和 AI 的私聊里的云端任务：用户说一句「在云端做」，这件事单独派到云端——开一份自己的会话（挂在私聊下面的
// 一行，kind = 'task'），和私聊自己那一轮互不挡；之后点名这个任务让它接着做、改，就接着这份会话。
// 话和任务卡都写在私聊里；带过去的只有这句话和随它发的文件。
import { HttpError } from '@oasis/service-kit';
import {
  withMessageLock,
  type Conversation,
  type ConversationRepo,
  type Message,
} from '../repo/conversation-repo.ts';
import { taskTitle } from './task-title.ts';
import type { Turns } from './turns.ts';

export function createDmCloud(deps: { repo: ConversationRepo; turns: Pick<Turns, 'begin'> }) {
  const { repo } = deps;
  return {
    /**
     * 这句话点名的云端任务的会话（任务卡上的 seat）：得是这个私聊下面的；不是就不算（照平常发）。
     * 它还在做这个任务时 409。
     */
    async target(dm: Conversation, seatId: string | undefined) {
      const task = seatId ? await repo.find(seatId) : undefined;
      if (task?.kind !== 'task' || task.parentId !== dm.id) return undefined;
      if (task.turn) throw new HttpError(409, 'task_running', '它还在做这个任务，做完再让它改');
      return task;
    },

    /** 把这句话交给云端：接着 task 做；没有就开一个新任务的会话。返回这一轮里 AI 的消息 */
    async begin(
      dm: Conversation,
      task: Conversation | undefined,
      said: Message,
      requestId: string,
    ) {
      const row =
        task ??
        (await repo.createTask({
          room: dm,
          modelKey: dm.modelKey ?? '',
          title: taskTitle([], said.content),
        }));
      return withMessageLock(repo, row.id, (locked) =>
        deps.turns.begin(locked, row, [said], requestId),
      );
    },
  };
}
