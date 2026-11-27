// 私聊：建对话、列消息、发消息（开一轮或插话，见 turns.ts）、停下这一轮、开新话题、删对话。
// 私聊里的 AI 就是干活的主 AI；花的钱由对话的主人付。
import { isDeepStrictEqual } from 'node:util';
import { ModelRoute } from '@oasis/contracts/agent';
import { ArtifactLookupResult, UploadLookupResult } from '@oasis/contracts/canvas';
import type {
  ConversationBody,
  MessageArtifact,
  MessageAttachment,
  MessageBody,
  MessageList,
  SendResult,
  SetupBody,
  SetupResult,
  TaskCard,
  TaskSummary,
  TurnState,
} from '@oasis/contracts/conversation';
import { defaultPermissions, RunBody, type Workplace } from '@oasis/contracts/harness';
import { Confirmation, type ConfirmDecision } from '@oasis/contracts/model-gateway';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import {
  withMessageLock as lockMessages,
  type Conversation,
  type ConversationRepo,
  type Message,
} from '../repo/conversation-repo.ts';
import { createConfirmations } from './confirmations.ts';
import { createDmCloud } from './dm-cloud.ts';
import type { Purge } from './purge.ts';
import type { Turns } from './turns.ts';

const turnState = (row: Conversation): TurnState | null =>
  row.turn
    ? {
        runId: row.turn.runId,
        startedAt: row.turn.startedAt,
        confirmations: row.turn.confirmations ?? [],
      }
    : null;

/** 在哪干活和权限：没设过的是云端沙箱、按地方的默认权限 */
function setupOf(row: Conversation): SetupBody {
  const workplace: Workplace = row.workplace ?? { kind: 'cloud' };
  return { workplace, permissions: row.permissions ?? defaultPermissions(workplace) };
}

function toConversationBody(row: Conversation): ConversationBody {
  return {
    id: row.id,
    // 这里只有私聊（群里的席位不经这个接口给出去）
    kind: 'dm',
    title: row.title,
    modelKey: row.modelKey,
    createdAt: row.createdAt.toISOString(),
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    turn: turnState(row),
    ...setupOf(row),
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

/** 还排着队的一句（用户发的、没交给 AI）；已经交给 AI 或删掉了 404 */
async function queuedMessage(
  store: ConversationRepo,
  conversationId: string,
  id: string,
): Promise<Message> {
  const message = await store.findMessage(conversationId, id);
  if (message?.authorKind !== 'user' || !message.data.pending)
    throw new HttpError(404, 'queued_message_not_found', '这句已经交给 AI 了，或者已经删掉了');
  return message;
}

/** 画布上最多列多少个任务 */
const TASK_LIMIT = 500;

export function createDmService(deps: {
  repo: ConversationRepo;
  agent: ServiceClient;
  harness: ServiceClient;
  canvas: ServiceClient;
  modelGateway: ServiceClient;
  turns: Turns;
  purge: Purge;
  logger: Logger;
}) {
  const { repo, turns } = deps;
  const cloud = createDmCloud({ repo, turns });
  const confirmations = createConfirmations(deps);

  async function owned(conversationId: string, ownerId: string): Promise<Conversation> {
    const conversation = await repo.findOwned(conversationId, ownerId);
    if (!conversation) throw new HttpError(404, 'conversation_not_found', '没有这个私聊');
    return conversation;
  }

  const withMessageLock = <T>(
    conversationId: string,
    work: (store: ConversationRepo) => Promise<T>,
  ) => lockMessages(repo, conversationId, work);

  /** 从新话题开始：AI 的会话记录和工作目录真删除（成品已经在画布里），聊天里插一条分隔 */
  async function startTopic(
    store: ConversationRepo,
    conversation: Conversation,
    content: string,
    requestId: string,
  ): Promise<MessageBody> {
    await deps.harness.json('POST', `/internal/conversations/${conversation.id}/purge`, {
      body: {},
      requestId,
    });
    await store.newTopic(conversation.id);
    const divider = await store.insertMessage({
      conversationId: conversation.id,
      authorKind: 'user',
      authorId: conversation.ownerId,
      content,
      status: 'complete',
      kind: 'topic',
      data: {},
    });
    await store.touchConversation(conversation.id);
    return toMessageBody(divider);
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

    /** 画布按任务分：这个人私聊里的任务，和他当群主的群里的任务（任务卡和它在哪段对话），新的在前 */
    async listTasks(ownerId: string): Promise<TaskSummary[]> {
      return (await repo.listTasks(ownerId, TASK_LIMIT)).map(({ message, seat }) => ({
        ...(message.data as TaskCard),
        // 做它的那份会话：卡上记着的（云端任务、席位），以前的卡没记就是席位，私聊家里做的是私聊自己
        conversationId: (message.data as TaskCard).seat ?? seat?.id ?? message.conversationId,
        room: message.conversationId,
        ...(seat
          ? { group: { id: message.conversationId, title: seat.group, key: message.authorId } }
          : {}),
      }));
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
     * 发一条消息：没有正在进行的一轮就开一轮；有就先排队，这一轮做完接着开下一轮
     * （用户可以点「引导」现在交给这一轮，见 steer）。带的文件和要改的成果都要核对过才收，
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
      /** 「在云端做」：单独派到云端 */
      task?: boolean;
      /** 点名的云端任务的会话：接着它做 */
      seat?: string | undefined;
      requestId: string;
    }): Promise<SendResult> {
      const conversation = await owned(input.conversationId, input.ownerId);
      // 交给云端的（新派一个任务，或接着点名的那个任务做）不占私聊自己那一轮，也不排队
      const task = await cloud.target(conversation, input.seat);
      const toCloud = input.task === true || task !== undefined;
      return withMessageLock(conversation.id, async (store) => {
        const latest = (await store.find(conversation.id))!;
        // 文件只能在一轮开始时放进工作目录
        if (!toCloud && latest.turn && (input.attachments.length || input.artifacts.length))
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
            ...(toCloud ? { task: true } : latest.turn ? { pending: true } : {}),
          },
        });
        let added: Message[];
        if (toCloud) {
          const replies = await cloud.begin(conversation, task, user, input.requestId);
          added = [(await store.findMessage(conversation.id, user.id)) ?? user, ...replies];
        } else if (latest.turn) {
          turns.follow(conversation.id);
          added = [user];
        } else {
          const replies = await turns.begin(store, latest, [user], input.requestId);
          added = [(await store.findMessage(conversation.id, user.id)) ?? user, ...replies];
        }
        await store.touchConversation(conversation.id);
        const fresh = (await store.find(conversation.id)) ?? latest;
        return { messages: added.map(toMessageBody), turn: turnState(fresh) };
      });
    },

    /** 「引导」：排着队的一句现在交给 AI（见 turns.steer）；已经交给 AI 或删掉了 404 */
    async steer(input: {
      ownerId: string;
      conversationId: string;
      messageId: string;
      requestId: string;
    }): Promise<SendResult> {
      const conversation = await owned(input.conversationId, input.ownerId);
      return withMessageLock(conversation.id, async (store) => {
        const latest = (await store.find(conversation.id))!;
        const queued = await queuedMessage(store, conversation.id, input.messageId);
        const added = await turns.steer(store, latest, queued, input.requestId);
        const fresh = (await store.find(conversation.id)) ?? latest;
        return { messages: added.map(toMessageBody), turn: turnState(fresh) };
      });
    },

    /** 从队里删掉一句（真删除）；改一句是删掉后放回输入框，由前端做 */
    async unqueue(ownerId: string, conversationId: string, messageId: string) {
      const conversation = await owned(conversationId, ownerId);
      await withMessageLock(conversation.id, async (store) => {
        await queuedMessage(store, conversation.id, messageId);
        await store.deleteMessage(messageId);
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
     * 改在哪干活和权限，下一轮起生效。换了地方从新话题开始：AI 的会话记录在原来那边接不上，
     * 原来的清掉、聊天里插一条分隔；一轮进行中不能换地方。还没说过话的对话直接定下，不算换。
     */
    async setup(
      ownerId: string,
      conversationId: string,
      body: SetupBody,
      requestId: string,
    ): Promise<SetupResult> {
      const conversation = await owned(conversationId, ownerId);
      if (conversation.kind !== 'dm') throw new HttpError(400, 'not_dm', '只有和 AI 的私聊能设');
      return withMessageLock(conversation.id, async (store) => {
        const latest = (await store.find(conversation.id))!;
        let message: MessageBody | null = null;
        if (!isDeepStrictEqual(setupOf(latest).workplace, body.workplace)) {
          if (latest.turn)
            throw new HttpError(409, 'turn_active', '这一轮还在做，先停下再换干活的地方');
          // 还没说过话的对话没有可忘的：直接定下在哪干活（桌面版里新对话的家定在电脑上），不插分隔
          if (latest.lastMessageAt) {
            const place =
              body.workplace.kind === 'device'
                ? `你的电脑（${body.workplace.folder}）`
                : '云端沙箱';
            message = await startTopic(store, latest, `换到${place}干活，开了新话题`, requestId);
          }
        }
        await store.saveSetup(conversation.id, body);
        deps.logger.info(
          { conversationId: conversation.id, workplace: body.workplace.kind },
          '改了在哪干活和权限',
        );
        return { conversation: toConversationBody((await store.find(conversation.id))!), message };
      });
    },

    /**
     * 点确认卡：允许一次 / 以后都允许 / 拒绝。「以后都允许」：这一轮里同类的自动允许（model-gateway
     * 记在这一轮的 Key 上），这个私聊的权限也改掉，下一轮起不再问。
     */
    async confirm(input: {
      ownerId: string;
      conversationId: string;
      confirmationId: string;
      decision: ConfirmDecision;
      requestId: string;
    }): Promise<Confirmation> {
      const conversation = await owned(input.conversationId, input.ownerId);
      return confirmations.decide(conversation, input, async (store, kind) => {
        const { workplace, permissions } = setupOf((await store.find(conversation.id))!);
        await store.saveSetup(conversation.id, {
          workplace,
          permissions: {
            ...permissions,
            always: [...new Set([...(permissions.always ?? []), kind])],
          },
        });
      });
    },

    /**
     * 开新话题：AI 从这里起不记得之前的事——它的会话记录和工作目录真删除（成品已经在画布里），
     * 聊天记录留着。一轮还在进行时先停下才能开。
     */
    async newTopic(ownerId: string, conversationId: string, requestId: string) {
      const conversation = await owned(conversationId, ownerId);
      return withMessageLock(conversation.id, async (store) => {
        const latest = (await store.find(conversation.id))!;
        if (latest.turn) throw new HttpError(409, 'turn_active', '这一轮还在做，先停下再开新话题');
        const divider = await startTopic(store, latest, '开了新话题', requestId);
        deps.logger.info({ conversationId: conversation.id }, '开了新话题');
        return divider;
      });
    },

    /**
     * 删除私聊（真删除）：正在进行的一轮先取消；AI 的会话记录和工作目录、工具的结果、画布里的成品、
     * 消息带的文件、消息都删掉。再点开这个 AI 是一个全新的私聊。
     */
    async deleteDm(ownerId: string, conversationId: string, requestId: string) {
      const conversation = await owned(conversationId, ownerId);
      await deps.purge.cancelTurn(conversation);
      await withMessageLock(conversation.id, async (store) => {
        const id = conversation.id;
        // 派到云端的任务各有一份会话：一起取消、清掉（那几行随私聊删掉）
        for (const task of await store.tasksOf(id)) {
          await deps.purge.cancelTurn(task);
          await deps.purge.remote(task.id, ownerId, requestId);
        }
        await deps.purge.remote(id, ownerId, requestId);
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
