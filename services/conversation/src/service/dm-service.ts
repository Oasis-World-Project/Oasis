// 私聊：建会话、存消息、调模型并把回复流式推给前端。私聊的模型调用由会话主人付费。
// 每条用户消息先判断是不是在交代任务（ADR 0005 §2）：是就转去接需求，不走普通聊天。
import { ModelRoute } from '@oasis/contracts/agent';
import { OASIS_HEADERS } from '@oasis/contracts/common';
import type { ConversationBody, MessageBody, StreamEvent } from '@oasis/contracts/conversation';
import type { ChatMessage } from '@oasis/contracts/model-gateway';
import { createSseParser, HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import type { Conversation, ConversationRepo, Message } from '../repo/conversation-repo.ts';
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
  stream_interrupted: '回复中断了，已保留收到的部分',
  intake_failed: '没能把需求整理好，请换个说法再说一次',
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
  intake: IntakeService;
  historyLimit: number;
  replyMaxTokens: number;
  /** 认出任务的两个阈值（ADR 0005 §2） */
  detect: { high: number; low: number };
  logger: Logger;
}) {
  const { repo } = deps;

  async function owned(conversationId: string, ownerId: string): Promise<Conversation> {
    const conversation = await repo.findOwned(conversationId, ownerId);
    if (!conversation) throw new HttpError(404, 'conversation_not_found', '没有这个会话');
    return conversation;
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
    });
    let text = '';
    let streamError: string | undefined;
    const parser = createSseParser((data) => {
      if (data === '[DONE]') return;
      const chunk = JSON.parse(data) as {
        error?: { message?: string };
        choices?: { delta?: { content?: string } }[];
      };
      if (chunk.error) streamError = chunk.error.message ?? '回复中断了';
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
    if (streamError) throw new HttpError(502, 'stream_interrupted', streamError);
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
    conversation: Conversation,
    input: { ownerId: string; requestId: string; emit: (event: StreamEvent) => void },
    suggestTask: boolean,
  ) {
    const placeholder = await repo.insertMessage({
      conversationId: conversation.id,
      authorKind: 'ai',
      authorId: conversation.modelKey ?? 'unknown',
      content: '',
      status: 'streaming',
      data: suggestTask ? { suggestTask } : {},
    });
    let partial = '';
    try {
      const route = await routeFor(conversation.modelKey ?? '', input.requestId);
      const history = await repo.recentComplete(conversation.id, deps.historyLimit, placeholder.id);
      const messages: ChatMessage[] = [
        { role: 'system', content: route.systemPrompt },
        ...history.map((m): ChatMessage => ({
          role: m.authorKind === 'user' ? 'user' : 'assistant',
          content: m.content,
        })),
      ];
      const text = await streamReply({
        ownerId: input.ownerId,
        providerModel: route.providerModel,
        messages,
        requestId: input.requestId,
        onDelta: (delta) => {
          partial += delta;
          input.emit({ type: 'delta', text: delta });
        },
      });
      const done = await repo.finishMessage(placeholder.id, { content: text, status: 'complete' });
      await repo.touchConversation(conversation.id);
      input.emit({ type: 'done', message: toMessageBody(done) });
    } catch (err) {
      const { code, message } = friendly(err);
      if (!(err instanceof HttpError) || err.statusCode >= 500) {
        deps.logger.error({ err, conversationId: conversation.id }, 'AI 回复失败');
      }
      await repo.finishMessage(placeholder.id, {
        content: partial,
        status: 'failed',
        error: message,
      });
      await repo.touchConversation(conversation.id);
      input.emit({ type: 'error', code, message });
    }
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
      return (await repo.listMessages(conversationId, 500)).map(toMessageBody);
    },

    /**
     * 发一条消息。所有结果（包括失败）都通过 emit 告诉前端，并存库：
     * - 正在接需求：这句话当作补充或修改意见，AI 接着问或改任务单；
     * - 像是在交代任务（或点了「发任务」）：开始接需求，出问题卡或任务单；
     * - 否则照常聊天，流式推送回复；有点像任务时回复下面附「当成任务来做」。
     */
    async sendMessage(input: {
      ownerId: string;
      conversationId: string;
      content: string;
      asTask: boolean;
      requestId: string;
      emit: (event: StreamEvent) => void;
    }): Promise<void> {
      const conversation = await owned(input.conversationId, input.ownerId);
      const userMessage = await repo.insertMessage({
        conversationId: conversation.id,
        authorKind: 'user',
        authorId: input.ownerId,
        content: input.content,
        status: 'complete',
      });
      input.emit({ type: 'accepted', userMessage: toMessageBody(userMessage) });

      const history = await repo.recentComplete(conversation.id, deps.historyLimit, userMessage.id);
      let suggestTask: boolean;
      try {
        const open = await deps.intake.findOpen(conversation.id);
        if (open) {
          return emitAll(
            input.emit,
            await deps.intake.userSaid({
              conversation,
              intake: open,
              ownerId: input.ownerId,
              text: input.content,
              requestId: input.requestId,
            }),
          );
        }
        const probability = input.asTask
          ? 1
          : await deps.intake.taskProbability({
              ownerId: input.ownerId,
              content: input.content,
              history,
              requestId: input.requestId,
            });
        if (input.asTask || probability >= deps.detect.high) {
          return emitAll(
            input.emit,
            await deps.intake.start({
              conversation,
              ownerId: input.ownerId,
              request: input.content,
              history,
              requestId: input.requestId,
            }),
          );
        }
        suggestTask = probability >= deps.detect.low;
      } catch (err) {
        return emitFailure(conversation, err, input.emit);
      }
      await chat(conversation, input, suggestTask);
    },
  };
}

export type DmService = ReturnType<typeof createDmService>;
