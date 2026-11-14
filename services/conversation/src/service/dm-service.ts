// 私聊：建对话、列消息、发消息（开一轮或插话，见 turns.ts）、停下这一轮、开新话题、删对话。
// 私聊里的 AI 就是干活的主 AI；花的钱由对话的主人付。
import { setTimeout as sleep } from 'node:timers/promises';
import { ModelRoute } from '@oasis/contracts/agent';
import { ArtifactLookupResult, UploadLookupResult } from '@oasis/contracts/canvas';
import type {
  ConversationBody,
  MessageArtifact,
  MessageAttachment,
  MessageBody,
  MessageList,
  SendResult,
  TurnState,
} from '@oasis/contracts/conversation';
import { RunBody } from '@oasis/contracts/harness';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import type { Conversation, ConversationRepo, Message } from '../repo/conversation-repo.ts';
import type { Turns } from './turns.ts';

const turnState = (row: Conversation): TurnState | null =>
  row.turn ? { runId: row.turn.runId, startedAt: row.turn.startedAt } : null;

function toConversationBody(row: Conversation): ConversationBody {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    modelKey: row.modelKey,
    createdAt: row.createdAt.toISOString(),
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    turn: turnState(row),
  };
}

function toMessageBody(row: Message): MessageBody {
  return {
    id: row.id,
    role: row.authorKind === 'user' ? 'user' : 'assistant',
    content: row.content,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    // data 按 kind 存的就是对应的内容（写入时已经是契约里的形状）
    kind: row.kind,
    data: row.data,
  } as MessageBody;
}

/** 删对话前等被取消的那一轮收尾，最多等这么久 */
const CANCEL_WAIT_MS = 60_000;

export function createDmService(deps: {
  repo: ConversationRepo;
  agent: ServiceClient;
  harness: ServiceClient;
  canvas: ServiceClient;
  modelGateway: ServiceClient;
  turns: Turns;
  logger: Logger;
}) {
  const { repo, turns } = deps;

  async function owned(conversationId: string, ownerId: string): Promise<Conversation> {
    const conversation = await repo.findOwned(conversationId, ownerId);
    if (!conversation) throw new HttpError(404, 'conversation_not_found', '没有这个私聊');
    return conversation;
  }

  /** 拿 message 锁：AI 的进度正在写进消息时锁会被占一小会儿，等一等再拿（最多约 5 秒） */
  async function withMessageLock<T>(
    conversationId: string,
    work: (store: ConversationRepo) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await repo.withLock('message', conversationId, work);
      } catch (err) {
        if (!(err instanceof HttpError && err.code === 'conversation_busy') || attempt >= 50)
          throw err;
        await sleep(100);
      }
    }
  }

  /** 删对话前：取消正在进行的一轮，等它收尾（沙箱停掉、产出存好） */
  async function cancelTurn(conversation: Conversation) {
    if (!conversation.turn) return;
    const { runId } = conversation.turn;
    await deps.harness
      .json('POST', `/internal/runs/${runId}/cancel`, { body: {} })
      .catch((err: unknown) => {
        if (!(err instanceof HttpError && err.statusCode === 404)) throw err;
      });
    for (const started = Date.now(); Date.now() - started < CANCEL_WAIT_MS; await sleep(500)) {
      const run = await deps.harness
        .json('GET', `/internal/runs/${runId}`, { schema: RunBody })
        .catch((err: unknown) => {
          if (err instanceof HttpError && err.statusCode === 404) return undefined;
          throw err;
        });
      if (!run || !['queued', 'starting', 'running'].includes(run.status)) return;
    }
    throw new HttpError(409, 'turn_active', '这一轮还在收尾，请稍后再删');
  }

  /** 核对随消息发的文件都在 canvas 里、都是这个人的，并记下它们被用上了（清扫不再删） */
  async function resolveAttachments(
    ownerId: string,
    ids: string[],
    requestId: string,
  ): Promise<MessageAttachment[]> {
    if (ids.length === 0) return [];
    try {
      const { uploads } = await deps.canvas.json('POST', '/internal/uploads/lookup', {
        body: { ownerId, ids, claim: true },
        requestId,
        schema: UploadLookupResult,
      });
      return uploads.map(({ id, name, size, contentType }) => ({ id, name, size, contentType }));
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404)
        throw new HttpError(400, 'attachment_not_found', '有文件没找到，请重新添加');
      throw err;
    }
  }

  /** 「让 AI 改」：核对要改的成果都在画布里、都是这个人的 */
  async function resolveArtifacts(
    ownerId: string,
    ids: string[],
    requestId: string,
  ): Promise<MessageArtifact[]> {
    if (ids.length === 0) return [];
    try {
      const { artifacts } = await deps.canvas.json('POST', '/internal/artifacts/lookup', {
        body: { ownerId, ids },
        requestId,
        schema: ArtifactLookupResult,
      });
      return artifacts.map((a) => ({
        id: a.id,
        name: a.application ? a.application.root : a.name,
        path: a.path,
      }));
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404)
        throw new HttpError(400, 'artifact_not_found', '要改的成果找不到了，请刷新画布再试');
      throw err;
    }
  }

  return {
    async createDm(
      ownerId: string,
      modelKey: string,
      requestId: string,
    ): Promise<ConversationBody> {
      const route = await deps.agent.json(
        'GET',
        `/internal/models/${encodeURIComponent(modelKey)}/route?userId=${ownerId}`,
        { requestId, schema: ModelRoute },
      );
      return toConversationBody(await repo.upsertDm(ownerId, modelKey, route.name));
    },

    async listDms(ownerId: string): Promise<ConversationBody[]> {
      return (await repo.listDms(ownerId)).map(toConversationBody);
    },

    async listMessages(ownerId: string, conversationId: string): Promise<MessageList> {
      const conversation = await owned(conversationId, ownerId);
      // 有一轮在进行、这个实例没在跟（重启过）就接着跟
      if (conversation.turn) turns.follow(conversation.id);
      return {
        messages: (await repo.listMessages(conversationId, 1000)).map(toMessageBody),
        turn: turnState(conversation),
      };
    },

    /**
     * 发一条消息：没有正在进行的一轮就开一轮；有就作为插话交给这一轮（AI 下一步就看到）。
     * 这一轮正在收尾、送不进去的话留到下一轮开头交给 AI。带的文件和要改的成果都要核对过才收，
     * 有一个不在或不是这个人的就整条消息不收。
     */
    async sendMessage(input: {
      ownerId: string;
      conversationId: string;
      content: string;
      /** 先传到 canvas 的文件 id */
      attachments: string[];
      /** 「让 AI 改」：画布里要改的成果 id */
      artifacts: string[];
      requestId: string;
    }): Promise<SendResult> {
      const conversation = await owned(input.conversationId, input.ownerId);
      return withMessageLock(conversation.id, async (store) => {
        const latest = (await store.find(conversation.id))!;
        // 文件只能在一轮开始时放进工作目录
        if (latest.turn && (input.attachments.length || input.artifacts.length))
          throw new HttpError(
            409,
            'turn_active',
            '这一轮还在做，带文件的话等它做完再发，或者先停下这一轮',
          );
        const artifacts = await resolveArtifacts(input.ownerId, input.artifacts, input.requestId);
        // 最后核对文件：核对时会记下文件被用上了
        const attachments = await resolveAttachments(
          input.ownerId,
          input.attachments,
          input.requestId,
        );
        const user = await store.insertMessage({
          conversationId: conversation.id,
          authorKind: 'user',
          authorId: input.ownerId,
          content: input.content,
          status: 'complete',
          kind: 'text',
          data: {
            ...(attachments.length ? { attachments } : {}),
            ...(artifacts.length ? { artifacts } : {}),
          },
        });
        let added: Message[];
        if (latest.turn) {
          turns.follow(conversation.id);
          added = (await turns.interject(store, latest, latest.turn, user)) ?? [
            (await store.updateMessage(user.id, { data: { ...user.data, pending: true } })) ?? user,
          ];
        } else {
          const replies = await turns.begin(store, latest, [user], input.requestId);
          added = [(await store.findMessage(conversation.id, user.id)) ?? user, ...replies];
        }
        await store.touchConversation(conversation.id);
        const fresh = (await store.find(conversation.id)) ?? latest;
        return { messages: added.map(toMessageBody), turn: turnState(fresh) };
      });
    },

    /**
     * 这个私聊某一轮工作目录里的一个文件（进度页预览中间产物和成品）：一轮还在做时从沙箱读，
     * 结束后只剩 out/ 里的。
     */
    async runFile(ownerId: string, conversationId: string, runId: string, path: string) {
      const conversation = await owned(conversationId, ownerId);
      const run = await deps.harness
        .json('GET', `/internal/runs/${runId}`, { schema: RunBody })
        .catch((err: unknown) => {
          if (err instanceof HttpError && err.statusCode === 404) return undefined;
          throw err;
        });
      if (run?.conversationId !== conversation.id)
        throw new HttpError(404, 'run_not_found', '这个私聊里没有这一轮');
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      const response = await deps.harness.stream(
        'GET',
        `/internal/runs/${runId}/workspace/${encoded}`,
      );
      return {
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        size: response.headers.get('content-length'),
        body: response.body,
      };
    },

    /** 停下正在进行的一轮：已经做出来的存下，下一轮接着做 */
    async stop(ownerId: string, conversationId: string) {
      const conversation = await owned(conversationId, ownerId);
      if (conversation.turn) await turns.stop(conversation.turn);
    },

    /**
     * 开新话题：AI 从这里起不记得之前的事——它的会话记录和工作目录真删除（成品已经在画布里），
     * 聊天记录留着。一轮还在进行时先停下才能开。
     */
    async newTopic(ownerId: string, conversationId: string, requestId: string) {
      const conversation = await owned(conversationId, ownerId);
      return withMessageLock(conversation.id, async (store) => {
        if ((await store.find(conversation.id))?.turn)
          throw new HttpError(409, 'turn_active', '这一轮还在做，先停下再开新话题');
        await deps.harness.json('POST', `/internal/conversations/${conversation.id}/purge`, {
          body: {},
          requestId,
        });
        await store.newTopic(conversation.id);
        const divider = await store.insertMessage({
          conversationId: conversation.id,
          authorKind: 'user',
          authorId: ownerId,
          content: '开了新话题',
          status: 'complete',
          kind: 'topic',
          data: {},
        });
        await store.touchConversation(conversation.id);
        deps.logger.info({ conversationId: conversation.id }, '开了新话题');
        return toMessageBody(divider);
      });
    },

    /**
     * 删除私聊（真删除）：正在进行的一轮先取消；AI 的会话记录和工作目录、工具的结果、画布里的成品、
     * 消息带的文件、消息都删掉。再点开这个 AI 是一个全新的私聊。
     */
    async deleteDm(ownerId: string, conversationId: string, requestId: string) {
      const conversation = await owned(conversationId, ownerId);
      await cancelTurn(conversation);
      await withMessageLock(conversation.id, async (store) => {
        const id = conversation.id;
        await deps.harness.json('POST', `/internal/conversations/${id}/purge`, {
          body: {},
          requestId,
        });
        await deps.modelGateway.json('POST', `/internal/conversations/${id}/purge`, {
          body: {},
          requestId,
        });
        await deps.canvas.json('POST', `/internal/conversations/${id}/purge`, {
          body: { ownerId },
          requestId,
        });
        // 先删文件再删对话：删文件失败时对话还在，用户重试即可（删除都是幂等的）
        const files = await store.attachmentIds(id);
        if (files.length)
          await deps.canvas.json('POST', '/internal/uploads/delete', {
            body: { ownerId, ids: files },
            requestId,
          });
        await store.deleteConversation(id);
      });
      deps.logger.info({ conversationId }, '私聊已删除');
    },
  };
}

export type DmService = ReturnType<typeof createDmService>;
