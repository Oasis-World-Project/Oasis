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
import { createBrowserStackClient } from '../src/adapters/browserstack.ts';
import type { ServiceClient } from '@oasis/service-kit';
import { createRenderClient } from '../src/adapters/runpod.ts';
import { createHash } from 'node:crypto';
import { createTavilyClient } from '../src/adapters/tavily.ts';
import type { Call, CallOutcome, CallsRepo, TypicalUsage } from '../src/repo/calls-repo.ts';
import type { ToolJob, ToolJobsRepo } from '../src/repo/tool-jobs-repo.ts';
import { createMeter } from '../src/service/metering.ts';
import { createToolService } from '../src/service/tool-service.ts';
import { registerRoutes } from '../src/api/routes.ts';

const PAYER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const TASK = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const HOLD = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const PNG = Buffer.from('fake-png').toString('base64');
/** 文件头是 JPEG 的假图片 */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString(
  'base64',
);

describe('Android 会话恢复', () => {
  const handle = JSON.stringify({
    uploadId: PAYER,
    device: 'Samsung Galaxy S23',
    osVersion: '13.0',
    app: 'bs://abc123',
    sha256: 'abc',
    steps: [{ action: 'screenshot' }],
  });
  function setup(phase: string) {
    const calls: string[] = [];
    const receipt = {
      saved: {
        phase,
        sessionId: phase === 'creating' ? undefined : 'session-1',
        startedAt: 1,
        report: {
          version: 1,
          target: 'android',
          passed: true,
          steps: [],
          diagnostics: [],
          unchecked: [],
        },
        screenshots: [],
      },
      async save(value: unknown) {
        this.saved = structuredClone(value) as typeof this.saved;
      },
    };
    const client = createBrowserStackClient({
      username: 'test',
      accessKey: 'test',
      apiUrl: 'https://api.example',
      hubUrl: 'https://hub.example',
      canvas: {} as ServiceClient,
      fetcher: async (url, options) => {
        calls.push(`${options?.method} ${String(url)}`);
        return Response.json({ value: null });
      },
    });
    return { client, receipt, calls };
  }
  it('中断后关闭已知设备，不重放操作，结果标为未检查；重复取回不重复关闭', async () => {
    const { client, receipt, calls } = setup('running');
    const result = await client.check(handle, receipt, AbortSignal.timeout(1000));
    expect(result.state).toBe('completed');
    if (result.state === 'completed') expect(result.outcome.data.report.passed).toBe(false);
    await client.check(handle, receipt, AbortSignal.timeout(1000));
    expect(calls.filter((call) => call.includes('/session/'))).toHaveLength(1);
    expect(calls.every((call) => call.startsWith('DELETE'))).toBe(true);
  });
  it('创建响应丢失时不新开设备，保留待核对状态并删除本次 APK', async () => {
    const { client, receipt, calls } = setup('creating');
    expect((await client.check(handle, receipt, AbortSignal.timeout(1000))).state).toBe(
      'uncertain',
    );
    expect(calls).toEqual(['DELETE https://api.example/app-automate/app/delete/abc123']);
  });
});

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
/** 接下来几次生图请求被供应商拒绝 */
let imageRejections = 0;
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
  if (visionStatus === 429 && (request.body as { model: string }).model === 'vision/first')
    return reply.code(429).send({ error: { message: 'temporarily rate-limited upstream' } });
  return { choices: [{ message: { content: '图中有一只杯子。' } }], usage: { cost: 0.002 } };
});
fake.addContentTypeParser('*', (_req, _body, done) => done(null, {}));
const record = (path: string, body: unknown) =>
  upstream.push({ path, body: body as Record<string, unknown> });
fake.post('/api/v1/images', async (request, reply) => {
  record('images', request.body);
  if ((request.body as { resolution?: string }).resolution === '1K')
    return reply.code(400).send({
      error: {
        message: 'requires at least 3,686,400 output pixels; omit resolution to use the default.',
      },
    });
  if (imageRejections > 0) {
    imageRejections -= 1;
    return reply.code(400).send({ error: { message: 'content rejected' } });
  }
  if ((request.body as { prompt?: string }).prompt === '说是 PNG 其实是 JPEG')
    return { data: [{ b64_json: JPEG, media_type: 'image/png' }], usage: { cost: 0.04 } };
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
/** 视频提交被拒的状态码和原文；null = 接受 */
let videoReject: { status: number; body: unknown } | null = null;
fake.post('/api/v1/videos', async (request, reply) => {
  record('video', request.body);
  if (videoReject) return reply.code(videoReject.status).send(videoReject.body);
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
const noHistory = (): TypicalUsage => ({ tools: new Map(), nodes: new Map(), nodeTokens: null });
let typical = noHistory();
const repo: CallsRepo = {
  start: async () => {},
  get: async (id) => recordedCalls.get(id) as Call | undefined,
  computeForRun: async () => [],
  regionBlockedModels: async () => blocked,
  typicalUsage: async () => typical,
  async finish(id, outcome, event) {
    recordedCalls.set(id, outcome);
    finished.push(outcome);
    if (event) settled.push(event);
  },
};

const jobRows = new Map<string, ToolJob>();
const deletedTasks = new Set<string>();
const jobs: ToolJobsRepo = {
  taskDeleted: async (taskId) => deletedTasks.has(taskId),
  async markTaskDeleted(taskId) {
    deletedTasks.add(taskId);
    for (const row of jobRows.values())
      if ((row.call.caller as { taskId?: string }).taskId === taskId) {
        row.call = {
          ...row.call,
          taskDeleted: true,
          taskFilesCleaned: false,
          ...(row.status === 'pending' ? { cancelRequested: true } : {}),
        };
      }
  },
  deletedResults: async (limit) =>
    [...jobRows.values()]
      .filter(
        (row) =>
          row.call.taskDeleted &&
          (!row.call.taskFilesCleaned || (row.status !== 'pending' && row.phase !== 'expired')),
      )
      .slice(0, limit),
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
    if (deletedTasks.has((job.call.caller as { taskId?: string }).taskId ?? ''))
      throw new Error('Task deleted');
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
let archiveFails = false;
let resultDeleteFails = false;
const mediaStore: ObjectStore = {
  put: async (key, body) => {
    mediaFiles.set(key, body);
  },
  get: async (key) => mediaFiles.get(key)!,
  read: async (key) => Readable.from([mediaFiles.get(key)!]),
  delete: async (key) => {
    if (resultDeleteFails && key.startsWith('tool-results/'))
      throw new Error('Result delete failed');
    if (renderCleanupFails && key.startsWith('jobs/'))
      throw new Error('Temporary staging delete failure');
    mediaFiles.delete(key);
  },
  async putStream(key, source, _type, limits) {
    if (archiveFails && key.startsWith('tool-results/')) throw new Error('Slow link dropped');
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
let renderStatus = 'COMPLETED';
let renderReceiptMissing = false;
let renderBusy = false;
let renderStatusGone = false;
let renderExposure: number | undefined;
const stagingReads: string[] = [];
const build = (tavilyKey: string | undefined, withMusic = false, withRender = false) => {
  const logger = pino({ level: 'silent' });
  return createToolService({
    render: withRender
      ? createRenderClient({
          baseUrl: 'https://api.runpod.ai/v2',
          metering: { microPerSecond: 373, startupCapSeconds: 90, idleSeconds: 5 },
          endpointId: 'fixture',
          apiKey: 'not-real',
          verified: true,
          holdMicro: 1000000,
          archive: mediaStore,
          staging: {
            ...mediaStore,
            read: async (key) => {
              stagingReads.push(key);
              return mediaStore.read(key);
            },
            sign: async (key) => 'https://example.test/' + key,
          },
          fetcher: async (url, init) => {
            if (String(url).endsWith('/health'))
              return Response.json({
                jobs: { completed: 3, failed: 1, inProgress: renderBusy ? 1 : 0, inQueue: 0 },
                workers: { idle: 1, running: 0 },
              });
            if (renderStatusGone && String(url).includes('/status/'))
              return Response.json({ status: 404, detail: 'job not found' }, { status: 404 });
            if (String(url).includes('/cancel/'))
              return Response.json({ id: 'gpu-one', status: 'CANCELLED' });
            if (init?.method === 'POST') {
              renderSubmits++;
              if (renderSubmitLost) throw new Error('Lost POST response');
              const body = JSON.parse(String(init.body)) as { input: { transferId: string } };
              renderTransfer = body.input.transferId;
              return Response.json({ id: 'gpu-one' });
            }
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
              device: {
                gpuUsed: true,
                ...(renderExposure === undefined
                  ? {}
                  : {
                      exposureAdjustEv: renderExposure,
                      devices: [{ name: 'NVIDIA GeForce RTX 4090', type: 'CUDA' }],
                    }),
              },
              boundary: {
                filesystem: true,
                networkSocketsDenied: true,
                secretEnvironmentEmpty: true,
              },
            };
            return Response.json({
              status: renderStatus,
              delayTime: 120400,
              ...(renderReceiptMissing ? {} : { executionTime: 3172 }),
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
  videoReject = null;
  typical = noHistory();
  renderReceiptMissing = false;
  renderBusy = false;
  renderStatusGone = false;
  renderExposure = undefined;
  stagingReads.length = 0;
  archiveFails = false;
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
  imageRejections = 0;
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
  deletedTasks.clear();
  resultDeleteFails = false;
  tools = build('tvly-k');
});

describe('任务删除回收工具结果', () => {
  async function completed(taskId = TASK) {
    tools = build('key', true);
    const id = (
      await call('audio.music', { prompt: 'A warm instrumental track', instrumental: true }, taskId)
    ).job!.id;
    await tools.job({ payerId: PAYER, taskId }, id, AbortSignal.timeout(3000));
    return id;
  }
  it('只删除目标任务的对象，保留账单，重复事件幂等，拒绝读取和迟到提交', async () => {
    const id = await completed();
    const other = await completed('00000000-0000-4000-8000-000000000008');
    const cost = jobRows.get(id)!.cost;
    // 旧版在第二个文件写入后未保存清单便中断，也必须回收。
    delete jobRows.get(id)!.call.resultFileIds;
    mediaFiles.set(`tool-results/${id}/1`, Buffer.from('legacy partial'));
    await tools.purgeTask(TASK);
    await tools.purgeTask(TASK);
    expect([...mediaFiles.keys()].filter((key) => key.startsWith(`tool-results/${id}/`))).toEqual(
      [],
    );
    expect(mediaFiles.has(`tool-results/${other}/0`)).toBe(true);
    expect(jobRows.get(id)).toMatchObject({
      status: 'completed',
      phase: 'expired',
      result: null,
      cost,
    });
    await expect(
      tools.job({ payerId: PAYER, taskId: TASK }, id, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ statusCode: 410 });
    const holds = billingCalls.length;
    await expect(
      call('audio.music', { prompt: 'another track', instrumental: true }, TASK),
    ).rejects.toMatchObject({ statusCode: 410 });
    expect(billingCalls).toHaveLength(holds);
  });
  it('删除失败保留清单，重启后可继续；不抢在途作业租约', async () => {
    const id = await completed();
    jobRows.get(id)!.leaseToken = 'other';
    jobRows.get(id)!.leaseUntil = new Date(Date.now() + 60000);
    await tools.purgeTask(TASK);
    expect(mediaFiles.has(`tool-results/${id}/0`)).toBe(true);
    jobRows.get(id)!.leaseUntil = null;
    resultDeleteFails = true;
    await tools.purgeTask(TASK);
    expect(jobRows.get(id)!.result).not.toBeNull();
    expect(jobRows.get(id)!.call.resultFileIds).toEqual(['0']);
    resultDeleteFails = false;
    tools = build('key', true);
    await tools.purgeTask(TASK);
    expect(mediaFiles.has(`tool-results/${id}/0`)).toBe(false);
  });
  it('删除与供应商完成竞争时照常结算，停止归档结果', async () => {
    geometryMode = true;
    geometryCancelCompleted = true;
    tools = build('key', true);
    const id = (await call('3d.generate', { image: geometryImage }, TASK)).job!.id;
    await tools.purgeTask(TASK);
    expect(jobRows.get(id)).toMatchObject({ status: 'completed', phase: 'expired', result: null });
    expect([...mediaFiles.keys()].some((key) => key.startsWith(`tool-results/${id}/`))).toBe(false);
    expect(billingCalls.filter((call) => call.path === 'settle')).toHaveLength(1);
  });
  it('失败作业的部分写入也回收；未知费用记录不冒充已结算', async () => {
    const id = await completed();
    const row = jobRows.get(id)!;
    row.status = 'pending';
    row.phase = 'uncertain';
    row.result = null;
    row.cost = null;
    await tools.purgeTask(TASK);
    expect(mediaFiles.has(`tool-results/${id}/0`)).toBe(false);
    expect(jobRows.get(id)!.status).toBe('pending');
    expect(jobRows.get(id)!.cost).toBeNull();
  });
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
  it.each(['lease-lost', 'already-finished'])(
    '原提交进程恢复时 %s，不能迟到发起 GPU 请求',
    async (mode) => {
      tools = build('key', false, true);
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
      modelRequestMaxBytes: 50 * 1024 ** 2,
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
  it('回执缺执行时长时先归档等人工对账；重启不重复生成，结算后回收暂存', async () => {
    tools = build('key', false, true);
    renderReceiptMissing = true;
    const id = (await call('3d.render', args)).job!.id;
    expect(jobRows.get(id)?.phase).toBe('uploading');
    expect(renderSubmits).toBe(0);
    await tools.submit(caller, id);
    await tools.submit(caller, id);
    expect(renderSubmits).toBe(1);
    const waiting = await tools.job(caller, id, AbortSignal.timeout(2000));
    expect(waiting).toMatchObject({ status: 'pending', phase: 'awaiting_cost' });
    expect(billingCalls.map((c) => c.path)).toEqual(['hold']);
    expect(jobRows.get(id)?.result?.files).toHaveLength(1);
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
    tools = build('key', false, true);
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
  it('只取回渲染图：工程包留在暂存不下载（只记摘要），随作业清理删除；曝光调整写进给 AI 的说明', async () => {
    tools = build('key', false, true);
    renderExposure = -3;
    const id = (await call('3d.render', args)).job!.id;
    await tools.submit(caller, id);
    expect((await pollRender(id)).status).toBe('completed');
    const result = jobRows.get(id)!.result!;
    expect(result.files.map((f) => f.name)).toEqual(['image.png']);
    expect(stagingReads.some((k) => k.endsWith('/project.zip'))).toBe(false);
    expect(stagingReads.some((k) => k.endsWith('/image.png'))).toBe(true);
    expect(result.data).toMatchObject({
      project: { retrieved: false, size: 'zip-fixture'.length },
    });
    expect(result.text).toContain('RTX 4090');
    expect(result.text).toContain('降低了 3 EV');
    expect(result.text).toContain('曝光设为 -3');
    expect([...mediaFiles.keys()].some((k) => k.startsWith('jobs/'))).toBe(false);
  });
  it('GPU 失败不向用户扣款，退回冻结', async () => {
    tools = build('key', false, true);
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
  it('取结果中断后供应商回执过期，仍按已保存的回执交付并计量结算一次', async () => {
    tools = build('key', false, true);
    const id = (await call('3d.render', args)).job!.id;
    await tools.submit(caller, id);
    archiveFails = true;
    expect((await pollRender(id)).status).toBe('pending');
    expect(jobRows.get(id)?.call.providerReceipt).toMatchObject({ status: 'COMPLETED' });
    archiveFails = false;
    renderStatusGone = true;
    const done = await pollRender(id);
    expect(done.status).toBe('completed');
    expect(billingCalls.filter((c) => c.path === 'settle').map((c) => c.body.costMicro)).toEqual([
      36927,
    ]);
    expect(renderSubmits).toBe(1);
  });
  it('提交断连过了排队与执行时限、GPU 空闲后自动结案退回冻结；GPU 仍忙或未到时限则继续等', async () => {
    tools = build('key', false, true);
    renderSubmitLost = true;
    const id = (await call('3d.render', args)).job!.id;
    await tools.submit(caller, id);
    const submittedAt = jobRows.get(id)!.call.submittedAt as number;
    expect(submittedAt).toBeGreaterThan(0);
    expect((await pollRender(id)).status).toBe('uncertain');
    jobRows.get(id)!.call.submittedAt = submittedAt - 43 * 60000;
    renderBusy = true;
    expect((await pollRender(id)).status).toBe('uncertain');
    expect(billingCalls.map((c) => c.path)).toEqual(['hold']);
    renderBusy = false;
    const closed = await pollRender(id);
    expect(closed).toMatchObject({ status: 'failed' });
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'release']);
    expect(jobRows.get(id)?.call.lostSubmitClosed).toBe(true);
    expect([...mediaFiles.keys()].some((k) => k.startsWith('jobs/'))).toBe(false);
    expect(renderSubmits).toBe(1);
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
  it('看图的模型被上游限流：退回冻结，换下一个模型；指定了模型就不换', async () => {
    visionStatus = 429;
    const result = await call('image.inspect', { images: [reference], question: '是什么？' });
    expect(result.text).toContain('杯子');
    expect(upstream.map((r) => r.body.model)).toEqual(['vision/first', 'vision/second']);
    expect(billingCalls.map((r) => r.path)).toEqual(['hold', 'release', 'hold', 'settle']);
    upstream.length = 0;
    await expect(
      call('image.inspect', { images: [reference], question: '是什么？', model: 'vision/first' }),
    ).rejects.toMatchObject({ code: 'provider_busy' });
    expect(upstream.map((r) => r.body.model)).toEqual(['vision/first']);
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
      'website.test',
      'android.test',
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

describe('工具目录里的单价', () => {
  it('有调用记录用记录的中位数；视频按供应商每秒单价；都没有才用兜底值并标出来', async () => {
    typical = {
      ...noHistory(),
      tools: new Map([
        ['bytedance-seed/seedream-4.5', { costMicro: 45_000, seconds: 110, samples: 8 }],
      ]),
    };
    const list = await build('k').list();
    const byKey = Object.fromEntries(list.map((t) => [t.key, t]));
    expect(byKey['image.generate']?.rates).toEqual([
      { model: 'bytedance-seed/seedream-4.5', costMicro: 45_000, seconds: 110, basis: 'history' },
      { model: 'openai/gpt-image-2', costMicro: 150_000, seconds: null, basis: 'fallback' },
    ]);
    expect(byKey['video.generate']).toMatchObject({
      unit: '秒',
      rates: [{ model: 'alibaba/wan-2.7', costMicro: 50_000, basis: 'catalog' }],
    });
  });
});

describe('调用工具', () => {
  it('生图分辨率被供应商拒绝时按默认档重试一次，只结算成功的那次', async () => {
    const result = await call('image.generate', { prompt: '扶手椅', resolution: '1K' }, TASK);
    expect(result).toMatchObject({ tool: 'image.generate', costMicro: 40_000 });
    expect(upstream.map((u) => u.body.resolution)).toEqual(['1K', undefined]);
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'settle']);
  });
  it('要几张就并行发几个单张请求，合计结算；部分失败时交出成功的那些', async () => {
    const result = await call('image.generate', { prompt: '三张候选', n: '3' }, TASK);
    expect(upstream.filter((u) => u.path === 'images').map((u) => u.body.n)).toEqual([1, 1, 1]);
    expect(result).toMatchObject({ costMicro: 120_000 });
    expect(result.files.map((f) => f.name)).toEqual(['image-1.png', 'image-2.png', 'image-3.png']);

    upstream.length = 0;
    imageRejections = 1;
    const partial = await call('image.generate', { prompt: '三张候选', n: '3' }, TASK);
    expect(partial.files).toHaveLength(2);
    expect(partial.costMicro).toBe(80_000);
    expect(partial.text).toContain('另有 1 张没生成出来');
  });

  it('供应商说是 PNG、实际是 JPEG：按文件头认成 JPEG', async () => {
    const result = await call('image.generate', { prompt: '说是 PNG 其实是 JPEG' }, TASK);
    expect(result.files[0]).toMatchObject({ name: 'image-1.jpg', mediaType: 'image/jpeg' });
  });

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
    expect(billingCalls[0]?.body).toMatchObject({ amountMicro: 500_000 });
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

  it('视频提交被 API Key 的花费上限拒绝：说明是平台额度不够，不是笼统的「拒绝了提交」', async () => {
    videoReject = {
      status: 403,
      body: { error: { message: 'Key limit exceeded (total limit).', code: 403 } },
    };
    expect(await errorOf(call('video.generate', { prompt: 'x' }))).toMatchObject({
      statusCode: 402,
      code: 'provider_credits',
    });
    videoReject = { status: 400, body: { error: { message: 'bad prompt' } } };
    expect((await errorOf(call('video.generate', { prompt: 'x' })))?.code).toBe('provider_error');
  });

  it('参数和价格预检失败不冻结；高价模型冻结覆盖实时目录而非固定单价', async () => {
    expect((await errorOf(call('video.generate', { prompt: 'x', duration: 21 })))?.statusCode).toBe(
      400,
    );
    expect((await errorOf(call('video.generate', { prompt: 'x', resolution: '768p' })))?.code).toBe(
      'video_parameters_unsupported',
    );
    expect(billingCalls).toHaveLength(0);
    videoCentsPerSecond = '100';
    videoUsdTariff = false;
    await call('video.generate', { prompt: 'x', duration: 6 });
    expect(billingCalls[0]?.body.amountMicro).toBe(6_000_000);
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
    expect(billingCalls[0]?.body).toMatchObject({ amountMicro: 4_200_000, ttlMs: 40 * 60_000 });

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
