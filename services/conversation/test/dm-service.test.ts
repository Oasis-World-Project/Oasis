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

const OWNER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const CONV = '3f2e1d0c-9b8a-4765-8432-10fedcba9876';
const TASK_ID = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';

/** 内存版仓库 */
function memoryRepo(): ConversationRepo & { rows: Message[]; intakes: Intake[] } {
  const rows: Message[] = [];
  const intakes: Intake[] = [];
  const conversation: Conversation = {
    id: CONV,
    kind: 'dm',
    ownerId: OWNER,
    modelKey: 'claude',
    title: 'Claude',
    createdAt: new Date(),
    lastMessageAt: null,
  };
  let seq = 0;
  const open = (i: Intake) => i.status === 'asking' || i.status === 'sheet';
  return {
    rows,
    intakes,
    upsertDm: async () => conversation,
    listDms: async () => [conversation],
    findOwned: async (id, owner) => (id === CONV && owner === OWNER ? conversation : undefined),
    insertMessage: async (m) => {
      const row: Message = {
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
    recentComplete: async (_c, limit, excludeId) =>
      rows.filter((r) => r.status === 'complete' && r.id !== excludeId).slice(-limit),
    listMessages: async () => rows,
    findMessage: async (_c, id) => rows.find((r) => r.id === id),
    setMessageData: async (id, data) =>
      Object.assign(
        rows.find((r) => r.id === id)!,
        { data },
      ),
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
}

const agent = Fastify();
agent.get('/internal/models/:key/route', async () => ({
  key: 'claude',
  name: 'Claude',
  providerModel: 'anthropic/x',
  systemPrompt: '你是 Claude',
}));

let gatewayMode: 'ok' | 'broke' | 'midway' = 'ok';
/** Jev 判断「是不是任务」的概率 */
let taskProbability = 0.1;
/** 接需求时模型依次给出的回答（非流式） */
let intakeReplies: string[] = [];
type ChatBody = { model: string; stream?: boolean; messages: { role: string; content: string }[] };
const seenRequests: { payer: unknown; body: ChatBody }[] = [];
const intakeRequests: ChatBody[] = [];
let decisionCalls = 0;
const modelGateway = Fastify();
modelGateway.post('/internal/v1/decisions', async () => {
  decisionCalls += 1;
  return { answers: { is_task: { type: 'noul', noul: taskProbability } } };
});
modelGateway.post('/internal/v1/chat/completions', async (request, reply) => {
  const body = request.body as ChatBody;
  if (body.stream === false) {
    intakeRequests.push(body);
    return { choices: [{ message: { role: 'assistant', content: intakeReplies.shift() ?? '' } }] };
  }
  seenRequests.push({ payer: request.headers['x-oasis-payer-id'], body });
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
      `data: ${JSON.stringify({ choices: [{ delta: { content: '我在。' } }] })}\n\n`,
      'data: [DONE]\n\n',
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

let repo: ReturnType<typeof memoryRepo>;
let service: ReturnType<typeof createDmService>;
let intake: ReturnType<typeof createIntakeService>;
const urls = { agent: '', gateway: '', task: '' };
beforeAll(async () => {
  urls.agent = await agent.listen({ port: 0, host: '127.0.0.1' });
  urls.gateway = await modelGateway.listen({ port: 0, host: '127.0.0.1' });
  urls.task = await task.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await agent.close();
  await modelGateway.close();
  await task.close();
});
beforeEach(() => {
  gatewayMode = 'ok';
  taskProbability = 0.1;
  intakeReplies = [];
  seenRequests.length = 0;
  intakeRequests.length = 0;
  createdTasks.length = 0;
  decisionCalls = 0;
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
    intake,
    historyLimit: 20,
    replyMaxTokens: 256,
    detect: { high: 0.7, low: 0.4 },
    logger,
  });
});

async function send(content: string, asTask = false): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  await service.sendMessage({
    ownerId: OWNER,
    conversationId: CONV,
    content,
    asTask,
    requestId: 'r',
    emit: (e) => events.push(e),
  });
  return events;
}
const lastDone = (events: StreamEvent[]) =>
  (events.at(-1) as Extract<StreamEvent, { type: 'done' }>).message;

describe('私聊发消息', () => {
  it('先确认收到，再逐段推送回复，最后存下完整回复；由会话主人付费', async () => {
    const events = await send('在吗');
    expect(events.map((e) => e.type)).toEqual(['accepted', 'delta', 'delta', 'done']);
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
    expect(lastDone(await send('想做个官网，怎么弄比较好？')).data).toEqual({ suggestTask: true });
    taskProbability = 0.1;
    expect(lastDone(await send('在吗')).data).toEqual({});
  });

  it('像任务：不聊天，直接出问题卡；点了「发任务」的不用再判断', async () => {
    taskProbability = 0.9;
    intakeReplies = [questions()];
    const events = await send('帮我给小木屋民宿写个官网首页开头');
    expect(events.map((e) => e.type)).toEqual(['accepted', 'done']);
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
    expect(prompt).toContain('语气 → 你看着办');
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
      message: '没能把需求整理好，请换个说法再说一次',
    });
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
