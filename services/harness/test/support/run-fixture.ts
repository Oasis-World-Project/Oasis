// 运行服务测试的公共部分：假执行器（里面跑假 dsh，见 fake-dsh.ts）、内存里的运行记录和对象存储、
// 假 model-gateway，每个用例前重置。
import { extract } from 'tar-stream';
import { PassThrough, Readable } from 'node:stream';
import { createServiceClient, packFiles } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import type { Executor, Sandbox, SandboxSpec } from '../../src/executor/executor.ts';
import {
  VERSIONS_KEPT,
  type Run,
  type RunEvent,
  type RunOutcome,
  type RunsRepo,
} from '../../src/repo/runs-repo.ts';
import { createRunService } from '../../src/service/run-service.ts';
import { fakeDsh, methods } from './fake-dsh.ts';

/** 测试里会改的开关和计数（ES 模块导出的变量在别的文件里不能赋值，所以集中放在一个对象里） */
export const fake = {
  pauseFails: false,
  /** 起沙箱要多久（模拟容器启动慢） */
  startDelayMs: 0,
  /** 从沙箱取产出要多久（模拟停止时存产出慢） */
  archiveDelayMs: 0,
  noNativeSession: false,
  gatewayOffline: false,
  renewStatus: 0,
};

export const PAYER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
export const CONVERSATION = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 假 dsh 收到的其他方法（initialize、session/resume、shutdown） */
export { methods };

/** 读出 tar 包里的文件（保留包里的完整路径） */
export async function tarEntries(tar: Buffer | Readable) {
  const parser = extract();
  if (Buffer.isBuffer(tar)) parser.end(tar);
  else tar.pipe(parser);
  const files: { path: string; content: Buffer }[] = [];
  for await (const entry of parser) {
    const chunks: Buffer[] = [];
    for await (const value of entry) chunks.push(Buffer.from(value as Uint8Array));
    if (entry.header.type === 'file')
      files.push({ path: entry.header.name, content: Buffer.concat(chunks) });
  }
  return files;
}

/** 假执行器：每个沙箱里跑一个假 dsh；工作目录的 out/ 里有 result.md */
export const started: SandboxSpec[] = [];
export const destroyed: string[] = [];
export const lifecycle: string[] = [];
export let orphansRemoved: ReadonlySet<string> | undefined;
export const workspaces = new Set<string>();
/** 运行中又放进沙箱的文件 */
export const puts: { dir: string; files: { path: string; content: Buffer }[] }[] = [];
/** 假沙箱和假工作目录里取出来的 tar：取目录时里面有 result.md，会话目录里还有原生会话记录 */
async function archiveOf(path: string, workspaceId: string) {
  lifecycle.push('archive');
  await sleep(fake.archiveDelayMs);
  const dir = path.split('/').at(-1) ?? 'x';
  if (dir === 'sessions' && fake.noNativeSession) return undefined;
  // 取单个文件：和 Docker 一样，包里只有这个文件
  if (dir.includes('.'))
    return Readable.from([await packFiles([{ path: dir, content: Buffer.from('# 成果') }])]);
  // 接管时 harness 看持久卷里有没有原生会话记录
  const extra =
    dir === 'sessions'
      ? [
          {
            path: `sessions/--workspace--/${workspaceId}/session.v4.jsonl.zstd`,
            content: Buffer.from('native-fixture'),
          },
        ]
      : [{ path: 'out/.oasis-batches/batch/meta.json', content: Buffer.from('{"rows":[]}') }];
  return Readable.from([
    await packFiles([{ path: `${dir}/result.md`, content: Buffer.from('# 成果') }, ...extra]),
  ]);
}

export const executor: Executor = {
  check: async () => {},
  readWorkspace: (workspaceId, path) => archiveOf(path, workspaceId),
  workspaceExists: async (id) => workspaces.has(id),
  suspend: async () => ({ endedAt: new Date(), cores: 2 }),
  purgeWorkspace: async (id) => {
    workspaces.delete(id);
  },
  async start(spec) {
    if (spec.workspaceId) workspaces.add(spec.workspaceId);
    const groups = new Map<string, { path: string; content: Buffer }[]>();
    for (const input of spec.files)
      groups.set(input.dir, [...(groups.get(input.dir) ?? []), ...(await tarEntries(input.tar))]);
    started.push({
      ...spec,
      files: await Promise.all(
        [...groups].map(async ([dir, files]) => ({ dir, tar: await packFiles(files) })),
      ),
    });
    await sleep(fake.startDelayMs);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    fakeDsh(stdin, stdout);
    const sandbox: Sandbox = {
      async pause() {
        lifecycle.push('pause');
        if (fake.pauseFails) throw new Error('freeze failed');
      },
      id: `container-${spec.runId}`,
      stdin,
      stdout,
      stderr: new PassThrough(),
      exec: async (cmd) => void lifecycle.push(`exec ${cmd.join(' ')}`),
      put: async (dir, tar) => void puts.push({ dir, files: await tarEntries(tar) }),
      readArchive: (path) => archiveOf(path, spec.workspaceId),
      async destroy() {
        lifecycle.push('destroy');
        destroyed.push(spec.runId);
        stdout.end();
      },
    };
    return sandbox;
  },
  async removeOrphans(keep) {
    orphansRemoved = keep;
    return 0;
  },
};

/** 内存里的 runs 表 + 事件 + 写过的结局 */
export const rows = new Map<string, Run>();
/** 存下的会话记录（一轮一版） */
export const versions = new Map<string, { sessionId: string; archive: Buffer; restore: boolean }>();
export const events: RunEvent[] = [];
export const finishes: { id: string; outcome: RunOutcome }[] = [];
export const repo: RunsRepo = {
  async insert(run, request) {
    if (rows.has(run.id)) return false;
    rows.set(run.id, {
      ...run,
      conversationId: run.conversationId ?? null,
      actorId: run.actorId ?? null,
      status: 'queued',
      error: null,
      containerId: null,
      runKeyId: null,
      outputs: [],
      summary: null,
      sessionId: run.sessionId ?? null,
      continueFrom: run.continueFrom ?? null,
      workplace: run.workplace ?? null,
      createdAt: new Date(),
      startedAt: null,
      finishedAt: null,
    });
    if (request)
      events.push({
        runId: run.id,
        seq: 0,
        kind: 'status',
        data: { status: 'admitted', request },
        createdAt: new Date(),
      });
    return true;
  },
  request: async (runId) => events.find((e) => e.runId === runId && e.seq === 0)?.data.request,
  control: async (runId) =>
    events.filter((e) => e.runId === runId && e.data.status === 'control_requested').at(-1)?.data
      .how as 'stop' | 'cancel' | undefined,
  suspension: async (runId) => {
    const event = events.filter((e) => e.runId === runId && e.data.status === 'suspended').at(-1);
    return event
      ? {
          endedAt: String(event.data.endedAt),
          cores: Number(event.data.cores),
          keyId: String(event.data.keyId),
        }
      : undefined;
  },
  get: async (id) => rows.get(id),
  hasRootPrompt: async (runId) =>
    events.some((e) => e.runId === runId && e.kind === 'user_message' && !e.data.parentSessionId),
  async update(id, patch) {
    const row = rows.get(id);
    if (row) rows.set(id, { ...row, ...patch });
  },
  async finish(id, outcome) {
    const row = rows.get(id);
    if (row) rows.set(id, { ...row, ...outcome });
    finishes.push({ id, outcome });
  },
  listUnfinished: async () =>
    [...rows.values()].filter((r) => ['queued', 'starting', 'running'].includes(r.status)),
  async appendEvents(runId, list) {
    for (const e of list) events.push({ ...e, runId, createdAt: new Date() });
  },
  listEvents: async (runId, after, limit) =>
    events.filter((e) => e.runId === runId && e.seq > after).slice(0, limit),
  nextSequence: async (runId) =>
    Math.max(-1, ...events.filter((e) => e.runId === runId).map((e) => e.seq)) + 1,
  listByConversation: async (conversationId) =>
    [...rows.values()].filter((r) => r.conversationId === conversationId),
  listBySession: async (sessionId) => [...rows.values()].filter((r) => r.sessionId === sessionId),
  async removeMany(ids) {
    for (const id of ids) {
      rows.delete(id);
      versions.delete(id);
    }
  },
  async saveVersion(run, archive) {
    const sessionId = run.sessionId ?? run.id;
    versions.delete(run.id);
    versions.set(run.id, { sessionId, archive, restore: false });
    const mine = [...versions].filter(([, version]) => version.sessionId === sessionId);
    for (const [runId] of mine.slice(0, -VERSIONS_KEPT)) versions.delete(runId);
  },
  version: async (runId) => versions.get(runId),
  hasVersion: async (runId) => versions.has(runId),
  async setRestore(runId, restore) {
    const version = versions.get(runId);
    if (version) version.restore = restore;
  },
};

/** 假 model-gateway：签发和作废临时 Key */
export const issued: Record<string, unknown>[] = [];
export const revoked: string[] = [];
const modelGateway = Fastify();
/** 执行目录：一个国内厂商的、一个国外厂商的；?domesticOnly=true 时只列国内的 */
modelGateway.get('/internal/v1/models/execution', async (request, reply) =>
  fake.gatewayOffline
    ? reply.code(503).send({ error: { code: 'unavailable', message: '临时断开' } })
    : {
        models: [
          {
            id: 'deepseek/deepseek-v4.1-flash',
            name: 'DeepSeek',
            contextWindow: 1000000,
            maxTokens: 131072,
            input: ['text', 'image'],
            reasoning: true,
          },
          {
            id: 'anthropic/claude-haiku-5.5',
            name: 'Claude',
            contextWindow: 200000,
            maxTokens: 64000,
            input: ['text', 'image'],
            reasoning: true,
          },
        ].filter(
          (model) =>
            (request.query as { domesticOnly?: string }).domesticOnly !== 'true' ||
            model.id.startsWith('deepseek/'),
        ),
      },
);
modelGateway.post('/internal/run-keys/:id/renew', async (_request, reply) => {
  const status = fake.gatewayOffline ? 503 : fake.renewStatus;
  return status
    ? reply
        .code(status)
        .send({ error: { code: 'renew_failed', message: '续租失败', requestId: 'lease' } })
    : reply.code(204).send();
});
/** 接着用空着的 dsh 时，它手里的 Key 改归到了哪一轮 */
export const rebound: string[] = [];
modelGateway.post('/internal/run-keys/:id/rebind', async (request, reply) => {
  rebound.push((request.body as { runId: string }).runId);
  return reply.code(204).send();
});
modelGateway.post('/internal/run-keys', async (request, reply) => {
  issued.push(request.body as Record<string, unknown>);
  return reply.code(201).send({
    keyId: '0d0c0b0a-0908-4706-8504-030201000000',
    key: 'oasis_run_secret',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
});
/** 假 model-gateway：算力冻结和结算 */
const COMPUTE_CALL = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
export const compute: { path: string; body: Record<string, unknown> }[] = [];
modelGateway.post('/internal/v1/compute', async (request, reply) => {
  compute.push({ path: 'hold', body: request.body as Record<string, unknown> });
  return reply.code(201).send({ callId: COMPUTE_CALL });
});
modelGateway.post('/internal/v1/compute/:id/settle', async (request, reply) => {
  compute.push({ path: 'settle', body: request.body as Record<string, unknown> });
  return reply.code(204).send();
});
modelGateway.post('/internal/v1/compute/runs/:id/recover', async (request, reply) => {
  compute.push({ path: 'recover', body: request.body as Record<string, unknown> });
  return reply.code(204).send();
});
modelGateway.post('/internal/v1/tools/runs/:id/cancel', async (_request, reply) =>
  reply.code(204).send(),
);
modelGateway.post('/internal/run-keys/:id/revoke', async (request, reply) => {
  if (fake.gatewayOffline)
    return reply.code(503).send({ error: { code: 'unavailable', message: '临时断开' } });
  revoked.push((request.params as { id: string }).id);
  return reply.code(204).send();
});

/** 假 canvas（和假 model-gateway 共用一个服务器）：用户上传的素材 */
export const PHOTO = '6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a';
export const BIG = '6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b';
/** 每次查上传文件时说的是谁名下的 */
export const uploadOwners: string[] = [];
modelGateway.post('/internal/uploads/lookup', async (request, reply) => {
  const { ids, ownerId } = request.body as { ids: string[]; ownerId: string };
  uploadOwners.push(ownerId);
  if (ids.some((id) => id !== PHOTO && id !== BIG))
    return reply
      .code(404)
      .send({ error: { code: 'upload_not_found', message: '没有这个文件', requestId: 'r' } });
  return {
    uploads: ids.map((id) => ({
      id,
      name: 'x',
      size: id === PHOTO ? 11 : 4096,
      contentType: 'application/octet-stream',
      createdAt: new Date().toISOString(),
    })),
  };
});
modelGateway.get('/internal/uploads/:id/content', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (id === PHOTO) return reply.type('image/jpeg').send(Buffer.from('photo-bytes'));
  if (id === BIG) return reply.type('application/octet-stream').send(Buffer.alloc(4096));
  return reply
    .code(404)
    .send({ error: { code: 'upload_not_found', message: '没有这个文件', requestId: 'r' } });
});
/** 假 canvas：画布里的一个成果（「让 AI 改」时拷进工作目录） */
export const POSTER = '6d6d6d6d-6d6d-4d6d-8d6d-6d6d6d6d6d6d';
/** 成果是按谁名下查的 */
export const artifactOwners: string[] = [];
modelGateway.post('/internal/artifacts/lookup', async (request, reply) => {
  const { ids, ownerId } = request.body as { ids: string[]; ownerId: string };
  artifactOwners.push(ownerId);
  if (ids.some((id) => id !== POSTER))
    return reply
      .code(404)
      .send({ error: { code: 'artifact_not_found', message: '有成果找不到了', requestId: 'r' } });
  return {
    artifacts: ids.map((id) => ({
      id,
      name: 'poster.png',
      path: 'site/poster.png',
      size: 12,
      contentType: 'image/png',
      category: 'media',
      conversationId: CONVERSATION,
      sessionId: CONVERSATION,
      task: '海报',
      runId: CONVERSATION,
      models: [],
      syncPath: '海报/site/poster.png',
      createdAt: new Date().toISOString(),
    })),
  };
});
modelGateway.get('/internal/artifacts/:id/content', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (id === POSTER) return reply.type('image/png').send(Buffer.from('poster-bytes'));
  return reply
    .code(404)
    .send({ error: { code: 'artifact_not_found', message: '没有这个成果', requestId: 'r' } });
});

export let service: ReturnType<typeof createRunService>;
let url: string;
export const buildService = (override: Partial<Parameters<typeof createRunService>[0]> = {}) =>
  createRunService({
    repo,
    executor,
    modelGateway: createServiceClient('model-gateway', url),
    canvas: createServiceClient('canvas', url),
    materialsMaxBytes: 1024,
    // 做完就收（接着用空着的 dsh 另有一条测试）
    idleMs: { cloud: 0, device: 0 },
    modelBaseUrl: 'http://sandbox-ingress:8080/v1',
    packages: {
      egressProxy: 'http://sandbox-egress:8888',
      npmRegistry: 'https://registry.npmmirror.com/',
      pipIndexUrl: 'https://pypi.example/simple',
    },
    guide: async () => ({
      rules: '# 在 Oasis 里干活\n',
      device: '## 环境\n\n- 用户的电脑\n',
      skills: [{ name: 'images', description: '图片类。适用：海报', content: '# 图片类\n正文' }],
    }),
    maxConcurrent: 2,
    timeoutMs: 60_000,
    cores: 2,
    outputMaxBytes: 1024 * 1024,
    serviceName: 'harness',
    logger: pino({ level: 'silent' }),
    ...override,
  });
/** 换成按这些参数建的运行服务（别的文件不能直接给导入的 service 赋值） */
export function useService(override?: Parameters<typeof buildService>[0]) {
  service = buildService(override);
}
beforeAll(async () => {
  url = await modelGateway.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => modelGateway.close());
afterEach(() => service.stopAll());
beforeEach(() => {
  fake.gatewayOffline = false;
  fake.renewStatus = 0;
  service = buildService();
  workspaces.clear();
  fake.noNativeSession = false;
  lifecycle.length = 0;
  fake.pauseFails = false;
  for (const list of [
    started,
    destroyed,
    events,
    finishes,
    issued,
    revoked,
    rebound,
    methods,
    compute,
    puts,
  ])
    list.length = 0;
  rows.clear();
  versions.clear();
  fake.startDelayMs = 0;
  fake.archiveDelayMs = 0;
});

export async function until<T>(read: () => T | undefined, ms = 3_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('等待超时');
    await sleep(10);
  }
}
/** 等到这一轮写下结局 */
export const finished = (id: string) =>
  until(() => (finishes.some((f) => f.id === id) ? rows.get(id) : undefined));

export const base = {
  payerId: PAYER,
  conversationId: CONVERSATION,
  model: 'deepseek/deepseek-v4.1-flash',
  materials: [],
};
