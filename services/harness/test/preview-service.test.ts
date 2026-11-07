import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { ServiceClient, ObjectStore } from '@oasis/service-kit';
import type { RunService } from '../src/service/run-service.ts';
import type { PreviewExecutor } from '../src/executor/preview-executor.ts';
import type { PreviewRepo, PreviewRow } from '../src/repo/preview-repo.ts';
import { createPreviewService } from '../src/service/preview-service.ts';
import { createWebsiteFetch, websiteUrl } from '../src/executor/website-fetch.ts';

const access = {
  artifactId: '00000000-0000-4000-8000-000000000001',
  ownerId: '00000000-0000-4000-8000-000000000002',
  taskId: '00000000-0000-4000-8000-000000000003',
};

function fixture(files?: Record<string, string>) {
  const rows = new Map<string, PreviewRow>();
  const repo: PreviewRepo = {
    async insert(value) {
      if (
        [...rows.values()].some(
          (row) =>
            row.ownerId === value.ownerId &&
            ['starting', 'running', 'stopping'].includes(row.status),
        )
      )
        return false;
      rows.set(value.id, {
        ...value,
        status: 'starting',
        containerId: null,
        computeCallId: null,
        heldMicro: 0,
        spentMicro: null,
        startedAt: null,
        lastInputAt: null,
        stoppedAt: null,
        error: null,
        createdAt: new Date(),
      });
      return true;
    },
    async latest(artifactId, ownerId) {
      return [...rows.values()]
        .reverse()
        .find((row) => row.artifactId === artifactId && row.ownerId === ownerId);
    },
    async active(ownerId) {
      return [...rows.values()].find(
        (row) =>
          row.ownerId === ownerId && ['starting', 'running', 'stopping'].includes(row.status),
      );
    },
    async update(id, patch) {
      Object.assign(rows.get(id)!, patch);
    },
    async unfinished() {
      return [...rows.values()].filter((row) =>
        ['starting', 'running', 'stopping'].includes(row.status),
      );
    },
    async removeFinished(taskId) {
      for (const [id, row] of rows)
        if (row.taskId === taskId && !['starting', 'running', 'stopping'].includes(row.status))
          rows.delete(id);
    },
  };
  const destroy = vi.fn(async () => undefined);
  const test = vi.fn(async () => ({
    report: {
      version: 1,
      target: 'application',
      passed: false,
      steps: [
        {
          index: 0,
          action: 'text',
          status: 'failed',
          error: '第 1 步 text h1：等到页面安定后文字不含「expected」，实际为「actual」',
        },
      ],
      diagnostics: [],
      unchecked: [],
    },
    screenshots: [{ name: 'step-0.jpg', base64: '/9j/2Q==' }],
  }));
  let alive = true;
  const start = vi.fn(async () => ({
    id: 'container-1',
    frame: () => ({ seq: 1, jpegBase64: 'AA==' }),
    input: vi.fn(),
    ready: async () => undefined,
    diagnostics: () => ['页面错误：boom（共 2 次）'],
    alive: () => alive,
    test,
    destroy,
  }));
  const executor = {
    check: vi.fn(async () => undefined),
    start,
    destroy,
    removeOrphans: vi.fn(async () => 0),
  } as unknown as PreviewExecutor;
  const canvas = {
    json: vi.fn(async () => ({
      spec: { version: 1, kind: 'static', root: 'site', entry: 'index.html' },
      files: [
        { path: 'oasis-app.json', contentBase64: 'e30=' },
        { path: 'index.html', contentBase64: 'PGgxPk9LPC9oMT4=' },
      ],
    })),
  } as unknown as ServiceClient;
  const modelGateway = {
    json: vi.fn(async (method: string, path: string) => {
      if (path.startsWith('/internal/v1/compute/quote')) return { maxMicro: 500 };
      if (method === 'POST' && path === '/internal/v1/compute')
        return { callId: '00000000-0000-4000-8000-000000000004', heldMicro: 500 };
      if (method === 'GET') return { status: 'succeeded', chargedMicro: 25 };
      return undefined;
    }),
  } as unknown as ServiceClient;
  const service = createPreviewService({
    repo,
    executor,
    canvas,
    modelGateway,
    logger: pino({ level: 'silent' }),
    cpus: 2,
    maxMs: 60_000,
    idleMs: 20_000,
    runs: {
      get: async () => ({
        payerId: access.ownerId,
        taskId: access.taskId,
        status: 'succeeded',
        outputs: Object.entries(files ?? {}).map(([path, content]) => ({
          path,
          size: Buffer.byteLength(content),
        })),
      }),
      file: async (_id: string, path: string) => ({ content: Buffer.from(files![path]!) }),
      // 运行中的沙箱：返回 out/<dir> 下的文件（路径相对 dir）
      liveFiles: async ({ dir }: { dir: string }) =>
        Object.entries(files ?? {})
          .filter(([path]) => path.startsWith(`${dir}/`))
          .map(([path, content]) => ({
            path: path.slice(dir.length + 1),
            content: Buffer.from(content),
          })),
    } as unknown as RunService,
    store: {
      put: vi.fn(async () => undefined),
      get: async () => Buffer.from('{}'),
    } as unknown as ObjectStore,
  });
  return {
    setAlive: (value: boolean) => {
      alive = value;
    },
    rows,
    service,
    start,
    destroy,
    modelGateway,
    executor,
    test,
  };
}

describe('私有预览生命周期', () => {
  it('清单字段缺失给出实际路径与字段错误，在启动和冻结前拒绝', async () => {
    const { service, start, modelGateway } = fixture({
      'site/oasis-app.json': JSON.stringify({ version: 1, kind: 'static', entry: 'index.html' }),
      'site/index.html': '<h1>actual</h1>',
    });
    try {
      const result = await service.checkRun({
        runId: access.artifactId,
        payerId: access.ownerId,
        taskId: access.taskId,
      });
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('root');
      expect(result.reason).toContain('out/site/oasis-app.json');
      expect(result.reason).toContain('in/.oasis-formats.json');
      expect(start).not.toHaveBeenCalled();
      expect(modelGateway.json).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });
  it('节点自查读运行中沙箱的目录，跑同一套浏览器检查，不留档；目录里没有清单时直接说明', async () => {
    const { service, test, destroy, rows } = fixture({
      'site/oasis-app.json': JSON.stringify({
        version: 1,
        kind: 'static',
        root: 'site',
        entry: 'index.html',
      }),
      'site/index.html': '<h1>actual</h1>',
      'site/oasis-test.json': JSON.stringify({
        version: 1,
        steps: [{ action: 'text', selector: 'h1', text: 'expected' }],
      }),
    });
    const input = {
      runId: access.artifactId,
      payerId: access.ownerId,
      taskId: access.taskId,
    };
    try {
      const result = await service.checkLive({ ...input, dir: 'site' });
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('实际为「actual」');
      expect(result.reason).toContain('页面错误：boom');
      expect(test).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledTimes(1);
      // 每次自查一条新的预览记录，用完即停
      expect([...rows.values()].every((row) => row.artifactId !== access.artifactId)).toBe(true);
      expect([...rows.values()].map((row) => row.status)).toEqual(['stopped']);
      const missing = await service.checkLive({ ...input, dir: 'other' });
      expect(missing).toEqual({
        passed: false,
        reason: expect.stringContaining('out/other 里没有 oasis-app.json'),
        frameCaptured: false,
      });
    } finally {
      await service.close();
    }
  });
  it('外站代理拒绝非白名单、写请求、内网地址及非 HTTPS', async () => {
    expect(() => websiteUrl('https://evil.example', ['https://example.com'])).toThrow();
    expect(() => websiteUrl('http://example.com', ['http://example.com'])).toThrow();
    const get = createWebsiteFetch(['https://127.0.0.1', 'https://169.254.169.254']);
    await expect(get({ url: 'https://127.0.0.1', method: 'GET' })).rejects.toThrow('公网');
    await expect(get({ url: 'https://169.254.169.254', method: 'GET' })).rejects.toThrow('公网');
    await expect(get({ url: 'https://127.0.0.1', method: 'POST' })).rejects.toThrow('限制');
  });
  it('业务断言失败会失败关卡，仍然停止并结算；报告读取校验属主', async () => {
    const { service, test, destroy } = fixture({
      'site/oasis-app.json': JSON.stringify({
        version: 1,
        kind: 'static',
        root: 'site',
        entry: 'index.html',
      }),
      'site/index.html': '<h1>actual</h1>',
      'site/oasis-test.json': JSON.stringify({
        version: 1,
        steps: [{ action: 'text', selector: 'h1', text: 'expected' }],
      }),
    });
    const input = { runId: access.artifactId, payerId: access.ownerId, taskId: access.taskId };
    try {
      const result = await service.checkRun(input);
      expect(result.passed).toBe(false);
      // 失败原因说清楚哪一步、看到了什么，以及页面自己报的错
      expect(result.reason).toBe(
        '第 1 步 text h1：等到页面安定后文字不含「expected」，实际为「actual」；页面诊断：页面错误：boom（共 2 次）',
      );
      expect(result.application).toMatchObject({
        manifestPath: 'site/oasis-app.json',
        spec: { version: 1, kind: 'static', root: 'site', entry: 'index.html' },
        files: expect.arrayContaining(['site/index.html', 'site/oasis-test.json']),
        plan: { version: 1, steps: [{ action: 'text', selector: 'h1', text: 'expected' }] },
        network: 'none',
      });
      expect(result.inputSha256).toMatch(/^[a-f0-9]{64}$/);
      // 首屏画面和步骤截图随结果返回（报告留档供下载）
      expect(result.screenshots).toEqual([
        { name: 'opening.jpg', base64: 'AA==' },
        { name: 'step-0.jpg', base64: '/9j/2Q==' },
      ]);
      expect(test).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledTimes(1);
      await expect(service.report({ ...input, payerId: access.taskId })).rejects.toThrow(
        '没有这次运行',
      );
    } finally {
      await service.close();
    }
  });
  it('检查不设时限：用户停止时断开即回收浏览器；检查用的浏览器自己退出记为未完成', async () => {
    const manifest = {
      'site/oasis-app.json': JSON.stringify({
        version: 1,
        kind: 'static',
        root: 'site',
        entry: 'index.html',
      }),
      'site/index.html': '<h1>actual</h1>',
      'site/oasis-test.json': JSON.stringify({
        version: 1,
        steps: [{ action: 'visible', selector: 'h1' }],
      }),
    };
    const { service, test, destroy } = fixture(manifest);
    const input = { runId: access.artifactId, payerId: access.ownerId, taskId: access.taskId };
    try {
      let rejectTest!: (error: Error) => void;
      test.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectTest = reject;
          }),
      );
      destroy.mockImplementationOnce(async () => {
        rejectTest(new Error('浏览器测试进程提前结束'));
        return undefined;
      });
      const abort = new AbortController();
      const checking = service.checkRun({ ...input, signal: abort.signal });
      await vi.waitFor(() => expect(test).toHaveBeenCalledTimes(1));
      abort.abort();
      await expect(checking).rejects.toMatchObject({ statusCode: 499, code: 'check_aborted' });
      expect(destroy).toHaveBeenCalled();
    } finally {
      await service.close();
    }
    const dead = fixture(manifest);
    dead.setAlive(false);
    try {
      await expect(dead.service.checkRun(input)).rejects.toMatchObject({
        statusCode: 503,
        code: 'check_incomplete',
      });
      expect(dead.test).not.toHaveBeenCalled();
    } finally {
      await dead.service.close();
    }
  });

  it('不合法计划在启动和冻结前拒绝', async () => {
    const { service, start, modelGateway } = fixture({
      'site/oasis-app.json': JSON.stringify({
        version: 1,
        kind: 'static',
        root: 'site',
        entry: 'index.html',
      }),
      'site/index.html': '<h1>actual</h1>',
      'site/oasis-test.json': '{"version":1,"steps":[{"action":"eval","script":"anything"}]}',
    });
    try {
      expect(
        (
          await service.checkRun({
            runId: access.artifactId,
            payerId: access.ownerId,
            taskId: access.taskId,
          })
        ).passed,
      ).toBe(false);
      expect(start).not.toHaveBeenCalled();
      expect(modelGateway.json).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });
  it('重复启动同一会话，停止后结算一次并可重开；任务删除后记录不留', async () => {
    const { service, start, destroy, modelGateway, rows } = fixture();
    try {
      const first = await service.start(access);
      expect(first.status).toBe('running');
      expect(first.heldMicro).toBe(500);
      expect((await service.start(access)).id).toBe(first.id);
      expect(start).toHaveBeenCalledTimes(1);
      expect((await service.frame(access)).seq).toBe(1);
      const stopped = await service.stop(access);
      expect(stopped.spentMicro).toBe(25);
      expect((await service.stop(access)).id).toBe(first.id);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(
        vi
          .mocked(modelGateway.json)
          .mock.calls.filter(
            ([method, path]) => method === 'POST' && String(path).endsWith('/settle'),
          ),
      ).toHaveLength(1);
      expect((await service.start(access)).id).not.toBe(first.id);
      // 任务删除：停掉、结算，再把记录真删除
      await service.stopTask(access.taskId);
      expect(rows.size).toBe(0);
    } finally {
      await service.close();
    }
  });
  it('重启回收活动容器，结算后清理孤儿容器', async () => {
    const { service, executor } = fixture();
    await service.start(access);
    await service.recover();
    expect((await service.current(access))?.status).toBe('stopped');
    expect(executor.removeOrphans).toHaveBeenCalledTimes(1);
    await service.close();
  });
});
