import type { EventEnvelope } from '@oasis/contracts/events';
import { createServiceClient, type HttpError } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOpenRouterClient } from '../src/adapters/openrouter.ts';
import { createTavilyClient } from '../src/adapters/tavily.ts';
import type { CallOutcome, CallsRepo } from '../src/repo/calls-repo.ts';
import type { ToolJob, ToolJobsRepo } from '../src/repo/tool-jobs-repo.ts';
import { createMeter } from '../src/service/metering.ts';
import { createToolService } from '../src/service/tool-service.ts';

const PAYER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const TASK = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const HOLD = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const PNG = Buffer.from('fake-png').toString('base64');

const billingCalls: { path: string; body: Record<string, unknown> }[] = [];
const billing = Fastify();
billing.post('/internal/holds', async (request, reply) => {
  billingCalls.push({ path: 'hold', body: request.body as Record<string, unknown> });
  return reply.code(201).send({ holdId: HOLD, heldMicro: 1 });
});
billing.post('/internal/holds/:id/settle', async (request) => {
  billingCalls.push({ path: 'settle', body: request.body as Record<string, unknown> });
  return { chargedMicro: (request.body as { costMicro: number }).costMicro };
});
billing.post('/internal/holds/:id/release', async (_request, reply) => {
  billingCalls.push({ path: 'release', body: {} });
  return reply.code(204).send();
});

/** 假的 OpenRouter（生图、配音、查花费、转写、决策）和 Tavily */
const upstream: { path: string; body: Record<string, unknown> }[] = [];
let imageStatus = 200;
const fake = Fastify();
fake.addContentTypeParser('*', (_req, _body, done) => done(null, {}));
const record = (path: string, body: unknown) =>
  upstream.push({ path, body: body as Record<string, unknown> });
fake.post('/api/v1/images', async (request, reply) => {
  record('images', request.body);
  if (imageStatus === 403) {
    return reply
      .code(403)
      .send({ error: { message: 'This model is not available in your region.' } });
  }
  return { data: [{ b64_json: PNG, media_type: 'image/png' }], usage: { cost: 0.04 } };
});
fake.post('/api/v1/audio/speech', async (request, reply) => {
  record('speech', request.body);
  return reply.header('x-generation-id', 'gen-1').type('audio/mpeg').send(Buffer.from('mp3'));
});
fake.get('/api/v1/generation', async () => ({ data: { total_cost: 0.0021 } }));
fake.post('/api/v1/audio/transcriptions', async (request) => {
  record('transcribe', request.body);
  return { text: '你好，欢迎来到小木屋。' };
});
/** 假的视频接口：前 videoPolls 次查询还在做，之后按 videoEnd 结束 */
let videoPolls = 0;
let videoEnd: 'completed' | 'failed' = 'completed';
fake.post('/api/v1/videos', async (request, reply) => {
  record('video', request.body);
  return reply
    .code(202)
    .send({ id: 'vid-1', polling_url: '/api/v1/videos/vid-1', status: 'pending' });
});
fake.get('/api/v1/videos/:id', async () => {
  if (videoPolls > 0) {
    videoPolls -= 1;
    return { id: 'vid-1', status: 'in_progress' };
  }
  return videoEnd === 'completed'
    ? { id: 'vid-1', status: 'completed', usage: { cost: 0.5 } }
    : { id: 'vid-1', status: 'failed', error: '内容不合规' };
});
fake.get('/api/v1/videos/:id/content', async (_request, reply) =>
  reply.type('video/mp4').send(Buffer.from('mp4')),
);
fake.post('/api/alpha/decisions', async (request) => {
  record('decide', request.body);
  return {
    answers: { q: { type: 'choice', choice: '标题B', probabilities: { 标题A: 0.2, 标题B: 0.8 } } },
    usage: { input_tokens: 50, output_tokens: 1, cost: 0.000002 },
  };
});
fake.post('/tavily/search', async (request) => {
  record('search', request.body);
  return {
    query: 'q',
    results: [{ title: '小木屋民宿', url: 'https://a.com', content: '山里的   木屋', score: 0.9 }],
    usage: { credits: 1 },
  };
});
fake.post('/tavily/extract', async (request) => {
  record('extract', request.body);
  return {
    results: [{ url: 'https://a.com', raw_content: '# 正文' }],
    failed_results: [{ url: 'https://b.com', error: '超时' }],
  };
});

const finished: CallOutcome[] = [];
const settled: EventEnvelope[] = [];
let blocked: string[] = [];
const repo: CallsRepo = {
  start: async () => {},
  get: async () => undefined,
  regionBlockedModels: async () => blocked,
  async finish(_id, outcome, event) {
    finished.push(outcome);
    if (event) settled.push(event);
  },
};

const jobRows = new Map<string, ToolJob>();
const jobs: ToolJobsRepo = {
  async insert(job) {
    jobRows.set(job.id, {
      ...job,
      status: 'pending',
      error: null,
      createdAt: new Date(),
      finishedAt: null,
    });
  },
  get: async (id) => jobRows.get(id),
  async finish(id, status, error) {
    const row = jobRows.get(id);
    if (row?.status !== 'pending') return false;
    jobRows.set(id, { ...row, status, error: error ?? null, finishedAt: new Date() });
    return true;
  },
};

let tools: ReturnType<typeof createToolService>;
let urls = { billing: '', fake: '' };
const build = (tavilyKey: string | undefined) => {
  const logger = pino({ level: 'silent' });
  return createToolService({
    openrouter: createOpenRouterClient({
      baseUrl: `${urls.fake}/api/v1`,
      decisionsUrl: `${urls.fake}/api/alpha/decisions`,
      apiKey: 'k',
    }),
    tavily: createTavilyClient({ baseUrl: `${urls.fake}/tavily`, apiKey: tavilyKey }),
    meter: createMeter({ billing: createServiceClient('billing', urls.billing), repo, logger }),
    jobs,
    jobTimeoutMs: 30 * 60_000,
    config: {
      imageModels: ['bytedance-seed/seedream-4.5', 'openai/gpt-image-2'],
      videoModels: ['alibaba/wan-2.7'],
      speechModels: ['bytedance-seed/seed-audio-1-0'],
      transcribeModels: ['openai/whisper-large-v3'],
      jevModel: 'typesafe/jev-1.14',
      tavilyCreditMicro: 8_000,
      speechMicroPerChar: 20,
    },
    logger,
  });
};
beforeAll(async () => {
  urls = {
    billing: await billing.listen({ port: 0, host: '127.0.0.1' }),
    fake: await fake.listen({ port: 0, host: '127.0.0.1' }),
  };
});
afterAll(async () => {
  await billing.close();
  await fake.close();
});
beforeEach(() => {
  billingCalls.length = 0;
  upstream.length = 0;
  finished.length = 0;
  settled.length = 0;
  blocked = [];
  imageStatus = 200;
  videoPolls = 0;
  videoEnd = 'completed';
  jobRows.clear();
  tools = build('tvly-k');
});

const call = (key: string, args: Record<string, unknown>, taskId?: string) =>
  tools.call({
    caller: { payerId: PAYER, ...(taskId ? { taskId } : {}) },
    key,
    args,
    requestId: 'r',
    signal: new AbortController().signal,
  });
const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as HttpError,
  );

describe('工具目录', () => {
  it('列出全部工具；没配 Key 的、模型都用不了的标成不可用；默认模型跳过用不了的', async () => {
    blocked = ['bytedance-seed/seedream-4.5'];
    const list = await build(undefined).list();
    const byKey = Object.fromEntries(list.map((t) => [t.key, t]));
    expect(Object.keys(byKey)).toEqual([
      'image.generate',
      'audio.speech',
      'audio.transcribe',
      'web.search',
      'web.fetch',
      'video.generate',
      'jev.decide',
    ]);
    expect(byKey['image.generate']).toMatchObject({
      available: true,
      models: ['openai/gpt-image-2'],
      defaultModel: 'openai/gpt-image-2',
    });
    expect(byKey['web.search']?.available).toBe(false);
    blocked = ['typesafe/jev-1.14'];
    expect((await build('k').list()).find((t) => t.key === 'jev.decide')?.available).toBe(false);
  });
});

describe('调用工具', () => {
  it('生图：冻结 → 调 OpenRouter → 按实际花费结算；交回图片文件；属于任务的发结算事件', async () => {
    const result = await call(
      'image.generate',
      { prompt: '山里的小木屋', aspect_ratio: '16:9', n: '1' },
      TASK,
    );
    expect(result).toMatchObject({
      tool: 'image.generate',
      costMicro: 40_000,
      files: [{ name: 'image-1.png', mediaType: 'image/png', base64: PNG }],
    });
    expect(upstream[0]).toEqual({
      path: 'images',
      body: {
        model: 'bytedance-seed/seedream-4.5',
        prompt: '山里的小木屋',
        n: 1,
        output_format: 'png',
        aspect_ratio: '16:9',
      },
    });
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'settle']);
    expect(billingCalls[0]?.body).toMatchObject({ amountMicro: 200_000 });
    expect(settled[0]).toMatchObject({
      data: { kind: 'tool', taskId: TASK, chargedMicro: 40_000 },
    });
  });

  it('参数不对、模型不在可选里、工具不存在：调供应商之前就拒绝，不冻结', async () => {
    expect((await errorOf(call('image.generate', {})))?.statusCode).toBe(400);
    expect(
      (await errorOf(call('image.generate', { prompt: 'x', model: 'x/y' })))?.message,
    ).toContain('不能用模型 x/y');
    expect((await errorOf(call('nope', {})))?.statusCode).toBe(404);
    expect(billingCalls).toHaveLength(0);
  });

  it('供应商说地区用不了：退回冻结，给出能看懂的原因', async () => {
    imageStatus = 403;
    const err = await errorOf(call('image.generate', { prompt: 'x' }));
    expect(err?.code).toBe('provider_region_unavailable');
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'release']);
  });

  it('配音：交回 MP3；花费按生成 ID 去查', async () => {
    const result = await call('audio.speech', { text: '欢迎来到小木屋' });
    expect(result).toMatchObject({
      costMicro: 2_100,
      files: [{ name: 'speech.mp3', mediaType: 'audio/mpeg' }],
    });
    expect(Buffer.from(result.files[0]!.base64, 'base64').toString()).toBe('mp3');
    expect(upstream[0]?.body).toMatchObject({
      model: 'bytedance-seed/seed-audio-1-0',
      response_format: 'mp3',
    });
  });

  it('转写：把录音交给转写模型，交回文字', async () => {
    const result = await call('audio.transcribe', {
      audio_base64: 'AAA',
      format: 'mp3',
      language: 'zh',
    });
    expect(result.text).toBe('你好，欢迎来到小木屋。');
    expect(upstream[0]?.body).toEqual({
      model: 'openai/whisper-large-v3',
      input_audio: { data: 'AAA', format: 'mp3' },
      language: 'zh',
    });
  });

  it('联网搜索和读取网页：按 Tavily 的积分算钱；读不到的网页写明原因', async () => {
    const search = await call('web.search', { query: '小木屋民宿 设计' });
    expect(search.text).toBe('1. 小木屋民宿\n   https://a.com\n   山里的 木屋');
    expect(search.costMicro).toBe(8_000);
    expect(upstream[0]?.body).toMatchObject({
      query: '小木屋民宿 设计',
      max_results: 5,
      search_depth: 'basic',
    });
    const page = await call('web.fetch', { urls: ['https://a.com', 'https://b.com'] });
    expect(page.text).toContain('## https://a.com\n\n# 正文');
    expect(page.text).toContain('（没读到：超时）');
    expect(page.costMicro).toBe(8_000);
  });

  it('Jev 判断：给选项就是选一个，交回各选项的概率', async () => {
    const result = await call('jev.decide', {
      question: '哪个标题更好',
      options: ['标题A', '标题B'],
    });
    expect(result.data).toMatchObject({ choice: '标题B' });
    expect(upstream[0]?.body).toEqual({
      model: 'typesafe/jev-1.14',
      state: ['哪个标题更好'],
      questions: {
        q: {
          type: 'choice',
          instructions: '哪个标题更好',
          criteria: { 标题A: '标题A', 标题B: '标题B' },
        },
      },
    });
  });

  it('没配 Key 的工具：503', async () => {
    tools = build(undefined);
    expect((await errorOf(call('web.search', { query: 'x' })))?.code).toBe('tool_unavailable');
  });
});

describe('长任务（视频）', () => {
  const job = (id: string, payerId = PAYER) =>
    tools.job({ payerId }, id, new AbortController().signal);

  it('提交时冻结（留够时间）并交回任务号；做好前是 pending；做好后按实际花费结算一次', async () => {
    videoPolls = 1;
    const submitted = await call('video.generate', { prompt: '木屋的清晨', duration: '6' }, TASK);
    const id = submitted.job?.id ?? '';
    expect(submitted).toMatchObject({ tool: 'video.generate', costMicro: 0, files: [] });
    expect(upstream[0]).toEqual({
      path: 'video',
      body: { model: 'alibaba/wan-2.7', prompt: '木屋的清晨', duration: 6 },
    });
    expect(billingCalls[0]?.body).toMatchObject({ amountMicro: 1_500_000, ttlMs: 40 * 60_000 });

    expect(await job(id)).toEqual({ status: 'pending' });
    const done = await job(id);
    expect(done).toMatchObject({
      status: 'completed',
      result: { costMicro: 500_000, files: [{ name: 'video.mp4', mediaType: 'video/mp4' }] },
    });
    expect(Buffer.from(done.result!.files[0]!.base64, 'base64').toString()).toBe('mp4');
    expect(settled[0]).toMatchObject({
      data: { kind: 'tool', taskId: TASK, chargedMicro: 500_000 },
    });

    // 再取一次：照样交回结果，但不再结算
    expect((await job(id)).status).toBe('completed');
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'settle']);
  });

  it('供应商说失败：退回冻结；之后再问也是失败', async () => {
    videoEnd = 'failed';
    const id = (await call('video.generate', { prompt: 'x' })).job?.id ?? '';
    const result = await job(id);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('内容不合规');
    expect((await job(id)).status).toBe('failed');
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'release']);
  });

  it('等太久：算失败并退回', async () => {
    videoPolls = 99;
    const id = (await call('video.generate', { prompt: 'x' })).job?.id ?? '';
    const row = jobRows.get(id)!;
    jobRows.set(id, { ...row, createdAt: new Date(Date.now() - 31 * 60_000) });
    expect(await job(id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('30 分钟'),
    });
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'release']);
  });

  it('别人的任务号：查不到', async () => {
    const id = (await call('video.generate', { prompt: 'x' })).job?.id ?? '';
    expect((await errorOf(job(id, TASK)))?.statusCode).toBe(404);
  });
});
