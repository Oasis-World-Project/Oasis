import { Readable } from 'node:stream';
import type { EventEnvelope } from '@oasis/contracts/events';
import {
  checkedParts,
  createServiceClient,
  type ObjectStore,
  type HttpError,
} from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenRouterClient } from '../src/adapters/openrouter.ts';
import { createFalClient } from '../src/adapters/fal.ts';
import { createRenderClient } from '../src/adapters/runpod.ts';
import { createHash } from 'node:crypto';
import { createTavilyClient } from '../src/adapters/tavily.ts';
import type { Call, CallOutcome, CallsRepo } from '../src/repo/calls-repo.ts';
import { auditPolicy, runpodFixture } from './runpod-fixture.ts';
import type { ToolJob, ToolJobsRepo } from '../src/repo/tool-jobs-repo.ts';
import { createMeter } from '../src/service/metering.ts';
import { createToolService } from '../src/service/tool-service.ts';
import { registerRoutes } from '../src/api/routes.ts';

const PAYER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const TASK = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const HOLD = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const PNG = Buffer.from('fake-png').toString('base64');

const billingCalls: { path: string; body: Record<string, unknown> }[] = [];
let settleFails = false;
let renewFails = false;
const billing = Fastify();
billing.post('/internal/holds/:id/renew', async (_request, reply) =>
  reply.code(renewFails ? 409 : 204).send(),
);
billing.post('/internal/holds', async (request, reply) => {
  billingCalls.push({ path: 'hold', body: request.body as Record<string, unknown> });
  return reply.code(201).send({ holdId: HOLD, heldMicro: 1 });
});
billing.post('/internal/holds/:id/settle', async (request, reply) => {
  if (settleFails) return reply.code(503).send({ error: 'temporary' });
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
let visionStatus = 200;
let referenceLimit = 4;
let pageText = '# 正文';
const fake = Fastify();
fake.get('/api/v1/images/models/*', async (request) => ({
  endpoints: [
    {
      supported_parameters: {
        input_references: {
          type: 'range',
          max: request.url.includes('seedream') ? 0 : referenceLimit,
        },
      },
    },
  ],
}));
fake.post('/api/v1/chat/completions', async (request, reply) => {
  record('vision', request.body);
  if (visionStatus === 403 && (request.body as { model: string }).model === 'vision/first')
    return reply.code(403).send({ error: { message: 'not available in your region' } });
  return { choices: [{ message: { content: '图中有一只杯子。' } }], usage: { cost: 0.002 } };
});
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
let videoUsageCost: number | undefined = 0.5;
let videoFramesSupported = true;
let videoCentsPerSecond = '5';
let videoUsdTariff = true;
fake.get('/api/v1/videos/models', async () => ({
  data: [
    {
      id: 'alibaba/wan-2.7',
      supported_durations: Array.from({ length: 20 }, (_, i) => i + 1),
      supported_resolutions: ['480p', '720p', '1080p'],
      supported_aspect_ratios: ['16:9', '9:16'],
      supported_frame_images: videoFramesSupported ? ['first_frame'] : [],
      pricing_skus: {
        ...(videoUsdTariff
          ? { duration_seconds_720p: String(Number(videoCentsPerSecond) / 100) }
          : { cents_per_video_output_second_720p: videoCentsPerSecond }),
        cents_per_image_input: '1',
      },
    },
  ],
}));
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
    ? {
        id: 'vid-1',
        status: 'completed',
        ...(videoUsageCost === undefined ? {} : { usage: { cost: videoUsageCost } }),
      }
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
    results: [{ url: 'https://a.com', raw_content: pageText }],
    failed_results: [{ url: 'https://b.com', error: '超时' }],
  };
});

const finished: CallOutcome[] = [];
const recordedCalls = new Map<string, CallOutcome>();
const settled: EventEnvelope[] = [];
let blocked: string[] = [];
const repo: CallsRepo = {
  start: async () => {},
  get: async (id) => recordedCalls.get(id) as Call | undefined,
  regionBlockedModels: async () => blocked,
  async finish(id, outcome, event) {
    recordedCalls.set(id, outcome);
    finished.push(outcome);
    if (event) settled.push(event);
  },
};

const jobRows = new Map<string, ToolJob>();
const jobs: ToolJobsRepo = {
  renderWindowEnd: async () => 0,
  async cancelRun(runId, payerId, taskId) {
    for (const row of await this.forRun(runId)) {
      const caller = row.call.caller as { payerId: string; taskId?: string };
      if (caller.payerId !== payerId || (caller.taskId && caller.taskId !== taskId))
        throw new Error('Owner mismatch');
      await this.requestCancel(row.id);
    }
  },
  async mergeCall(id, patch) {
    const row = jobRows.get(id)!;
    row.call = { ...row.call, ...patch };
  },
  async requestCancel(id) {
    const row = jobRows.get(id);
    if (row?.status === 'pending') {
      row.call = { ...row.call, cancelRequested: true };
      row.phase = 'cancel_requested';
    }
  },
  forRun: async (runId) =>
    [...jobRows.values()].filter(
      (row) => row.status === 'pending' && (row.call.caller as { runId?: string })?.runId === runId,
    ),
  async insert(job) {
    if (job.requestKey && [...jobRows.values()].some((row) => row.requestKey === job.requestKey))
      return false;
    jobRows.set(job.id, {
      ...job,
      status: 'pending',
      phase: job.providerJobId ? 'pending' : 'submitting',
      result: null,
      cost: null,
      leaseToken: null,
      leaseUntil: null,
      expiresAt: null,
      error: null,
      createdAt: new Date(),
      finishedAt: null,
    });
    return true;
  },
  byRequest: async (key) => [...jobRows.values()].find((row) => row.requestKey === key),
  get: async (id) => jobRows.get(id),
  async update(id, patch) {
    Object.assign(jobRows.get(id)!, patch);
  },
  async claim(id, token, until) {
    const row = jobRows.get(id);
    if (!row || (row.leaseToken !== token && row.leaseUntil && row.leaseUntil > new Date()))
      return false;
    row.leaseToken = token;
    row.leaseUntil = until;
    return true;
  },
  async unlock(id, token) {
    const row = jobRows.get(id)!;
    if (row.leaseToken === token) {
      row.leaseToken = null;
      row.leaseUntil = null;
    }
  },
  pending: async () =>
    [...jobRows.values()].filter(
      (row) => row.status === 'pending' && (row.phase !== 'uncertain' || row.tool === '3d.render'),
    ),
  expired: async (now) =>
    [...jobRows.values()].filter(
      (row) => row.expiresAt && row.expiresAt < now && row.phase === 'completed',
    ),
  async finish(id, status, error) {
    const row = jobRows.get(id);
    if (!row) return false;
    jobRows.set(id, {
      ...row,
      status,
      phase: status,
      error: error ?? null,
      finishedAt: new Date(),
    });
    return true;
  },
};

const mediaFiles = new Map<string, Buffer>();
let renderCleanupFails = false;
const mediaStore: ObjectStore = {
  put: async (key, body) => {
    mediaFiles.set(key, body);
  },
  get: async (key) => mediaFiles.get(key)!,
  read: async (key) => Readable.from([mediaFiles.get(key)!]),
  delete: async (key) => {
    if (renderCleanupFails && key.startsWith('jobs/'))
      throw new Error('Temporary staging delete failure');
    mediaFiles.delete(key);
  },
  async putStream(key, source, _type, limits) {
    const parts = checkedParts(source, limits);
    const chunks: Buffer[] = [];
    for (;;) {
      const part = await parts.next();
      if (part.done) {
        mediaFiles.set(key, Buffer.concat(chunks));
        return part.value;
      }
      chunks.push(part.value);
    }
  },
};
let tools: ReturnType<typeof createToolService>;
let urls = { billing: '', fake: '' };
const falCalls: { url: string; input?: Record<string, unknown> }[] = [];
let falSubmitFails = false;
let geometryMode = false;
let geometryMalformed = false;
let geometryCancelled = false;
let geometryCancelCompleted = false;
const geometryImage = [
  {
    mediaType: 'image/png',
    base64: Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)]).toString(
      'base64',
    ),
  },
];
let renderSubmits = 0;
let renderTransfer = '';
let renderSubmitLost = false;
let renderAuditFixture = runpodFixture();
let renderStatus = 'COMPLETED';
const build = (
  tavilyKey: string | undefined,
  withMusic = false,
  withRender = false,
  withAudit = false,
  withMetering = false,
) => {
  const logger = pino({ level: 'silent' });
  return createToolService({
    render: withRender
      ? createRenderClient({
          baseUrl: 'https://api.runpod.ai/v2',
          controlBaseUrl: 'https://control.test/v2',
          auditPolicy: withAudit ? auditPolicy : undefined,
          ...(withMetering
            ? { metering: { microPerSecond: 373, startupCapSeconds: 90, idleSeconds: 5 } }
            : {}),
          now: renderAuditFixture.now,
          endpointId: 'fixture',
          apiKey: 'not-real',
          verified: true,
          holdMicro: 1000000,
          archive: mediaStore,
          staging: { ...mediaStore, sign: async (key) => 'https://example.test/' + key },
          fetcher: async (url, init) => {
            if (String(url).includes('/cancel/'))
              return Response.json({ id: 'gpu-one', status: 'CANCELLED' });
            if (init?.method === 'POST') {
              renderSubmits++;
              if (renderSubmitLost) throw new Error('Lost POST response');
              const body = JSON.parse(String(init.body)) as { input: { transferId: string } };
              renderTransfer = body.input.transferId;
              return Response.json({ id: 'gpu-one' });
            }
            if (withAudit && !String(url).includes('/status/'))
              return renderAuditFixture.fetcher(url, init);
            const artifact = (key: string) => ({
              size: mediaFiles.get(key)!.length,
              sha256: createHash('sha256').update(mediaFiles.get(key)!).digest('hex'),
            });
            const imageKey = `jobs/${renderTransfer}/image.png`,
              zipKey = `jobs/${renderTransfer}/project.zip`;
            mediaFiles.set(imageKey, Buffer.from('png-fixture'));
            mediaFiles.set(zipKey, Buffer.from('zip-fixture'));
            const output = {
              transferId: renderTransfer,
              artifacts: { image: artifact(imageKey), project: artifact(zipKey) },
              device: { gpuUsed: true },
              boundary: {
                filesystem: true,
                networkSocketsDenied: true,
                secretEnvironmentEmpty: true,
              },
            };
            if (withAudit) {
              renderAuditFixture.output = output;
              return renderAuditFixture.fetcher(url, init);
            }
            return Response.json({
              status: renderStatus,
              delayTime: 120400,
              executionTime: 3172,
              ...(renderStatus === 'COMPLETED' ? { output } : {}),
            });
          },
        })
      : undefined,
    fal: withMusic
      ? createFalClient({
          baseUrl: 'https://queue.fal.run',
          apiKey: 'test',
          mediaHosts: ['fal.media'],
          fetcher: async (input, init) => {
            const url = String(input);
            const body = init?.body
              ? (JSON.parse(String(init.body)) as Record<string, unknown>)
              : undefined;
            falCalls.push({ url, input: body });
            if (init?.method === 'PUT') {
              if (geometryCancelCompleted)
                return Response.json({ status: 'ALREADY_COMPLETED' }, { status: 400 });
              geometryCancelled = true;
              return new Response(null, { status: 202 });
            }
            if (init?.method === 'POST') {
              if (falSubmitFails) throw new Error('connection lost');
              return Response.json({
                request_id: 'music-one',
                status_url: 'https://queue.fal.run/fal-ai/minimax-music/requests/music-one/status',
                response_url: 'https://queue.fal.run/fal-ai/minimax-music/requests/music-one',
              });
            }
            if (url.endsWith('/status'))
              return Response.json({ status: geometryCancelled ? 'CANCELLED' : 'COMPLETED' });
            if (geometryMode) {
              if (!url.includes('fal.media'))
                return Response.json({ model_glb: { url: 'https://v3.fal.media/model.glb' } });
              const bytes = Buffer.alloc(24);
              bytes.write('glTF');
              bytes.writeUInt32LE(2, 4);
              bytes.writeUInt32LE(24, 8);
              bytes.writeUInt32LE(4, 12);
              bytes.writeUInt32LE(0x4e4f534a, 16);
              bytes.write('{}  ', 20);
              return new Response(geometryMalformed ? Buffer.from('invalid') : bytes);
            }
            if (url.includes('fal.media'))
              return new Response('ID3music', { headers: { 'content-type': 'audio/mpeg' } });
            return Response.json({ audio: { url: 'https://v3.fal.media/music.mp3' } });
          },
        })
      : undefined,
    openrouter: createOpenRouterClient({
      baseUrl: `${urls.fake}/api/v1`,
      decisionsUrl: `${urls.fake}/api/alpha/decisions`,
      apiKey: 'k',
    }),
    tavily: createTavilyClient({ baseUrl: `${urls.fake}/tavily`, apiKey: tavilyKey }),
    meter: createMeter({ billing: createServiceClient('billing', urls.billing), repo, logger }),
    jobs,
    store: mediaStore,
    jobTimeoutMs: 30 * 60_000,
    config: {
      musicModels: ['fal-ai/minimax-music/v2.6'],
      geometryModels: withMusic ? ['fal-ai/trellis-2'] : [],
      imageModels: ['bytedance-seed/seedream-4.5', 'openai/gpt-image-2'],
      visionModels: ['vision/first', 'vision/second'],
      visionMaxTokens: 2048,
      fetchMaxBytes: 200_000,
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
  renderAuditFixture = runpodFixture();
  renderCleanupFails = false;
  recordedCalls.clear();
  renderSubmits = 0;
  renderStatus = 'COMPLETED';
  renderTransfer = '';
  renderSubmitLost = false;
  geometryMode = false;
  geometryMalformed = false;
  geometryCancelled = false;
  geometryCancelCompleted = false;
  billingCalls.length = 0;
  settleFails = false;
  renewFails = false;
  falSubmitFails = false;
  falCalls.length = 0;
  mediaFiles.clear();
  upstream.length = 0;
  finished.length = 0;
  settled.length = 0;
  blocked = [];
  imageStatus = 200;
  visionStatus = 200;
  referenceLimit = 4;
  pageText = '# 正文';
  videoPolls = 0;
  videoEnd = 'completed';
  videoUsageCost = 0.5;
  videoFramesSupported = true;
  videoCentsPerSecond = '5';
  videoUsdTariff = true;
  jobRows.clear();
  tools = build('tvly-k');
});

describe('3D 生成复用长任务', () => {
  it('取消与完成竞争时取回已完成成果，不把 ALREADY_COMPLETED 当成终止确认', async () => {
    geometryMode = true;
    geometryCancelCompleted = true;
    tools = build('key', true);
    const id = (await call('3d.generate', { image: geometryImage })).job!.id;
    await tools.cancel({ payerId: PAYER }, id);
    await tools.close();
    expect(jobRows.get(id)?.status).toBe('completed');
    expect(billingCalls.map((r) => r.path)).toEqual(['hold', 'settle']);
  });
  it('只接受本地单图，未配置模型不启用；预算不足不提交', async () => {
    expect((await tools.list()).find((t) => t.key === '3d.generate')?.available).toBe(false);
    await expect(call('3d.generate', { image: geometryImage })).rejects.toMatchObject({
      statusCode: 503,
    });
    tools = build('key', true);
    await expect(
      call('3d.generate', { image_url: 'https://example.com/private' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      tools.call({
        caller: { payerId: PAYER },
        key: '3d.generate',
        args: { image: geometryImage },
        requestId: 'budget',
        signal: AbortSignal.timeout(1000),
        maxCostMicro: 1,
      }),
    ).rejects.toMatchObject({ code: 'call_budget_exceeded' });
    expect(falCalls).toHaveLength(0);
    expect(billingCalls).toHaveLength(0);
  });
  it('同请求只提交一次；结算中断从归档恢复，保留未知检查项', async () => {
    geometryMode = true;
    tools = build('key', true);
    const input = {
      caller: { payerId: PAYER, taskId: TASK },
      key: '3d.generate',
      args: { image: geometryImage },
      requestId: 'geometry',
      idempotencyKey: '00000000-0000-4000-8000-000000000077',
      signal: AbortSignal.timeout(5000),
    };
    const first = await tools.call(input),
      same = await tools.call(input);
    expect(first.job?.id).toBe(same.job?.id);
    expect(falCalls.filter((r) => r.input)).toHaveLength(1);
    expect(falCalls[0]?.input).toMatchObject({ resolution: 1024 });
    settleFails = true;
    await tools.job(input.caller, first.job!.id, AbortSignal.timeout(1000));
    expect(jobRows.get(first.job!.id)?.phase).toBe('stored');
    const count = falCalls.length;
    settleFails = false;
    tools = build('key', true);
    const done = await tools.job(input.caller, first.job!.id, AbortSignal.timeout(1000));
    expect(done.status).toBe('completed');
    expect(done.result?.files[0]).toMatchObject({ mediaType: 'model/gltf-binary', size: 24 });
    expect(done.result?.data).toMatchObject({
      unchecked: ['真实尺寸', '背面', '拓扑', '可打印性'],
    });
    expect(falCalls).toHaveLength(count);
    expect(billingCalls.filter((r) => r.path === 'settle')).toHaveLength(1);
  });
  it('坏 GLB 不归档结算，也不重新生成；原请求提交断连保留未知', async () => {
    geometryMode = true;
    geometryMalformed = true;
    tools = build('key', true);
    const id = (await call('3d.generate', { image: geometryImage })).job!.id;
    await tools.job({ payerId: PAYER }, id, AbortSignal.timeout(1000));
    expect(mediaFiles.size).toBe(0);
    expect(billingCalls.map((r) => r.path)).toEqual(['hold']);
    falSubmitFails = true;
    const unknown = (await call('3d.generate', { image: geometryImage })).job!.id;
    expect((await tools.job({ payerId: PAYER }, unknown, AbortSignal.timeout(1000))).status).toBe(
      'uncertain',
    );
    expect(falCalls.filter((r) => r.input)).toHaveLength(2);
  });
  it('取消意图持久化且检查归属；接受取消不等于费用可退回', async () => {
    geometryMode = true;
    tools = build('key', true);
    const id = (await call('3d.generate', { image: geometryImage }, TASK)).job!.id;
    await expect(tools.cancel({ payerId: PAYER, taskId: PAYER }, id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await tools.cancel({ payerId: PAYER, taskId: TASK }, id);
    await tools.close();
    expect(jobRows.get(id)?.call.cancelRequested).toBe(true);
    expect(jobRows.get(id)?.phase).toBe('uncertain');
    expect(geometryCancelled).toBe(true);
    expect(billingCalls.map((r) => r.path)).toEqual(['hold']);
  });
});

const call = (key: string, args: Record<string, unknown>, taskId?: string) =>
  tools.call({
    caller: { payerId: PAYER, ...(taskId ? { taskId } : {}) },
    key,
    args,
    requestId: 'r',
    signal: new AbortController().signal,
  });

describe('云渲染的准备、恢复、归档和对账', () => {
  const caller = { payerId: PAYER };
  const args = {
    scene: {
      version: 1,
      units: 'm',
      objects: [{ id: 'cube', kind: 'box', size: [1, 1, 1], position: [0, 0, 0] }],
      camera: { position: [3, 3, 3], target: [0, 0, 0] },
    },
    assets: [],
    render: { width: 128, height: 128, samples: 8, backend: 'CUDA' },
  };
  const pollRender = (id: string) => tools.job(caller, id, AbortSignal.timeout(2000));
  async function autoRender() {
    tools = build('key', false, true, true);
    const id = (await call('3d.render', args)).job!.id;
    await tools.submit(caller, id);
    return id;
  }
  async function billReady(id: string, status = 'COMPLETED') {
    renderAuditFixture.jobStatus = status;
    if (status === 'COMPLETED') renderAuditFixture.jobs.completed = 1;
    else renderAuditFixture.jobs.failed = 1;
    await pollRender(id);
    renderAuditFixture.advance(60000);
    await pollRender(id);
    renderAuditFixture.at('2026-10-28T10:16:00Z');
    renderAuditFixture.totalMicro = 12345;
    await pollRender(id);
    renderAuditFixture.advance(300000);
  }
  it('自动对账贯通归档、重启、结算失败恢复及补账；只扣一次且不重发 GPU', async () => {
    const id = await autoRender();
    await billReady(id);
    tools = build('key', false, true, true);
    settleFails = true;
    expect((await pollRender(id)).status).toBe('pending');
    expect(jobRows.get(id)?.cost?.costMicro).toBe(12345);
    settleFails = false;
    expect((await pollRender(id)).status).toBe('completed');
    expect(jobRows.get(id)?.result?.costMicro).toBe(12345);
    expect(billingCalls.filter((c) => c.path === 'settle')).toHaveLength(1);
    renderAuditFixture.totalMicro = 52345;
    renderAuditFixture.advance(300000);
    await pollRender(id);
    expect(jobRows.get(id)?.call.latePlatformRiskMicro).toBe(40000);
    expect(billingCalls.filter((c) => c.path === 'settle')).toHaveLength(1);
    expect(renderSubmits).toBe(1);
  });
  it('取消终态要等 worker 和账单证据；结算后清理失败重试也能完成且不重复扣款', async () => {
    const id = await autoRender();
    renderAuditFixture.jobStatus = 'CANCELLED';
    await tools.cancel(caller, id);
    await tools.close();
    expect(jobRows.get(id)?.status).toBe('pending');
    expect(billingCalls.some((c) => c.path === 'release')).toBe(false);
    await billReady(id, 'CANCELLED');
    renderCleanupFails = true;
    await pollRender(id);
    expect(jobRows.get(id)?.status).toBe('pending');
    expect(recordedCalls.get((jobRows.get(id)!.call as { id: string }).id)?.status).toBe('failed');
    renderCleanupFails = false;
    expect((await pollRender(id)).status).toBe('failed');
    expect(billingCalls.filter((c) => c.path === 'settle')).toHaveLength(1);
    expect(billingCalls.some((c) => c.path === 'release')).toBe(false);
  });
  it('未知提交在 TTL、停止和归属账单确认后自动终结，不重新提交', async () => {
    renderSubmitLost = true;
    const id = await autoRender();
    expect(jobRows.get(id)?.phase).toBe('uncertain');
    renderAuditFixture.jobs.failed = 1;
    renderAuditFixture.at('2026-10-28T09:40:00Z');
    await pollRender(id);
    renderAuditFixture.advance(60000);
    await pollRender(id);
    renderAuditFixture.at('2026-10-28T10:16:00Z');
    renderAuditFixture.totalMicro = 321;
    await pollRender(id);
    renderAuditFixture.advance(300000);
    expect((await pollRender(id)).status).toBe('failed');
    expect(billingCalls.find((c) => c.path === 'settle')?.body.costMicro).toBe(321);
    expect(renderSubmits).toBe(1);
  });
  it('证据已持久化但写成本中断，重启仍能结算；缺少基线的旧作业不会补造证据', async () => {
    const id = await autoRender();
    await billReady(id);
    const original = jobs.update;
    const spy = vi.spyOn(jobs, 'update').mockImplementation(async (key, patch) => {
      if (patch.cost) throw new Error('Crash before cost persistence');
      await original(key, patch);
    });
    try {
      await pollRender(id);
    } finally {
      spy.mockRestore();
    }
    expect(jobRows.get(id)?.cost).toBeNull();
    expect(jobRows.get(id)?.call.autoAudit).toMatchObject({ acceptedMicro: 12345 });
    tools = build('key', false, true, true);
    renderAuditFixture.advance(30000);
    expect((await pollRender(id)).status).toBe('completed');
    expect(billingCalls.filter((c) => c.path === 'settle')).toHaveLength(1);
    delete jobRows.get(id)!.call.autoAudit;
    const requests = renderAuditFixture.requests.length;
    await pollRender(id);
    expect(renderAuditFixture.requests).toHaveLength(requests);
  });
  it('冻结失效仍收集停机与完整费用，保留平台风险，不偷偷再次扣款或退款', async () => {
    const id = await autoRender();
    renewFails = true;
    await billReady(id, 'CANCELLED');
    await pollRender(id);
    expect(jobRows.get(id)?.call).toMatchObject({
      holdLost: true,
      platformRiskMicro: 12345,
      billingEvidence: { costMicro: 12345 },
    });
    expect(jobRows.get(id)?.cost).toBeNull();
    expect(billingCalls.filter((c) => c.path !== 'hold')).toEqual([]);
  });
  it('准备审计失败不提交 GPU，随后只重试原作业', async () => {
    tools = build('key', false, true, true);
    const id = (await call('3d.render', args)).job!.id;
    renderAuditFixture.activeWorkers = [{ id: 'other-worker', status: 'IDLE' }];
    await expect(tools.submit(caller, id)).rejects.toMatchObject({
      code: 'render_audit_not_ready',
    });
    expect(renderSubmits).toBe(0);
    expect(jobRows.get(id)?.phase).toBe('uploading');
    renderAuditFixture.activeWorkers = [];
    await tools.submit(caller, id);
    expect(renderSubmits).toBe(1);
  });
  it.each(['lease-lost', 'already-finished'])(
    '原提交进程恢复时 %s，不能迟到发起 GPU 请求',
    async (mode) => {
      tools = build('key', false, true, true);
      const id = (await call('3d.render', args)).job!.id;
      const original = jobs.claim;
      let claims = 0;
      const spy = vi.spyOn(jobs, 'claim').mockImplementation(async (key, token, until) => {
        claims++;
        if (claims === 2) {
          if (mode === 'lease-lost') {
            jobRows.get(id)!.leaseToken = 'another-process';
            return false;
          }
          await jobs.finish(id, 'failed');
        }
        return original(key, token, until);
      });
      try {
        await tools.submit(caller, id);
      } finally {
        spy.mockRestore();
      }
      expect(renderSubmits).toBe(0);
      if (mode === 'already-finished') expect(jobRows.get(id)?.phase).toBe('failed');
      else expect(jobRows.get(id)?.leaseToken).toBe('another-process');
    },
  );
  it('场景引用和灯光方向错误在冻结和 GPU 提交前拒绝', async () => {
    tools = build('key', false, true);
    for (const scene of [
      { ...args.scene, objects: [{ ...args.scene.objects[0], kind: 'asset', asset: 'missing' }] },
      { ...args.scene, lights: [{ position: [0, 0, 0] }] },
    ]) {
      await expect(call('3d.render', { ...args, scene })).rejects.toMatchObject({
        code: 'invalid_tool_args',
      });
    }
    expect(billingCalls).toEqual([]);
    expect(renderSubmits).toBe(0);
  });
  it('真实 HTTP 路由串接准备、二进制上传和幂等提交', async () => {
    tools = build('key', false, true);
    const app = Fastify({ loggerInstance: pino({ level: 'silent' }) });
    registerRoutes(app, {
      tools,
      runKeys: { authenticate: async () => caller },
      chat: {},
      compute: {},
      decisions: {},
      unavailableModels: async () => [],
    } as unknown as Parameters<typeof registerRoutes>[1]);
    try {
      const bytes = Buffer.from('uploaded mesh fixture'),
        sha256 = createHash('sha256').update(bytes).digest('hex');
      const prepared = await app.inject({
        method: 'POST',
        url: '/run/v1/tools/3d.render',
        payload: {
          args: {
            ...args,
            scene: {
              ...args.scene,
              assets: [{ id: 'a', path: 'assets/a.glb', origin: 'fixture', sha256 }],
            },
            assets: [{ id: 'a', size: bytes.length, sha256 }],
          },
        },
      });
      expect(prepared.statusCode).toBe(200);
      const id = prepared.json().job.id as string;
      const uploaded = await app.inject({
        method: 'PUT',
        url: `/run/v1/tools/jobs/${id}/inputs/0`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: bytes,
      });
      expect(uploaded.statusCode).toBe(200);
      expect(mediaFiles.get(`tool-inputs/${id}/0`)).toEqual(bytes);
      const submitted = await app.inject({
        method: 'POST',
        url: `/run/v1/tools/jobs/${id}/submit`,
        payload: {},
      });
      expect(submitted.statusCode).toBe(200);
      expect(renderSubmits).toBe(1);
    } finally {
      await app.close();
    }
  });
  it('先归档等待全成本证据；重启不重复生成，结算后回收暂存', async () => {
    tools = build('key', false, true);
    const id = (await call('3d.render', args)).job!.id;
    expect(jobRows.get(id)?.phase).toBe('uploading');
    expect(renderSubmits).toBe(0);
    await tools.submit(caller, id);
    await tools.submit(caller, id);
    expect(renderSubmits).toBe(1);
    const waiting = await tools.job(caller, id, AbortSignal.timeout(2000));
    expect(waiting).toMatchObject({ status: 'pending', phase: 'awaiting_cost' });
    expect(billingCalls.map((c) => c.path)).toEqual(['hold']);
    expect(jobRows.get(id)?.result?.files).toHaveLength(2);
    tools = build('key', false, true);
    settleFails = true;
    await expect(
      tools.reconcile(caller, id, { costMicro: 12345, billId: 'bill-line-one', stopped: true }),
    ).rejects.toThrow('结算未确认');
    expect(jobRows.get(id)?.phase).toBe('stored');
    settleFails = false;
    expect((await tools.job(caller, id, AbortSignal.timeout(2000))).status).toBe('completed');
    expect(jobRows.get(id)?.result?.costMicro).toBe(12345);
    expect(renderSubmits).toBe(1);
    expect([...mediaFiles.keys()].some((k) => k.startsWith('jobs/'))).toBe(false);
    expect(billingCalls.filter((c) => c.path === 'settle')).toHaveLength(1);
    await expect(tools.file({ payerId: TASK }, id, '0')).rejects.toMatchObject({ statusCode: 404 });
  });
  it('输入不齐不提交、坏摘要不保存；取消上传不调用 GPU', async () => {
    tools = build('key', false, true);
    const bytes = Buffer.from('mesh-data'),
      sha256 = createHash('sha256').update(bytes).digest('hex');
    const id = (
      await call('3d.render', {
        ...args,
        scene: {
          ...args.scene,
          assets: [{ id: 'asset', path: 'assets/a.glb', sha256, origin: 'authorized fixture' }],
        },
        assets: [{ id: 'asset', size: bytes.length, sha256 }],
      })
    ).job!.id;
    await expect(tools.submit(caller, id)).rejects.toMatchObject({ code: 'inputs_missing' });
    await expect(
      tools.upload(caller, id, '0', Readable.from([Buffer.from('bad')])),
    ).rejects.toThrow();
    await tools.upload(caller, id, '0', Readable.from([bytes]));
    await tools.cancel(caller, id);
    await tools.close();
    expect(jobRows.get(id)?.status).toBe('failed');
    expect(renderSubmits).toBe(0);
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'release']);
  });
  it('按 GPU 回执计量即时结算并交付：执行秒 + 封顶启动秒 + 空闲秒，只扣一次', async () => {
    tools = build('key', false, true, false, true);
    const id = (await call('3d.render', args)).job!.id;
    await tools.submit(caller, id);
    const done = await tools.job(caller, id, AbortSignal.timeout(2000));
    expect(done.status).toBe('completed');
    // ceil(3.172)=4 + min(ceil(120.4)=121, 90) + 5 = 99 s × 373
    expect(billingCalls.filter((c) => c.path === 'settle').map((c) => c.body.costMicro)).toEqual([
      36927,
    ]);
    expect(jobRows.get(id)?.result?.data).toMatchObject({
      gpuBilling: { billedSeconds: 99, microPerSecond: 373 },
    });
    await tools.job(caller, id, AbortSignal.timeout(2000));
    expect(billingCalls.filter((c) => c.path === 'settle')).toHaveLength(1);
    expect(renderSubmits).toBe(1);
  });
  it('计量模式下 GPU 失败不向用户扣款，退回冻结', async () => {
    tools = build('key', false, true, false, true);
    renderStatus = 'FAILED';
    const id = (await call('3d.render', args)).job!.id;
    await tools.submit(caller, id);
    const done = await tools.job(caller, id, AbortSignal.timeout(2000));
    expect(done.status).toBe('failed');
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'release']);
    renderStatus = 'COMPLETED';
  });
  it('提交断连保留未知且不重发；终态成本超过冻结的部分记平台风险', async () => {
    tools = build('key', false, true);
    renderSubmitLost = true;
    const id = (await call('3d.render', args)).job!.id;
    await tools.submit(caller, id);
    await tools.submit(caller, id);
    expect(renderSubmits).toBe(1);
    expect(jobRows.get(id)?.phase).toBe('uncertain');
    await tools.reconcile(caller, id, { costMicro: 1500000, billId: 'risk-line', stopped: true });
    expect(jobRows.get(id)?.status).toBe('failed');
    expect(jobRows.get(id)?.call.platformRiskMicro).toBe(500000);
    expect(billingCalls.find((c) => c.path === 'settle')?.body.costMicro).toBe(1000000);
  });
});
const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as HttpError,
  );

const reference = {
  mediaType: 'image/png',
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=',
};
describe('文件场景工具', () => {
  it('参考图仅发送给能力目录确认支持的模型，保留 data URL', async () => {
    await call('image.generate', { prompt: '换背景', references: [reference] });
    expect(upstream[0]?.body).toMatchObject({
      model: 'openai/gpt-image-2',
      input_references: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${reference.base64}` } },
      ],
      provider: { require_parameters: true },
    });
  });
  it('不支持参考图、数量太多和签名不符均在冻结前拒绝', async () => {
    referenceLimit = 0;
    await expect(
      call('image.generate', { prompt: 'x', references: [reference] }),
    ).rejects.toMatchObject({ code: 'reference_images_unsupported' });
    for (const images of [Array(5).fill(reference), [{ ...reference, base64: PNG }]]) {
      await expect(call('image.inspect', { question: 'x', images })).rejects.toMatchObject({
        code: 'invalid_tool_args',
      });
    }
    expect(billingCalls).toEqual([]);
    expect(upstream).toEqual([]);
  });
  it('大图片校验不递归溢出，总字节数超限在冻结前拒绝', async () => {
    const bytes = Buffer.alloc(6 * 1024 * 1024);
    Buffer.from(reference.base64, 'base64').copy(bytes);
    const large = { ...reference, base64: bytes.toString('base64') };
    // 不支持参考图会在校验之后拒绝，避免把大请求发往假 HTTP 服务。
    referenceLimit = 0;
    await expect(
      call('image.generate', { prompt: 'x', references: [large] }),
    ).rejects.toMatchObject({ code: 'reference_images_unsupported' });
    await expect(
      call('image.inspect', { question: 'x', images: Array(4).fill(large) }),
    ).rejects.toMatchObject({ code: 'invalid_tool_args' });
    expect(billingCalls).toEqual([]);
  });
  it('看图按实际费用结算并归属任务；明确地区拒绝才自动换模型', async () => {
    visionStatus = 403;
    const result = await call('image.inspect', { images: [reference], question: '是什么？' }, TASK);
    expect(result.text).toContain('杯子');
    expect(upstream.map((r) => r.body.model)).toEqual(['vision/first', 'vision/second']);
    expect(upstream[1]?.body).toMatchObject({
      max_tokens: 2048,
      messages: [{ role: 'user', content: [{ type: 'text' }, { type: 'image_url' }] }],
    });
    expect(billingCalls.map((r) => r.path)).toEqual(['hold', 'release', 'hold', 'settle']);
    expect(settled[0]).toMatchObject({ data: { taskId: TASK, kind: 'tool', chargedMicro: 2000 } });
  });
  it('网页全文不截断，保留来源与失败信息；超限明确失败', async () => {
    pageText = '研究资料'.repeat(10_000);
    const result = await call('web.fetch', { urls: ['https://a.com'], format: 'files' });
    expect(Buffer.from(result.files[0]!.base64, 'base64').toString()).toContain(pageText);
    expect(result.text.length).toBeLessThan(300);
    expect(result.files[0]!.name).toMatch(/^1-[a-f0-9]{12}\.md$/);
    expect(result.data).toMatchObject({ failed: [{ url: 'https://b.com' }] });
    pageText = '汉'.repeat(100_000);
    await expect(
      call('web.fetch', { urls: ['https://a.com'], format: 'files' }),
    ).rejects.toMatchObject({ code: 'web_content_too_large' });
  });
  it('单行预算在冻结和供应商调用前检查', async () => {
    await expect(
      tools.call({
        caller: { payerId: PAYER },
        key: 'jev.decide',
        args: { question: '好不好' },
        maxCostMicro: 1,
        requestId: 'r',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'call_budget_exceeded' });
    expect(billingCalls).toEqual([]);
    expect(upstream).toEqual([]);
  });
});

describe('工具目录', () => {
  it('列出全部工具；没配 Key 的、模型都用不了的标成不可用；默认模型跳过用不了的', async () => {
    blocked = ['bytedance-seed/seedream-4.5'];
    const list = await build(undefined).list();
    const byKey = Object.fromEntries(list.map((t) => [t.key, t]));
    expect(Object.keys(byKey)).toEqual([
      '3d.render',
      '3d.generate',
      'image.generate',
      'image.inspect',
      'audio.speech',
      'audio.transcribe',
      'web.search',
      'web.fetch',
      'audio.music',
      'video.generate',
      'jev.decide',
      'text.batch',
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
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'release', 'hold', 'release']);
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
    tools.job({ payerId, taskId: TASK }, id, new AbortController().signal);

  it('供应商不回费用时使用持久化的时长/模型报价，重建服务不会变成固定短镜头价格', async () => {
    videoUsageCost = undefined;
    const submitted = await call('video.generate', { prompt: 'x', duration: 20 }, TASK);
    const id = submitted.job!.id;
    expect(jobRows.get(id)?.call.videoEstimateMicro).toBe(1_000_000);
    // 之后目录变价也不改变原报价；新的工具服务只从同一持久作业取回结果。
    videoCentsPerSecond = '20';
    tools = build('tvly-k');
    const done = await job(id);
    expect(done.result?.costMicro).toBe(1_000_000);
    expect(billingCalls.at(-1)?.body.costMicro).toBe(1_000_000);
    await job(id);
    expect(billingCalls.filter((x) => x.path === 'settle')).toHaveLength(1);
  });

  it('私有首帧以内联图像传给供应商；不支持时在冻结前拒绝，不能退化为文生视频', async () => {
    const base64 = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex').toString(
      'base64',
    );
    const args = {
      prompt: '保持原商品，镜头缓慢推进',
      first_frame: [{ mediaType: 'image/png', base64 }],
    };
    videoFramesSupported = false;
    expect((await errorOf(call('video.generate', args)))?.code).toBe(
      'video_parameters_unsupported',
    );
    expect(billingCalls).toHaveLength(0);
    expect(upstream).toHaveLength(0);
    videoFramesSupported = true;
    const result = await call('video.generate', args, TASK);
    expect(result.job).toBeDefined();
    expect(upstream[0]?.body.frame_images).toEqual([
      {
        type: 'image_url',
        frame_type: 'first_frame',
        image_url: { url: `data:image/png;base64,${base64}` },
      },
    ]);
  });

  it('参数和价格预检失败不冻结；高价模型冻结覆盖实时目录而非固定单价', async () => {
    expect((await errorOf(call('video.generate', { prompt: 'x', duration: 21 })))?.statusCode).toBe(
      400,
    );
    expect((await errorOf(call('video.generate', { prompt: 'x', resolution: '768p' })))?.code).toBe(
      'video_parameters_unsupported',
    );
    expect(billingCalls).toHaveLength(0);
    videoCentsPerSecond = '50';
    videoUsdTariff = false;
    await call('video.generate', { prompt: 'x', duration: 6 });
    expect(billingCalls[0]?.body.amountMicro).toBe(3_000_000);
  });

  it('提交时冻结（留够时间）并交回任务号；做好前是 pending；做好后按实际花费结算一次', async () => {
    videoPolls = 1;
    const submitted = await call('video.generate', { prompt: '木屋的清晨', duration: '6' }, TASK);
    const id = submitted.job?.id ?? '';
    expect(submitted).toMatchObject({ tool: 'video.generate', costMicro: 0, files: [] });
    expect(upstream[0]).toEqual({
      path: 'video',
      body: { model: 'alibaba/wan-2.7', prompt: '木屋的清晨', duration: 6, resolution: '720p' },
    });
    expect(billingCalls[0]?.body).toMatchObject({ amountMicro: 1_500_000, ttlMs: 40 * 60_000 });

    expect(await job(id)).toEqual({ status: 'pending' });
    const done = await job(id);
    expect(done).toMatchObject({
      status: 'completed',
      result: { costMicro: 500_000, files: [{ name: 'video.mp4', mediaType: 'video/mp4' }] },
    });
    const file = await tools.file({ payerId: PAYER, taskId: TASK }, id, done.result!.files[0]!.id!);
    const chunks: Buffer[] = [];
    for await (const chunk of file.content) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('mp4');
    videoPolls = 99;
    videoEnd = 'failed';
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

  it('等太久：保留未确认状态，不自动退回或重发', async () => {
    videoPolls = 99;
    const id = (await call('video.generate', { prompt: 'x' })).job?.id ?? '';
    const row = jobRows.get(id)!;
    jobRows.set(id, { ...row, createdAt: new Date(Date.now() - 31 * 60_000) });
    expect(await job(id)).toMatchObject({
      status: 'uncertain',
      error: expect.stringContaining('费用待核对'),
    });
    expect(billingCalls.map((c) => c.path)).toEqual(['hold']);
  });

  it('别人的任务号：查不到', async () => {
    const id = (await call('video.generate', { prompt: 'x' })).job?.id ?? '';
    expect((await errorOf(job(id, TASK)))?.statusCode).toBe(404);
  });
});

describe('音乐长任务', () => {
  it('提交尚在途时查询保持 pending，只有遗留提交才转为未确认且不重发', async () => {
    tools = build('key', true);
    const id = '00000000-0000-4000-8000-000000000097';
    await jobs.insert({
      id,
      tool: 'audio.music',
      providerJobId: '',
      requestKey: null,
      requestHash: 'test',
      call: { caller: { payerId: PAYER, taskId: TASK } },
    });
    expect(
      await tools.job({ payerId: PAYER, taskId: TASK }, id, AbortSignal.timeout(1000)),
    ).toEqual({ status: 'pending' });
    jobRows.get(id)!.createdAt = new Date(Date.now() - 121_000);
    expect(
      await tools.job({ payerId: PAYER, taskId: TASK }, id, AbortSignal.timeout(1000)),
    ).toMatchObject({ status: 'uncertain' });
    expect(falCalls).toEqual([]);
    expect(billingCalls).toEqual([]);
  });
  it('相同幂等键的并发提交只生成一次，重复冻结退回，改参数不能复用键', async () => {
    tools = build('key', true);
    const input = {
      caller: { payerId: PAYER, taskId: TASK },
      key: 'audio.music',
      args: { prompt: 'A complete instrumental with a warm ending', instrumental: true },
      requestId: 'test',
      idempotencyKey: '00000000-0000-4000-8000-000000000098',
      signal: AbortSignal.timeout(5000),
    };
    const [first, second] = await Promise.all([tools.call(input), tools.call(input)]);
    expect(first.job?.id).toBe(second.job?.id);
    expect(falCalls.filter((call) => call.input)).toHaveLength(1);
    await tools.job(input.caller, first.job!.id, AbortSignal.timeout(1000));
    expect(billingCalls.filter((call) => call.path === 'settle')).toHaveLength(1);
    await expect(
      tools.call({
        ...input,
        args: { ...input.args, prompt: 'Different complete instrumental song' },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it('器乐与歌词参数明确；结果保存后进程重建不再调供应商，其他任务不能访问', async () => {
    tools = build('key', true);
    const id = (
      await call(
        'audio.music',
        { prompt: 'Warm piano and strings with a complete ending', instrumental: 'true' },
        TASK,
      )
    ).job!.id;
    expect(falCalls[0]?.input).toMatchObject({ is_instrumental: true, lyrics: '' });
    expect(falCalls[0]?.input).toMatchObject({
      audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
    });
    const done = await tools.job({ payerId: PAYER, taskId: TASK }, id, AbortSignal.timeout(1000));
    expect(done.status).toBe('completed');
    expect(done.result?.files[0]).toMatchObject({ id: '0', size: 8 });
    const count = falCalls.length;
    await tools.close();
    tools = build('key', true);
    expect(
      (await tools.job({ payerId: PAYER, taskId: TASK }, id, AbortSignal.timeout(1000))).status,
    ).toBe('completed');
    expect(falCalls).toHaveLength(count);
    expect(billingCalls.map((call) => call.path)).toEqual(['hold', 'settle']);
    await expect(tools.file({ payerId: PAYER, taskId: PAYER }, id, '0')).rejects.toMatchObject({
      statusCode: 404,
    });
    const missing = await errorOf(
      call('audio.music', {
        prompt: 'A complete vocal song with accompaniment',
        instrumental: 'false',
      }),
    );
    expect(missing?.code).toBe('invalid_tool_args');
    const song = await call('audio.music', {
      prompt: 'A complete vocal song with accompaniment',
      instrumental: 'false',
      lyrics: '[Verse] 测试歌词',
    });
    expect(song.job).toBeTruthy();
    expect(falCalls.at(-1)?.input).toMatchObject({
      is_instrumental: false,
      lyrics: '[Verse] 测试歌词',
    });
  });
  it('提交断连不重新提交；结算失败从已存文件继续而不重新生成或下载', async () => {
    tools = build('key', true);
    falSubmitFails = true;
    const unknown = (
      await call('audio.music', {
        prompt: 'A warm instrumental track with a soft ending',
        instrumental: true,
      })
    ).job!.id;
    expect((await tools.job({ payerId: PAYER }, unknown, AbortSignal.timeout(1000))).status).toBe(
      'uncertain',
    );
    expect(falCalls).toHaveLength(1);
    expect(billingCalls.map((call) => call.path)).toEqual(['hold']);
    falSubmitFails = false;
    settleFails = true;
    const id = (
      await call('audio.music', {
        prompt: 'A warm instrumental track with a soft ending',
        instrumental: true,
      })
    ).job!.id;
    expect((await tools.job({ payerId: PAYER }, id, AbortSignal.timeout(1000))).status).toBe(
      'pending',
    );
    expect(jobRows.get(id)?.phase).toBe('stored');
    const count = falCalls.length;
    settleFails = false;
    tools = build('key', true);
    expect((await tools.job({ payerId: PAYER }, id, AbortSignal.timeout(1000))).status).toBe(
      'completed',
    );
    expect(falCalls).toHaveLength(count);
  });
});
