import { AvatarSpec } from '@oasis/contracts/avatar';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { AVATAR_COMPLETIONS_PATH, createAvatarLlmServer } from '../src/api/avatar-server.ts';
import { createAvatarService } from '../src/service/avatar-service.ts';
import {
  createAnswerSniffer,
  planTurn,
  retrieve,
  saidHandoff,
} from '../src/service/avatar-turns.ts';
import type { ChatService } from '../src/service/chat-service.ts';
import { createRunKeyService } from '../src/service/run-key-service.ts';
import { fakeClient, fakeMeter, memoryRunKeys, memorySessions } from './avatar-fakes.ts';

const PAYER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const OTHER_RUN = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b';
const logger = pino({ level: 'silent' });

const knowledge = [
  { title: '早餐时间', content: '早餐在一楼餐厅，每天七点到九点半。', source: '入住须知' },
  { title: '退房', content: '退房时间是中午十二点，可以寄存行李。' },
  { title: '交通', content: '从高铁站打车约四十分钟，民宿可以预约接站。' },
];
const spec = AvatarSpec.parse({
  name: '民宿前台',
  avatarId: '9c59a215-4c9f-478f-9d95-edca74c7b0d0',
  prompt: '你是山间民宿的前台。',
  knowledge,
  handoff: { when: '客人要退款或投诉', message: '这个我帮您转给值班经理，请稍等。' },
});

describe('数字人每一轮的提示', () => {
  it('知识要点少时全部放进提示，只把和问题相关的记成引用', () => {
    const { included, relevant } = retrieve(knowledge, '早餐几点开始？');
    expect(included).toHaveLength(3);
    expect(relevant.map((k) => k.title)).toEqual(['早餐时间']);
  });

  it('知识要点多时只放检索到的前三条', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      title: `条目${i}`,
      content: `${i === 7 ? '游泳池开放到晚上十点。' : '这是一段无关的说明文字。'}${'内容'.repeat(100)}`,
    }));
    const { included, relevant } = retrieve(many, '游泳池几点关？');
    expect(included.length).toBeLessThanOrEqual(3);
    expect(relevant[0]?.title).toBe('条目7');
  });

  it('换上我们的系统提示（人设、口语规则、资料、转人工），保留对话历史', () => {
    const turn = planTurn(spec, [
      { role: 'system', content: 'LiveAvatar 的系统提示' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮您？' },
      { role: 'user', content: '早餐几点？' },
    ]);
    expect(turn.question).toBe('早餐几点？');
    expect(turn.sources).toEqual(['早餐时间']);
    expect(turn.messages).toHaveLength(4);
    const system = String(turn.messages[0]?.content);
    expect(system).toContain('你是山间民宿的前台。');
    expect(system).toContain('不超过 80 个字');
    expect(system).toContain('[1] 早餐时间：早餐在一楼餐厅');
    expect(system).toContain('只说这一句：「这个我帮您转给值班经理，请稍等。」');
    expect(system).not.toContain('LiveAvatar 的系统提示');
  });

  it('只碰巧有一两个字相同的不算引用', () => {
    const items = [...knowledge, { title: 'Wi-Fi', content: 'Wi-Fi 密码贴在房间门后。' }];
    expect(retrieve(items, '房间太吵了，我要退款。').relevant).toEqual([]);
  });

  it('识别转人工：忽略标点和空白', () => {
    expect(saidHandoff(spec, '好的。这个我帮您转给值班经理 请稍等')).toBe(true);
    expect(saidHandoff(spec, '早餐七点开始')).toBe(false);
  });

  it('从被拆开的 SSE 里读出回答和第一个字的时间', () => {
    let t = 100;
    const sniffer = createAnswerSniffer(() => t);
    sniffer.push('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"del');
    t = 150;
    sniffer.push('ta":{"content":"早餐"}}]}\n\n');
    t = 200;
    sniffer.push('data: {"choices":[{"delta":{"content":"七点"}}]}\n\ndata: [DONE]\n\n');
    expect(sniffer.answer()).toBe('早餐七点');
    expect(sniffer.firstAt()).toBe(150);
  });
});

describe('数字人大模型入口', () => {
  it('只认进行中会话的 Key；关掉思考、换上提示，流式转发并记下这一轮', async () => {
    const clock = () => new Date('2026-11-01T12:00:00Z');
    const runKeyRepo = memoryRunKeys();
    const runKeys = createRunKeyService({ repo: runKeyRepo });
    const sessions = memorySessions(clock);
    const billing = fakeMeter();
    const fake = fakeClient();
    const avatars = createAvatarService({
      client: fake.client,
      runKeys,
      repo: sessions,
      calls: billing.repo,
      meter: billing.meter,
      publicBaseUrl: 'https://oasis-dev.test/avatar/v1',
      model: 'deepseek/x',
      sandbox: true,
      creditMicro: 95_000,
      sweepMs: 60_000,
      logger,
    });
    const started = await avatars.start(PAYER, { spec });
    const avatarKey = fake.secrets.get('sec-1');
    const agentKey = (await runKeys.issue({ payerId: PAYER, runId: OTHER_RUN, ttlSeconds: 60 }))
      .key;

    const prepared: unknown[] = [];
    const chat = {
      prepare: async (input: { body: unknown }) => {
        prepared.push(input.body);
        return {};
      },
      open: async () => new Response(''),
      pump: async (_call: unknown, _res: unknown, write: (chunk: string) => void) => {
        write('data: {"choices":[{"delta":{"content":"早餐在一楼，"}}]}\n\n');
        write('data: {"choices":[{"delta":{"content":"七点开始。"}}]}\n\ndata: [DONE]\n\n');
      },
      finishJson: async () => ({}),
    } as unknown as ChatService;
    let t = 1000;
    const app = createAvatarLlmServer({
      logger,
      runKeys,
      chat,
      avatars,
      model: 'deepseek/fast',
      clock: () => (t += 50),
    });
    const post = (authorization?: string, url = AVATAR_COMPLETIONS_PATH) =>
      app.inject({
        method: 'POST',
        url,
        headers: authorization ? { authorization } : {},
        payload: {
          model: 'whatever',
          stream: true,
          max_completion_tokens: 4000,
          messages: [
            { role: 'system', content: 'x' },
            { role: 'user', content: '早餐几点？' },
          ],
        },
      });

    const ok = await post(`Bearer ${avatarKey}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('七点开始');
    expect(prepared[0]).toMatchObject({
      model: 'deepseek/fast',
      max_tokens: 400,
      reasoning: { enabled: false },
    });
    expect(prepared[0]).not.toHaveProperty('max_completion_tokens');
    const turns = sessions.rows.get(started.sessionId)?.turns ?? [];
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      question: '早餐几点？',
      answer: '早餐在一楼，七点开始。',
      sources: ['早餐时间'],
      handoff: false,
    });
    expect(turns[0]?.firstTokenMs).toBeGreaterThan(0);

    expect((await post(`Bearer ${agentKey}`)).statusCode).toBe(401);
    expect((await post()).statusCode).toBe(401);
    expect((await post(`Bearer ${avatarKey}`, '/run/v1/chat/completions')).statusCode).toBe(404);
    expect((await post(`Bearer ${avatarKey}`, '/internal/v1/chat/completions')).statusCode).toBe(
      404,
    );
    await avatars.stop(PAYER, started.sessionId);
    expect((await post(`Bearer ${avatarKey}`)).statusCode).toBe(401);
    await app.close();
  });
});
