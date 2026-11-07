import type { MessageBody, StreamEvent } from '@oasis/contracts/conversation';
import { createServiceClient, type HttpError } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Conversation,
  ConversationRepo,
  Intake,
  Message,
} from '../src/repo/conversation-repo.ts';
import { createDmService, toMessageBody } from '../src/service/dm-service.ts';
import { createContext, type ContextService } from '../src/service/context.ts';
import { createIntakeService } from '../src/service/intake-service.ts';
import {
  FALLBACK_SHEET_INTRO,
  groundRequirements,
  intakeMessages,
  readIntakeReply,
  taskBrief,
} from '../src/service/intake.ts';
import { TaskSheet } from '@oasis/contracts/task';
import type { IntakeTurn } from '../src/repo/schema.ts';

const OWNER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const CONV = '3f2e1d0c-9b8a-4765-8432-10fedcba9876';
const TASK_ID = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';

describe('任务单来源与默认答案', () => {
  const turns: IntakeTurn[] = [
    {
      kind: 'questions',
      round: 1,
      questions: [
        {
          id: 'q1',
          text: '语言？',
          default: 'b',
          options: [
            { id: 'a', label: '全中文' },
            { id: 'b', label: '中文为主，保留专名' },
          ],
        },
      ],
      answers: { q1: 'auto' },
    },
  ];
  it('auto 和跳过都确定采用当轮推荐，原话在 brief 中保留', () => {
    const messages = intakeMessages({
      name: 'AI',
      request: '按报价计算',
      summary: null,
      context: [],
      files: [],
      turns,
      roundsLeft: 1,
      skipped: false,
    });
    expect(messages[1]?.content).toContain('采用当轮默认项：中文为主，保留专名（选项 b）');
    const sheet = TaskSheet.parse({
      title: '测试',
      deliverables: [{ name: '表', form: 'XLSX' }],
      criteria: ['按报价计算'],
    });
    expect(taskBrief('按报价计算', turns, sheet)).toContain('用户的原话：按报价计算');
    expect(
      taskBrief(
        '按报价计算',
        [
          {
            ...turns[0]!,
            kind: 'questions',
            round: 1,
            questions: turns[0]!.kind === 'questions' ? turns[0]!.questions : [],
            answers: null,
            skipped: true,
          },
        ],
        sheet,
      ),
    ).toContain('采用当轮默认项：中文为主');
  });
  it('引文按原文核对：对不上的来源去掉，原话和明确选择缺了就补上，不抛错', () => {
    const sheet = TaskSheet.parse({
      title: '测试',
      deliverables: [{ name: '表', form: 'XLSX' }],
      criteria: ['中文为主'],
      requirements: [
        {
          id: 'r1',
          text: '中文为主',
          sources: [
            { kind: 'answer', round: 1, questionId: 'q1', optionId: 'b', quote: '中文为主' },
          ],
        },
      ],
    });
    expect(groundRequirements(sheet, '按报价计算', turns).requirements).toEqual([
      { id: 'r1', text: '按报价计算', sources: [{ kind: 'request', quote: '按报价计算' }] },
      { ...sheet.requirements![0]!, id: 'r2' },
    ]);
    sheet.requirements = [
      {
        id: 'x',
        text: '全中文',
        sources: [{ kind: 'answer', round: 1, questionId: 'q1', optionId: 'a', quote: '全中文' }],
      },
      {
        id: 'x',
        text: '按市场估价',
        sources: [
          { kind: 'material', uploadId: OWNER, sha256: 'a'.repeat(64), quote: '市场估价' },
          { kind: 'request', quote: '报价' },
        ],
      },
    ];
    expect(groundRequirements(sheet, '按报价计算', turns).requirements).toEqual([
      { id: 'r1', text: '按市场估价', sources: [{ kind: 'request', quote: '报价' }] },
      {
        id: 'r2',
        text: '语言？：中文为主，保留专名',
        sources: [
          {
            kind: 'answer',
            round: 1,
            questionId: 'q1',
            optionId: 'b',
            quote: '中文为主，保留专名',
          },
        ],
      },
    ]);
  });
  it('回答里的小毛病就地整理；用不了时给出原因而不是抛错', () => {
    const read = readIntakeReply(
      JSON.stringify({
        type: 'sheet',
        intro: '',
        questions: [
          {
            id: 'q1',
            text: '问',
            options: [
              { id: 'a', label: '一' },
              { id: 'b', label: '二' },
            ],
            default: 'z',
          },
        ],
        sheet: null,
      }),
      false,
    );
    expect(read.reply).toMatchObject({ type: 'questions', questions: [{ default: 'a' }] });
    const long = readIntakeReply(
      JSON.stringify({
        type: 'sheet',
        intro: '',
        sheet: {
          title: '长'.repeat(80),
          deliverables: [{ name: '表', form: 'XLSX' }],
          criteria: ['好'],
          style: [],
          budgetMicro: null,
          assumptions: [],
          requirements: [],
          // 模型抄来的旧预算：不能出现在新任务单上
          budget: { tier: 'standard', micro: 10_000_000, minutes: 60, steps: [] },
        },
      }),
      true,
    );
    expect(long.reply?.type === 'sheet' && long.reply.sheet.title).toHaveLength(60);
    expect(long.reply?.type === 'sheet' && long.reply.sheet.budget).toBeUndefined();
    expect(readIntakeReply('好的', false)).toEqual({
      reply: null,
      problem: '回答里没有 JSON 对象',
    });
    expect(readIntakeReply(questions(), true).reply).toBeNull();
  });
});

/** 内存版仓库 */
function memoryRepo(): ConversationRepo & { rows: Message[]; intakes: Intake[] } {
  const rows: Message[] = [];
  const intakes: Intake[] = [];
  const conversation: Conversation = {
    nextMessageSeq: 0,
    id: CONV,
    kind: 'dm',
    ownerId: OWNER,
    modelKey: 'claude',
    title: 'Claude',
    createdAt: new Date(),
    lastMessageAt: null,
    contextSummary: null,
  };
  let seq = 0;
  let messageLocked = false;
  let deleted = false;
  const open = (i: Intake) => i.status === 'asking' || i.status === 'sheet';
  const repo: ConversationRepo & { rows: Message[]; intakes: Intake[] } = {
    rows,
    intakes,
    withMessageLock: async (_id, work) => {
      if (messageLocked) throw Object.assign(new Error('busy'), { code: 'conversation_busy' });
      messageLocked = true;
      try {
        return await work(repo);
      } finally {
        messageLocked = false;
      }
    },
    taskSourceIds: async () =>
      rows
        .filter(
          (r) =>
            r.authorKind === 'user' &&
            (r.data.intent === 'task' || intakes.some((i) => i.request === r.content)),
        )
        .map((r) => r.id),
    mergeMessageData: async (id, data, unlessStopped) => {
      const row = rows.find((r) => r.id === id);
      if (!row || (unlessStopped && row.data.stopRequested)) return undefined;
      row.data = { ...row.data, ...data };
      return row;
    },
    requestStop: async (_c, id) => {
      const row = rows.find((r) => r.id === id);
      if (!row || row.data.intent === 'task') return false;
      row.data = { ...row.data, stopRequested: true };
      return true;
    },
    mutateChat: async (_c, obsolete, edit) => {
      const ids = obsolete.map((m) => m.id).filter((id) => id !== edit?.id && id !== edit?.replyId);
      for (let i = rows.length - 1; i >= 0; i--) if (ids.includes(rows[i]!.id)) rows.splice(i, 1);
      if (edit)
        Object.assign(
          rows.find((r) => r.id === edit.id)!,
          { content: edit.content },
        );
      if (edit?.replyId)
        Object.assign(
          rows.find((r) => r.id === edit.replyId)!,
          {
            content: '',
            status: 'streaming',
            error: null,
            data: { replyTo: edit.id, stopped: false },
          },
        );
      if (obsolete.length) conversation.contextSummary = null;
    },
    saveIntakeAnswers: async (id, cardId, turns, answers) => {
      const card = rows.find((m) => m.id === cardId)!;
      await repo.setMessageData(cardId, { ...card.data, answers });
      return repo.updateIntake(id, { turns, cardMessageId: cardId });
    },
    commitIntakeReply: async (id, input, patch) => {
      const previous = intakes.find((i) => i.id === id)!;
      if (previous.status === 'sheet' && previous.cardMessageId) {
        const card = rows.find((m) => m.id === previous.cardMessageId)!;
        await repo.setMessageData(card.id, { ...card.data, status: 'superseded' });
      }
      const row = await repo.insertMessage(input);
      await repo.updateIntake(id, { ...patch, cardMessageId: row.id });
      return row;
    },
    withIntakeLock: async (_id, work) => work(repo),
    findQuestionCard: async (conversationId, intakeId, round) =>
      rows.find(
        (m) =>
          m.conversationId === conversationId &&
          m.kind === 'questions' &&
          m.data.intakeId === intakeId &&
          m.data.round === round,
      ),
    upsertDm: async () => conversation,
    listDms: async () => [conversation],
    findOwned: async (id, owner) =>
      id === CONV && owner === OWNER && !deleted ? conversation : undefined,
    attachmentIds: async (conversationId) => [
      ...new Set(
        rows
          .filter((r) => r.conversationId === conversationId)
          .flatMap((r) => ((r.data.attachments ?? []) as { id: string }[]).map((a) => a.id)),
      ),
    ],
    deleteConversation: async () => {
      deleted = true;
      rows.length = 0;
      intakes.length = 0;
    },
    hasDelivery: async (conversationId, taskId) =>
      rows.some(
        (r) =>
          r.conversationId === conversationId && r.kind === 'delivery' && r.data.taskId === taskId,
      ),
    insertMessage: async (m) => {
      const row: Message = {
        seq: seq + 1,
        kind: 'text',
        data: {},
        ...m,
        id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
        error: null,
        createdAt: new Date(Date.now() + seq),
      };
      rows.push(row);
      return row;
    },
    insertMessageOnce: async () => undefined,
    finishMessage: async (id, update) => {
      const row = rows.find((r) => r.id === id)!;
      Object.assign(row, {
        content: update.content,
        status: update.status,
        error: update.error ?? null,
      });
      return row;
    },
    touchConversation: async () => {},
    completeMessages: async (_c, excludeId, beforeSeq) =>
      rows.filter(
        (r) =>
          r.status === 'complete' &&
          r.id !== excludeId &&
          (beforeSeq === undefined || r.seq <= beforeSeq),
      ),
    setContextSummary: async (_id, next) => {
      conversation.contextSummary = next;
    },
    listMessages: async () => rows,
    findMessage: async (_c, id) => rows.find((r) => r.id === id),
    setMessageData: async (id, data) =>
      Object.assign(
        rows.find((r) => r.id === id)!,
        { data },
      ),
    async removeTaskMessages(conversationId, taskId) {
      const hits = rows.filter(
        (r) =>
          r.conversationId === conversationId &&
          ['task', 'delivery', 'notice'].includes(r.kind) &&
          r.data.taskId === taskId,
      );
      for (const r of hits) rows.splice(rows.indexOf(r), 1);
      return hits.length;
    },
    async createIntake(intake) {
      if (intakes.some((i) => i.conversationId === intake.conversationId && open(i)))
        return undefined;
      const row: Intake = {
        ...intake,
        context: [],
        status: 'asking',
        round: 0,
        turns: [],
        cardMessageId: null,
        sheet: null,
        taskId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      intakes.push(row);
      return row;
    },
    findOpenIntake: async (conversationId) =>
      intakes.find((i) => i.conversationId === conversationId && open(i)),
    updateIntake: async (id, patch) =>
      Object.assign(
        intakes.find((i) => i.id === id)!,
        patch,
      ),
  };
  return repo;
}

const agent = Fastify();
agent.get('/internal/models/:key/route', async () => ({
  key: 'claude',
  name: 'Claude',
  providerModel: 'anthropic/x',
  systemPrompt: '你是 Claude',
}));

let gatewayMode: 'ok' | 'broke' | 'midway' | 'slow' | 'length' | 'no-done' = 'ok';
let upstreamStopped = false;
let replySuffix = '我在。';
/** Jev 判断「是不是任务」的概率 */
let taskProbability = 0.1;
/** 正在整理任务时，Jev 判断新消息是不是在说这件任务；不设时不回答这一问（按补充处理） */
let aboutOpen: number | undefined;
/** 接需求时模型依次给出的回答（非流式） */
let intakeReplies: string[] = [];
let finishReasons: string[] = [];
type ChatBody = { model: string; stream?: boolean; messages: { role: string; content: string }[] };
const seenRequests: { payer: unknown; body: ChatBody }[] = [];
const intakeRequests: ChatBody[] = [];
let decisionCalls = 0;
/** 接需求的非流式调用本身失败（网络/额度）时返回的状态码 */
let intakeStatus = 0;
let blocked: string[] = [];
const modelGateway = Fastify();
modelGateway.get('/internal/v1/models/unavailable', async () => ({ models: blocked }));
modelGateway.post('/internal/v1/decisions', async () => {
  decisionCalls += 1;
  return {
    answers: {
      is_task: { type: 'noul', noul: taskProbability },
      ...(aboutOpen === undefined ? {} : { about_open: { type: 'noul', noul: aboutOpen } }),
    },
  };
});
/** 看图工具收到的图片数 */
let visionCalls = 0;
modelGateway.post('/internal/v1/tools/image.inspect', async () => {
  visionCalls += 1;
  return {
    text: '一名戴眼镜的男子，穿荧光黄外卖骑手冲锋衣，胸口印 Uber Eats，正面、侧面、背面三视图。',
  };
});
modelGateway.post('/internal/v1/chat/completions', async (request, reply) => {
  const body = request.body as ChatBody;
  if (body.stream === false) {
    intakeRequests.push(body);
    if (intakeStatus)
      return reply
        .code(intakeStatus)
        .send({ error: { code: 'provider_unavailable', message: '连不上', requestId: 'r' } });
    return {
      choices: [
        {
          finish_reason: finishReasons.shift() ?? 'stop',
          message: { role: 'assistant', content: intakeReplies.shift() ?? '' },
        },
      ],
    };
  }
  seenRequests.push({ payer: request.headers['x-oasis-payer-id'], body });
  if (gatewayMode === 'slow') {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.raw.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: '收到的部分' } }] })}\n\n`,
    );
    await new Promise<void>((resolve) =>
      reply.raw.on('close', () => {
        upstreamStopped = true;
        resolve();
      }),
    );
    return;
  }
  if (gatewayMode === 'broke')
    return reply
      .code(402)
      .send({ error: { code: 'insufficient_balance', message: '额度不够了', requestId: 'r' } });
  reply.header('content-type', 'text/event-stream');
  const parts = [`data: ${JSON.stringify({ choices: [{ delta: { content: '你好，' } }] })}\n\n`];
  if (gatewayMode === 'midway')
    parts.push(`data: ${JSON.stringify({ error: { message: '回复中断了' } })}\n\n`);
  else
    parts.push(
      `data: ${JSON.stringify({ choices: [{ delta: { content: replySuffix }, finish_reason: gatewayMode === 'length' ? 'length' : 'stop' }] })}\n\n`,
      ...(gatewayMode === 'no-done' ? [] : ['data: [DONE]\n\n']),
    );
  return parts.join('');
});

/** 假 task：记下建任务的请求 */
const createdTasks: Record<string, unknown>[] = [];
/** 建任务的请求到了 task，但回给 conversation 的是失败（超时、断线） */
let taskFailsOnce = false;
const task = Fastify();
/** task 给任务单的报价；null 表示这次没报出来 */
let quoteReply: unknown = null;
const quoteRequests: Record<string, unknown>[] = [];
/** 用户的任务（私聊里的 AI 被问起时回答进度）；哪些文件是任务素材 */
let ownerTasks: unknown[] = [];
let inUse: string[] = [];
task.get('/internal/owners/:ownerId/tasks', async () => ({ tasks: ownerTasks }));
task.post('/internal/materials/in-use', async (request) => ({
  ids: (request.body as { ids: string[] }).ids.filter((id) => inUse.includes(id)),
}));
task.post('/internal/quotes', async (request) => {
  quoteRequests.push(request.body as Record<string, unknown>);
  return { quote: quoteReply };
});
task.post('/internal/tasks', async (request, reply) => {
  createdTasks.push(request.body as Record<string, unknown>);
  if (taskFailsOnce) {
    taskFailsOnce = false;
    return reply
      .code(503)
      .send({ error: { code: 'unavailable', message: 'task 暂时不可用', requestId: 'r' } });
  }
  return reply.code(201).send({
    id: TASK_ID,
    title: '小木屋首页',
    brief: 'b',
    status: 'planning',
    attention: null,
    estimateMicro: null,
    spentMicro: 0,
    budgetLimitMicro: null,
    nodes: [],
    edges: [],
    createdAt: new Date().toISOString(),
    finishedAt: null,
  });
});

/** 假 canvas：KAI 的两个文件 */
const PHOTO = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  name: '民宿照片.jpg',
  size: 2_400_000,
  contentType: 'image/jpeg',
};
const LOGO = {
  id: 'aaaaaaaa-0000-4000-8000-000000000002',
  name: 'logo.png',
  size: 30_000,
  contentType: 'image/png',
};
const canvas = Fastify();
/** 真删除：conversation 让 canvas 删掉的文件；认领过的文件 */
const deletedUploads: { ownerId: string; ids: string[] }[] = [];
const claimedUploads: string[] = [];
canvas.post('/internal/uploads/delete', async (request) => {
  deletedUploads.push(request.body as { ownerId: string; ids: string[] });
  return { deleted: (request.body as { ids: string[] }).ids.length };
});
canvas.post('/internal/uploads/lookup', async (request, reply) => {
  const { ownerId, ids, claim } = request.body as {
    ownerId: string;
    ids: string[];
    claim?: boolean;
  };
  if (claim) claimedUploads.push(...ids);
  const files = [PHOTO, LOGO].filter((f) => ids.includes(f.id));
  if (ownerId !== OWNER || files.length !== ids.length)
    return reply
      .code(404)
      .send({ error: { code: 'upload_not_found', message: '没有', requestId: 'r' } });
  return { uploads: files.map((f) => ({ ...f, createdAt: new Date().toISOString() })) };
});

let repo: ReturnType<typeof memoryRepo>;
let service: ReturnType<typeof createDmService>;
let intake: ReturnType<typeof createIntakeService>;
let context: ContextService;
const urls = { agent: '', gateway: '', task: '', canvas: '' };
beforeAll(async () => {
  urls.agent = await agent.listen({ port: 0, host: '127.0.0.1' });
  urls.gateway = await modelGateway.listen({ port: 0, host: '127.0.0.1' });
  urls.task = await task.listen({ port: 0, host: '127.0.0.1' });
  urls.canvas = await canvas.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await agent.close();
  await modelGateway.close();
  await task.close();
  await canvas.close();
});
beforeEach(() => {
  gatewayMode = 'ok';
  upstreamStopped = false;
  replySuffix = '我在。';
  taskProbability = 0.1;
  aboutOpen = undefined;
  intakeReplies = [];
  seenRequests.length = 0;
  intakeRequests.length = 0;
  createdTasks.length = 0;
  taskFailsOnce = false;
  decisionCalls = 0;
  visionCalls = 0;
  quoteReply = null;
  quoteRequests.length = 0;
  ownerTasks = [];
  inUse = [];
  intakeStatus = 0;
  blocked = [];
  finishReasons = [];
  repo = memoryRepo();
  const logger = pino({ level: 'silent' });
  const clients = {
    agent: createServiceClient('agent', urls.agent),
    modelGateway: createServiceClient('model-gateway', urls.gateway),
  };
  context = createContext({
    repo,
    modelGateway: clients.modelGateway,
    summaryModel: 'deepseek/summary',
    logger,
  });
  intake = createIntakeService({
    repo,
    context,
    ...clients,
    task: createServiceClient('task', urls.task),
    config: {
      detectModel: 'typesafe/jev-1.14',
      detectHigh: 0.7,
      detectLow: 0.4,
      fallbackModel: 'deepseek/fallback',
      maxRounds: 3,
      maxTokens: 2000,
      quoteTimeoutMs: 180_000,
    },
    logger,
  });
  service = createDmService({
    repo,
    ...clients,
    canvas: createServiceClient('canvas', urls.canvas),
    task: createServiceClient('task', urls.task),
    intake,
    context,
    replyMaxTokens: 256,
    detect: { model: 'typesafe/jev-1.14', high: 0.7, low: 0.4 },
    logger,
  });
});

async function send(
  content: string,
  asTask = false,
  attachmentIds: string[] = [],
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  await service.sendMessage({
    ownerId: OWNER,
    conversationId: CONV,
    content,
    asTask,
    attachments: await service.resolveAttachments(OWNER, attachmentIds, 'r'),
    requestId: 'r',
    emit: (e) => events.push(e),
  });
  return events;
}
const lastDone = (events: StreamEvent[]) =>
  (events.at(-1) as Extract<StreamEvent, { type: 'done' }>).message;

describe('普通聊天的替换、删除和停止', () => {
  it('尚在思考、没有任何正文时也能停止，不继续识别或启动任务', async () => {
    let stop: Promise<void> | undefined;
    await service.sendMessage({
      ownerId: OWNER,
      conversationId: CONV,
      content: '普通问题',
      asTask: false,
      attachments: [],
      requestId: 'thinking',
      emit: (event) => {
        if (event.type === 'accepted') stop = service.stopReply(OWNER, CONV, event.userMessage.id);
      },
    });
    await stop;
    expect(seenRequests).toEqual([]);
    expect(createdTasks).toEqual([]);
    expect(repo.rows.at(-1)).toMatchObject({
      content: '',
      data: { stopped: true },
      status: 'complete',
    });
  });
  it('修改过去一轮只替换本轮，生成不偷看后续消息；旧正文和旧回复不留在上下文', async () => {
    await send('旧问题');
    const user = repo.rows[0]!,
      reply = repo.rows[1]!;
    await send('后续问题');
    const laterIds = repo.rows.slice(2).map((r) => r.id);
    replySuffix = '替换后的回答';
    await service.replaceReply({
      ownerId: OWNER,
      conversationId: CONV,
      messageId: user.id,
      content: '新问题',
      requestId: 'replace',
      emit: () => {},
    });
    expect(repo.rows).toHaveLength(4);
    expect(repo.rows[0]?.id).toBe(user.id);
    expect(repo.rows[1]?.id).toBe(reply.id);
    expect(repo.rows.slice(2).map((r) => r.id)).toEqual(laterIds);
    expect(seenRequests.at(-1)!.body.messages.map((m) => m.content)).toEqual([
      '你是 Claude',
      '新问题',
    ]);
    expect(repo.rows[1]?.content).toBe('你好，替换后的回答');
    // 重新生成不重新识别为任务，也不创建平行历史。
    const decisionsBefore = decisionCalls;
    await service.replaceReply({
      ownerId: OWNER,
      conversationId: CONV,
      messageId: user.id,
      requestId: 'regen',
      emit: () => {},
    });
    expect(decisionCalls).toBe(decisionsBefore);
    expect(repo.rows).toHaveLength(4);
    await service.deleteMessage(OWNER, CONV, user.id);
    expect(repo.rows.map((r) => r.id)).toEqual(laterIds);
    await send('继续');
    expect(
      seenRequests
        .at(-1)!
        .body.messages.some((m) => ['旧问题', '新问题', '你好，替换后的回答'].includes(m.content)),
    ).toBe(false);
  });

  it.each(['local', 'persisted'])(
    '%s 停止会关闭上游连接、保留部分文本，不触发后台任务；拒绝迟到覆盖',
    async (mode) => {
      gatewayMode = 'slow';
      let userId = '';
      let delta!: () => void;
      const received = new Promise<void>((resolve) => {
        delta = resolve;
      });
      const pending = service.sendMessage({
        ownerId: OWNER,
        conversationId: CONV,
        content: '普通聊天',
        asTask: false,
        attachments: [],
        requestId: 'slow',
        emit: (e) => {
          if (e.type === 'accepted') userId = e.userMessage.id;
          if (e.type === 'delta') delta();
        },
      });
      await received;
      await expect(service.deleteMessage(OWNER, CONV, userId)).rejects.toMatchObject({
        code: 'conversation_busy',
      });
      await expect(
        service.replaceReply({
          ownerId: OWNER,
          conversationId: CONV,
          messageId: userId,
          content: '另一版',
          requestId: 'r',
          emit: () => {},
        }),
      ).rejects.toMatchObject({ code: 'conversation_busy' });
      if (mode === 'local') await service.stopReply(OWNER, CONV, userId);
      else await repo.requestStop(CONV, userId);
      await pending;
      await expect.poll(() => upstreamStopped).toBe(true);
      expect(repo.rows[1]).toMatchObject({
        status: 'complete',
        content: '收到的部分',
        data: { stopped: true, replyTo: userId },
      });
      expect(createdTasks).toEqual([]);
      gatewayMode = 'ok';
      await service.replaceReply({
        ownerId: OWNER,
        conversationId: CONV,
        messageId: userId,
        requestId: 'r',
        emit: () => {},
      });
      expect(repo.rows[1]?.data.stopped).toBe(false);
      expect(repo.rows[1]?.content).toBe('你好，我在。');
    },
  );

  it('长度上限单独说明，手打继续沿原回复追加，不再识别任务或增加消息', async () => {
    gatewayMode = 'length';
    const events = await send('原问题');
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'reply_length' });
    const reply = repo.rows[1]!;
    const prefix = reply.content;
    expect(reply.data.resumable).toBe(true);
    const decisions = decisionCalls;
    gatewayMode = 'ok';
    await send('继续');
    expect(repo.rows).toHaveLength(2);
    expect(decisionCalls).toBe(decisions);
    expect(reply.content).toBe(prefix + '你好，我在。');
    expect(reply).toMatchObject({
      status: 'complete',
      error: null,
      data: { resumable: false, stopped: false },
    });
    expect(seenRequests.at(-1)!.body.messages.map((m) => m.content)).toEqual([
      '你是 Claude',
      '原问题',
      prefix,
      '从上次中断处继续，保留原要求，不重复已经输出的内容。',
    ]);
    await expect(
      service.replaceReply({
        ownerId: OWNER,
        conversationId: CONV,
        messageId: repo.rows[0]!.id,
        continue: true,
        requestId: 'dup',
        emit: () => {},
      }),
    ).rejects.toMatchObject({ code: 'reply_not_paused' });
  });

  it('识别前暂停后继续，保留原需求和附件，重新走任务识别而非识别继续二字', async () => {
    const attachment = { id: OWNER, name: '参考图.png', size: 300, contentType: 'image/png' };
    const user = await repo.insertMessage({
      conversationId: CONV,
      authorKind: 'user',
      authorId: OWNER,
      content: '制作马车',
      status: 'complete',
      data: { intent: 'chat', stopRequested: true, attachments: [attachment] },
    });
    await repo.insertMessage({
      conversationId: CONV,
      authorKind: 'ai',
      authorId: 'claude',
      content: '',
      status: 'complete',
      data: { replyTo: user.id, stopped: true },
    });
    taskProbability = 0.95;
    intakeReplies = [questions()];
    await send('继续');
    expect(repo.rows.filter((m) => m.authorKind === 'user')).toHaveLength(1);
    expect(repo.rows.some((m) => m.kind === 'questions')).toBe(true);
    expect(user.data.intent).toBe('task');
    const open = await repo.findOpenIntake(CONV);
    expect(open?.request).toBe('制作马车');
    expect(open?.materials).toEqual([{ uploadId: OWNER, name: '参考图.png', size: 300 }]);
    expect(seenRequests).toHaveLength(0);
  });

  it('继续中再次暂停保留前缀和新片段，并拒绝同时重入', async () => {
    gatewayMode = 'length';
    await send('原问题');
    const user = repo.rows[0]!,
      reply = repo.rows[1]!,
      prefix = reply.content;
    gatewayMode = 'slow';
    let received!: () => void;
    const delta = new Promise<void>((resolve) => {
      received = resolve;
    });
    const running = service.replaceReply({
      ownerId: OWNER,
      conversationId: CONV,
      messageId: user.id,
      continue: true,
      requestId: 'resume',
      emit: (e) => {
        if (e.type === 'delta' && e.text === '收到的部分') received();
      },
    });
    await delta;
    await expect(
      service.replaceReply({
        ownerId: OWNER,
        conversationId: CONV,
        messageId: user.id,
        continue: true,
        requestId: 'dup',
        emit: () => {},
      }),
    ).rejects.toMatchObject({ code: 'conversation_busy' });
    await service.stopReply(OWNER, CONV, user.id);
    await running;
    expect(reply.content).toBe(prefix + '收到的部分');
    expect(reply.data.stopped).toBe(true);
    expect(repo.rows).toHaveLength(2);
  });

  it.each(['length', 'no-done'] as const)('普通回复 %s 也不能伪装正常完成', async (mode) => {
    gatewayMode = mode;
    await send('问答');
    expect(repo.rows.at(-1)?.status).toBe('failed');
  });

  it('已识别和旧任务来源的消息均有标记，任何消息操作都不能改动任务', async () => {
    const legacy = await repo.insertMessage({
      conversationId: CONV,
      authorKind: 'user',
      authorId: OWNER,
      content: '旧任务原话',
      status: 'complete',
    });
    await repo.createIntake({
      id: TASK_ID,
      conversationId: CONV,
      request: legacy.content,
      materials: [],
    });
    expect((await service.listMessages(OWNER, CONV))[0]).toMatchObject({
      data: { intent: 'task' },
    });
    for (const action of [
      () => service.deleteMessage(OWNER, CONV, legacy.id),
      () => service.stopReply(OWNER, CONV, legacy.id),
      () =>
        service.replaceReply({
          ownerId: OWNER,
          conversationId: CONV,
          messageId: legacy.id,
          requestId: 'r',
          emit: () => {},
        }),
    ])
      await expect(action()).rejects.toMatchObject({ code: 'task_message_locked' });
    await expect(service.deleteMessage(TASK_ID, CONV, legacy.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(repo.rows[0]?.content).toBe('旧任务原话');
  });
});

describe('私聊发消息', () => {
  it('先确认收到，再逐段推送回复，最后存下完整回复；由会话主人付费', async () => {
    const events = await send('在吗');
    expect(events.map((e) => e.type)).toEqual(['accepted', 'activity', 'delta', 'delta', 'done']);
    expect(lastDone(events)).toMatchObject({
      role: 'assistant',
      kind: 'text',
      content: '你好，我在。',
      status: 'complete',
    });
    expect(seenRequests[0]!.payer).toBe(OWNER);
    expect(seenRequests[0]!.body.messages).toEqual([
      { role: 'system', content: '你是 Claude' },
      { role: 'user', content: '在吗' },
    ]);
  });

  it('任何一个私聊里的 AI 都能看到用户任务的进度（只在被问起时说）', async () => {
    ownerTasks = [
      {
        id: TASK_ID,
        title: '3D 马车',
        status: 'running',
        nodesDone: 2,
        nodesTotal: 5,
        spentMicro: 0,
        revisionOf: null,
        revising: true,
        createdAt: new Date().toISOString(),
      },
    ];
    await send('马车改得怎么样了');
    const [system, tasks] = seenRequests[0]!.body.messages;
    expect(system).toEqual({ role: 'system', content: '你是 Claude' });
    expect(tasks!.role).toBe('system');
    expect(tasks!.content).toContain('只有用户问起时才说');
    expect(tasks!.content).toContain('- 「3D 马车」：AI 团队正在按修改意见改（2/5 步）');
  });

  it('第二轮带上前面的对话作为上下文', async () => {
    await send('在吗');
    await send('今天周几');
    expect(seenRequests[1]!.body.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
  });

  it('额度不够时这条回复标记失败，并给出能看懂的原因', async () => {
    gatewayMode = 'broke';
    const events = await send('在吗');
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'insufficient_balance',
      message: '额度不够了，这条没有回复',
    });
    expect(repo.rows.at(-1)).toMatchObject({ status: 'failed', error: '额度不够了，这条没有回复' });
  });

  it('回复中途断了，保留已经收到的部分', async () => {
    gatewayMode = 'midway';
    const events = await send('在吗');
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'stream_interrupted' });
    expect(repo.rows.at(-1)).toMatchObject({ status: 'failed', content: '你好，' });
  });

  it('别人的会话访问不到', async () => {
    await expect(
      service.listMessages('11111111-1111-4111-8111-111111111111', CONV),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

const questions = (round = 1) =>
  JSON.stringify({
    type: 'questions',
    intro: '先确认两件事：',
    questions: [
      {
        id: 'q1',
        text: `首页给谁看（第 ${round} 轮）`,
        options: [
          { id: 'a', label: '想来度假的家庭' },
          { id: 'b', label: '情侣' },
        ],
        default: 'a',
      },
      {
        id: 'q2',
        text: '语气',
        options: [
          { id: 'a', label: '温馨' },
          { id: 'b', label: '简洁' },
        ],
        default: 'a',
      },
    ],
  });
const sheet = (title = '小木屋首页') =>
  JSON.stringify({
    type: 'sheet',
    intro: '整理好了：',
    sheet: {
      title,
      deliverables: [{ name: '首页开头文案', form: 'Markdown' }],
      criteria: ['不超过 80 字', '语气温馨'],
      style: ['面向家庭'],
      budgetMicro: null,
      assumptions: ['用中文'],
      materials: [],
    },
  });
const card = (message: MessageBody) => message.data as Record<string, unknown>;

describe('认出任务', () => {
  it('有点像任务：照常聊天，回复下面附「当成任务来做」；不像任务的不附', async () => {
    taskProbability = 0.5;
    expect(lastDone(await send('想做个官网，怎么弄比较好？')).data).toMatchObject({
      suggestTask: true,
    });
    taskProbability = 0.1;
    expect(lastDone(await send('在吗')).data).toMatchObject({ suggestTask: false });
  });

  it('像任务：不聊天，直接出问题卡；点了「发任务」的不用再判断', async () => {
    taskProbability = 0.9;
    intakeReplies = [questions()];
    const events = await send('帮我给小木屋民宿写个官网首页开头');
    expect(events.map((e) => e.type)).toEqual(['accepted', 'activity', 'done']);
    expect(seenRequests).toHaveLength(0);
    const message = lastDone(events);
    expect(message.kind).toBe('questions');
    expect(card(message)).toMatchObject({ round: 1, answers: null });
    expect(message.content).toContain('想来度假的家庭（推荐） / 情侣 / 你看着办');
    expect(intakeRequests[0]!.messages[1]!.content).toContain('帮我给小木屋民宿写个官网首页开头');

    await intake.cancel((await repo.findOwned(CONV, OWNER))!);
    intakeReplies = [questions()];
    await send('再帮我写个海报文案', true);
    expect(decisionCalls).toBe(1);
  });

  it('点「当成任务来做」：从那条消息开始接需求', async () => {
    taskProbability = 0.5;
    await send('想做个官网首页');
    intakeReplies = [sheet()];
    const conversation = (await repo.findOwned(CONV, OWNER))!;
    const result = await intake.startFrom({
      conversation,
      ownerId: OWNER,
      messageId: repo.rows[0]!.id,
      requestId: 'r',
    });
    expect(result.map((m) => m.kind)).toEqual(['sheet']);
    expect(repo.intakes[0]!.request).toBe('想做个官网首页');
  });
});

describe('接需求', () => {
  it('真实接需求链读取材料并核对来源；一次生成即给出任务单，不做会打回的语义审查', async () => {
    const request = '按材料报价做费用表，中文为主';
    const evidence = '按报价计算，小计另加10%';
    const generated = {
      type: 'sheet',
      sheet: {
        title: '费用表',
        deliverables: [{ name: '表', form: 'XLSX' }],
        criteria: ['按原报价计算'],
        materials: [{ fabricated: '模型不负责填写素材元数据' }],
        requirements: [
          {
            id: 'r1',
            text: '按原报价小计加10%',
            sources: [
              { kind: 'material', uploadId: PHOTO.id, sha256: 'a'.repeat(64), quote: evidence },
            ],
          },
        ],
      },
    };
    const inspector = {
      json: async () => ({
        files: [
          {
            uploadId: PHOTO.id,
            name: '报价.txt',
            sha256: 'a'.repeat(64),
            text: evidence,
            status: 'complete',
          },
        ],
      }),
    } as unknown as ReturnType<typeof createServiceClient>;
    const prepared = createIntakeService({
      repo,
      context,
      agent: createServiceClient('agent', urls.agent),
      modelGateway: createServiceClient('model-gateway', urls.gateway),
      task: createServiceClient('task', urls.task),
      harness: inspector,
      config: {
        detectModel: 'jev',
        detectHigh: 0.7,
        detectLow: 0.4,
        fallbackModel: 'fallback',
        maxRounds: 3,
        maxTokens: 2000,
        quoteTimeoutMs: 180_000,
      },
      logger: pino({ level: 'silent' }),
    });
    const conversation = (await repo.findOwned(CONV, OWNER))!;
    intakeReplies = [JSON.stringify(generated)];
    const messages = await prepared.start({
      conversation,
      ownerId: OWNER,
      request,
      attachments: [PHOTO],
      requestId: 'r',
    });
    expect(messages.at(-1)?.kind).toBe('sheet');
    expect(repo.intakes[0]?.sheet?.materials).toEqual([PHOTO.name]);
    expect(intakeRequests.at(-1)?.messages[1]?.content).toContain(evidence);
    expect(repo.intakes[0]?.sheet?.requirements).toEqual([
      { id: 'r1', text: request, sources: [{ kind: 'request', quote: request }] },
      {
        id: 'r2',
        text: '按原报价小计加10%',
        sources: [
          { kind: 'material', uploadId: PHOTO.id, sha256: 'a'.repeat(64), quote: evidence },
        ],
      },
    ]);
    expect(intakeRequests).toHaveLength(1);
    expect(decisionCalls).toBe(0);
    expect(createdTasks).toHaveLength(0);
  });

  it('图片素材的原图不写进提示词，也不存进接需求记录', async () => {
    const base64 = 'iVBORw0KGgo'.repeat(50_000);
    const inspector = {
      json: async () => ({
        files: [
          {
            uploadId: PHOTO.id,
            name: PHOTO.name,
            sha256: 'b'.repeat(64),
            text: '',
            status: 'complete',
            image: { mediaType: 'image/png', base64 },
          },
        ],
      }),
    } as unknown as ReturnType<typeof createServiceClient>;
    const prepared = createIntakeService({
      repo,
      context,
      agent: createServiceClient('agent', urls.agent),
      modelGateway: createServiceClient('model-gateway', urls.gateway),
      task: createServiceClient('task', urls.task),
      harness: inspector,
      config: {
        detectModel: 'jev',
        detectHigh: 0.7,
        detectLow: 0.4,
        fallbackModel: 'fallback',
        maxRounds: 3,
        maxTokens: 2000,
        quoteTimeoutMs: 180_000,
      },
      logger: pino({ level: 'silent' }),
    });
    intakeReplies = [questions()];
    await prepared.start({
      conversation: (await repo.findOwned(CONV, OWNER))!,
      ownerId: OWNER,
      request: '做一段送外卖的视频，主角参考我给的图',
      attachments: [PHOTO],
      requestId: 'r',
    });
    const prompt = intakeRequests.at(-1)!.messages[1]!.content;
    expect(prompt).not.toContain('iVBORw0KGgo');
    expect(prompt).toContain(
      '看图模型的描述（只用来理解图片内容，不是用户原话）：一名戴眼镜的男子，穿荧光黄外卖骑手冲锋衣',
    );
    expect(visionCalls).toBe(1);
    expect(prompt.length).toBeLessThan(20_000);
    expect(JSON.stringify(repo.intakes[0]!.turns)).not.toContain('iVBORw0KGgo');
  });
  it('任务说明保留用户补充、链接和问题卡答案，超长不会静默截断', () => {
    const finalSheet = JSON.parse(sheet()).sheet;
    const turns = [
      { kind: 'user' as const, text: '改成两份，参考 https://example.com/source' },
      {
        kind: 'questions' as const,
        round: 1,
        questions: JSON.parse(questions()).questions,
        answers: { q1: 'b' },
      },
    ];
    const brief = taskBrief('最初要一份', turns, finalSheet);
    expect(brief).toContain('改成两份，参考 https://example.com/source');
    expect(brief).toContain('首页给谁看（第 1 轮） → 情侣');
    expect(brief).toContain('最后确认的任务单');
    expect(() => taskBrief('长'.repeat(20000), turns, finalSheet)).toThrow('原话未被截断');
  });
  const conversation = () => repo.findOwned(CONV, OWNER) as Promise<Conversation>;
  const begin = async () => {
    taskProbability = 0.9;
    intakeReplies = [questions()];
    await send('帮我写个官网首页开头');
  };

  it('回答问题卡 → 回答写进卡片，AI 看到选项的文字 → 给出任务单', async () => {
    await begin();
    intakeReplies = [sheet()];
    const [message] = await intake.answer({
      conversation: await conversation(),
      ownerId: OWNER,
      answers: { q1: 'b', q2: 'auto' },
      skip: false,
      requestId: 'r',
    });
    expect(message!.kind).toBe('sheet');
    expect(toMessageBody(message!).data).toMatchObject({ status: 'open', taskId: null });
    expect(message!.content).toContain('怎么算做好：\n- 不超过 80 字');
    expect(repo.rows.find((r) => r.kind === 'questions')?.data).toMatchObject({
      answers: { q1: 'b', q2: 'auto' },
    });
    const prompt = intakeRequests[1]!.messages[1]!.content;
    expect(prompt).toContain('首页给谁看（第 1 轮） → 情侣');
    expect(prompt).toContain('语气 → 采用当轮默认项：温馨（选项 a）');
  });

  it('选项都不合适时自己写：AI 看到原话，任务单的要求按原话补上', async () => {
    await begin();
    intakeReplies = [sheet()];
    await intake.answer({
      conversation: await conversation(),
      ownerId: OWNER,
      answers: { q1: 'custom:  来出差的商务客  ' },
      skip: false,
      requestId: 'r',
    });
    expect(repo.rows.find((r) => r.kind === 'questions')?.data).toMatchObject({
      answers: { q1: 'custom:来出差的商务客' },
    });
    expect(intakeRequests[1]!.messages[1]!.content).toContain(
      '用户没选选项，自己写的（选项 custom）：来出差的商务客',
    );
    expect(repo.intakes[0]!.sheet!.requirements).toContainEqual(
      expect.objectContaining({
        sources: [
          expect.objectContaining({ kind: 'answer', optionId: 'custom', quote: '来出差的商务客' }),
        ],
      }),
    );
  });

  it('自己写的答案不能是空的', async () => {
    await begin();
    const err = await intake
      .answer({
        conversation: await conversation(),
        ownerId: OWNER,
        answers: { q1: 'custom:   ' },
        skip: false,
        requestId: 'r',
      })
      .catch((e: unknown) => e);
    expect((err as HttpError).statusCode).toBe(400);
  });

  it('之前的对话整段带上并按任务分段：旧任务的消息标成只作背景，它的文件列出来但不自动算素材', async () => {
    const old = { id: PHOTO.id, name: '批注-site-截图1.png', size: 300, contentType: 'image/png' };
    const oldIntake = '0d0d0d0d-0000-4000-8000-000000000001';
    await repo.insertMessage({
      conversationId: CONV,
      authorKind: 'user',
      authorId: OWNER,
      content: '修改马车：去掉墓碑',
      status: 'complete',
      data: { intent: 'task', intakeId: oldIntake, attachments: [old] },
    });
    await repo.insertMessage({
      conversationId: CONV,
      authorKind: 'ai',
      authorId: 'claude',
      content: '任务：3D 马车',
      status: 'complete',
      kind: 'sheet',
      data: {
        intakeId: oldIntake,
        intro: '',
        sheet: { title: '3D 马车' },
        quote: null,
        status: 'confirmed',
        taskId: TASK_ID,
      },
    });
    await repo.insertMessage({
      conversationId: CONV,
      authorKind: 'ai',
      authorId: 'claude',
      content: '马车已交付',
      status: 'complete',
      kind: 'delivery',
      data: { taskId: TASK_ID },
    });
    await repo.insertMessage({
      conversationId: CONV,
      authorKind: 'user',
      authorId: OWNER,
      content: '3 秒的视频够发朋友圈吗',
      status: 'complete',
      data: { intent: 'chat' },
    });
    taskProbability = 0.9;
    intakeReplies = [questions()];
    await send('帮我做一段送外卖的视频');
    const prompt = intakeRequests[0]!.messages[1]!.content as string;
    expect(prompt).toContain('用户：【任务「3D 马车」·已交付，只作背景】修改马车：去掉墓碑');
    expect(prompt).toContain('用户：3 秒的视频够发朋友圈吗');
    expect(prompt).toContain(
      `[${PHOTO.id}] 批注-site-截图1.png（1 KB）· 来自任务「3D 马车」·已交付`,
    );
    // 这次的原话不重复出现在之前的对话里
    expect(prompt.split('帮我做一段送外卖的视频')).toHaveLength(2);
    expect((await repo.findOpenIntake(CONV))!.materials).toEqual([]);
  });

  it('选项不存在：400', async () => {
    await begin();
    const err = await intake
      .answer({
        conversation: await conversation(),
        ownerId: OWNER,
        answers: { q1: 'z' },
        skip: false,
        requestId: 'r',
      })
      .catch((e: unknown) => e);
    expect((err as HttpError).statusCode).toBe(400);
  });

  it('直接开始：告诉 AI 不能再问；它还是给了问题也不重来，按原话和选择列出任务单', async () => {
    await begin();
    intakeReplies = [questions(2)];
    const [message] = await intake.answer({
      conversation: await conversation(),
      ownerId: OWNER,
      answers: {},
      skip: true,
      requestId: 'r',
    });
    expect(message!.kind).toBe('sheet');
    expect(intakeRequests[1]!.messages[1]!.content).toContain('用户点了「直接开始」');
    expect(intakeRequests).toHaveLength(2);
    expect(toMessageBody(message!).data).toMatchObject({ intro: FALLBACK_SHEET_INTRO });
    expect(repo.intakes[0]!.sheet!.requirements!.map((r) => r.text)).toEqual([
      '帮我写个官网首页开头',
      '首页给谁看（第 1 轮）：想来度假的家庭',
      '语气：温馨',
    ]);
  });

  it('写不出 JSON 也只调用一次：直接按原话列出任务单，流程不中断', async () => {
    taskProbability = 0.9;
    intakeReplies = ['好的我来问几个问题'];
    const events = await send('帮我写个官网首页开头');
    const done = lastDone(events);
    expect(done.kind).toBe('sheet');
    expect(done.content).toContain('帮我写个官网首页开头');
    expect(intakeRequests.map((r) => r.model)).toEqual(['anthropic/x']);
  });

  it('私聊的 AI 在当前地区用不了：事先改用默认模型，不先失败再换', async () => {
    taskProbability = 0.9;
    blocked = ['anthropic/x'];
    intakeReplies = [questions()];
    expect(lastDone(await send('帮我写个官网首页开头')).kind).toBe('questions');
    expect(intakeRequests.map((r) => r.model)).toEqual(['deepseek/fallback']);
  });

  it('字段不合格不重试；生成请求使用契约约束、留足输出上限且不消耗额外推理输出', async () => {
    await begin();
    const invalid = JSON.parse(sheet());
    invalid.sheet.criteria = ['要求8', 8];
    intakeReplies = [JSON.stringify(invalid)];
    const [message] = await intake.answer({
      conversation: await conversation(),
      ownerId: OWNER,
      answers: {},
      skip: true,
      requestId: 'once',
    });
    expect(message?.kind).toBe('sheet');
    expect(intakeRequests).toHaveLength(2);
    expect(intakeRequests.at(-1)).toMatchObject({
      max_tokens: 2000,
      response_format: { type: 'json_schema' },
      reasoning: { enabled: false },
      provider: { require_parameters: true },
    });
  });

  it('网络失败保留卡片；旧版空指针也能恢复，继续整理不覆盖已保存选择', async () => {
    await begin();
    const card = repo.rows.find((m) => m.kind === 'questions')!;
    intakeStatus = 503;
    await expect(
      intake.answer({
        conversation: await conversation(),
        ownerId: OWNER,
        answers: { q1: 'b' },
        skip: true,
        requestId: 'fail',
      }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(intakeRequests).toHaveLength(2);
    intakeStatus = 0;
    expect(repo.intakes[0]!.cardMessageId).toBe(card.id);
    // 模拟修复前遗留的状态，答案已保存但卡片指针被提前清空。
    repo.intakes[0]!.cardMessageId = null;
    intakeReplies = [sheet()];
    const [resumed] = await intake.answer({
      conversation: await conversation(),
      ownerId: OWNER,
      answers: {},
      skip: false,
      requestId: 'resume',
    });
    expect(resumed?.kind).toBe('sheet');
    expect(intakeRequests.at(-1)!.messages[1]!.content).toContain('情侣');
    expect(intakeRequests.at(-1)!.messages[1]!.content).toContain('直接给出任务单');
    expect(repo.intakes[0]!.turns.filter((t) => t.kind === 'questions')).toHaveLength(1);
  });

  it('length 结束即使能解析也不当成功，也不重来：按原话和选择列出任务单', async () => {
    await begin();
    finishReasons = ['length'];
    intakeReplies = [sheet('截断结果')];
    const [message] = await intake.answer({
      conversation: await conversation(),
      ownerId: OWNER,
      answers: { q1: 'b' },
      skip: false,
      requestId: 'cut',
    });
    expect(message?.kind).toBe('sheet');
    expect(repo.intakes[0]!.sheet!.title).toBe('帮我写个官网首页开头');
    expect(repo.intakes[0]!.sheet!.requirements!.map((r) => r.text)).toContain(
      '首页给谁看（第 1 轮）：情侣',
    );
    expect(intakeRequests).toHaveLength(2);
  });

  it('过期问题卡不能错答下一轮', async () => {
    await begin();
    intakeReplies = [questions(2)];
    await intake.answer({
      conversation: await conversation(),
      ownerId: OWNER,
      answers: {},
      skip: false,
      requestId: 'next',
    });
    expect(repo.intakes[0]!.round).toBe(2);
    const calls = intakeRequests.length;
    await expect(
      intake.answer({
        conversation: await conversation(),
        ownerId: OWNER,
        answers: {},
        skip: false,
        messageId: repo.rows.find((m) => m.kind === 'questions')!.id,
        requestId: 'stale',
      }),
    ).rejects.toMatchObject({ code: 'stale_questions' });
    expect(intakeRequests).toHaveLength(calls);
  });

  it('模型漏掉的用户选择由系统按原文补进要求，不调用语义审查也不重试', async () => {
    await begin();
    const generated = JSON.parse(sheet());
    generated.sheet.requirements = [
      { id: 'r1', text: '写官网', sources: [{ kind: 'request', quote: '官网' }] },
    ];
    intakeReplies = [JSON.stringify(generated)];
    const decisions = decisionCalls;
    await intake.answer({
      conversation: await conversation(),
      ownerId: OWNER,
      answers: { q1: 'b' },
      skip: false,
      requestId: 'semantic',
    });
    expect(repo.intakes[0]!.sheet!.requirements).toEqual([
      { id: 'r1', text: '写官网', sources: [{ kind: 'request', quote: '官网' }] },
      {
        id: 'r2',
        text: '首页给谁看（第 1 轮）：情侣',
        sources: [{ kind: 'answer', round: 1, questionId: 'q1', optionId: 'b', quote: '情侣' }],
      },
    ]);
    expect(intakeRequests).toHaveLength(2);
    expect(decisionCalls).toBe(decisions);
    expect(createdTasks).toHaveLength(0);
  });

  it('问满 3 轮：告诉 AI 不能再问了', async () => {
    await begin();
    for (const round of [2, 3]) {
      intakeReplies = [questions(round)];
      await intake.answer({
        conversation: await conversation(),
        ownerId: OWNER,
        answers: {},
        skip: false,
        requestId: 'r',
      });
    }
    intakeReplies = [sheet()];
    await intake.answer({
      conversation: await conversation(),
      ownerId: OWNER,
      answers: {},
      skip: false,
      requestId: 'r',
    });
    expect(intakeRequests.at(-1)!.messages[1]!.content).toContain('不能再问了，请直接给出任务单');
  });

  it('看了任务单在对话里提意见：AI 改出新任务单，旧的标成已替换', async () => {
    await begin();
    intakeReplies = [sheet()];
    await intake.answer({
      conversation: await conversation(),
      ownerId: OWNER,
      answers: {},
      skip: true,
      requestId: 'r',
    });
    intakeReplies = [sheet('小木屋首页（活泼版）')];
    const events = await send('语气改活泼一点');
    expect(decisionCalls).toBe(2); // 接需求期间先判断是不是在说这件任务；判断不出就当补充
    expect(card(lastDone(events))).toMatchObject({
      status: 'open',
      sheet: { title: '小木屋首页（活泼版）' },
    });
    const sheets = repo.rows.filter((r) => r.kind === 'sheet');
    expect(sheets.map((s) => (s.data as { status: string }).status)).toEqual([
      'superseded',
      'open',
    ]);
    expect(intakeRequests.at(-1)!.messages[1]!.content).toContain('用户说：语气改活泼一点');
  });

  it('确认任务单：交给 task（带任务单和用户原话），任务单卡记下任务，出现任务卡', async () => {
    await begin();
    intakeReplies = [sheet()];
    await intake.answer({
      conversation: await conversation(),
      ownerId: OWNER,
      answers: {},
      skip: true,
      requestId: 'r',
    });
    const [message] = await intake.confirm({
      conversation: await conversation(),
      ownerId: OWNER,
      requestId: 'r',
    });
    expect(message).toMatchObject({ kind: 'task', data: { taskId: TASK_ID } });
    expect(createdTasks[0]).toMatchObject({
      ownerId: OWNER,
      payerId: OWNER,
      conversationId: CONV,
      title: '小木屋首页',
      sheet: { criteria: ['不超过 80 字', '语气温馨'] },
    });
    expect(createdTasks[0]!.brief).toContain('用户的原话：帮我写个官网首页开头');
    expect(createdTasks[0]!.brief).toContain('最后确认的任务单');
    expect(repo.rows.find((r) => r.kind === 'sheet')?.data).toMatchObject({
      status: 'confirmed',
      taskId: TASK_ID,
    });
    // 确认后回到普通聊天
    taskProbability = 0.1;
    expect(lastDone(await send('谢谢')).kind).toBe('text');
  });

  it('任务单附三档报价；确认时按选的档把预算写进任务单，自定义不能低于最低预算', async () => {
    quoteReply = {
      tiers: [
        { tier: 'economy', micro: 400_000, minutes: 6 },
        { tier: 'standard', micro: 1_200_000, minutes: 12 },
        { tier: 'premium', micro: 3_000_000, minutes: 25 },
      ],
      minimumMicro: 400_000,
      steps: ['写初稿', '润色'],
      rough: false,
    };
    await begin();
    intakeReplies = [sheet()];
    await intake.answer({
      conversation: await conversation(),
      ownerId: OWNER,
      answers: {},
      skip: true,
      requestId: 'r',
    });
    expect(quoteRequests[0]).toMatchObject({ ownerId: OWNER, sheet: { title: '小木屋首页' } });
    expect(repo.rows.find((r) => r.kind === 'sheet')?.data).toMatchObject({ quote: quoteReply });
    const low = await intake
      .confirm({
        conversation: await conversation(),
        ownerId: OWNER,
        budget: { tier: 'custom', customMicro: 100_000 },
        requestId: 'r',
      })
      .catch((e: unknown) => e);
    expect((low as HttpError).statusCode).toBe(400);
    expect(createdTasks).toHaveLength(0);
    await intake.confirm({
      conversation: await conversation(),
      ownerId: OWNER,
      budget: { tier: 'custom', customMicro: 2_000_000 },
      requestId: 'r',
    });
    // 自定义 $2 落在标准和精细之间：用时按标准档估
    expect(createdTasks[0]).toMatchObject({
      sheet: {
        budget: { tier: 'custom', micro: 2_000_000, minutes: 12, steps: ['写初稿', '润色'] },
      },
    });
    expect(createdTasks[0]!.brief).toContain('预算（参考，不是上限）：约 $2.00');
  });

  it('确认失败后再点：带同一个任务 ID 重交，task 不会建出第二个；改过的任务单换新 ID', async () => {
    await begin();
    intakeReplies = [sheet()];
    await intake.answer({
      conversation: await conversation(),
      ownerId: OWNER,
      answers: {},
      skip: true,
      requestId: 'r',
    });
    taskFailsOnce = true;
    await expect(
      intake.confirm({ conversation: await conversation(), ownerId: OWNER, requestId: 'r1' }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(repo.intakes[0]!.status).toBe('sheet');
    await intake.confirm({ conversation: await conversation(), ownerId: OWNER, requestId: 'r2' });
    expect(createdTasks).toHaveLength(2);
    expect(createdTasks[1]!.id).toBe(createdTasks[0]!.id);
    expect(createdTasks[0]!.id).toEqual(expect.any(String));
  });

  it('确认失败后用户改了任务单：新单换新的任务 ID，不沿用旧单留下的', async () => {
    await begin();
    intakeReplies = [sheet()];
    await intake.answer({
      conversation: await conversation(),
      ownerId: OWNER,
      answers: {},
      skip: true,
      requestId: 'r',
    });
    taskFailsOnce = true;
    await expect(
      intake.confirm({ conversation: await conversation(), ownerId: OWNER, requestId: 'r1' }),
    ).rejects.toMatchObject({ statusCode: 503 });
    intakeReplies = [sheet('小木屋首页（活泼版）')];
    await send('语气改活泼一点');
    expect(repo.intakes[0]!.taskId).toBeNull();
    await intake.confirm({ conversation: await conversation(), ownerId: OWNER, requestId: 'r2' });
    expect(createdTasks[1]).toMatchObject({ title: '小木屋首页（活泼版）' });
    expect(createdTasks[1]!.id).not.toBe(createdTasks[0]!.id);
  });

  it('不做了：任务单作废，回一句话，回到普通聊天；没在接需求时取消是 409', async () => {
    await begin();
    const [message] = await intake.cancel(await conversation());
    expect(message).toMatchObject({ kind: 'text', content: '好的，这件事先不做了，我们接着聊。' });
    const err = await intake.cancel(await conversation()).catch((e: unknown) => e);
    expect((err as HttpError).statusCode).toBe(409);
  });

  it('用户在对话里说不做了：AI 回答 cancel，结束接需求', async () => {
    await begin();
    intakeReplies = [JSON.stringify({ type: 'cancel', intro: '好，那我们先不做。' })];
    const events = await send('算了不用了');
    expect(lastDone(events)).toMatchObject({ kind: 'text', content: '好，那我们先不做。' });
    expect(repo.intakes[0]!.status).toBe('cancelled');
  });

  it('正在整理任务时聊别的：照常聊天，任务还在整理，这条消息不算任务', async () => {
    await begin();
    aboutOpen = 0.05;
    taskProbability = 0.1;
    const events = await send('对了，今天新加坡天气怎么样');
    const reply = lastDone(events);
    expect(reply).toMatchObject({ kind: 'text', data: { suggestTask: false } });
    expect(seenRequests).toHaveLength(1);
    expect(repo.intakes[0]!.status).toBe('asking');
    const user = repo.rows.find((r) => r.content === '对了，今天新加坡天气怎么样')!;
    expect((user.data as { intent?: string }).intent).not.toBe('task');
  });

  it('正在整理任务时说了另一件新任务：旧的收起来，按新需求开始整理', async () => {
    await begin();
    aboutOpen = 0.05;
    taskProbability = 0.95;
    intakeReplies = [questions()];
    const events = await send('换个事：帮我做一张周末读书会的海报');
    const messages = events.flatMap((e) => (e.type === 'done' ? [e.message] : []));
    expect(messages.map((m) => m.content)).toContain(
      '上一件还没确认的任务先放下了，我按新的需求来整理。',
    );
    expect(repo.intakes.map((i) => i.status)).toEqual(['cancelled', 'asking']);
    expect(repo.intakes[1]!.request).toBe('换个事：帮我做一张周末读书会的海报');
  });

  it('补充这件任务的话仍交给接需求', async () => {
    await begin();
    aboutOpen = 0.9;
    intakeReplies = [questions()];
    await send('主角用我给的图片');
    expect(seenRequests).toHaveLength(0);
    expect(intakeRequests.at(-1)!.messages[1]!.content).toContain('用户说：主角用我给的图片');
  });
});

describe('随消息发文件（ADR 0007 §4）', () => {
  it('附件记在用户消息上；聊天时 AI 知道附了哪些文件；删掉消息时文件在 canvas 里一起彻底删掉', async () => {
    deletedUploads.length = 0;
    claimedUploads.length = 0;
    const events = await send('看看这张照片', false, [PHOTO.id]);
    const accepted = events[0] as Extract<StreamEvent, { type: 'accepted' }>;
    expect(accepted.userMessage.data).toMatchObject({ attachments: [PHOTO], intent: 'chat' });
    const toModel = seenRequests[0]!.body.messages.at(-1)!.content;
    expect(toModel).toContain('随消息附了文件：民宿照片.jpg（2.3 MB）');
    // 随消息发出就认领，canvas 的清扫不会删它
    expect(claimedUploads).toEqual([PHOTO.id]);
    await service.deleteMessage(OWNER, CONV, accepted.userMessage.id);
    expect(deletedUploads).toEqual([{ ownerId: OWNER, ids: [PHOTO.id] }]);
    expect(repo.rows).toHaveLength(0);
  });

  it('删除私聊：消息和附件真删除，任务素材留着；之后这个私聊不存在了', async () => {
    deletedUploads.length = 0;
    await send('看看这两张', false, [PHOTO.id, LOGO.id]);
    inUse = [LOGO.id];
    await service.deleteDm(OWNER, CONV, 'r');
    expect(deletedUploads).toEqual([{ ownerId: OWNER, ids: [PHOTO.id] }]);
    expect(repo.rows).toHaveLength(0);
    const err = await service.listMessages(OWNER, CONV).catch((e: unknown) => e);
    expect((err as HttpError).statusCode).toBe(404);
  });

  it('文件不存在或不是自己的：整条消息不收，400', async () => {
    const err = await service
      .resolveAttachments(OWNER, ['aaaaaaaa-0000-4000-8000-0000000000ff'], 'r')
      .catch((e: unknown) => e);
    expect((err as HttpError).statusCode).toBe(400);
    expect(repo.rows).toHaveLength(0);
  });

  it('素材由 AI 从会话里的文件中挑：开始前发的照片要它选上才算，补发的文件默认用上；确认时交给 task', async () => {
    taskProbability = 0.1;
    await send('先发你一张照片', false, [PHOTO.id]);
    taskProbability = 0.9;
    intakeReplies = [JSON.stringify({ ...JSON.parse(questions()), materialIds: [PHOTO.id] })];
    await send('用它做个官网首页');
    expect(intakeRequests[0]!.messages[1]!.content).toContain(
      `[${PHOTO.id}] 民宿照片.jpg（2.3 MB）· 来自之前的聊天`,
    );
    expect(repo.intakes[0]!.materials).toEqual([
      { uploadId: PHOTO.id, name: PHOTO.name, size: PHOTO.size },
    ]);

    intakeReplies = [sheet()];
    await send('还有这个 logo，也用上', false, [LOGO.id, PHOTO.id]);
    expect(intakeRequests[1]!.messages[1]!.content).toContain(
      '民宿照片.jpg（2.3 MB）· 来自接需求时用户发的 · 已选为素材',
    );
    await intake.confirm({
      conversation: (await repo.findOwned(CONV, OWNER))!,
      ownerId: OWNER,
      requestId: 'r',
    });
    expect(createdTasks[0]).toMatchObject({
      materials: [
        { uploadId: PHOTO.id, name: PHOTO.name, size: PHOTO.size },
        { uploadId: LOGO.id, name: LOGO.name, size: LOGO.size },
      ],
      sheet: { materials: ['民宿照片.jpg', 'logo.png'] },
    });
  });

  it('用户说不用哪个文件，AI 去掉后任务单的素材跟着变；没列出来的 id 不认', async () => {
    taskProbability = 0.9;
    intakeReplies = [questions()];
    await send('做个官网首页', false, [PHOTO.id, LOGO.id]);
    expect(repo.intakes[0]!.materials.map((m) => m.uploadId)).toEqual([PHOTO.id, LOGO.id]);
    intakeReplies = [
      JSON.stringify({ ...JSON.parse(sheet()), materialIds: [LOGO.id, 'not-listed'] }),
    ];
    await send('照片别用了');
    expect(repo.intakes[0]!.materials.map((m) => m.uploadId)).toEqual([LOGO.id]);
    expect(repo.intakes[0]!.sheet?.materials).toEqual(['logo.png']);
  });
});
