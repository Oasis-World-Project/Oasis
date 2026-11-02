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
import { createIntakeService } from '../src/service/intake-service.ts';
import { taskBrief, intakeMessages, validateSheetSources } from '../src/service/intake.ts';
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
      context: [],
      turns,
      roundsLeft: 1,
      skipped: false,
      materials: [],
    });
    expect(messages[1]?.content).toContain('采用当轮默认项：中文为主，保留专名（选项 b）');
    const sheet = TaskSheet.parse({
      title: '测试',
      deliverables: [{ name: '表', form: 'XLSX' }],
      criteria: ['按报价计算'],
    });
    expect(taskBrief('按报价计算', turns, sheet)).toContain('AI 假设不得覆盖');
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
  it('不能引用未选中的选项、伪造附件摘要或引文', () => {
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
    expect(() => validateSheetSources(sheet, '按报价计算', turns)).not.toThrow();
    sheet.requirements![0]!.sources = [
      { kind: 'answer', round: 1, questionId: 'q1', optionId: 'a', quote: '全中文' },
    ];
    expect(() => validateSheetSources(sheet, '按报价计算', turns)).toThrow('来源或引文不符');
    sheet.requirements![0]!.sources = [
      { kind: 'material', uploadId: OWNER, sha256: 'a'.repeat(64), quote: '市场估价' },
    ];
    expect(() => validateSheetSources(sheet, '按报价计算', turns)).toThrow('来源或引文不符');
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
  };
  let seq = 0;
  let messageLocked = false;
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
      for (const draft of intakes.filter((i) => i.status === 'asking' || i.status === 'sheet'))
        draft.context = draft.context.filter(
          (c) =>
            !obsolete.some((m) => (c.messageId ? c.messageId === m.id : c.content === m.content)),
        );
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
    findOwned: async (id, owner) => (id === CONV && owner === OWNER ? conversation : undefined),
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
    recentComplete: async (_c, limit, excludeId, beforeSeq) =>
      rows
        .filter(
          (r) =>
            r.status === 'complete' &&
            r.id !== excludeId &&
            (beforeSeq === undefined || r.seq <= beforeSeq),
        )
        .slice(-limit),
    listMessages: async () => rows,
    findMessage: async (_c, id) => rows.find((r) => r.id === id),
    setMessageData: async (id, data) =>
      Object.assign(
        rows.find((r) => r.id === id)!,
        { data },
      ),
    async markTaskRemoved(conversationId, taskId, removed) {
      const hits = rows.filter(
        (r) =>
          r.conversationId === conversationId &&
          ['task', 'delivery', 'notice'].includes(r.kind) &&
          r.data.taskId === taskId,
      );
      for (const r of hits) r.data = { ...r.data, removed };
      return hits.length;
    },
    async createIntake(intake) {
      if (intakes.some((i) => i.conversationId === intake.conversationId && open(i)))
        return undefined;
      const row: Intake = {
        ...intake,
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
/** 接需求时模型依次给出的回答（非流式） */
let intakeReplies: string[] = [];
let finishReasons: string[] = [];
type ChatBody = { model: string; stream?: boolean; messages: { role: string; content: string }[] };
const seenRequests: { payer: unknown; body: ChatBody }[] = [];
const intakeRequests: ChatBody[] = [];
let decisionCalls = 0;
let preserveProbability = 0.9;
let selectionFailures = 0;
const modelGateway = Fastify();
modelGateway.post('/internal/v1/decisions', async (request) => {
  decisionCalls += 1;
  const questions = (request.body as { questions: Record<string, unknown> }).questions;
  const selections = Object.keys(questions).filter((key) => key.startsWith('answer_'));
  return {
    answers: {
      ...Object.fromEntries(
        selections.map((key) => [
          key,
          { noul: key === 'answer_1_q1' && selectionFailures-- > 0 ? 0.1 : 0.9 },
        ]),
      ),
      is_task: { type: 'noul', noul: taskProbability },
      preserved: { noul: preserveProbability },
    },
  };
});
modelGateway.post('/internal/v1/chat/completions', async (request, reply) => {
  const body = request.body as ChatBody;
  if (body.stream === false) {
    intakeRequests.push(body);
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
const task = Fastify();
task.post('/internal/tasks', async (request, reply) => {
  createdTasks.push(request.body as Record<string, unknown>);
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
canvas.post('/internal/uploads/lookup', async (request, reply) => {
  const { ownerId, ids } = request.body as { ownerId: string; ids: string[] };
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
  intakeReplies = [];
  seenRequests.length = 0;
  intakeRequests.length = 0;
  createdTasks.length = 0;
  decisionCalls = 0;
  preserveProbability = 0.9;
  selectionFailures = 0;
  finishReasons = [];
  repo = memoryRepo();
  const logger = pino({ level: 'silent' });
  const clients = {
    agent: createServiceClient('agent', urls.agent),
    modelGateway: createServiceClient('model-gateway', urls.gateway),
  };
  intake = createIntakeService({
    repo,
    ...clients,
    task: createServiceClient('task', urls.task),
    config: {
      detectModel: 'typesafe/jev-1.14',
      detectHigh: 0.7,
      detectLow: 0.4,
      fallbackModel: 'deepseek/fallback',
      maxRounds: 3,
      maxTokens: 2000,
    },
    logger,
  });
  service = createDmService({
    repo,
    ...clients,
    canvas: createServiceClient('canvas', urls.canvas),
    intake,
    historyLimit: 20,
    replyMaxTokens: 256,
    detect: { high: 0.7, low: 0.4 },
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
      context: [],
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
  it('真实接需求链读取材料并核对来源；语义审查失败时有限重试，不确认漂移任务单', async () => {
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
      history: [],
      requestId: 'r',
    });
    expect(messages.at(-1)?.kind).toBe('sheet');
    expect(repo.intakes[0]?.sheet?.materials).toEqual([PHOTO.name]);
    expect(intakeRequests.at(-1)?.messages[1]?.content).toContain(evidence);
    expect(repo.intakes[0]?.sheet?.requirements?.[0]?.sources[0]).toMatchObject({
      sha256: 'a'.repeat(64),
    });
    await prepared.cancel(conversation);
    preserveProbability = 0.1;
    intakeReplies = Array.from({ length: 3 }, () => JSON.stringify(generated));
    await expect(
      prepared.start({
        conversation,
        ownerId: OWNER,
        request,
        attachments: [PHOTO],
        history: [],
        requestId: 'r2',
      }),
    ).rejects.toMatchObject({ code: 'intake_failed' });
    expect(createdTasks).toHaveLength(0);
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

  it('直接开始：告诉 AI 不能再问；它还是给了问题就算不合格，带着原因重来', async () => {
    await begin();
    intakeReplies = [questions(2), sheet()];
    const [message] = await intake.answer({
      conversation: await conversation(),
      ownerId: OWNER,
      answers: {},
      skip: true,
      requestId: 'r',
    });
    expect(message!.kind).toBe('sheet');
    expect(intakeRequests[1]!.messages[1]!.content).toContain('用户点了「直接开始」');
    expect(intakeRequests[2]!.messages.at(-1)!.content).toContain('现在不能再问了，必须给出任务单');
  });

  it('写不出合格的 JSON：再要一次，还不行就换默认模型', async () => {
    taskProbability = 0.9;
    intakeReplies = ['好的我来问几个问题', '{"type":"questions"}', questions()];
    const events = await send('帮我写个官网首页开头');
    expect(lastDone(events).kind).toBe('questions');
    expect(intakeRequests.map((r) => r.model)).toEqual([
      'anthropic/x',
      'anthropic/x',
      'deepseek/fallback',
    ]);
  });

  it('三个都不行：这条标记失败，给出能看懂的原因', async () => {
    taskProbability = 0.9;
    intakeReplies = ['x', 'y', 'z'];
    const events = await send('帮我写个官网首页开头');
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'intake_failed',
      message: '任务单暂时未能生成，原话和已提交的回答已保存，请继续整理或稍后重试',
    });
  });

  it('失败结果被带回修复；生成请求使用契约约束且不消耗额外推理输出', async () => {
    await begin();
    const invalid = JSON.parse(sheet());
    invalid.sheet.criteria = ['要求8', 8];
    intakeReplies = [JSON.stringify(invalid), sheet()];
    await intake.answer({
      conversation: await conversation(),
      ownerId: OWNER,
      answers: {},
      skip: true,
      requestId: 'repair',
    });
    const retried = intakeRequests.at(-1)!;
    expect(
      retried.messages.some((m) => m.role === 'assistant' && m.content.includes('要求8')),
    ).toBe(true);
    expect(retried).toMatchObject({
      response_format: { type: 'json_schema' },
      reasoning: { enabled: false },
      provider: { require_parameters: true },
    });
  });

  it('回答后生成失败保留卡片；旧版空指针也能恢复，重试不覆盖已保存选择', async () => {
    await begin();
    const card = repo.rows.find((m) => m.kind === 'questions')!;
    intakeReplies = ['x', 'y', 'z'];
    await expect(
      intake.answer({
        conversation: await conversation(),
        ownerId: OWNER,
        answers: { q1: 'b' },
        skip: true,
        requestId: 'fail',
      }),
    ).rejects.toMatchObject({ code: 'intake_failed' });
    expect(repo.intakes[0]!.cardMessageId).toBe(card.id);
    // 模拟修复前遗留的状态，答案已保存但卡片指针被提前清空。
    repo.intakes[0]!.cardMessageId = null;
    intakeReplies = [questions(2), sheet()];
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

  it('即使返回可解析 JSON，length 结束也不能当成功；过期问题卡不能错答下一轮', async () => {
    await begin();
    finishReasons = ['length', 'stop'];
    intakeReplies = [sheet('截断结果'), questions(2)];
    await intake.answer({
      conversation: await conversation(),
      ownerId: OWNER,
      answers: {},
      skip: false,
      requestId: 'cut',
    });
    expect(repo.intakes[0]!.status).toBe('asking');
    expect(repo.intakes[0]!.round).toBe(2);
    expect(intakeRequests.at(-1)!.messages.at(-1)!.content).toContain('被截断');
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

  it('需求保持检查指明未确认的用户选择，修复不以降低验收门槛放行', async () => {
    await begin();
    const generated = JSON.parse(sheet());
    generated.sheet.requirements = [
      { id: 'r1', text: '写官网', sources: [{ kind: 'request', quote: '官网' }] },
    ];
    intakeReplies = [JSON.stringify(generated), JSON.stringify(generated)];
    selectionFailures = 1;
    const prepared = createIntakeService({
      repo,
      agent: createServiceClient('agent', urls.agent),
      modelGateway: createServiceClient('model-gateway', urls.gateway),
      task: createServiceClient('task', urls.task),
      harness: createServiceClient('harness', urls.task),
      config: {
        detectModel: 'jev',
        detectHigh: 0.7,
        detectLow: 0.4,
        fallbackModel: 'fallback',
        maxRounds: 3,
        maxTokens: 2000,
      },
      logger: pino({ level: 'silent' }),
    });
    await prepared.answer({
      conversation: await conversation(),
      ownerId: OWNER,
      answers: { q1: 'b' },
      skip: false,
      requestId: 'semantic',
    });
    expect(intakeRequests.at(-1)!.messages.at(-1)!.content).toContain(
      '第1轮「首页给谁看（第 1 轮）」选择「情侣」',
    );
    expect(intakeRequests).toHaveLength(3);
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
    expect(decisionCalls).toBe(1); // 接需求期间不再判断是不是任务
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
});

describe('随消息发文件（ADR 0007 §4）', () => {
  it('附件记在用户消息上；聊天时 AI 知道附了哪些文件', async () => {
    const events = await send('看看这张照片', false, [PHOTO.id]);
    const accepted = events[0] as Extract<StreamEvent, { type: 'accepted' }>;
    expect(accepted.userMessage.data).toMatchObject({ attachments: [PHOTO], intent: 'chat' });
    const toModel = seenRequests[0]!.body.messages.at(-1)!.content;
    expect(toModel).toContain('随消息附了文件：民宿照片.jpg（2.3 MB）');
  });

  it('文件不存在或不是自己的：整条消息不收，400', async () => {
    const err = await service
      .resolveAttachments(OWNER, ['aaaaaaaa-0000-4000-8000-0000000000ff'], 'r')
      .catch((e: unknown) => e);
    expect((err as HttpError).statusCode).toBe(400);
    expect(repo.rows).toHaveLength(0);
  });

  it('开始前发的文件和接需求时补的文件都算素材；确认时交给 task，任务单的素材以实际文件为准', async () => {
    taskProbability = 0.1;
    await send('先发你一张照片', false, [PHOTO.id]);
    taskProbability = 0.9;
    intakeReplies = [questions()];
    await send('用它做个官网首页');
    expect(intakeRequests[0]!.messages[1]!.content).toContain('【用户给的素材】');
    expect(repo.intakes[0]!.materials).toEqual([
      { uploadId: PHOTO.id, name: PHOTO.name, size: PHOTO.size },
    ]);

    intakeReplies = [sheet()];
    await send('还有这个 logo，也用上', false, [LOGO.id, PHOTO.id]);
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
});
