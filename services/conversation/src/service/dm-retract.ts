// 删掉我在和 AI 的私聊里的一句话（真删除，连同随它发的文件）。还排着队、没交给 AI 的直接删；已经交给
// AI 的只能删最后一句（编辑也是先删，改好的由前端当新的一句发）：AI 对它的回复一起删，AI 的记忆退回这句话
// 之前（harness 撤回那一轮）。已经改的文件、交出的成果不动，任务卡留着。派到云端的话、一轮还在做时不能删。
import { SESSION_VERSION_GONE, UndoRunResult } from '@oasis/contracts/harness';
import { HttpError, type ServiceClient } from '@oasis/service-kit';
import type { Conversation, ConversationRepo, Message } from '../repo/conversation-repo.ts';

/** 往回看多少条消息：最后一句和 AI 对它的回复都在里面 */
const RECENT = 200;

const runOf = (message: Message) =>
  typeof message.data.runId === 'string' ? message.data.runId : undefined;

export function createDmRetract(deps: { harness: ServiceClient; canvas: ServiceClient }) {
  /** AI 对这句话的回复（它自己那份会话说的，不算云端任务说的）；这句话不是最后一句就 409 */
  async function repliesTo(store: ConversationRepo, dm: Conversation, message: Message) {
    const recent = await store.listMessages(dm.id, RECENT);
    const at = recent.findIndex((m) => m.id === message.id);
    const after = at < 0 ? [] : recent.slice(at + 1);
    if (at < 0 || after.some((m) => m.authorKind === 'user'))
      throw new HttpError(409, 'not_last', '只能删最后一句');
    // 云端任务各有一份会话，它们的话也写在这个私聊里：按轮认出来，不动
    const cloud = new Set<unknown>(
      (await store.tasksOf(dm.id)).flatMap((task) => [task.turn?.runId, task.lastRunId]),
    );
    for (const card of recent)
      if (card.kind === 'task' && card.data.seat)
        for (const runId of [card.data.runId, ...((card.data.runs as string[] | undefined) ?? [])])
          cloud.add(runId);
    return after.filter((m) => m.kind === 'text' && !cloud.has(runOf(m)));
  }

  return {
    /** 返回删掉的消息 */
    async remove(
      store: ConversationRepo,
      dm: Conversation,
      message: Message,
      requestId: string,
    ): Promise<string[]> {
      let replies: Message[] = [];
      if (!message.data.pending) {
        if (dm.turn) throw new HttpError(409, 'turn_active', '这一轮还在做，先停下再删这句话');
        if (message.data.task) throw new HttpError(409, 'not_retractable', '派到云端的话删不了');
        replies = await repliesTo(store, dm, message);
        // 这句话引出的那一轮是这份会话最近的一轮：撤回它，之后接着它之前的那一轮
        if (dm.lastRunId && replies.some((reply) => runOf(reply) === dm.lastRunId)) {
          const undone = await deps.harness
            .json('POST', `/internal/runs/${dm.lastRunId}/undo`, {
              body: { conversationId: dm.id },
              requestId,
              schema: UndoRunResult,
            })
            .catch((err: unknown) => {
              if (err instanceof HttpError && err.code === SESSION_VERSION_GONE)
                throw new HttpError(
                  409,
                  SESSION_VERSION_GONE,
                  '这句话之前 AI 的记忆没有存下来，删不了；想让它忘掉可以开新话题',
                );
              // 那一轮在 harness 里已经没有了：没有可撤的
              if (err instanceof HttpError && err.statusCode === 404) return undefined;
              throw err;
            });
          if (undone) await store.resumeFrom(dm.id, undone.continueFrom);
        }
      }
      // 先删文件再删消息：删文件失败时消息还在，重试即可
      const files = ((message.data.attachments as { id: string }[] | undefined) ?? []).map(
        (file) => file.id,
      );
      if (files.length)
        await deps.canvas.json('POST', '/internal/uploads/delete', {
          body: { ownerId: dm.ownerId, ids: files },
          requestId,
        });
      const removed = [...replies, message].map((gone) => gone.id);
      for (const id of removed) await store.deleteMessage(id);
      await store.touchConversation(dm.id);
      return removed;
    },
  };
}
