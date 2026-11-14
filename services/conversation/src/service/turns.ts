// 一轮 = harness 的一次运行：用户说一句开一轮，一轮进行中再说的话是插话。
// 开一轮、插话、停止在这里；开了以后跟进 harness 的事件，把 AI 说的话和做的步骤写进消息，
// 进行中定时看花费（用了生图、视频这类工具就出任务卡），结束时把成品登记进画布、写上用时和花费，
// 收尾时用户发来的话接着开下一轮。服务重启后接着跟进没结束的轮。
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ModelRoute } from '@oasis/contracts/agent';
import { ArtifactBody, ArtifactLookupResult } from '@oasis/contracts/canvas';
import { OASIS_HEADERS } from '@oasis/contracts/common';
import type { TaskCard, TaskFile } from '@oasis/contracts/conversation';
import { RunBody, RunEventList, type StartRunBody } from '@oasis/contracts/harness';
import { GENERATION_TOOLS, RunSpend } from '@oasis/contracts/model-gateway';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import { z } from 'zod';
import type { Conversation, ConversationRepo, Message } from '../repo/conversation-repo.ts';
import type { Turn } from '../repo/schema.ts';
import { gather, handOver, withNote } from './hand-over.ts';
import {
  contentOf,
  failure,
  firstLine,
  refused,
  segmentOf,
  settleSteps,
  terminal,
  writeEvents,
} from './turn-parts.ts';

export interface TurnDeps {
  repo: ConversationRepo;
  agent: ServiceClient;
  harness: ServiceClient;
  canvas: ServiceClient;
  modelGateway: ServiceClient;
  logger: Logger;
  /** 跟进的间隔 */
  pollMs?: number;
  /** 进行中多久看一次花费 */
  spendMs?: number;
}

/** 一次拉多少条运行事件 */
const EVENT_PAGE = 500;
/** 接不上原会话（工作目录不在了、会话已有更新的一轮）：这一轮开新会话 */
const SESSION_GONE = new Set(['continue_unavailable', 'session_advanced', 'workspace_unavailable']);
const RegisteredArtifacts = z.object({ artifacts: z.array(ArtifactBody) });

export function createTurns(deps: TurnDeps) {
  const { harness, logger } = deps;
  const pollMs = deps.pollMs ?? 700;
  const spendMs = deps.spendMs ?? 3000;
  const following = new Map<string, Promise<void>>();
  const closing = new AbortController();

  async function getRun(runId: string): Promise<RunBody | undefined> {
    try {
      return await harness.json('GET', `/internal/runs/${runId}`, { schema: RunBody });
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404) return undefined;
      throw err;
    }
  }

  const spendOf = (ownerId: string, runId: string) =>
    deps.modelGateway.json('GET', `/internal/v1/runs/${runId}/spend`, {
      headers: { [OASIS_HEADERS.payerId]: ownerId },
      schema: RunSpend,
    });

  /** 任务卡：这一轮用了生图、视频这类工具或交了文件；有就更新，没有就建 */
  async function saveTaskCard(
    store: ConversationRepo,
    conversation: Conversation,
    turn: Turn,
    card: TaskCard,
  ) {
    const content = card.status === 'running' ? '任务进行中' : '任务结束';
    if (turn.cardId && (await store.updateMessage(turn.cardId, { content, data: card }))) return;
    const created = await store.insertMessage({
      conversationId: conversation.id,
      authorKind: 'ai',
      authorId: conversation.modelKey ?? 'unknown',
      content,
      status: 'complete',
      kind: 'task',
      data: card,
    });
    await store.updateTurn(conversation.id, turn.runId, { cardId: created.id });
    turn.cardId = created.id;
  }

  /** 进行中看一眼花费：用了做东西的工具就出任务卡，任务卡上的花费跟着涨 */
  async function live(store: ConversationRepo, conversation: Conversation, turn: Turn) {
    const spend = await spendOf(conversation.ownerId, turn.runId);
    if (!turn.cardId && !spend.tools.some((tool) => GENERATION_TOOLS.includes(tool))) return;
    await saveTaskCard(store, conversation, turn, {
      runId: turn.runId,
      status: 'running',
      startedAt: turn.startedAt,
      finishedAt: null,
      spentMicro: spend.spentMicro,
      files: [],
    });
  }

  /** 这一轮交的文件登记进画布（新的和改过的），返回它们 */
  async function register(conversation: Conversation, run: RunBody): Promise<TaskFile[]> {
    const { artifacts } = await deps.canvas.json('POST', '/internal/artifacts/runs', {
      body: {
        ownerId: conversation.ownerId,
        conversationId: conversation.id,
        sessionId: run.sessionId,
        runId: run.id,
        topic: conversation.topic ?? conversation.title,
        models: [run.model],
        outputs: run.outputs,
      },
      schema: RegisteredArtifacts,
    });
    return artifacts.map((a) => ({
      artifactId: a.id,
      name: a.name,
      path: a.path,
      size: a.size,
      category: a.category,
    }));
  }

  /**
   * 这一轮结束：最后一段 AI 消息写上结局和花费，成品登记进画布、写到任务卡上，清掉这一轮，
   * 收尾时用户发来的话接着开下一轮。run 为 undefined：harness 里没有这一轮（没开成）。
   */
  async function finish(
    store: ConversationRepo,
    conversation: Conversation,
    turn: Turn,
    run: RunBody | undefined,
  ) {
    const status = run?.status ?? 'failed';
    const notices: string[] = [];
    let files: TaskFile[] = [];
    if (run?.outputs.length && status !== 'cancelled') {
      try {
        files = await register(conversation, run);
      } catch (err) {
        logger.warn({ err, runId: turn.runId }, '成品登记进画布失败');
        notices.push('成品没能登记进画布，文件还在工作目录里，可以让 AI 再交一次');
      }
    }
    const spend = run
      ? await spendOf(conversation.ownerId, run.id).catch((err: unknown) => {
          logger.warn({ err, runId: run.id }, '读这一轮的花费失败');
          return { spentMicro: 0, tools: [] };
        })
      : { spentMicro: 0, tools: [] };
    const message = await store.findMessage(conversation.id, turn.segmentId);
    if (message) {
      const settled = settleSteps(segmentOf(message), status === 'succeeded');
      for (const text of notices) settled.parts.push({ type: 'notice', text });
      await store.updateMessage(message.id, {
        content: contentOf(settled),
        status: status === 'failed' ? 'failed' : 'complete',
        error: status === 'failed' ? failure(run?.error) : null,
        data: {
          ...message.data,
          parts: settled.parts,
          ...(settled.todos ? { todos: settled.todos } : {}),
          spentMicro: spend.spentMicro,
          ...(status === 'stopped' || status === 'cancelled' ? { stopped: true } : {}),
        },
      });
    }
    if (turn.cardId || files.length || spend.tools.some((tool) => GENERATION_TOOLS.includes(tool)))
      await saveTaskCard(store, conversation, turn, {
        runId: turn.runId,
        status: status === 'succeeded' ? 'done' : status === 'failed' ? 'failed' : 'stopped',
        startedAt: turn.startedAt,
        finishedAt: run?.finishedAt ?? new Date().toISOString(),
        spentMicro: spend.spentMicro,
        files,
      });
    // 和用户的操作错开：拿到 message 锁再收尾，免得用户这时发的话两头落空
    for (let attempt = 0; ; attempt += 1) {
      try {
        await store.withLock('message', conversation.id, async (locked) => {
          await locked.endTurn(
            conversation.id,
            turn.runId,
            run ? (run.resumable ? run.id : null) : conversation.lastRunId,
          );
          await locked.touchConversation(conversation.id);
          const pending = await locked.pendingMessages(conversation.id);
          const latest = await locked.find(conversation.id);
          if (pending.length && latest && !latest.turn)
            await begin(locked, latest, pending, `pending:${turn.runId}`);
        });
        break;
      } catch (err) {
        if (!(err instanceof HttpError && err.code === 'conversation_busy') || attempt >= 50)
          throw err;
        await sleep(200);
      }
    }
    logger.info({ conversationId: conversation.id, runId: turn.runId, status }, '一轮结束');
  }

  /** 跟进一轮直到结束（拿着 follow 锁：同一时间只有一个实例在跟） */
  async function track(store: ConversationRepo, conversationId: string) {
    let spentAt = 0;
    let backoff = pollMs;
    while (!closing.signal.aborted) {
      try {
        const conversation = await store.find(conversationId);
        const turn = conversation?.turn;
        if (!conversation || !turn) return;
        const run = await getRun(turn.runId);
        if (!run) return await finish(store, conversation, turn, undefined);
        const { events } = await harness.json(
          'GET',
          `/internal/runs/${turn.runId}/events?after=${turn.cursor}&limit=${EVENT_PAGE}`,
          { schema: RunEventList },
        );
        // 用户正在发话、这批没写进去：等一会儿再拉，写完才算跟到了这里
        const written =
          !events.length || (await writeEvents(store, conversationId, turn.runId, events));
        if (written && terminal(run.status) && events.length < EVENT_PAGE) {
          const latest = (await store.find(conversationId))?.turn;
          if (latest?.runId === turn.runId)
            return await finish(store, conversation, { ...turn, ...latest }, run);
          return;
        }
        if (Date.now() - spentAt >= spendMs) {
          spentAt = Date.now();
          await live(store, conversation, turn).catch((err: unknown) =>
            logger.warn({ err, runId: turn.runId }, '读这一轮的花费失败，下次再看'),
          );
        }
        backoff = pollMs;
        if (written && events.length === EVENT_PAGE) continue;
      } catch (err) {
        logger.warn({ err, conversationId }, '跟进这一轮出错，稍后再试');
        backoff = Math.min(backoff * 2, 30_000);
      }
      await sleep(backoff, undefined, { signal: closing.signal }).catch(() => undefined);
    }
  }

  /** 开始跟进这个对话正在进行的一轮（已经在跟就不重复） */
  function follow(conversationId: string) {
    if (closing.signal.aborted || following.has(conversationId)) return;
    const task = deps.repo
      .withLock('follow', conversationId, (store) => track(store, conversationId))
      .catch((err: unknown) => {
        // 别的实例正在跟
        if (err instanceof HttpError && err.code === 'conversation_busy') return;
        logger.error({ err, conversationId }, '跟进一轮失败');
      })
      .finally(() => following.delete(conversationId));
    following.set(conversationId, task);
  }

  /**
   * 开一轮（调用方拿着这个对话的 message 锁）：userMessages 是这一轮用户说的话（已经存下），
   * 交给 AI 的是它们连起来的文字和带的文件。返回这一轮新增的 AI 消息。
   */
  async function begin(
    store: ConversationRepo,
    conversation: Conversation,
    userMessages: Message[],
    requestId: string,
  ): Promise<Message[]> {
    const runId = randomUUID();
    const { text, attachments, revisingIds } = gather(userMessages);
    for (const m of userMessages) {
      const { pending: _pending, ...data } = m.data;
      await store.updateMessage(m.id, { data: { ...data, runId } });
    }
    const aiMessage = (status: Message['status'], data: Record<string, unknown>, error?: string) =>
      store.insertMessage({
        conversationId: conversation.id,
        authorKind: 'ai',
        authorId: conversation.modelKey ?? 'unknown',
        content: '',
        status,
        kind: 'text',
        data: { runId, ...data },
        ...(error ? { error } : {}),
      });
    let route: ModelRoute;
    let revising: ArtifactLookupResult | undefined;
    let sessionId: string | undefined;
    try {
      route = await deps.agent.json(
        'GET',
        `/internal/models/${encodeURIComponent(conversation.modelKey ?? '')}/route?userId=${conversation.ownerId}`,
        { requestId, schema: ModelRoute },
      );
      if (revisingIds.length) {
        revising = await deps.canvas.json('POST', '/internal/artifacts/lookup', {
          body: { ownerId: conversation.ownerId, ids: revisingIds, withFiles: true },
          requestId,
          schema: ArtifactLookupResult,
        });
        // 这一轮接着的会话：要改的成果是它做的，就还在工作目录里
        if (conversation.lastRunId) sessionId = (await getRun(conversation.lastRunId))?.sessionId;
      }
    } catch (err) {
      logger.warn(
        { err, conversationId: conversation.id },
        '这一轮开不了：查不到 AI 的型号或要改的成果',
      );
      await store.touchConversation(conversation.id);
      return [await aiMessage('failed', {}, refused(err))];
    }
    const handed = handOver(attachments, revising, sessionId);
    const segment = await aiMessage('streaming', { parts: [] });
    const startedAt = new Date().toISOString();
    const topic = firstLine(text, 30) || `${conversation.title} ${startedAt.slice(0, 10)}`;
    const turn = { runId, startedAt, cursor: -1, segmentId: segment.id };
    if (!(await store.startTurn(conversation.id, turn, topic))) {
      await store.deleteMessage(segment.id);
      throw new HttpError(409, 'turn_active', '这个对话还有一轮在进行');
    }
    const body: StartRunBody = {
      runId,
      payerId: conversation.ownerId,
      conversationId: conversation.id,
      model: route.providerModel,
      persona: route.systemPrompt,
      domesticOnly: route.domesticOnly,
      prompt: withNote(text, handed.note),
      materials: handed.materials,
      ...(conversation.lastRunId ? { continueFrom: conversation.lastRunId } : {}),
    };
    try {
      try {
        await harness.json('POST', '/internal/runs', { body, requestId, schema: RunBody });
      } catch (err) {
        if (!(err instanceof HttpError && SESSION_GONE.has(err.code))) throw err;
        // 原来的工作目录不在了：这一轮开新会话，AI 不记得之前的事；要改的成果都得拷进来
        const { continueFrom: _continueFrom, ...rest } = body;
        const fresh = handOver(attachments, revising, undefined);
        await harness.json('POST', '/internal/runs', {
          body: { ...rest, prompt: withNote(text, fresh.note), materials: fresh.materials },
          requestId,
          schema: RunBody,
        });
        await store.updateMessage(segment.id, {
          data: {
            runId,
            parts: [
              {
                type: 'notice',
                text: '原来的工作目录已经不在了，这一轮从头开始（AI 不记得之前的事）',
              },
            ],
          },
        });
      }
    } catch (err) {
      logger.warn({ err, conversationId: conversation.id, runId }, '这一轮没能开始');
      await store.endTurn(conversation.id, runId, conversation.lastRunId);
      return [await finishRefused(store, conversation, segment, err)];
    }
    await store.touchConversation(conversation.id);
    follow(conversation.id);
    return [(await store.findMessage(conversation.id, segment.id)) ?? segment];
  }

  /** 没开成的一轮：AI 那条消息写上原因 */
  async function finishRefused(
    store: ConversationRepo,
    conversation: Conversation,
    message: Message,
    err: unknown,
  ): Promise<Message> {
    await store.touchConversation(conversation.id);
    return (
      (await store.updateMessage(message.id, { status: 'failed', error: refused(err) })) ?? message
    );
  }

  return {
    begin,
    follow,

    /**
     * 插话（调用方拿着 message 锁）：交给正在进行的这一轮，AI 做完手上这一步就看到；看到时跟进那边
     * 换一条新的 AI 消息接着写（见 write）。这一轮已经在收尾、送不进去时返回 undefined
     * （由调用方留到下一轮开头）。
     */
    async interject(
      store: ConversationRepo,
      conversation: Conversation,
      turn: Turn,
      user: Message,
    ): Promise<Message[] | undefined> {
      try {
        await harness.json('POST', `/internal/runs/${turn.runId}/messages`, {
          body: { text: user.content },
        });
      } catch (err) {
        if (err instanceof HttpError && (err.statusCode === 409 || err.statusCode === 404))
          return undefined;
        throw err;
      }
      await store.updateTurn(conversation.id, turn.runId, { unheard: (turn.unheard ?? 0) + 1 });
      const updated = await store.updateMessage(user.id, {
        data: { ...user.data, runId: turn.runId, interjection: true },
      });
      return [updated ?? user];
    },

    /** 停下这一轮：已经做出来的存下，下一轮接着做 */
    async stop(turn: Turn) {
      try {
        await harness.json('POST', `/internal/runs/${turn.runId}/stop`, { body: {} });
      } catch (err) {
        if (!(err instanceof HttpError && err.statusCode === 404)) throw err;
      }
    },

    /** 服务启动时：接着跟进没结束的轮 */
    async resumeAll() {
      for (const conversation of await deps.repo.activeTurns()) follow(conversation.id);
    },

    async close() {
      closing.abort();
      await Promise.allSettled([...following.values()]);
    },
  };
}

export type Turns = ReturnType<typeof createTurns>;
