import { extract } from 'tar-stream';
import { PassThrough, Readable } from 'node:stream';
import type { EventEnvelope } from '@oasis/contracts/events';
import { createServiceClient, HttpError } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Executor, Sandbox, SandboxSpec } from '../src/executor/executor.ts';
import { extractFiles, packFiles } from '../src/executor/tar.ts';
import { checkedParts, type ObjectStore } from '@oasis/service-kit';
import type { Run, RunEvent, RunsRepo } from '../src/repo/runs-repo.ts';
import { createRunService } from '../src/service/run-service.ts';

const PAYER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
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
const methods: string[] = [];

/** 假执行器：每个沙箱里跑一个假 dsh；产出目录里有 result.md */
const started: SandboxSpec[] = [];
const destroyed: string[] = [];
const lifecycle: string[] = [];
let pauseFails = false;
let orphansRemoved: ReadonlySet<string> | undefined;
/** 起沙箱要多久（模拟容器启动慢） */
let startDelayMs = 0;
/** 从沙箱取产出要多久（模拟停止时存产出慢） */
let archiveDelayMs = 0;
const workspaces = new Set<string>();
let noNativeSession = false;
const executor: Executor = {
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
    await sleep(startDelayMs);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    fakeDsh(stdin, stdout);
    const sandbox: Sandbox = {
      async pause() {
        lifecycle.push('pause');
        if (pauseFails) throw new Error('freeze failed');
      },
      id: `container-${spec.runId}`,
      stdin,
      stdout,
      stderr: new PassThrough(),
      async readArchive(path) {
        lifecycle.push('archive');
        await sleep(archiveDelayMs);
        const dir = path.split('/').at(-1) ?? 'x';
        if (dir === 'sessions' && noNativeSession) return undefined;
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
const rows = new Map<string, Run>();
const events: RunEvent[] = [];
const outbox: EventEnvelope[] = [];
const repo: RunsRepo = {
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

const stored = new Map<string, Buffer>();
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
const issued: Record<string, unknown>[] = [];
const revoked: string[] = [];
let gatewayOffline = false;
let renewStatus = 0;
const modelGateway = Fastify();
modelGateway.get('/internal/v1/models/execution', async (_request, reply) =>
  gatewayOffline
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
  const status = gatewayOffline ? 503 : renewStatus;
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
const compute: { path: string; body: Record<string, unknown> }[] = [];
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
  if (gatewayOffline)
    return reply.code(503).send({ error: { code: 'unavailable', message: '临时断开' } });
  revoked.push((request.params as { id: string }).id);
  return reply.code(204).send();
});

/** 假 canvas（和假 model-gateway 共用一个服务器）：用户上传的素材 */
const PHOTO = '6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a';
const BIG = '6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b';
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

let service: ReturnType<typeof createRunService>;
let url: string;
const buildService = (override: Partial<Parameters<typeof createRunService>[0]> = {}) =>
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
beforeAll(async () => {
  url = await modelGateway.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => modelGateway.close());
afterEach(() => service.stopAll());
beforeEach(() => {
  gatewayOffline = false;
  renewStatus = 0;
  service = buildService();
  workspaces.clear();
  noNativeSession = false;
  lifecycle.length = 0;
  pauseFails = false;
  for (const list of [started, destroyed, events, outbox, issued, revoked, methods, compute])
    list.length = 0;
  rows.clear();
  stored.clear();
  startDelayMs = 0;
  archiveDelayMs = 0;
});

async function until<T>(read: () => T | undefined, ms = 3_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('等待超时');
    await sleep(10);
  }
}
const finished = (id: string) =>
  until(() => {
    const row = rows.get(id);
    return row &&
      ['succeeded', 'failed', 'cancelled', 'stopped'].includes(row.status) &&
      outbox.length
      ? row
      : undefined;
  });

describe('依赖中断后的原运行接管', () => {
  it('租约 503 挂起原身份，保留撤销失败的 Key，依赖恢复后接管，不发布中间失败', async () => {
    service = buildService({ leaseMs: 200 });
    const run = await service.start({ ...base, prompt: 'SLOW 恢复' });
    await until(() => rows.get(run.id)?.status === 'running' || undefined);
    gatewayOffline = true;
    await until(() => rows.get(run.id)?.status === 'queued' || undefined);
    expect(rows.get(run.id)?.runKeyId).toBeTruthy();
    expect(rows.get(run.id)?.outputKey).toBeTruthy();
    expect(workspaces.has(run.id)).toBe(true);
    expect(outbox).toHaveLength(0);
    const checkpoint = await repo.suspension!(run.id);
    const replacement = buildService({ executor: { ...executor, suspend: async () => undefined } });
    await replacement.recover();
    expect(started).toHaveLength(1);
    expect(rows.get(run.id)?.status).toBe('queued');
    gatewayOffline = false;
    await replacement.recover();
    expect(compute.filter((entry) => entry.path === 'recover').at(-1)?.body.endedAt).toBe(
      checkpoint?.endedAt,
    );
    await until(() => rows.get(run.id)?.status === 'succeeded' || undefined, 8000);
    expect(rows.size).toBe(1);
    expect(started.map((box) => box.runId)).toEqual([run.id, run.id]);
    expect(rows.get(run.id)?.sessionId).toBe(run.id);
    expect(methods).toContain('session/resume');
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.data).toMatchObject({ status: 'succeeded' });
    expect(new Set(events.map((event) => event.seq)).size).toBe(events.length);
    await replacement.stopAll();
  }, 15000);

  it.each(['stop', 'cancel'] as const)(
    '挂起后 %s 的持久意图在进程重启后优先，不再派发模型执行',
    async (how) => {
      service = buildService({ leaseMs: 200 });
      const run = await service.start({ ...base, prompt: 'SLOW 停止优先' });
      await until(() => rows.get(run.id)?.status === 'running' || undefined);
      gatewayOffline = true;
      await until(() => rows.get(run.id)?.status === 'queued' || undefined);
      await service[how](run.id);
      expect(await repo.control(run.id)).toBe(how);
      await service.stopAll();
      gatewayOffline = false;
      const replacement = buildService();
      await replacement.recover();
      await until(
        () => rows.get(run.id)?.status === (how === 'stop' ? 'stopped' : 'cancelled') || undefined,
      );
      expect(started).toHaveLength(1);
      expect(issued).toHaveLength(1);
      expect(outbox).toHaveLength(1);
      await replacement.stopAll();
    },
  );

  it('明确的 402 不作为临时断网无限自动接管', async () => {
    service = buildService({ leaseMs: 200 });
    const run = await service.start({ ...base, prompt: 'SLOW 额度不足' });
    await until(() => rows.get(run.id)?.status === 'running' || undefined);
    renewStatus = 402;
    await finished(run.id);
    expect(rows.get(run.id)?.status).toBe('stopped');
    await service.recover();
    expect(started).toHaveLength(1);
  });
});

const base = {
  payerId: PAYER,
  model: 'deepseek/deepseek-v4.1-flash',
  inputs: [],
  inputsFrom: [],
};

describe('一次 agent 运行', () => {
  it('视频报告必须绑定归档摘要及归属；篡改摘要或缺少报告均保持未检查', async () => {
    const taskId = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
    const run = await service.start({ ...base, taskId, prompt: '做一次' });
    const row = await finished(run.id);
    const sha256 = 'a'.repeat(64);
    rows.set(run.id, { ...row, outputs: [{ path: 'final.mp4', size: 5, sha256 }] });
    const key = `runs/${run.id}/video-check.json`;
    expect(await service.videoCheck(run.id, PAYER, taskId)).toEqual({
      files: [],
      unchecked: ['final.mp4'],
    });
    stored.set(
      key,
      Buffer.from(
        JSON.stringify({
          files: [{ path: 'final.mp4', size: 5, sha256, valid: true, width: 1280, height: 720 }],
          unchecked: [],
        }),
      ),
    );
    expect((await service.videoCheck(run.id, PAYER, taskId)).files[0]?.width).toBe(1280);
    await expect(service.videoCheck(run.id, PAYER, PAYER)).rejects.toMatchObject({
      statusCode: 404,
    });
    stored.set(
      key,
      Buffer.from(
        JSON.stringify({
          files: [{ path: 'final.mp4', size: 5, sha256: 'b'.repeat(64), valid: true }],
          unchecked: [],
        }),
      ),
    );
    expect(await service.videoCheck(run.id, PAYER, taskId)).toEqual({
      files: [],
      unchecked: ['final.mp4'],
    });
  });
  it.each(['TRUNCATED', 'NO_END'])(
    '非正常结束不能当成功：%s（即使有产物和空闲通知）',
    async (prompt) => {
      const run = await service.start({ ...base, prompt });
      const row = await finished(run.id);
      expect(row.status).toBe('failed');
      expect(row.error).toMatch(/未完成|未收到正常结束/);
      expect(outbox[0]).toMatchObject({ data: { status: 'failed' } });
    },
  );

  it('跑完：签发 Key → 起沙箱（挂持久工作目录）→ 交任务 → 收产出 → 销毁沙箱、作废 Key → 发事件', async () => {
    const run = await service.start({
      ...base,
      prompt: '写一份成果',
      inputs: [{ path: 'brief.txt', contentBase64: 'aGk=' }],
    });
    expect(run.status).toBe('queued');
    const row = await finished(run.id);

    expect(row.status).toBe('succeeded');
    expect(row.outputs).toMatchObject([{ path: 'result.md', size: Buffer.byteLength('# 成果') }]);
    expect(stored.has(`runs/${run.id}/outputs.tar`)).toBe(true);
    // 会话在持久工作目录里，对象存储只存产出
    expect([...stored.keys()]).toEqual([`runs/${run.id}/outputs.tar`]);
    expect(started[0]).toMatchObject({ workspaceId: run.id, restore: false });
    expect(issued[0]).toMatchObject({ runId: run.id, payerId: PAYER });
    expect(started[0]?.env).toMatchObject({
      OASIS_RUN_KEY: 'oasis_run_secret',
      OASIS_MODEL: base.model,
      // 装软件包走出口代理；调模型和工具的入口代理不走
      HTTPS_PROXY: 'http://sandbox-egress:8888',
      NO_PROXY: 'sandbox-ingress,localhost,127.0.0.1',
      npm_config_registry: 'https://registry.npmmirror.com/',
      PIP_INDEX_URL: 'https://pypi.example/simple',
    });
    expect(destroyed).toEqual([run.id]);
    expect(revoked).toHaveLength(1);
    // 算力：开沙箱前按最长时间冻结，销毁后按实际时长结算
    expect(compute.map((c) => c.path)).toEqual(['hold', 'settle']);
    expect(compute[0]?.body).toMatchObject({ runId: run.id, cores: 2, maxMs: 300_000 });
    expect(compute[1]?.body).toMatchObject({ cores: 2, elapsedMs: expect.any(Number) });
    expect(outbox[0]).toMatchObject({
      type: 'harness.run.finished',
      data: {
        runId: run.id,
        status: 'succeeded',
        outputs: [{ path: 'result.md' }],
        summary: '收到：写一份成果',
      },
    });
    // 运行时上下文那条不是用户说的，不记
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      'status',
      'status',
      'user_message',
      'assistant_text',
      'turn_end',
      'status',
    ]);
    expect((await service.events(run.id, -1, 100))[0]?.data).toEqual({ status: 'admitted' });
  });

  it('任务被删除：已结束运行的产出包、记录和持久工作目录都删掉；没结束的留到下次', async () => {
    const taskId = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
    const nodeId = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';
    const run = await service.start({ ...base, taskId, nodeId, prompt: '写' });
    expect(await service.purgeTask(taskId)).toBe(false);
    expect(rows.has(run.id)).toBe(true);
    await finished(run.id);
    expect(stored.has(`runs/${run.id}/outputs.tar`)).toBe(true);
    expect(workspaces.has(run.id)).toBe(true);
    expect(await service.purgeTask(taskId)).toBe(true);
    expect(rows.has(run.id)).toBe(false);
    expect([...stored.keys()].some((k) => k.startsWith(`runs/${run.id}/`))).toBe(false);
    expect(workspaces.has(run.id)).toBe(false);
    expect(await service.purgeTask(taskId)).toBe(true);
  });

  it('上游运行的产出放进 in/<上游名>/；只能引用同一付费人、已成功的运行', async () => {
    const upstream = await service.start({ ...base, prompt: '先写' });
    await finished(upstream.id);
    outbox.length = 0;
    const downstream = await service.start({
      ...base,
      prompt: '接着写',
      inputsFrom: [{ runId: upstream.id, as: 'draft' }],
    });
    await finished(downstream.id);
    // 沙箱拿到的输入包里，上游产出在 in/draft/ 下（extractFiles 去掉了顶层的 in/）
    const sandboxTar = started[1]?.files[0]?.tar ?? Buffer.alloc(0);
    const files = (await extractFiles(sandboxTar)).map((f) => f.path);
    expect(files).toContain('draft/result.md');
    expect(files.some((path) => path.includes('.oasis-batches'))).toBe(false);

    const OTHER_PAYER = '1d1d1d1d-1d1d-4d1d-8d1d-1d1d1d1d1d1d';
    const cases = [
      { payerId: PAYER, runId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' }, // 不存在
      { payerId: OTHER_PAYER, runId: downstream.id }, // 别人的运行
    ];
    for (const { payerId, runId } of cases) {
      const err = await service
        .start({ ...base, payerId, prompt: 'p', inputsFrom: [{ runId, as: 'x' }] })
        .catch((e: unknown) => e);
      expect((err as HttpError).statusCode).toBe(409);
    }
  });

  it('用户给的素材向 canvas 取出来放进 materials/；取不到或太大时运行失败', async () => {
    const run = await service.start({
      ...base,
      prompt: '用照片',
      materials: [{ uploadId: PHOTO, path: 'materials/照片.jpg' }],
    });
    await finished(run.id);
    const files = await extractFiles(started[0]?.files[0]?.tar ?? Buffer.alloc(0));
    expect(files.find((f) => f.path === '照片.jpg')?.content.toString()).toBe('photo-bytes');

    const errors: (string | null)[] = [];
    for (const uploadId of ['6c6c6c6c-6c6c-4c6c-8c6c-6c6c6c6c6c6c', BIG]) {
      const failed = await service.start({
        ...base,
        prompt: '用照片',
        materials: [{ uploadId, path: 'materials/x.bin' }],
      });
      await finished(failed.id);
      const body = await service.get(failed.id);
      expect(body.status).toBe('failed');
      errors.push(body.error);
    }
    expect(errors[1]).toContain('素材加起来超过');
  });

  it('接着原会话：挂上原来的持久工作目录接着做；工作目录不在了就拒绝（409 workspace_unavailable）', async () => {
    const first = await service.start({ ...base, prompt: '先写' });
    await finished(first.id);
    expect(await service.get(first.id)).toMatchObject({ resumable: true });
    const next = await service.start({ ...base, prompt: '按意见改', continueFrom: first.id });
    await finished(next.id);
    expect(started[1]).toMatchObject({ workspaceId: first.id, restore: true });
    expect(methods).toContain('session/resume');
    expect(rows.get(next.id)).toMatchObject({ sessionId: first.id, continueFrom: first.id });

    // 持久卷被清掉：只剩对象存储里的产出，不能冒充接着原会话做，也不登记这次运行
    workspaces.clear();
    expect(await service.get(next.id)).toMatchObject({ resumable: false });
    const count = rows.size;
    await expect(
      service.start({ ...base, prompt: '再改', continueFrom: next.id }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'workspace_unavailable' });
    expect(rows.size).toBe(count);
    expect(started).toHaveLength(2);

    await expect(
      service.start({ ...base, prompt: 'p', continueFrom: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'continue_unavailable' });
  });

  it('读一个产出文件：带上内容类型；没有的文件 404', async () => {
    const run = await service.start({ ...base, prompt: '写' });
    await finished(run.id);
    const file = await service.file(run.id, 'result.md');
    expect(file.content.toString()).toBe('# 成果');
    expect(file.contentType).toBe('text/markdown; charset=utf-8');
    const err = await service.file(run.id, '.oasis-keep').catch((e: unknown) => e);
    expect((err as HttpError).statusCode).toBe(404);
    await expect(service.file(run.id, '.oasis-batches/batch/meta.json')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('读文字类产出给关卡用：只读文字文件，总长超过上限就截断', async () => {
    const run = await service.start({ ...base, prompt: '写' });
    await finished(run.id);
    expect(await service.texts(run.id, 3)).toEqual({
      files: [{ path: 'result.md', text: '# 成', valid: true, truncated: true }],
      truncated: true,
    });
    expect(await service.texts(run.id, 100, [])).toEqual({ files: [], truncated: false });
    expect(await service.texts(run.id, 100, ['missing.md'])).toEqual({
      files: [],
      truncated: false,
    });
    expect((await service.texts(run.id, 100, ['result.md'])).files.map((f) => f.path)).toEqual([
      'result.md',
    ]);
  });

  it('运行中追问：排在当前这一轮之后处理，处理完才收尾；结束后再追问是 409', async () => {
    const run = await service.start({ ...base, prompt: '先做这个' });
    await until(() => events.find((e) => e.kind === 'user_message'));
    await service.message(run.id, '再补一句');
    const row = await finished(run.id);
    expect(row.status).toBe('succeeded');
    const said = events.filter((e) => e.kind === 'user_message').map((e) => e.data.text);
    expect(said).toEqual(['先做这个', '再补一句']);
    const err = await service.message(run.id, '还在吗').catch((e: unknown) => e);
    expect((err as HttpError).statusCode).toBe(409);
  });

  it('最后一轮模型出错：运行失败，带上原因', async () => {
    const run = await service.start({ ...base, prompt: 'FAIL 一下' });
    const row = await finished(run.id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('上游 500');
    expect(events.find((e) => e.kind === 'error')?.data).toEqual({
      message: '上游 500',
      sessionId: run.id,
    });
  });

  it('前一轮 completed 不遮住排队追问缺少结束通知', async () => {
    const run = await service.start({ ...base, prompt: '先做这个' });
    await until(() => events.find((e) => e.kind === 'user_message'));
    await service.message(run.id, 'NO_END');
    expect((await finished(run.id)).status).toBe('failed');
  });

  it('取消：立即销毁沙箱、作废 Key，记为已取消', async () => {
    const run = await service.start({ ...base, prompt: 'SLOW 慢慢做' });
    await until(() => events.find((e) => e.kind === 'user_message'));
    await service.cancel(run.id);
    const row = await finished(run.id);
    expect(row.status).toBe('cancelled');
    expect(destroyed).toContain(run.id);
    expect(revoked).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ data: { status: 'cancelled' } });
  });

  it('停止：先存下已经做出来的产出，再销毁沙箱；会话留在持久工作目录里，之后可以接着这次运行做', async () => {
    const run = await service.start({ ...base, prompt: 'SLOW 慢慢做' });
    await until(() => events.find((e) => e.kind === 'user_message'));
    await service.stop(run.id);
    const row = await finished(run.id);
    expect(row).toMatchObject({
      status: 'stopped',
      error: '已停止',
      outputs: [{ path: 'result.md' }],
    });
    expect(lifecycle.slice(0, 3)).toEqual(['pause', 'archive', 'destroy']);
    expect(outbox[0]).toMatchObject({ data: { resumable: true } });
    expect(destroyed).toContain(run.id);
    expect(revoked).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ data: { status: 'stopped' } });

    outbox.length = 0;
    const next = await service.start({ ...base, prompt: '接着做', continueFrom: run.id });
    expect((await finished(next.id)).status).toBe('succeeded');
    expect(methods).toContain('session/resume');
    expect(started[1]).toMatchObject({ workspaceId: run.id, restore: true });
  });

  it('停止后马上继续：等那次运行停好再接着，不当成「还没结束」拒掉', async () => {
    // 2026-11-08 回归测试发现：存会话时继续请求就到了，被 409 拒掉，节点失败
    archiveDelayMs = 200;
    const run = await service.start({ ...base, prompt: 'SLOW 慢慢做' });
    await until(() => events.find((e) => e.kind === 'user_message'));
    await service.stop(run.id);
    const next = await service.start({ ...base, prompt: '接着做', continueFrom: run.id });
    expect((await finished(run.id)).status).toBe('stopped');
    expect((await finished(next.id)).status).toBe('succeeded');
    expect(methods).toContain('session/resume');
  });

  it('冻结失败不归档仍在变动的检查点，并明确告知保存失败', async () => {
    pauseFails = true;
    const run = await service.start({ ...base, prompt: 'SLOW 等待' });
    await until(() => events.find((e) => e.kind === 'user_message'));
    await service.stop(run.id);
    const row = await finished(run.id);
    expect(row.error).toContain('保存失败');
    expect(lifecycle).not.toContain('archive');
    expect(stored.has(`runs/${run.id}/outputs.tar`)).toBe(false);
  });

  it('沙箱还在启动时被取消：起好后立刻销毁，不再交任务', async () => {
    startDelayMs = 200;
    const run = await service.start({ ...base, prompt: '做一次' });
    await until(() => started.find((s) => s.runId === run.id));
    await service.cancel(run.id);
    const row = await finished(run.id);
    expect(row.status).toBe('cancelled');
    expect(destroyed).toContain(run.id);
    expect(events.some((e) => e.kind === 'user_message')).toBe(false);
  });

  it('还在排队就被停止：不起沙箱，记为已停止', async () => {
    const busy = [
      await service.start({ ...base, prompt: 'SLOW 1' }),
      await service.start({ ...base, prompt: 'SLOW 2' }),
    ];
    const queued = await service.start({ ...base, prompt: '排队的' });
    await service.stop(queued.id);
    for (const r of busy) await service.cancel(r.id);
    const row = await until(() =>
      rows.get(queued.id)?.status === 'stopped' ? rows.get(queued.id) : undefined,
    );
    expect(row.outputKey).toBeNull();
    expect(started.map((s) => s.runId)).not.toContain(queued.id);
  });

  it('同一个运行 ID 重复提交：幂等返回，不会起第二个沙箱', async () => {
    const runId = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
    await service.start({ ...base, runId, prompt: '做一次' });
    const again = await service.start({ ...base, runId, prompt: '做一次' });
    expect(again.id).toBe(runId);
    await finished(runId);
    expect(started).toHaveLength(1);
    const conflict = await service
      .start({ ...base, runId, model: 'other/model', prompt: '做一次' })
      .catch((e: unknown) => e);
    expect((conflict as HttpError).statusCode).toBe(409);
  });

  it('优雅重启挂起后保持原运行身份、事件序号和目录，完成只发一次事件', async () => {
    const run = await service.start({ ...base, prompt: 'SLOW 原始任务' });
    await until(() =>
      rows.get(run.id)?.status === 'running' && events.some((e) => e.kind === 'user_message')
        ? true
        : undefined,
    );
    await service.stopAll();
    expect(rows.get(run.id)?.status).toBe('queued');
    expect(outbox).toHaveLength(0);
    expect(workspaces.has(run.id)).toBe(true);
    const oldMax = Math.max(...events.map((e) => e.seq));
    const replacement = buildService();
    await replacement.recover();
    await finished(run.id);
    expect(rows.get(run.id)?.status).toBe('succeeded');
    expect(rows.size).toBe(1);
    expect(started.map((s) => s.runId)).toEqual([run.id, run.id]);
    expect(started[1]).toMatchObject({ workspaceId: run.id, restore: true });
    expect(events.find((e) => e.data.status === 'recovering')?.seq).toBe(oldMax + 1);
    expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
    expect(outbox).toHaveLength(1);
    expect(methods).toContain('session/resume');
    await replacement.stopAll();
  });

  it('接管排队请求保留内联输入和素材，尚未开始时不恢复不存在的会话', async () => {
    const id = '8e8e8e8e-8e8e-4e8e-8e8e-8e8e8e8e8e8e';
    const body = {
      ...base,
      runId: id,
      prompt: '排队任务',
      inputs: [
        { path: 'seed.txt', contentBase64: Buffer.from('durable-input').toString('base64') },
      ],
    };
    await repo.insert(
      {
        id,
        payerId: PAYER,
        taskId: null,
        nodeId: null,
        sessionId: id,
        continueFrom: null,
        model: base.model,
        prompt: body.prompt,
        inputsFrom: [],
      },
      { body },
    );
    await service.recover();
    await finished(id);
    expect(rows.get(id)?.status).toBe('succeeded');
    expect(methods).not.toContain('session/resume');
    const files = await extractFiles(started[0]!.files[0]!.tar);
    expect(files.find((f) => f.path === 'seed.txt')?.content.toString()).toBe('durable-input');
  });

  it('已开始的运行丢失持久目录时不调用模型、不创建空沙箱', async () => {
    const run = await service.start({ ...base, prompt: 'SLOW 原始任务' });
    await until(() => (rows.get(run.id)?.status === 'running' ? true : undefined));
    await service.stopAll();
    workspaces.clear();
    const replacement = buildService();
    const count = issued.length;
    await replacement.recover();
    expect(rows.get(run.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('持久工作目录缺失'),
    });
    expect(issued.length).toBe(count);
    expect(started).toHaveLength(1);
  });

  it('新运行已登记但尚未挂入内存时，定时接管不会重复派发', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checked = buildService({
      repo: {
        ...repo,
        async insert(row, request) {
          const inserted = await repo.insert(row, request);
          await waiting;
          return inserted;
        },
      },
    });
    const starting = checked.start({ ...base, prompt: '唯一一次派发' });
    try {
      await until(() => (rows.size ? true : undefined));
      await checked.recover();
      expect(started).toHaveLength(0);
      expect(outbox).toHaveLength(0);
    } finally {
      release();
    }
    const run = await starting;
    expect((await finished(run.id)).status).toBe('succeeded');
    expect(started).toHaveLength(1);
    expect(outbox).toHaveLength(1);
    await checked.stopAll();
  });

  it('运行环境不具备所需能力时，登记和冻结之前拒绝', async () => {
    const checked = buildService({
      executor: {
        ...executor,
        environment: async () => ({
          image: 'oasis/test:1',
          imageId: 'sha256:test',
          software: { node: '24' },
          capabilities: ['node'],
          notes: [],
        }),
      },
    });
    await expect(
      checked.start({ ...base, prompt: '需要本地浏览器', requires: ['browser'] }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'execution_capability_unavailable' });
    expect(rows.size).toBe(0);
    expect(issued).toHaveLength(0);
    expect(compute).toHaveLength(0);
  });

  it.each(['stop', 'cancel'] as const)(
    '恢复等待时的 %s 意图持久化；不唤醒模型、不创建新运行',
    async (how) => {
      const run = await service.start({ ...base, prompt: 'SLOW 原任务' });
      await until(() => events.find((e) => e.runId === run.id && e.kind === 'user_message'));
      await service.stopAll();
      const replacement = buildService();
      await replacement[how](run.id);
      const row = await finished(run.id);
      expect(row.status).toBe(how === 'stop' ? 'stopped' : 'cancelled');
      expect(started).toHaveLength(1);
      expect(rows.size).toBe(1);
      expect(outbox).toHaveLength(1);
      expect(events.some((e) => e.data.status === 'control_requested' && e.data.how === how)).toBe(
        true,
      );
      await replacement.stopAll();
    },
  );

  it('原生会话创建前崩溃：保留原身份首次派发原子请求', async () => {
    const id = '7e7e7e7e-7e7e-4e7e-8e7e-7e7e7e7e7e7e';
    const body = { ...base, runId: id, prompt: '首次派发原请求' };
    await repo.insert(
      {
        id,
        payerId: PAYER,
        taskId: null,
        nodeId: null,
        sessionId: id,
        continueFrom: null,
        model: base.model,
        prompt: body.prompt,
        inputsFrom: [],
      },
      { body },
    );
    await repo.update(id, { status: 'running', startedAt: new Date() });
    workspaces.add(id);
    noNativeSession = true;
    await service.recover();
    expect((await finished(id)).status).toBe('succeeded');
    expect(methods).not.toContain('session/resume');
    expect(events.filter((e) => e.kind === 'user_message').map((e) => e.data.text)).toEqual([
      body.prompt,
    ]);
  });

  it('缺少恢复请求时明确失败，不能新建空运行', async () => {
    await repo.insert({
      id: '9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e',
      payerId: PAYER,
      taskId: null,
      nodeId: null,
      model: 'm',
      prompt: 'p',
    });
    await service.recover();
    expect(rows.get('9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e')).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('恢复状态不可用'),
    });
    expect(outbox[0]).toMatchObject({ data: { status: 'failed' } });
    expect(orphansRemoved?.size).toBe(0);
  });
});
