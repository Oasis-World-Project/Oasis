// 修改成果（ADR 0012，2026-11-05 改为在原任务里接着做）：把修改意见（用户原话 + 每条批注一行 + 参数）交给
// 原任务，交付节点接着原会话改、下游跟着更新；不新建任务、不重新规划、不调用模型。新版交付后 canvas 原地更新成果。
import type {
  MessageAttachment,
  RevisionNote,
  RevisionParameter,
} from '@oasis/contracts/conversation';
import { TaskBody } from '@oasis/contracts/task';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import type { Conversation, ConversationRepo, Message } from '../repo/conversation-repo.ts';
import { mergeMaterials } from './attachments.ts';

/**
 * 修改意见的完整文字：用户写的话，加上每条批注一行（ADR 0012 §9）。
 * 交给原任务的修改意见和私聊里的消息都用它，保证两处说的是同一件事。
 */
export function revisionText(
  request: string,
  annotations: RevisionNote[],
  parameters: RevisionParameter[] = [],
): string {
  // 按用户看到的顺序（前端按文件、编号排好）
  const notes = annotations.map((a) => {
    const extra = [
      a.quote ? `原文「${a.quote}」` : '',
      a.snapshot ? `见截图 ${a.snapshot}` : '',
    ].filter(Boolean);
    return `${a.number}.「${a.file}」${a.where}：${a.note}${extra.length ? `（${extra.join('；')}）` : ''}`;
  });
  const params = parameters.map((p) => `「${p.file}」${p.name}：${p.value}`);
  return [
    request,
    ...(notes.length ? ['批注：', ...notes] : []),
    ...(params.length ? ['参数：', ...params] : []),
  ]
    .filter(Boolean)
    .join('\n');
}

export function createRevisionService(deps: {
  repo: ConversationRepo;
  task: ServiceClient;
  logger: Logger;
}) {
  const { repo, logger } = deps;

  return {
    /** 发起修改：返回这次新增的消息（用户的修改意见、任务卡） */
    async revise(input: {
      conversation: Conversation;
      ownerId: string;
      taskId: string;
      request: string;
      annotations: RevisionNote[];
      parameters?: RevisionParameter[];
      attachments: MessageAttachment[];
      requestId: string;
    }): Promise<Message[]> {
      const { ownerId, requestId } = input;
      const text = revisionText(input.request, input.annotations, input.parameters ?? []);
      let task: TaskBody;
      try {
        task = await deps.task.json('POST', `/internal/tasks/${input.taskId}/revise`, {
          body: { ownerId, request: text, materials: mergeMaterials([], input.attachments) },
          schema: TaskBody,
          requestId,
        });
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 404)
          throw new HttpError(404, 'task_not_found', '没有这个任务');
        throw err;
      }
      const userMessage = await repo.insertMessage({
        conversationId: input.conversation.id,
        authorKind: 'user',
        authorId: ownerId,
        content: `修改「${task.title}」：${text}`,
        status: 'complete',
        kind: 'text',
        data: { intent: 'task', attachments: input.attachments },
      });
      const card = await repo.insertMessage({
        conversationId: input.conversation.id,
        authorKind: 'ai',
        authorId: input.conversation.modelKey ?? 'unknown',
        content: `好的，接着原来的工作流按你的意见改「${task.title}」。改好后画布里的成果会直接更新，进度会显示在这里。`,
        status: 'complete',
        kind: 'task',
        // revisionOf 指向自己：卡片标成「修改」（同一个任务接着改）
        data: { taskId: task.id, revisionOf: task.id },
      });
      await repo.touchConversation(input.conversation.id);
      logger.info({ taskId: task.id }, '发起修改，在原任务里接着改');
      return [userMessage, card];
    },
  };
}

export type RevisionService = ReturnType<typeof createRevisionService>;
