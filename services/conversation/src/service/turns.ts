// 一轮 = harness 的一次运行：用户说一句开一轮；一轮进行中再说的话先排队，用户点「引导」才作为插话交给这一轮。
// 开一轮（起好任务名）、插话、停止在这里；开了以后跟进 harness 的事件，把 AI 说的话和做的步骤写进消息，
// 进行中定时看一眼（在等用户点的确认卡放进这一轮；做好的文件登记进画布；是任务就出任务卡，见 task-cards.ts），
// 结束时把成品再登记一遍、写上用时和花费，排着队的话接着开下一轮。服务重启后接着跟进没结束的轮。
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ModelRoute } from '@oasis/contracts/agent';
import { ArtifactLookupResult, type ArtifactBody } from '@oasis/contracts/canvas';
import type { TaskFile } from '@oasis/contracts/conversation';
import {
  defaultPermissions,
  RunBody,
  RunEventList,
  type StartRunBody,
  type Workplace,
} from '@oasis/contracts/harness';
import { GENERATION_TOOLS, ToolList, type ToolEntry } from '@oasis/contracts/model-gateway';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import {
  roomOf,
  type Conversation,
  type ConversationRepo,
  type Message,
} from '../repo/conversation-repo.ts';
import type { Turn } from '../repo/schema.ts';
import { gather, handOver, withNote } from './hand-over.ts';
import type { SeatBrief } from './group-hearing.ts';
import { createTaskCards } from './task-cards.ts';
import { taskTitle } from './task-title.ts';
import {
  contentOf,
  failure,
  refused,
  segmentOf,
  settleSteps,
  terminal,
  writeEvents,
  type Durations,
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
  /** 进行中多久看一次 model-gateway 那边（确认卡、花费） */
  spendMs?: number;
  /** 群里的席位交了文件（已登记进画布）：进群文件 */
  delivered?: (seat: Conversation, runId: string, files: ArtifactBody[]) => Promise<void>;
}

/** 群里的席位做完一轮（runId）、空下来了：还有叫它的话就接着开下一轮（调用方拿着这个席位的 message 锁） */
type SeatIdle = (store: ConversationRepo, seat: Conversation, runId: string) => Promise<void>;

/** 一次拉多少条运行事件 */
const EVENT_PAGE = 500;
/** 工具目录（各型号通常要多久）多久重新拉一次 */
const CATALOG_MS = 5 * 60_000;
/** 开一轮是先记下这一轮、再交给 harness：交接的这一会儿（请求最多等 10 秒）harness 里还没有它 */
const HANDOVER_MS = 60_000;
/** 接不上原会话（工作目录不在了、会话已有更新的一轮）：这一轮开新会话 */
const SESSION_GONE = new Set(['continue_unavailable', 'session_advanced', 'workspace_unavailable']);
/** 起任务名时往回看多少条消息 */
const TITLE_HISTORY = 40;

export function createTurns(deps: TurnDeps) {
  const { harness, logger } = deps;
  const pollMs = deps.pollMs ?? 700;
  // 确认卡要尽快出现在网页上（AI 在等）
  const spendMs = deps.spendMs ?? 1500;
  const following = new Map<string, Promise<void>>();
  const closing = new AbortController();
  const cards = createTaskCards(deps);
  let seatIdle: SeatIdle | undefined;

  async function getRun(runId: string): Promise<RunBody | undefined> {
    try {
      return await harness.json('GET', `/internal/runs/${runId}`, { schema: RunBody });
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404) return undefined;
      throw err;
    }
  }

  /** 工具目录：几分钟拉一次；拉不到就用上次的（第一次拉不到就不写预计用时） */
  let catalog: { at: number; tools: ToolEntry[] } = { at: 0, tools: [] };
  async function durations(): Promise<Durations> {
    if (Date.now() - catalog.at > CATALOG_MS) {
      const tools = await deps.modelGateway
        .json('GET', '/internal/v1/tools', { schema: ToolList })
        .then((list) => list.tools)
        .catch((err: unknown) => {
          logger.warn({ err }, '读不到工具目录，这次不写预计用时');
          return catalog.tools;
        });
      catalog = { at: Date.now(), tools };
    }
    const { tools } = catalog;
    return (key, model) => {
      const rates = tools.find((tool) => tool.key === key)?.rates ?? [];
      return (rates.find((rate) => rate.model === model) ?? rates[0])?.seconds ?? undefined;
    };
  }

  /**
   * 这一轮结束：最后一段 AI 消息写上结局和花费，out/ 里的成品按产出清单再登记一遍（进行中已经登记的
   * 内容没变就不动）、写到任务卡上，清掉这一轮，排着队的话接着开下一轮。
   * run 为 undefined：harness 里没有这一轮（没开成）。
   */
  async function finish(
    store: ConversationRepo,
    conversation: Conversation,
    turn: Turn,
    run: RunBody | undefined,
  ) {
    const status = run?.status ?? 'failed';
    const notices: string[] = [];
    let files: TaskFile[] = turn.files ?? [];
    if (run?.outputs.length && status !== 'cancelled') {
      try {
        files = await cards.register(conversation, turn, run, run.outputs);
      } catch (err) {
        logger.warn({ err, runId: turn.runId }, '成品登记进画布失败');
        notices.push('成品没能登记进画布，文件还在工作目录里，可以让 AI 再交一次');
      }
    }
    const spend = run
      ? await cards.activityOf(conversation.ownerId, run.id).catch((err: unknown) => {
          logger.warn({ err, runId: run.id }, '读这一轮的花费失败');
          return { spentMicro: 0, tools: [] };
        })
      : { spentMicro: 0, tools: [] };
    const message = await store.findMessage(roomOf(conversation), turn.segmentId);
    if (message) {
      const settled = settleSteps(
        segmentOf(message),
        status === 'succeeded',
        run?.finishedAt ?? new Date().toISOString(),
      );
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
      await cards.save(store, conversation, turn, {
        runId: turn.runId,
        ...(turn.title ? { title: turn.title } : {}),
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
          // 这一轮进行时席位被移出了群（forget 记着这一轮）：不留它的会话，再叫回来从头开始
          const forgotten = (await locked.find(conversation.id))?.options.forget === turn.runId;
          const resume = run ? (run.resumable ? run.id : null) : conversation.lastRunId;
          await locked.endTurn(conversation.id, turn.runId, forgotten ? null : resume);
          await locked.touchConversation(roomOf(conversation));
          const latest = await locked.find(conversation.id);
          if (!latest || latest.turn) return;
          if (latest.kind === 'seat') {
            await seatIdle?.(locked, latest, turn.runId).catch((err: unknown) =>
              logger.warn({ err, seatId: latest.id }, '席位空下来后没能接着开下一轮'),
            );
            return;
          }
          const pending = await locked.pendingMessages(conversation.id);
          if (pending.length) await begin(locked, latest, pending, `pending:${turn.runId}`);
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
        if (!run) {
          // 还在交接（比如这时用户刷新了私聊页，开始跟进）就接着等；过了交接的时间还没有，
          // 才是没开成（交给 harness 之前服务重启了）
          if (Date.now() - Date.parse(turn.startedAt) > HANDOVER_MS)
            return await finish(store, conversation, turn, undefined);
          await sleep(pollMs, undefined, { signal: closing.signal }).catch(() => undefined);
          continue;
        }
        const { events } = await harness.json(
          'GET',
          `/internal/runs/${turn.runId}/events?after=${turn.cursor}&limit=${EVENT_PAGE}`,
          { schema: RunEventList },
        );
        // 用户正在发话、这批没写进去：等一会儿再拉，写完才算跟到了这里
        const written =
          !events.length ||
          (await writeEvents(store, conversationId, turn.runId, events, await durations()));
        if (written && terminal(run.status) && events.length < EVENT_PAGE) {
          const latest = (await store.find(conversationId))?.turn;
          if (latest?.runId === turn.runId)
            return await finish(store, conversation, { ...turn, ...latest }, run);
          return;
        }
        if (Date.now() - spentAt >= spendMs) {
          spentAt = Date.now();
          await cards
            .live(store, conversation, turn, run)
            .catch((err: unknown) =>
              logger.warn({ err, runId: turn.runId }, '看这一轮的进展（花费、成果）失败，下次再看'),
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
      .withLock('follow', conversationId, (store) => track(store, conversationId).then(() => true))
      .catch((err: unknown) => {
        // 别的实例正在跟
        if (!(err instanceof HttpError && err.code === 'conversation_busy'))
          logger.error({ err, conversationId }, '跟进一轮失败');
        return false;
      })
      .finally(() => following.delete(conversationId))
      // 收尾时接着开了下一轮（排着的话、群里叫它的话）：接着跟
      .then(async (ended) => {
        if (ended && (await deps.repo.find(conversationId))?.turn) follow(conversationId);
      })
      .catch(() => undefined);
    following.set(conversationId, task);
  }

  /**
   * 开一轮（调用方拿着这个对话的 message 锁）：userMessages 是这一轮用户说的话（已经存下；排着队的
   * 挪到最后），交给 AI 的是它们连起来的文字和带的文件。返回这一轮新增的 AI 消息。
   * 群里的席位开一轮时给 brief：交给 AI 的是 brief 里的那段话，AI 的消息写进群里。
   */
  async function begin(
    store: ConversationRepo,
    conversation: Conversation,
    userMessages: Message[],
    requestId: string,
    brief?: SeatBrief,
  ): Promise<Message[]> {
    const runId = randomUUID();
    const room = roomOf(conversation);
    const gathered = gather(userMessages);
    const { attachments, revisingIds } = gathered;
    const text = brief?.text ?? gathered.text;
    for (const m of userMessages) {
      const { pending, ...data } = m.data;
      if (pending) await store.moveToEnd(conversation.id, m.id);
      await store.updateMessage(m.id, { data: { ...data, runId } });
    }
    const aiMessage = (status: Message['status'], data: Record<string, unknown>, error?: string) =>
      store.insertMessage({
        conversationId: room,
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
      await store.touchConversation(room);
      return [await aiMessage('failed', {}, refused(err))];
    }
    const handed = brief?.files ?? handOver(attachments, revising, sessionId);
    // 任务名：往回看这一轮之前的话（确认的任务单、答的题）；群里用叫它的那句话
    const history = brief ? [] : await store.listMessages(room, TITLE_HISTORY);
    const own = new Set(userMessages.map((m) => m.id));
    const first = history.findIndex((m) => own.has(m.id));
    const title =
      brief?.title ??
      taskTitle(
        (first < 0 ? history : history.slice(0, first)).map((m) => ({
          author: m.authorKind,
          kind: m.kind,
          content: m.content,
        })),
        text,
      );
    const segment = await aiMessage('streaming', { parts: [], title });
    const startedAt = new Date().toISOString();
    const turn: Turn = {
      runId,
      startedAt,
      title,
      cursor: -1,
      segmentId: segment.id,
      ...(brief ? { callers: brief.callers } : {}),
    };
    if (!(await store.startTurn(conversation.id, turn))) {
      await store.deleteMessage(segment.id);
      throw new HttpError(409, 'turn_active', '这个对话还有一轮在进行');
    }
    const workplace: Workplace = conversation.workplace ?? { kind: 'cloud' };
    const body: StartRunBody = {
      runId,
      payerId: conversation.ownerId,
      conversationId: conversation.id,
      model: route.providerModel,
      persona: brief ? `${route.systemPrompt}\n\n${brief.persona}`.trim() : route.systemPrompt,
      ...(brief ? { scene: 'group' as const } : {}),
      domesticOnly: route.domesticOnly,
      prompt: withNote(text, handed.note),
      materials: handed.materials,
      workplace,
      permissions: conversation.permissions ?? defaultPermissions(workplace),
      ...(conversation.lastRunId ? { continueFrom: conversation.lastRunId } : {}),
    };
    try {
      try {
        await harness.json('POST', '/internal/runs', { body, requestId, schema: RunBody });
      } catch (err) {
        if (!(err instanceof HttpError && SESSION_GONE.has(err.code))) throw err;
        // 原来的工作目录不在了：这一轮开新会话，AI 不记得之前的事；要改的成果都得拷进来
        const { continueFrom: _continueFrom, ...rest } = body;
        const fresh = brief?.allFiles ?? handOver(attachments, revising, undefined);
        await harness.json('POST', '/internal/runs', {
          body: { ...rest, prompt: withNote(text, fresh.note), materials: fresh.materials },
          requestId,
          schema: RunBody,
        });
        await store.updateMessage(segment.id, {
          data: {
            runId,
            title,
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
    await store.touchConversation(room);
    follow(conversation.id);
    return [(await store.findMessage(room, segment.id)) ?? segment];
  }

  /**
   * 把一句话作为插话送进正在进行的一轮：AI 做完手上这一步就看到（还没开始的话开头那句之后就看到）。
   * 这一轮在交接或收尾、送不进去时 409。
   */
  async function interject(store: ConversationRepo, conversation: Conversation, text: string) {
    const { turn } = conversation;
    if (!turn) throw new HttpError(409, 'turn_not_active', '这一轮已经结束了');
    follow(conversation.id);
    try {
      await harness.json('POST', `/internal/runs/${turn.runId}/messages`, { body: { text } });
    } catch (err) {
      if (err instanceof HttpError && (err.statusCode === 409 || err.statusCode === 404))
        throw new HttpError(
          409,
          'turn_not_ready',
          '这一轮正在交接或收尾，暂时送不进去；这句还排着，做完会接着做',
        );
      throw err;
    }
    await store.updateTurn(conversation.id, turn.runId, { unheard: (turn.unheard ?? 0) + 1 });
  }

  /** 没开成的一轮：AI 那条消息写上原因 */
  async function finishRefused(
    store: ConversationRepo,
    conversation: Conversation,
    message: Message,
    err: unknown,
  ): Promise<Message> {
    await store.touchConversation(roomOf(conversation));
    return (
      (await store.updateMessage(message.id, { status: 'failed', error: refused(err) })) ?? message
    );
  }

  return {
    begin,
    follow,
    interject,
    /** 群里的席位做完一轮后要做的事（接着开下一轮），由群那边登记 */
    onSeatIdle(hook: SeatIdle) {
      seatIdle = hook;
    },

    /**
     * 「引导」（调用方拿着 message 锁）：把排着队的一句现在交给 AI，返回新增的消息。有一轮在进行就作为
     * 插话交给它，AI 做完手上这一步就看到（AI 还没开始的话开头那句之后就看到），看到时跟进那边换一条
     * 新的 AI 消息接着写（见 writeEvents），这句挪到聊天最后；没有就用它开一轮。这一轮在交接或收尾、
     * 送不进去时 409（还排着，做完接着做）。
     */
    async steer(
      store: ConversationRepo,
      conversation: Conversation,
      user: Message,
      requestId: string,
    ): Promise<Message[]> {
      const { turn } = conversation;
      if (!turn) {
        const replies = await begin(store, conversation, [user], requestId);
        return [(await store.findMessage(conversation.id, user.id)) ?? user, ...replies];
      }
      await interject(store, conversation, user.content);
      await store.moveToEnd(conversation.id, user.id);
      const { pending: _pending, ...data } = user.data;
      const updated = await store.updateMessage(user.id, {
        data: { ...data, runId: turn.runId, interjection: true },
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
