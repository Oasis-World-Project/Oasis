// 消费 task.task.status_changed：第一次完成时在发起它的私聊里发交付，过程状态留在工作流。
// 同一个事件只发一条消息（事件可能重复到达）。
import type { DeliveryCard } from '@oasis/contracts/conversation';
import type { TaskDeletedData, TaskStatusChangedData } from '@oasis/contracts/events';
import { TaskBody } from '@oasis/contracts/task';
import type { Logger, ServiceClient } from '@oasis/service-kit';
import type { ConversationRepo } from '../repo/conversation-repo.ts';

const list = (items: string[]) => items.map((x) => `- ${x}`).join('\n');

/** 交付消息的文字（卡片之外只显示文字的地方用） */
function deliveryText(card: DeliveryCard): string {
  const parts = [
    `「${card.title}」${card.unmet.length ? '已交付，有未满足项' : card.unchecked?.length ? '已交付，部分检查未完成' : '已交付'}。成果保存在系统中，可预览或主动下载；仅在你授权同步文件夹后自动保存到电脑。`,
  ];
  if (card.files.length > 0) {
    parts.push(`成果：\n${list(card.files.map((f) => `${f.deliverable}：${f.path}`))}`);
  }
  if (card.unmet.length > 0) parts.push(`没完全满足的地方：\n${list(card.unmet)}`);
  if (card.warnings.length > 0) parts.push(`过程中的提醒：\n${list(card.warnings)}`);
  if (card.unchecked?.length) parts.push(`未完成的检查：\n${list(card.unchecked)}`);
  if (card.unmet.length > 0)
    parts.push(
      '需要改的话，在画布的成果上批注后点「发给 AI 团队修改」，AI 团队会接着改、原地更新成果。',
    );
  return parts.join('\n\n');
}

/** 从任务详情整理出交付消息 */
function deliveryCard(task: TaskBody): DeliveryCard {
  const byId = new Map(task.nodes.map((n) => [n.id, n]));
  return {
    taskId: task.id,
    title: task.title,
    files:
      task.deliveryFiles ??
      task.deliverables.flatMap((d) => {
        const node = d.nodeId ? byId.get(d.nodeId) : undefined;
        return node
          ? node.outputs.map((f) => ({
              deliverable: d.name,
              nodeId: node.id,
              path: f.path,
              size: f.size,
            }))
          : [];
      }),
    unmet: task.acceptance?.unmet ?? [],
    unchecked: task.acceptance?.unchecked ?? [],
    warnings: [
      ...task.nodes.flatMap((n) => (n.warning ? [`「${n.title}」${n.warning}`] : [])),
      ...(task.acceptance?.unchecked ?? []).map((u) => `未完成的检查：${u}`),
    ],
  };
}

export function createTaskNotices(deps: {
  repo: ConversationRepo;
  task: ServiceClient;
  logger: Logger;
}) {
  const { repo, logger } = deps;

  return {
    async onStatusChanged(eventId: string, data: TaskStatusChangedData): Promise<void> {
      if (!data.conversationId) return;
      if (data.status !== 'succeeded') return; // 过程状态与检查原因只在工作流显示。
      const conversation = await repo.findOwned(data.conversationId, data.ownerId);
      // 私聊删了就不发；修改后的新版不再发到私聊（2026-11-05：修改直接交给 AI 团队，进度在画布上看，
      // 私聊里的 AI 只在用户问起时回答）
      if (!conversation || (await repo.hasDelivery(conversation.id, data.taskId))) return;
      const base = {
        conversationId: conversation.id,
        authorKind: 'ai' as const,
        authorId: conversation.modelKey ?? 'unknown',
        status: 'complete' as const,
      };
      const task = await deps.task.json('GET', `/internal/tasks/${data.taskId}`, {
        schema: TaskBody,
      });
      const card = deliveryCard(task);
      const inserted = await repo.insertMessageOnce({
        ...base,
        kind: 'delivery',
        content: deliveryText(card),
        data: { ...card, eventId },
      });
      if (inserted) {
        await repo.touchConversation(conversation.id);
        logger.info({ taskId: data.taskId, status: data.status }, '任务结果发到私聊');
      }
    },

    /**
     * 任务被用户删除（真删除，2026-11-05）：它在私聊里的任务卡、交付消息和提醒都删掉，
     * 不留「已删除」的空壳。重复到达时结果一样。
     */
    async onDeleted(data: TaskDeletedData): Promise<void> {
      if (!data.conversationId) return;
      const conversation = await repo.findOwned(data.conversationId, data.ownerId);
      if (!conversation) return;
      const removed = await repo.removeTaskMessages(conversation.id, data.taskId);
      if (removed) logger.info({ taskId: data.taskId, removed }, '私聊里这个任务的消息已删除');
    },
  };
}
