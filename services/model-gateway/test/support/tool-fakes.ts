// 工具服务测试用的假依赖：billing、OpenRouter/Tavily/视频接口、调用记录、作业表和对象存储。
import { Readable } from 'node:stream';
import type { EventEnvelope } from '@oasis/contracts/events';
import { checkedParts, type ObjectStore } from '@oasis/service-kit';
import Fastify from 'fastify';
import type { Call, CallOutcome, CallsRepo, TypicalUsage } from '../../src/repo/calls-repo.ts';
import type { ToolJob, ToolJobsRepo } from '../../src/repo/tool-jobs-repo.ts';

/** 测试里会改的开关和计数（ES 模块导出的变量在别的文件里不能赋值，所以集中放在一个对象里） */
export const knobs = {
  settleFails: false,
  renewFails: false,
  imageStatus: 200,
  /** 接下来几次生图请求被供应商拒绝 */
  imageRejections: 0,
  visionStatus: 200,
  referenceLimit: 4,
  pageText: '# 正文',
  videoPolls: 0,
  /** 假的视频接口：前 knobs.videoPolls 次查询还在做，之后按 videoEnd 结束 */
  videoEnd: 'completed' as 'completed' | 'failed',
  videoUsageCost: 0.5 as number | undefined,
  videoFramesSupported: true,
  videoCentsPerSecond: '5',
  videoUsdTariff: true,
  /** 视频提交被拒的状态码和原文；null = 接受 */
  videoReject: null as { status: number; body: unknown } | null,
  /** 测试用户有没有打开「只用国内模型」（ADR 0027） */
  domesticOnly: false,
  typical: noHistory(),
  renderCleanupFails: false,
  archiveFails: false,
  resultDeleteFails: false,
  falSubmitFails: false,
  geometryMode: false,
  geometryMalformed: false,
  geometryCancelled: false,
  geometryCancelCompleted: false,
  renderSubmits: 0,
  renderTransfer: '',
  renderSubmitLost: false,
  renderStatus: 'COMPLETED',
  renderReceiptMissing: false,
  renderBusy: false,
  renderStatusGone: false,
  renderExposure: undefined as number | undefined,
};

export const PAYER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
export const TASK = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const HOLD = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
export const PNG = Buffer.from('fake-png').toString('base64');
/** 文件头是 JPEG 的假图片 */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString(
  'base64',
);

export const billingCalls: { path: string; body: Record<string, unknown> }[] = [];
export const billing = Fastify();
billing.post('/internal/holds/:id/renew', async (_request, reply) =>
  reply.code(knobs.renewFails ? 409 : 204).send(),
);
billing.post('/internal/holds', async (request, reply) => {
  billingCalls.push({ path: 'hold', body: request.body as Record<string, unknown> });
  return reply.code(201).send({ holdId: HOLD, heldMicro: 1 });
});
billing.post('/internal/holds/:id/settle', async (request, reply) => {
  if (knobs.settleFails) return reply.code(503).send({ error: 'temporary' });
  billingCalls.push({ path: 'settle', body: request.body as Record<string, unknown> });
  return { chargedMicro: (request.body as { costMicro: number }).costMicro };
});
billing.post('/internal/holds/:id/release', async (_request, reply) => {
  billingCalls.push({ path: 'release', body: {} });
  return reply.code(204).send();
});

/** 假的 OpenRouter（生图、配音、查花费、转写、决策）和 Tavily */
export const upstream: { path: string; body: Record<string, unknown> }[] = [];
export const fake = Fastify();
fake.get('/api/v1/images/models/*', async (request) => ({
  endpoints: [
    {
      supported_parameters: {
        input_references: {
          type: 'range',
          max: request.url.includes('seedream') ? 0 : knobs.referenceLimit,
        },
      },
    },
  ],
}));
fake.post('/api/v1/chat/completions', async (request, reply) => {
  record('vision', request.body);
  if (knobs.visionStatus === 403 && (request.body as { model: string }).model === 'vision/first')
    return reply.code(403).send({ error: { message: 'not available in your region' } });
  if (knobs.visionStatus === 429 && (request.body as { model: string }).model === 'vision/first')
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
  if (knobs.imageRejections > 0) {
    knobs.imageRejections -= 1;
    return reply.code(400).send({ error: { message: 'content rejected' } });
  }
  if ((request.body as { prompt?: string }).prompt === '说是 PNG 其实是 JPEG')
    return { data: [{ b64_json: JPEG, media_type: 'image/png' }], usage: { cost: 0.04 } };
  if (knobs.imageStatus === 403) {
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
fake.get('/api/v1/videos/models', async () => ({
  data: [
    {
      id: 'alibaba/wan-2.7',
      supported_durations: Array.from({ length: 20 }, (_, i) => i + 1),
      supported_resolutions: ['480p', '720p', '1080p'],
      supported_aspect_ratios: ['16:9', '9:16'],
      supported_frame_images: knobs.videoFramesSupported ? ['first_frame'] : [],
      pricing_skus: {
        ...(knobs.videoUsdTariff
          ? { duration_seconds_720p: String(Number(knobs.videoCentsPerSecond) / 100) }
          : { cents_per_video_output_second_720p: knobs.videoCentsPerSecond }),
        cents_per_image_input: '1',
      },
    },
  ],
}));
fake.post('/api/v1/videos', async (request, reply) => {
  record('video', request.body);
  if (knobs.videoReject) return reply.code(knobs.videoReject.status).send(knobs.videoReject.body);
  return reply
    .code(202)
    .send({ id: 'vid-1', polling_url: '/api/v1/videos/vid-1', status: 'pending' });
});
fake.get('/api/v1/videos/:id', async () => {
  if (knobs.videoPolls > 0) {
    knobs.videoPolls -= 1;
    return { id: 'vid-1', status: 'in_progress' };
  }
  return knobs.videoEnd === 'completed'
    ? {
        id: 'vid-1',
        status: 'completed',
        ...(knobs.videoUsageCost === undefined ? {} : { usage: { cost: knobs.videoUsageCost } }),
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
    results: [{ url: 'https://a.com', raw_content: knobs.pageText }],
    failed_results: [{ url: 'https://b.com', error: '超时' }],
  };
});

export const finished: CallOutcome[] = [];
export const recordedCalls = new Map<string, CallOutcome>();
export const settled: EventEnvelope[] = [];
export function noHistory(): TypicalUsage {
  return { tools: new Map(), nodes: new Map(), nodeTokens: null };
}
export const repo: CallsRepo = {
  start: async () => {},
  get: async (id) => recordedCalls.get(id) as Call | undefined,
  computeForRun: async () => [],
  regionBlockedModels: async () => [],
  staleRunning: async () => [],
  typicalUsage: async () => knobs.typical,
  async finish(id, outcome, event) {
    recordedCalls.set(id, outcome);
    finished.push(outcome);
    if (event) settled.push(event);
  },
};

export const jobRows = new Map<string, ToolJob>();
export const deletedTasks = new Set<string>();
export const jobs: ToolJobsRepo = {
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

export const mediaFiles = new Map<string, Buffer>();
export const mediaStore: ObjectStore = {
  put: async (key, body) => {
    mediaFiles.set(key, body);
  },
  get: async (key) => mediaFiles.get(key)!,
  read: async (key) => Readable.from([mediaFiles.get(key)!]),
  delete: async (key) => {
    if (knobs.resultDeleteFails && key.startsWith('tool-results/'))
      throw new Error('Result delete failed');
    if (knobs.renderCleanupFails && key.startsWith('jobs/'))
      throw new Error('Temporary staging delete failure');
    mediaFiles.delete(key);
  },
  async putStream(key, source, _type, limits) {
    if (knobs.archiveFails && key.startsWith('tool-results/')) throw new Error('Slow link dropped');
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
