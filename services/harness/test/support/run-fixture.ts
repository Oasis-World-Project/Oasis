// 运行服务测试的公共部分：假 dsh、假执行器、内存里的运行记录和对象存储、假 model-gateway，每个用例前重置。
import { extract } from 'tar-stream';
import { PassThrough, Readable } from 'node:stream';
import type { EventEnvelope } from '@oasis/contracts/events';
import { createServiceClient, checkedParts, type ObjectStore } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import type { Executor, Sandbox, SandboxSpec } from '../../src/executor/executor.ts';
import { packFiles } from '../../src/executor/tar.ts';
import type { Run, RunEvent, RunsRepo } from '../../src/repo/runs-repo.ts';
import { createRunService } from '../../src/service/run-service.ts';

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 假的 dsh SDK 运行时：说同样的 JSON-RPC。每条用户消息处理成一轮：
 * 回一句 "收到：<内容>"；内容含 FAIL 时这一轮以模型错误结束；含 SLOW 时这一轮要很久。
 */
function fakeDsh(stdin: PassThrough, stdout: PassThrough) {
  const queue: string[] = [];
  const waiters: (() => void)[] = [];
  let busy = false;
  let sessionId = '';
  const send = (msg: unknown) => stdout.write(`${JSON.stringify(msg)}\n`);
  const event = (type: string, data: unknown) =>
    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type, data } } });
  async function drain() {
    if (busy) return;
    busy = true;
    send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'running' } });
    while (queue.length > 0) {
      const text = queue.shift() ?? '';
      event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] });
      event('user/message', {
        source: { kind: 'runtime' },
        content: [{ type: 'text', text: 'ctx' }],
      });
      await sleep(text.includes('SLOW') ? 5_000 : 20);
      if (text.includes('FAIL')) {
        event('turn/end', { reason: { kind: 'error', error: { message: '上游 500' } } });
      } else if (text.includes('TRUNCATED')) {
        event('turn/end', { reason: { kind: 'max-tokens' } });
      } else if (text.includes('NO_END')) {
        // session/wait 返回空闲，但没有正常结束通知。
      } else {
        event('assistant/message', {
          message: { content: [{ type: 'text', text: `收到：${text}` }] },
        });
        event('turn/end', { reason: { kind: 'completed' } });
      }
    }
    busy = false;
    send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } });
    waiters.splice(0).forEach((resolve) => resolve());
  }
  let buffer = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const req = JSON.parse(buffer.slice(0, i)) as {
        id: number;
        method: string;
        params: { sessionId?: string; contentBlocks?: { text: string }[] };
      };
      buffer = buffer.slice(i + 1);
      if (req.method === 'session/prompt') {
        sessionId = req.params.sessionId ?? '';
        queue.push(req.params.contentBlocks?.[0]?.text ?? '');
        send({ jsonrpc: '2.0', id: req.id, result: { messageId: 'm' } });
        void drain();
      } else if (req.method === 'session/wait') {
        if (!busy && queue.length === 0) send({ jsonrpc: '2.0', id: req.id, result: {} });
        else waiters.push(() => send({ jsonrpc: '2.0', id: req.id, result: {} }));
      } else {
        methods.push(req.method);
        send({ jsonrpc: '2.0', id: req.id, result: {} });
      }
    }
  });
}

/** 假 dsh 收到的其他方法（initialize、session/resume、shutdown） */
export const methods: string[] = [];

/** 假执行器：每个沙箱里跑一个假 dsh；产出目录里有 result.md */
export const started: SandboxSpec[] = [];
export const destroyed: string[] = [];
export const lifecycle: string[] = [];
export let orphansRemoved: ReadonlySet<string> | undefined;
export const workspaces = new Set<string>();
export const executor: Executor = {
  check: async () => {},
  workspaceExists: async (id) => workspaces.has(id),
  suspend: async () => ({ endedAt: new Date(), cores: 2 }),
  purgeWorkspace: async (id) => {
    workspaces.delete(id);
  },
  async start(spec) {
    if (spec.workspaceId) workspaces.add(spec.workspaceId);
    const groups = new Map<string, { path: string; content: Buffer }[]>();
    for (const input of spec.files) {
      const parser = extract();
      if (Buffer.isBuffer(input.tar)) parser.end(input.tar);
      else input.tar.pipe(parser);
      const collected = groups.get(input.dir) ?? [];
      for await (const entry of parser) {
        const chunks: Buffer[] = [];
        for await (const value of entry) chunks.push(Buffer.from(value as Uint8Array));
        if (entry.header.type === 'file')
          collected.push({ path: entry.header.name, content: Buffer.concat(chunks) });
      }
      groups.set(input.dir, collected);
    }
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
      async readArchive(path) {
        lifecycle.push('archive');
        await sleep(fake.archiveDelayMs);
        const dir = path.split('/').at(-1) ?? 'x';
        if (dir === 'sessions' && fake.noNativeSession) return undefined;
        // 接管时 harness 看持久卷里有没有原生会话记录
        const extra =
          dir === 'sessions'
            ? [
                {
                  path: `sessions/--workspace--/${spec.workspaceId}/session.v4.jsonl.zstd`,
                  content: Buffer.from('native-fixture'),
                },
              ]
            : [{ path: 'out/.oasis-batches/batch/meta.json', content: Buffer.from('{"rows":[]}') }];
        return Readable.from([
          await packFiles([{ path: `${dir}/result.md`, content: Buffer.from('# 成果') }, ...extra]),
        ]);
      },
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

/** 内存里的 runs 表 + 事件 + 发件箱 */
export const rows = new Map<string, Run>();
export const events: RunEvent[] = [];
export const outbox: EventEnvelope[] = [];
export const repo: RunsRepo = {
  async insert(run, request) {
    if (rows.has(run.id)) return false;
    rows.set(run.id, {
      ...run,
      taskId: run.taskId ?? null,
      nodeId: run.nodeId ?? null,
      status: 'queued',
      error: null,
      containerId: null,
      runKeyId: null,
      outputs: [],
      outputKey: null,
      summary: null,
      inputsFrom: run.inputsFrom ?? [],
      sessionId: run.sessionId ?? null,
      continueFrom: run.continueFrom ?? null,
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
  async finish(id, outcome, event) {
    const row = rows.get(id);
    if (row) rows.set(id, { ...row, ...outcome });
    outbox.push(event);
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
  listByTask: async (taskId) => [...rows.values()].filter((r) => r.taskId === taskId),
  listBySession: async (sessionId) => [...rows.values()].filter((r) => r.sessionId === sessionId),
  async removeMany(ids) {
    for (const id of ids) rows.delete(id);
  },
};

export const stored = new Map<string, Buffer>();
const store: ObjectStore = {
  delete: async (key) => {
    stored.delete(key);
  },
  putStream: async (key, source, _type, limits) => {
    const iterator = checkedParts(source, limits);
    const chunks: Buffer[] = [];
    for (;;) {
      const part = await iterator.next();
      if (part.done) {
        stored.set(key, Buffer.concat(chunks));
        return part.value;
      }
      chunks.push(part.value);
    }
  },
  put: async (key, body) => void stored.set(key, body),
  get: async (key) => {
    const body = stored.get(key);
    if (!body) throw new Error(`没有 ${key}`);
    return body;
  },
  read: async (key) => {
    const body = stored.get(key);
    if (!body) throw new Error(`没有 ${key}`);
    return Readable.from([body]);
  },
};

/** 假 model-gateway：签发和作废临时 Key */
export const issued: Record<string, unknown>[] = [];
export const revoked: string[] = [];
const modelGateway = Fastify();
modelGateway.get('/internal/v1/models/execution', async (_request, reply) =>
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
        ],
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
modelGateway.post('/internal/uploads/lookup', async (request, reply) => {
  const { ids } = request.body as { ids: string[] };
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

export let service: ReturnType<typeof createRunService>;
let url: string;
export const buildService = (override: Partial<Parameters<typeof createRunService>[0]> = {}) =>
  createRunService({
    repo,
    executor,
    store,
    modelGateway: createServiceClient('model-gateway', url),
    canvas: createServiceClient('canvas', url),
    materialsMaxBytes: 1024,
    modelBaseUrl: 'http://sandbox-ingress:8080/v1',
    packages: {
      egressProxy: 'http://sandbox-egress:8888',
      npmRegistry: 'https://registry.npmmirror.com/',
      pipIndexUrl: 'https://pypi.example/simple',
    },
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
  for (const list of [started, destroyed, events, outbox, issued, revoked, methods, compute])
    list.length = 0;
  rows.clear();
  stored.clear();
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
export const finished = (id: string) =>
  until(() => {
    const row = rows.get(id);
    return row &&
      ['succeeded', 'failed', 'cancelled', 'stopped'].includes(row.status) &&
      outbox.length
      ? row
      : undefined;
  });

export const base = {
  payerId: PAYER,
  model: 'deepseek/deepseek-v4.1-flash',
  inputs: [],
  inputsFrom: [],
};
