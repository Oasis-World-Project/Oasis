// 任务的结果回到私聊（ADR 0005 §6）：消费 task 的 task.task.status_changed，
// 完成时发交付消息，需要用户处理或没能完成时发提醒。同一个事件只发一条消息（事件可能重复到达）。
import type { DeliveryCard, NoticeCard } from '@oasis/contracts/conversation';
import type { TaskStatusChangedData } from '@oasis/contracts/events';
import { TaskBody } from '@oasis/contracts/task';
import type { Logger, ServiceClient } from '@oasis/service-kit';
import type { ConversationRepo } from '../repo/conversation-repo.ts';

const list = (items: string[]) => items.map((x) => `- ${x}`).join('\n');

/** 交付消息的文字（卡片之外只显示文字的地方用） */
function deliveryText(card: DeliveryCard): string {
  const parts = [`「${card.title}」做好了。`];
  if (card.files.length > 0) {
    parts.push(`成果：\n${list(card.files.map((f) => `${f.deliverable}：${f.path}`))}`);
  }
  if (card.unmet.length > 0) parts.push(`没完全满足的地方：\n${list(card.unmet)}`);
  if (card.warnings.length > 0) parts.push(`过程中的提醒：\n${list(card.warnings)}`);
  if (card.unmet.length > 0) parts.push('需要改的话，告诉我要怎么改，我再交给 AI 团队做一版。');
  return parts.join('\n\n');
}

/** 从任务详情整理出交付消息 */
function deliveryCard(task: TaskBody): DeliveryCard {
  const byId = new Map(task.nodes.map((n) => [n.id, n]));
  return {
    taskId: task.id,
    title: task.title,
    files: task.deliverables.flatMap((d) => {
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
    warnings: task.nodes.flatMap((n) => (n.warning ? [`「${n.title}」${n.warning}`] : [])),
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
      const conversation = await repo.findOwned(data.conversationId, data.ownerId);
      if (!conversation) return;
      const base = {
        conversationId: conversation.id,
        authorKind: 'ai' as const,
        authorId: conversation.modelKey ?? 'unknown',
        status: 'complete' as const,
      };
      let inserted;
      if (data.status === 'succeeded') {
        const task = await deps.task.json('GET', `/internal/tasks/${data.taskId}`, {
          schema: TaskBody,
        });
        const card = deliveryCard(task);
        inserted = await repo.insertMessageOnce({
          ...base,
          kind: 'delivery',
          content: deliveryText(card),
          data: { ...card, eventId },
        });
      } else if (data.status === 'needs_attention' || data.status === 'failed') {
        const message =
          data.status === 'failed'
            ? `「${data.title}」没能完成。`
            : `「${data.title}」需要你处理：${data.attention?.message ?? ''}`;
        const card: NoticeCard = { taskId: data.taskId, status: data.status, message };
        inserted = await repo.insertMessageOnce({
          ...base,
          kind: 'notice',
          content: message,
          data: { ...card, eventId },
        });
      } else {
        return; // 规划中、运行中、验收中、已停止、已取消：任务卡自己会显示，不另发消息
      }
      if (inserted) {
        await repo.touchConversation(conversation.id);
        logger.info({ taskId: data.taskId, status: data.status }, '任务结果发到私聊');
      }
    },
  };
}
