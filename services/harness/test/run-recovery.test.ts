// 运行服务：依赖中断、优雅重启和进程崩溃之后的接管与恢复。
import { describe, expect, it } from 'vitest';
import { extractFiles } from '../src/executor/tar.ts';
import {
  fake,
  PAYER,
  methods,
  started,
  orphansRemoved,
  workspaces,
  executor,
  rows,
  events,
  outbox,
  repo,
  issued,
  compute,
  service,
  buildService,
  useService,
  until,
  finished,
  base,
} from './support/run-fixture.ts';

describe('依赖中断后的原运行接管', () => {
  it('租约 503 挂起原身份，保留撤销失败的 Key，依赖恢复后接管，不发布中间失败', async () => {
    useService({ leaseMs: 200 });
    const run = await service.start({ ...base, prompt: 'SLOW 恢复' });
    await until(() => rows.get(run.id)?.status === 'running' || undefined);
    fake.gatewayOffline = true;
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
    fake.gatewayOffline = false;
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
      useService({ leaseMs: 200 });
      const run = await service.start({ ...base, prompt: 'SLOW 停止优先' });
      await until(() => rows.get(run.id)?.status === 'running' || undefined);
      fake.gatewayOffline = true;
      await until(() => rows.get(run.id)?.status === 'queued' || undefined);
      await service[how](run.id);
      expect(await repo.control(run.id)).toBe(how);
      await service.stopAll();
      fake.gatewayOffline = false;
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
    useService({ leaseMs: 200 });
    const run = await service.start({ ...base, prompt: 'SLOW 额度不足' });
    await until(() => rows.get(run.id)?.status === 'running' || undefined);
    fake.renewStatus = 402;
    await finished(run.id);
    expect(rows.get(run.id)?.status).toBe('stopped');
    await service.recover();
    expect(started).toHaveLength(1);
  });
});

describe('一次 agent 运行：重启接管', () => {
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
    fake.noNativeSession = true;
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
