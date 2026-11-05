// 私聊：建会话、存消息、调模型并把回复流式推给前端。私聊的模型调用由会话主人付费。
// 每条用户消息先判断是不是在交代任务（ADR 0005 §2）：是就转去接需求，不走普通聊天。
import { ModelRoute } from '@oasis/contracts/agent';
import { OASIS_HEADERS } from '@oasis/contracts/common';
import { UploadLookupResult } from '@oasis/contracts/canvas';
import type {
  ConversationBody,
  MessageAttachment,
  MessageBody,
  StreamEvent,
} from '@oasis/contracts/conversation';
import type { ChatMessage } from '@oasis/contracts/model-gateway';
import { TaskList, type TaskSummary } from '@oasis/contracts/task';
import { createSseParser, HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import { z } from 'zod';
import type { Conversation, ConversationRepo, Message } from '../repo/conversation-repo.ts';
import { attachmentsOf } from './attachments.ts';
import { rendered, tokensOf, type ContextService } from './context.ts';
import type { IntakeService } from './intake-service.ts';

/** 给用户看的错误说明（上游的技术细节只进日志）。 */
const FRIENDLY_ERRORS: Record<string, string> = {
  insufficient_balance: '额度不够了，这条没有回复',
  provider_not_configured: '模型服务还没有配置好',
  provider_unavailable: '模型服务暂时连不上，请稍后再试',
  provider_error: '模型服务出错了，请稍后再试',
  provider_region_unavailable: '这个 AI 在当前网络所在的地区用不了，换一个 AI 试试',
  provider_busy: '这个 AI 现在太忙了，过一会儿再试',
  model_unavailable: '这个 AI 还没有接入',
  stream_interrupted: '回复连接中断，已保留内容，可以继续回复',
  reply_length: '本次回复达到长度上限，已保留内容，可以继续回复',
};

function toConversationBody(row: Conversation): ConversationBody {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    modelKey: row.modelKey,
    createdAt: row.createdAt.toISOString(),
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
  };
}

/** 任务进度的一句话 */
function taskState(t: TaskSummary): string {
  const progress = t.nodesTotal ? `（${t.nodesDone}/${t.nodesTotal} 步）` : '';
  if (t.revising) return `AI 团队正在按修改意见改${progress}`;
  switch (t.status) {
    case 'planning':
      return 'AI 团队正在排工作流';
    case 'running':
    case 'accepting':
      return `AI 团队正在做${progress}`;
    case 'succeeded':
      return '已交付';
    case 'failed':
      return '没做成';
    case 'cancelled':
      return '已取消';
    case 'stopped':
      return `用户停下了${progress}`;
    default:
      return `需要用户处理${progress}`;
  }
}

/** 哪些文件是任务素材 */
const InUse = z.object({ ids: z.array(z.string()) });

export function toMessageBody(row: Message): MessageBody {
  return {
    id: row.id,
    role: row.authorKind === 'user' ? 'user' : 'assistant',
    content: row.content,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    // data 按 kind 存的就是对应卡片的内容（写入时已经是契约里的形状）
    kind: row.kind,
    data: row.data,
  } as MessageBody;
}

export function createDmService(deps: {
  repo: ConversationRepo;
  agent: ServiceClient;
  modelGateway: ServiceClient;
  /** 核对用户随消息发的文件 */
  canvas: ServiceClient;
  /** 查用户的任务（被问起时回答进度）、删私聊时问哪些文件是任务素材 */
  task: ServiceClient;
  intake: IntakeService;
  /** 交给模型的历史：整段对话，快到窗口时压缩较早部分（ADR 0016 §8） */
  context: ContextService;
  replyMaxTokens: number;
  /** 认出任务的决策模型和两个阈值（ADR 0005 §2） */
  detect: { model: string; high: number; low: number };
  logger: Logger;
}) {
  const { repo } = deps;
  // 仅管理普通私聊生成，不持有或调用后台任务的控制句柄。
  const active = new Map<
    string,
    { controller: AbortController; ownerId: string; conversationId: string; canStop: boolean }
  >();

  async function chatTurn(store: ConversationRepo, conversationId: string, messageId: string) {
    const rows = await store.listMessages(conversationId, 10000);
    const user = rows.find((m) => m.id === messageId);
    if (!user || user.authorKind !== 'user' || user.kind !== 'text')
      throw new HttpError(404, 'message_not_found', '没有这条用户消息');
    if ((await store.taskSourceIds(conversationId)).includes(user.id))
      throw new HttpError(409, 'task_message_locked', '任务消息已锁定，不能编辑、删除或重新生成');
    const nextUser = rows.find((m) => m.authorKind === 'user' && m.seq > user.seq);
    const replies = rows.filter(
      (m) =>
        m.authorKind === 'ai' &&
        m.kind === 'text' &&
        (m.data.replyTo === user.id ||
          (!m.data.replyTo && m.seq > user.seq && (!nextUser || m.seq < nextUser.seq))),
    );
    return { user, replies };
  }

  async function controlled<T>(
    store: ConversationRepo,
    user: Message,
    work: (signal: AbortSignal) => Promise<T>,
  ) {
    const controller = new AbortController();
    active.set(user.id, {
      controller,
      ownerId: user.authorId,
      conversationId: user.conversationId,
      canStop: user.data.intent !== 'task',
    });
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void store
        .findMessage(user.conversationId, user.id)
        .then((row) => {
          if (!row || row.data.stopRequested) controller.abort();
        })
        .catch(() => controller.abort())
        .finally(() => {
          checking = false;
        });
    }, 250);
    try {
      return await work(controller.signal);
    } finally {
      clearInterval(timer);
      active.delete(user.id);
      await store.mergeMessageData(user.id, { replyPending: false });
    }
  }

  async function owned(conversationId: string, ownerId: string): Promise<Conversation> {
    const conversation = await repo.findOwned(conversationId, ownerId);
    if (!conversation) throw new HttpError(404, 'conversation_not_found', '没有这个会话');
    return conversation;
  }

  /**
   * 用户的任务进度（2026-11-05：任务和私聊解耦，任何一个私聊里的 AI 都能在用户问起时回答）。
   * 查不到时不带，照常聊天。
   */
  async function tasksNote(ownerId: string, requestId: string): Promise<string | null> {
    let tasks: TaskSummary[];
    try {
      ({ tasks } = await deps.task.json('GET', `/internal/owners/${ownerId}/tasks`, {
        requestId,
        schema: TaskList,
      }));
    } catch (err) {
      deps.logger.warn({ err, requestId }, '查不到用户的任务，这次聊天不带任务进度');
      return null;
    }
    if (!tasks.length) return null;
    const lines = tasks.map((t) => `- 「${t.title}」：${taskState(t)}`);
    return [
      '【用户交给 AI 团队的任务】（由 AI 团队在画布上做，你不负责执行。只有用户问起时才说；用户想改成果时，告诉他在画布的成果上批注后点「发给 AI 团队修改」）',
      ...lines,
    ].join('\n');
  }

  async function routeFor(modelKey: string, requestId: string) {
    return deps.agent.json('GET', `/internal/models/${encodeURIComponent(modelKey)}/route`, {
      requestId,
      schema: ModelRoute,
    });
  }

  /** 调模型并逐段回调；返回完整回复。上游在流中途报错时抛 HttpError（已收到的部分调用方已经通过 onDelta 拿到）。 */
  async function streamReply(input: {
    ownerId: string;
    providerModel: string;
    messages: ChatMessage[];
    requestId: string;
    onDelta: (text: string) => void;
    signal: AbortSignal;
  }): Promise<string> {
    const response = await deps.modelGateway.stream('POST', '/internal/v1/chat/completions', {
      body: {
        model: input.providerModel,
        messages: input.messages,
        max_tokens: deps.replyMaxTokens,
        stream: true,
      },
      headers: { [OASIS_HEADERS.payerId]: input.ownerId },
      requestId: input.requestId,
      signal: input.signal,
    });
    let text = '';
    let completed = false;
    let streamError: string | undefined;
    let limited = false;
    const parser = createSseParser((data) => {
      if (data === '[DONE]') {
        completed = true;
        return;
      }
      const chunk = JSON.parse(data) as {
        error?: { message?: string };
        choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
      };
      if (chunk.error) streamError = chunk.error.message ?? '回复中断了';
      const finish = chunk.choices?.[0]?.finish_reason;
      if (finish === 'length') limited = true;
      else if (finish && finish !== 'stop') streamError = `回复未正常结束：${finish}`;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        input.onDelta(delta);
      }
    });
    const decoder = new TextDecoder();
    for await (const bytes of response.body as AsyncIterable<Uint8Array>) {
      parser.push(decoder.decode(bytes, { stream: true }));
    }
    parser.end();
    input.signal.throwIfAborted();
    if (!completed) streamError ??= '回复未收到完成标记';
    if (streamError) throw new HttpError(502, 'stream_interrupted', streamError);
    if (limited) throw new HttpError(502, 'reply_length', '回复达到长度上限');
    return text;
  }

  function emitAll(emit: (event: StreamEvent) => void, messages: Message[]) {
    for (const message of messages) emit({ type: 'done', message: toMessageBody(message) });
  }

  function friendly(err: unknown): { code: string; message: string } {
    const code = err instanceof HttpError ? err.code : 'internal_error';
    const message =
      FRIENDLY_ERRORS[code] ??
      (err instanceof HttpError && err.statusCode < 500 ? err.message : '回复失败了，请重试');
    return { code, message };
  }

  /** 接需求出错：存一条失败的 AI 消息，告诉前端 */
  async function emitFailure(
    conversation: Conversation,
    err: unknown,
    emit: (event: StreamEvent) => void,
  ) {
    const { code, message } = friendly(err);
    if (!(err instanceof HttpError) || err.statusCode >= 500) {
      deps.logger.error({ err, conversationId: conversation.id }, '接需求失败');
    }
    await repo.insertMessage({
      conversationId: conversation.id,
      authorKind: 'ai',
      authorId: conversation.modelKey ?? 'unknown',
      content: '',
      status: 'failed',
    });
    await repo.touchConversation(conversation.id);
    emit({ type: 'error', code, message });
  }

  /** 普通聊天：流式推送回复 */
  async function chat(
    store: ConversationRepo,
    conversation: Conversation,
    input: {
      ownerId: string;
      requestId: string;
      emit: (event: StreamEvent) => void;
      signal: AbortSignal;
      user: Message;
      placeholder?: Message;
      prefix?: string;
    },
    suggestTask: boolean,
  ) {
    const placeholder =
      input.placeholder ??
      (await store.insertMessage({
        conversationId: conversation.id,
        authorKind: 'ai',
        authorId: conversation.modelKey ?? 'unknown',
        content: '',
        status: 'streaming',
        data: { suggestTask, replyTo: input.user.id },
      }));
    let partial = input.prefix ?? '';
    if (partial) input.emit({ type: 'delta', text: partial });
    try {
      input.signal.throwIfAborted();
      const route = await routeFor(conversation.modelKey ?? '', input.requestId);
      input.signal.throwIfAborted();
      const history = await deps.context.history({
        conversation,
        excludeId: placeholder.id,
        beforeSeq: input.user.seq,
        providerModels: [route.providerModel],
        reserveTokens: tokensOf(route.systemPrompt) + deps.replyMaxTokens,
        ownerId: input.ownerId,
        requestId: input.requestId,
      });
      input.signal.throwIfAborted();
      const tasks = await tasksNote(input.ownerId, input.requestId);
      input.signal.throwIfAborted();
      const messages: ChatMessage[] = [
        { role: 'system', content: route.systemPrompt },
        ...(tasks ? [{ role: 'system' as const, content: tasks }] : []),
        ...(history.summary
          ? [{ role: 'system' as const, content: `【较早对话的摘要】\n${history.summary}` }]
          : []),
        ...history.messages.map((m): ChatMessage => ({
          role: m.authorKind === 'user' ? 'user' : 'assistant',
          content: rendered(m, history.labels),
        })),
      ];
      if (input.prefix) {
        messages.push({ role: 'assistant', content: input.prefix });
        messages.push({
          role: 'user',
          content: '从上次中断处继续，保留原要求，不重复已经输出的内容。',
        });
      }
      await streamReply({
        ownerId: input.ownerId,
        providerModel: route.providerModel,
        messages,
        requestId: input.requestId,
        signal: input.signal,
        onDelta: (delta) => {
          partial += delta;
          input.emit({ type: 'delta', text: delta });
        },
      });
      input.signal.throwIfAborted();
      await store.mergeMessageData(placeholder.id, { stopped: false, resumable: false });
      const done = await store.finishMessage(placeholder.id, {
        content: partial,
        status: 'complete',
      });
      await store.touchConversation(conversation.id);
      input.emit({ type: 'done', message: toMessageBody(done) });
    } catch (err) {
      if (input.signal.aborted) {
        await store.mergeMessageData(placeholder.id, { stopped: true, resumable: true });
        const done = await store.finishMessage(placeholder.id, {
          content: partial,
          status: 'complete',
        });
        input.emit({ type: 'done', message: toMessageBody(done) });
        return;
      }
      const { code, message } = friendly(err);
      if (!(err instanceof HttpError) || err.statusCode >= 500) {
        deps.logger.error({ err, conversationId: conversation.id }, 'AI 回复失败');
      }
      await store.mergeMessageData(placeholder.id, {
        resumable: code === 'reply_length' || code === 'stream_interrupted',
      });
      await store.finishMessage(placeholder.id, {
        content: partial,
        status: 'failed',
        error: message,
      });
      await store.touchConversation(conversation.id);
      input.emit({ type: 'error', code, message });
    }
  }

  type TurnInput = {
    ownerId: string;
    conversationId: string;
    content: string;
    asTask: boolean;
    attachments: MessageAttachment[];
    requestId: string;
    emit: (event: StreamEvent) => void;
  };
  async function processTurn(
    store: ConversationRepo,
    conversation: Conversation,
    userMessage: Message,
    input: TurnInput,
    placeholder?: Message,
  ) {
    await controlled(store, userMessage, async (signal) => {
      input.emit({ type: 'accepted', userMessage: toMessageBody(userMessage) });

      let suggestTask: boolean;
      try {
        // Jev 和问需求的 AI 判断时看整段对话（别的任务的消息带标签），按两者中较小的窗口压缩
        const route = await routeFor(conversation.modelKey ?? '', input.requestId);
        const history = await deps.context.history({
          conversation,
          excludeId: userMessage.id,
          beforeSeq: userMessage.seq,
          providerModels: [route.providerModel, deps.detect.model],
          reserveTokens: tokensOf(route.systemPrompt) + deps.replyMaxTokens,
          ownerId: input.ownerId,
          requestId: input.requestId,
        });
        signal.throwIfAborted();
        const open = await deps.intake.findOpen(conversation.id);
        // 有任务还在整理时，先判断这句话是不是在说它；不是就照常聊天或开始新任务（2026-11-05）
        const verdict = open
          ? await deps.intake.duringIntake({
              ownerId: input.ownerId,
              content: input.content,
              intake: open,
              history,
              requestId: input.requestId,
              signal,
            })
          : null;
        signal.throwIfAborted();
        if (open && (!verdict || verdict.about >= 0.5)) {
          active.get(userMessage.id)!.canStop = false;
          if (
            !(await store.mergeMessageData(
              userMessage.id,
              { intent: 'task', intakeId: open.id },
              true,
            ))
          )
            throw new DOMException('已停止', 'AbortError');
          input.emit({ type: 'activity', phase: 'intake' });
          return emitAll(
            input.emit,
            await deps.intake.userSaid({
              conversation,
              intake: open,
              ownerId: input.ownerId,
              text: input.content,
              attachments: input.attachments,
              requestId: input.requestId,
            }),
          );
        }
        const probability = input.asTask
          ? 1
          : verdict
            ? verdict.task
            : await deps.intake.taskProbability({
                ownerId: input.ownerId,
                content: input.content,
                history,
                requestId: input.requestId,
                signal,
              });
        signal.throwIfAborted();
        if (input.asTask || probability >= deps.detect.high) {
          active.get(userMessage.id)!.canStop = false;
          if (!(await store.mergeMessageData(userMessage.id, { intent: 'task' }, true))) {
            throw new DOMException('已停止', 'AbortError');
          }
          input.emit({ type: 'activity', phase: 'intake' });
          // 一个会话同时只整理一件任务：交代了另一件新任务，就把还没确认的那件收起来
          const closed = open
            ? await deps.intake.cancel(
                conversation,
                '上一件还没确认的任务先放下了，我按新的需求来整理。',
              )
            : [];
          return emitAll(input.emit, [
            ...closed,
            ...(await deps.intake.start({
              conversation,
              ownerId: input.ownerId,
              request: input.content,
              sourceMessageId: userMessage.id,
              attachments: input.attachments,
              requestId: input.requestId,
            })),
          ]);
        }
        // 正在整理任务时说的别的事，不再提示「当成任务来做」，任务卡片留着可以接着点
        suggestTask = !open && probability >= deps.detect.low;
      } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
          await chat(
            store,
            conversation,
            {
              ...input,
              signal: AbortSignal.abort(),
              user: userMessage,
              ...(placeholder ? { placeholder } : {}),
            },
            false,
          );
          return;
        }
        return emitFailure(conversation, err, input.emit);
      }
      await store.mergeMessageData(userMessage.id, { replyPhase: 'chat' });
      input.emit({ type: 'activity', phase: 'chat' });
      await chat(
        store,
        conversation,
        { ...input, signal, user: userMessage, ...(placeholder ? { placeholder } : {}) },
        suggestTask,
      );
    });
  }

  async function continueTurn(
    store: ConversationRepo,
    conversation: Conversation,
    messageId: string,
    input: Pick<TurnInput, 'ownerId' | 'requestId' | 'emit'>,
  ) {
    const { user, replies } = await chatTurn(store, conversation.id, messageId);
    const reply = replies.at(-1);
    const rows = await store.listMessages(conversation.id, 10000);
    if (rows.some((m) => m.authorKind === 'user' && m.seq > user.seq))
      throw new HttpError(409, 'reply_not_latest', '只能继续最近一轮回复');
    if (!reply || !(reply.data.stopped || reply.data.resumable || reply.status === 'failed'))
      throw new HttpError(409, 'reply_not_paused', '这条回复不需要继续');
    const updated = (await store.mergeMessageData(user.id, {
      stopRequested: false,
      replyPending: true,
    }))!;
    // 保留旧正文和附件；不删除消息，不把继续当成新需求。
    if (!reply.content && user.data.replyPhase !== 'chat') {
      await processTurn(
        store,
        conversation,
        updated,
        {
          ...input,
          conversationId: conversation.id,
          content: user.content,
          asTask: false,
          attachments: attachmentsOf(user),
        },
        reply,
      );
      return;
    }
    await controlled(store, updated, async (signal) => {
      input.emit({ type: 'accepted', userMessage: toMessageBody(updated) });
      input.emit({ type: 'activity', phase: 'chat' });
      await chat(
        store,
        conversation,
        { ...input, signal, user: updated, placeholder: reply, prefix: reply.content },
        Boolean(reply.data.suggestTask),
      );
    });
  }

  return {
    assertOwned: owned,

    async createDm(
      ownerId: string,
      modelKey: string,
      requestId: string,
    ): Promise<ConversationBody> {
      const route = await routeFor(modelKey, requestId);
      return toConversationBody(await repo.upsertDm(ownerId, modelKey, route.name));
    },

    async listDms(ownerId: string): Promise<ConversationBody[]> {
      return (await repo.listDms(ownerId)).map(toConversationBody);
    },

    async listMessages(ownerId: string, conversationId: string): Promise<MessageBody[]> {
      await owned(conversationId, ownerId);
      const taskIds = new Set(await repo.taskSourceIds(conversationId));
      return (await repo.listMessages(conversationId, 500)).map((m) =>
        toMessageBody(taskIds.has(m.id) ? { ...m, data: { ...m.data, intent: 'task' } } : m),
      );
    },

    /**
     * 删除私聊（2026-11-05）：消息、卡片、接需求记录和摘要真删除，消息带的文件在 canvas 里一起删；
     * 已经成为任务素材的文件留着（任务还要用）。任务和成果不受影响；再点开这个 AI 是全新的私聊。
     */
    async deleteDm(ownerId: string, conversationId: string, requestId: string) {
      const conversation = await owned(conversationId, ownerId);
      if (conversation.kind !== 'dm')
        throw new HttpError(404, 'conversation_not_found', '没有这个私聊');
      // 正在生成的回复先停下
      for (const turn of active.values())
        if (turn.conversationId === conversationId) turn.controller.abort();
      await repo.withMessageLock(conversationId, async (store) => {
        await store.withIntakeLock(conversationId, async (scoped) => {
          const ids = await scoped.attachmentIds(conversationId);
          if (ids.length) {
            const { ids: used } = await deps.task.json('POST', '/internal/materials/in-use', {
              body: { ownerId, ids },
              requestId,
              schema: InUse,
            });
            const free = ids.filter((id) => !used.includes(id));
            // 先删文件再删对话：删文件失败时对话还在，用户重试即可（删文件是幂等的）
            if (free.length)
              await deps.canvas.json('POST', '/internal/uploads/delete', {
                body: { ownerId, ids: free },
                requestId,
              });
          }
          await scoped.deleteConversation(conversationId);
        });
      });
      deps.logger.info({ conversationId }, '私聊已删除');
    },

    async deleteMessage(ownerId: string, conversationId: string, messageId: string) {
      await owned(conversationId, ownerId);
      await repo.withMessageLock(conversationId, async (store) => {
        await store.withIntakeLock(conversationId, async (scoped) => {
          const { user, replies } = await chatTurn(scoped, conversationId, messageId);
          // 真删除（2026-11-05）：先在 canvas 里把消息带的文件连对象一起删掉，再删消息；
          // 删文件失败时消息也不删，用户重试即可（删文件是幂等的）
          const attachments = [user, ...replies].flatMap((m) => attachmentsOf(m).map((a) => a.id));
          if (attachments.length)
            await deps.canvas.json('POST', '/internal/uploads/delete', {
              body: { ownerId, ids: attachments },
            });
          await scoped.mutateChat(conversationId, [user, ...replies]);
        });
        await store.touchConversation(conversationId);
      });
    },

    async stopReply(ownerId: string, conversationId: string, messageId: string) {
      // 本机在途调用先按已鉴权归属中止，避免长流占满连接池后连停止操作也排队。
      const inflight = active.get(messageId);
      if (
        inflight?.ownerId === ownerId &&
        inflight.conversationId === conversationId &&
        inflight.canStop
      )
        inflight.controller.abort();
      await owned(conversationId, ownerId);
      const { user } = await chatTurn(repo, conversationId, messageId);
      if (!(await repo.requestStop(conversationId, user.id)))
        throw new HttpError(409, 'task_message_locked', '任务消息已锁定');
      active.get(user.id)?.controller.abort();
    },

    async replaceReply(input: {
      ownerId: string;
      conversationId: string;
      messageId: string;
      content?: string;
      continue?: boolean;
      requestId: string;
      emit: (event: StreamEvent) => void;
    }) {
      const conversation = await owned(input.conversationId, input.ownerId);
      await repo.withMessageLock(conversation.id, async (store) => {
        if (input.continue) return continueTurn(store, conversation, input.messageId, input);
        const { user, reply } = await store.withIntakeLock(conversation.id, async (scoped) => {
          const { user, replies } = await chatTurn(scoped, conversation.id, input.messageId);
          const reply = replies[0];
          await scoped.mutateChat(conversation.id, [user, ...replies], {
            id: user.id,
            content: input.content ?? user.content,
            ...(reply ? { replyId: reply.id } : {}),
          });
          return { user, reply };
        });
        const updated = (await store.mergeMessageData(user.id, {
          intent: 'chat',
          replyPhase: 'chat',
          stopRequested: false,
          replyPending: true,
        }))!;
        await controlled(store, updated, async (signal) => {
          input.emit({ type: 'accepted', userMessage: toMessageBody(updated) });
          input.emit({ type: 'activity', phase: 'chat' });
          await chat(
            store,
            conversation,
            {
              ...input,
              signal,
              user: updated,
              ...(reply
                ? { placeholder: (await store.findMessage(conversation.id, reply.id))! }
                : {}),
            },
            false,
          );
        });
      });
    },

    /**
     * 发一条消息。所有结果（包括失败）都通过 emit 告诉前端，并存库：
     * - 正在接需求：这句话当作补充或修改意见，AI 接着问或改任务单；
     * - 像是在交代任务（或点了「发任务」）：开始接需求，出问题卡或任务单；
     * - 否则照常聊天，流式推送回复；有点像任务时回复下面附「当成任务来做」。
     */
    /** 核对随消息发的文件都在 canvas 里、都是这个人的；有一个不是就整条消息不收 */
    async resolveAttachments(
      ownerId: string,
      ids: string[],
      requestId: string,
    ): Promise<MessageAttachment[]> {
      if (ids.length === 0) return [];
      try {
        const { uploads } = await deps.canvas.json('POST', '/internal/uploads/lookup', {
          // claim：文件随消息发出、被用上了，canvas 的清扫不再删它
          body: { ownerId, ids, claim: true },
          requestId,
          schema: UploadLookupResult,
        });
        return uploads.map(({ id, name, size, contentType }) => ({ id, name, size, contentType }));
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 404) {
          throw new HttpError(400, 'attachment_not_found', '有文件没找到，请重新添加');
        }
        throw err;
      }
    },

    async sendMessage(input: {
      ownerId: string;
      conversationId: string;
      content: string;
      asTask: boolean;
      /** 已经核对过的附件（resolveAttachments） */
      attachments: MessageAttachment[];
      requestId: string;
      emit: (event: StreamEvent) => void;
    }): Promise<void> {
      const conversation = await owned(input.conversationId, input.ownerId);
      await repo.withMessageLock(conversation.id, async (store) => {
        if (
          !input.asTask &&
          input.attachments.length === 0 &&
          /^(继续|继续回复)[。！!]?$/u.test(input.content.trim()) &&
          !(await deps.intake.findOpen(conversation.id))
        ) {
          const rows = await store.listMessages(conversation.id, 10000);
          const last = rows.filter((m) => m.kind !== 'notice').at(-1);
          if (
            last?.authorKind === 'ai' &&
            (last.data.stopped || last.data.resumable || last.status === 'failed') &&
            typeof last.data.replyTo === 'string'
          ) {
            return continueTurn(store, conversation, last.data.replyTo, input);
          }
        }
        const userMessage = await store.insertMessage({
          conversationId: conversation.id,
          authorKind: 'user',
          authorId: input.ownerId,
          content: input.content,
          status: 'complete',
          data: {
            attachments: input.attachments,
            intent: input.asTask ? 'task' : 'chat',
            replyPending: true,
          },
        });
        await processTurn(store, conversation, userMessage, input);
      });
    },
  };
}

export type DmService = ReturnType<typeof createDmService>;
