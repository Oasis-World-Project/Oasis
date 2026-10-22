import { PassThrough, Readable } from 'node:stream';
import type { EventEnvelope } from '@oasis/contracts/events';
import { createServiceClient, HttpError } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Executor, Sandbox, SandboxSpec } from '../src/executor/executor.ts';
import { extractFiles, packFiles } from '../src/executor/tar.ts';
import type { ObjectStore } from '../src/repo/object-store.ts';
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
  const send = (msg: unknown) => stdout.write(`${JSON.stringify(msg)}\n`);
  const event = (type: string, data: unknown) =>
    send({ jsonrpc: '2.0', method: 'session.event', params: { event: { type, data } } });
  async function drain() {
    if (busy) return;
    busy = true;
    send({ jsonrpc: '2.0', method: 'session.status', params: { status: 'running' } });
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
      } else {
        event('assistant/message', {
          message: { content: [{ type: 'text', text: `收到：${text}` }] },
        });
        event('turn/end', { reason: { kind: 'completed' } });
      }
    }
    busy = false;
    send({ jsonrpc: '2.0', method: 'session.status', params: { status: 'idle' } });
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
        params: { contentBlocks?: { text: string }[] };
      };
      buffer = buffer.slice(i + 1);
      if (req.method === 'session/prompt') {
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
let orphansRemoved: ReadonlySet<string> | undefined;
const executor: Executor = {
  check: async () => {},
  async start(spec) {
    started.push(spec);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    fakeDsh(stdin, stdout);
    const sandbox: Sandbox = {
      id: `container-${spec.runId}`,
      stdin,
      stdout,
      stderr: new PassThrough(),
      async readArchive(path) {
        const dir = path.split('/').at(-1) ?? 'x';
        // 会话目录里带一个锁文件，接着原会话时应该被去掉
        const extra =
          dir === 'sessions'
            ? [{ path: 'sessions/s/session.lock', content: Buffer.from('1') }]
            : [];
        return Readable.from([
          await packFiles([{ path: `${dir}/result.md`, content: Buffer.from('# 成果') }, ...extra]),
        ]);
      },
      async destroy() {
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
  async insert(run) {
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
      sessionKey: null,
      summary: null,
      inputsFrom: run.inputsFrom ?? [],
      sessionId: run.sessionId ?? null,
      continueFrom: run.continueFrom ?? null,
      createdAt: new Date(),
      startedAt: null,
      finishedAt: null,
    });
    return true;
  },
  get: async (id) => rows.get(id),
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
};

const stored = new Map<string, Buffer>();
const store: ObjectStore = {
  put: async (key, body) => void stored.set(key, body),
  get: async (key) => {
    const body = stored.get(key);
    if (!body) throw new Error(`没有 ${key}`);
    return body;
  },
};

/** 假 model-gateway：签发和作废临时 Key */
const issued: Record<string, unknown>[] = [];
const revoked: string[] = [];
const modelGateway = Fastify();
modelGateway.post('/internal/run-keys', async (request, reply) => {
  issued.push(request.body as Record<string, unknown>);
  return reply.code(201).send({
    keyId: '0d0c0b0a-0908-4706-8504-030201000000',
    key: 'oasis_run_secret',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
});
modelGateway.post('/internal/run-keys/:id/revoke', async (request, reply) => {
  revoked.push((request.params as { id: string }).id);
  return reply.code(204).send();
});

let service: ReturnType<typeof createRunService>;
beforeAll(async () => {
  const url = await modelGateway.listen({ port: 0, host: '127.0.0.1' });
  service = createRunService({
    repo,
    executor,
    store,
    modelGateway: createServiceClient('model-gateway', url),
    modelBaseUrl: 'http://sandbox-ingress:8080/v1',
    maxConcurrent: 2,
    timeoutMs: 60_000,
    outputMaxBytes: 1024 * 1024,
    serviceName: 'harness',
    logger: pino({ level: 'silent' }),
  });
});
afterAll(() => modelGateway.close());
beforeEach(() => {
  for (const list of [started, destroyed, events, outbox, issued, revoked, methods])
    list.length = 0;
  rows.clear();
  stored.clear();
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

const base = {
  payerId: PAYER,
  model: 'deepseek/deepseek-v4.1-flash',
  inputs: [],
  inputsFrom: [],
};

describe('一次 agent 运行', () => {
  it('跑完：签发 Key → 起沙箱 → 交任务 → 收产出和会话存档 → 销毁沙箱、作废 Key → 发事件', async () => {
    const run = await service.start({
      ...base,
      prompt: '写一份成果',
      inputs: [{ path: 'brief.txt', contentBase64: 'aGk=' }],
    });
    expect(run.status).toBe('queued');
    const row = await finished(run.id);

    expect(row.status).toBe('succeeded');
    expect(row.outputs).toEqual([{ path: 'result.md', size: Buffer.byteLength('# 成果') }]);
    expect(stored.has(`runs/${run.id}/outputs.tar`)).toBe(true);
    expect(stored.has(`runs/${run.id}/session.tar`)).toBe(true);
    expect(issued[0]).toMatchObject({ runId: run.id, payerId: PAYER });
    expect(started[0]?.env).toMatchObject({
      OASIS_RUN_KEY: 'oasis_run_secret',
      OASIS_MODEL: base.model,
    });
    expect(destroyed).toEqual([run.id]);
    expect(revoked).toHaveLength(1);
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
    expect(kinds).toEqual(['status', 'user_message', 'assistant_text', 'turn_end', 'status']);
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

  it('接着之前的运行：放回会话存档（去掉锁文件）、放回产出，并让 dsh 恢复原会话', async () => {
    const first = await service.start({ ...base, prompt: '先写' });
    await finished(first.id);
    outbox.length = 0;
    const next = await service.start({ ...base, prompt: '按意见改', continueFrom: first.id });
    await finished(next.id);
    const [workspace, dshHome] = started[1]?.files ?? [];
    expect((await extractFiles(workspace?.tar ?? Buffer.alloc(0))).map((f) => f.path)).toContain(
      'result.md',
    );
    const session = (await extractFiles(dshHome?.tar ?? Buffer.alloc(0))).map((f) => f.path);
    expect(session).toEqual(['result.md']); // sessions/ 下的锁文件被去掉了
    expect(dshHome?.dir).toBe('/home/node/.dsh');
    expect(methods).toContain('session/resume');
    expect(rows.get(next.id)).toMatchObject({ sessionId: first.id, continueFrom: first.id });

    const err = await service
      .start({ ...base, prompt: 'p', continueFrom: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' })
      .catch((e: unknown) => e);
    expect((err as HttpError).statusCode).toBe(409);
  });

  it('读文字类产出给关卡用：只读文字文件，总长超过上限就截断', async () => {
    const run = await service.start({ ...base, prompt: '写' });
    await finished(run.id);
    expect(await service.texts(run.id, 3)).toEqual({
      files: [{ path: 'result.md', text: '# 成' }],
      truncated: true,
    });
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
    expect(events.find((e) => e.kind === 'error')?.data).toEqual({ message: '上游 500' });
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

  it('停止：先存下已经做出来的产出和会话，再销毁沙箱；之后可以接着这次运行做', async () => {
    const run = await service.start({ ...base, prompt: 'SLOW 慢慢做' });
    await until(() => events.find((e) => e.kind === 'user_message'));
    await service.stop(run.id);
    const row = await finished(run.id);
    expect(row).toMatchObject({
      status: 'stopped',
      error: '已停止',
      outputs: [{ path: 'result.md' }],
    });
    expect(stored.has(`runs/${run.id}/session.tar`)).toBe(true);
    expect(destroyed).toContain(run.id);
    expect(revoked).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ data: { status: 'stopped' } });

    outbox.length = 0;
    const next = await service.start({ ...base, prompt: '接着做', continueFrom: run.id });
    expect((await finished(next.id)).status).toBe('succeeded');
    expect(methods).toContain('session/resume');
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
    expect(row.sessionKey).toBeNull();
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

  it('重启接管：上次没结束的运行记为失败，清理遗留沙箱', async () => {
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
      error: '运行中断：harness 重启',
    });
    expect(outbox[0]).toMatchObject({ data: { status: 'failed' } });
    expect(orphansRemoved?.size).toBe(0);
  });
});
