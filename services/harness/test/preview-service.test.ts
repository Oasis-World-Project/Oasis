import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { ServiceClient, ObjectStore } from '@oasis/service-kit';
import type { RunService } from '../src/service/run-service.ts';
import type { PreviewExecutor } from '../src/executor/preview-executor.ts';
import type { BrowserRepo, BrowserRow } from '../src/repo/browser-repo.ts';
import { createPreviewService } from '../src/service/preview-service.ts';
import { createWebsiteFetch, websiteUrl } from '../src/executor/website-fetch.ts';

const RUN = '00000000-0000-4000-8000-000000000001';
const PAYER = '00000000-0000-4000-8000-000000000002';
const TASK = '00000000-0000-4000-8000-000000000003';
const CALL = '00000000-0000-4000-8000-000000000004';
const input = { runId: RUN, payerId: PAYER, taskId: TASK };
const ACTIVE = ['starting', 'running', 'stopping'];

function fixture(files?: Record<string, string>) {
  const rows = new Map<string, BrowserRow>();
  // 和数据库一样，读出来的是快照
  const repo: BrowserRepo = {
    async insert(value) {
      rows.set(value.id, {
        ...value,
        status: 'starting',
        containerId: null,
        computeCallId: null,
        heldMicro: 0,
        spentMicro: null,
        startedAt: null,
        stoppedAt: null,
        error: null,
        createdAt: new Date(),
      });
    },
    async get(id) {
      const row = rows.get(id);
      return row && { ...row };
    },
    async update(id, patch) {
      Object.assign(rows.get(id)!, patch);
    },
    async unfinished() {
      return [...rows.values()]
        .filter((row) => ACTIVE.includes(row.status))
        .map((row) => ({ ...row }));
    },
    async removeFinished(taskId) {
      for (const [id, row] of rows)
        if (row.taskId === taskId && !ACTIVE.includes(row.status)) rows.delete(id);
    },
  };
  const destroy = vi.fn(async (_id?: string) => undefined);
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
  const look = vi.fn(async (): Promise<{ blank: boolean; color?: string }> => ({ blank: false }));
  const start = vi.fn(async () => ({
    id: 'container-1',
    frame: () => ({ seq: 1, jpegBase64: 'AA==' }),
    look,
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
  const modelGateway = {
    json: vi.fn(async (method: string, path: string) => {
      if (method === 'POST' && path === '/internal/v1/compute')
        return { callId: CALL, heldMicro: 500 };
      if (method === 'GET') return { status: 'succeeded', chargedMicro: 25 };
      return undefined;
    }),
  } as unknown as ServiceClient;
  const service = createPreviewService({
    repo,
    executor,
    modelGateway,
    logger: pino({ level: 'silent' }),
    cpus: 2,
    maxMs: 60_000,
    runs: {
      get: async () => ({
        payerId: PAYER,
        taskId: TASK,
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
  /** 发出去的算力结算（POST …/settle 的请求体） */
  const settles = () =>
    vi
      .mocked(modelGateway.json)
      .mock.calls.filter(([method, path]) => method === 'POST' && String(path).endsWith('/settle'))
      .map((call) => (call[2] as { body: unknown }).body);
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
    look,
    settles,
  };
}

const staticApp = (files: Record<string, string>) => ({
  'site/oasis-app.json': JSON.stringify({
    version: 1,
    kind: 'static',
    root: 'site',
    entry: 'index.html',
  }),
  ...files,
});

/** 带测试计划的网页：检查会走到 box.test */
const testedApp = (steps: unknown[]) =>
  staticApp({
    'site/index.html': '<h1>actual</h1>',
    'site/oasis-test.json': JSON.stringify({ version: 1, steps }),
  });

describe('隔离浏览器检查', () => {
  it('清单字段缺失给出实际路径与字段错误，在启动和冻结前拒绝', async () => {
    const { service, start, modelGateway, rows } = fixture({
      'site/oasis-app.json': JSON.stringify({ version: 1, kind: 'static', entry: 'index.html' }),
      'site/index.html': '<h1>actual</h1>',
    });
    try {
      const result = await service.checkRun(input);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('root');
      expect(result.reason).toContain('out/site/oasis-app.json');
      expect(result.reason).toContain('in/.oasis-formats.json');
      expect(start).not.toHaveBeenCalled();
      expect(modelGateway.json).not.toHaveBeenCalled();
      expect(rows.size).toBe(0);
    } finally {
      await service.close();
    }
  });
  it('节点自查读运行中沙箱的目录，跑同一套浏览器检查，不留档；目录里没有清单时直接说明', async () => {
    const { service, test, destroy, rows } = fixture(
      testedApp([{ action: 'text', selector: 'h1', text: 'expected' }]),
    );
    try {
      const result = await service.checkLive({ ...input, dir: 'site' });
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('实际为「actual」');
      expect(result.reason).toContain('页面错误：boom');
      expect(test).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledTimes(1);
      // 每次检查开一个浏览器，用完即停、结算
      expect([...rows.values()]).toMatchObject([
        { payerId: PAYER, taskId: TASK, status: 'stopped', heldMicro: 500, spentMicro: 25 },
      ]);
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
  it('静态网页按画布的方式打开：入口换成只放隔离框的外壳，多文件模块也一并装进框里（ADR 0021）', async () => {
    const { service, start } = fixture(
      staticApp({
        'site/index.html':
          '<script type="importmap">{"imports":{"three":"./js/three.js"}}</script><script type="module" src="./js/app.js"></script>',
        'site/js/app.js': "import * as T from 'three'; T.go();",
        'site/js/three.js': "export const go = () => document.body.append('ok');",
      }),
    );
    try {
      expect((await service.checkLive({ ...input, dir: 'site' })).reason).toContain(
        '页面错误：boom',
      );
      const files = (
        start.mock.calls[0] as unknown as [{ files: { path: string; content: Buffer }[] }]
      )[0].files;
      const entry = files.find((file) => file.path === 'index.html')!.content.toString('utf8');
      expect(entry).toContain(
        '<iframe title="oasis-live" sandbox="allow-scripts allow-pointer-lock"',
      );
      expect(entry).toContain('Content-Security-Policy');
      expect(entry).toContain('oasis-file:/js/three.js');
      // 其余交付文件原样带上
      expect(files.map((file) => file.path)).toEqual(
        expect.arrayContaining(['js/app.js', 'js/three.js', 'oasis-app.json']),
      );
    } finally {
      await service.close();
    }
  });
  it('画布里加载不了的文件、放错目录的测试计划，在启动和冻结前就说清楚', async () => {
    const broken = fixture(
      staticApp({
        'site/index.html': '<script type="module" src="./app.js"></script>',
        'site/app.js': "import { x } from './gone.js'; x();",
      }),
    );
    try {
      const result = await broken.service.checkRun(input);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('这些文件在画布里加载不了：site/gone.js');
      expect(result.reason).toContain('fetch/XHR');
      expect(broken.start).not.toHaveBeenCalled();
    } finally {
      await broken.service.close();
    }
    const misplaced = fixture(
      staticApp({
        'site/index.html': '<h1>ok</h1>',
        'oasis-test.json': JSON.stringify({
          version: 1,
          steps: [{ action: 'visible', selector: 'h1' }],
        }),
      }),
    );
    try {
      const result = await misplaced.service.checkRun(input);
      expect(result.reason).toBe(
        'oasis-test.json 放在了 out/oasis-test.json，要和 oasis-app.json 一起放进 out/site/ 才会执行。',
      );
      expect(misplaced.start).not.toHaveBeenCalled();
    } finally {
      await misplaced.service.close();
    }
  });
  it('画面一直是一整片纯色时检查不通过（ADR 0021）', async () => {
    const { service, look } = fixture(staticApp({ 'site/index.html': '<canvas></canvas>' }));
    look.mockResolvedValueOnce({ blank: true, color: '#080808' });
    try {
      const result = await service.checkRun(input);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('画面检查：打开后一直是一整片纯色（#080808）');
      expect(result.report?.unchecked[0]).toContain('要和 oasis-app.json 放在同一目录');
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
    const { service, test, destroy, settles } = fixture(
      testedApp([{ action: 'text', selector: 'h1', text: 'expected' }]),
    );
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
      expect(settles()).toHaveLength(1);
      await expect(service.report({ ...input, payerId: TASK })).rejects.toThrow('没有这次运行');
    } finally {
      await service.close();
    }
  });
  it('检查不设时限：用户停止时断开即回收浏览器；检查用的浏览器自己退出记为未完成', async () => {
    const app = testedApp([{ action: 'visible', selector: 'h1' }]);
    const { service, test, destroy, rows } = fixture(app);
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
      expect([...rows.values()].map((row) => row.status)).toEqual(['stopped']);
    } finally {
      await service.close();
    }
    const dead = fixture(app);
    dead.setAlive(false);
    try {
      await expect(dead.service.checkRun(input)).rejects.toMatchObject({
        statusCode: 503,
        code: 'check_incomplete',
      });
      expect(dead.test).not.toHaveBeenCalled();
      expect([...dead.rows.values()].map((row) => row.status)).toEqual(['stopped']);
    } finally {
      await dead.service.close();
    }
  });

  it('不合法计划在启动和冻结前拒绝', async () => {
    const { service, start, modelGateway } = fixture(
      staticApp({
        'site/index.html': '<h1>actual</h1>',
        'site/oasis-test.json': '{"version":1,"steps":[{"action":"eval","script":"anything"}]}',
      }),
    );
    try {
      expect((await service.checkRun(input)).passed).toBe(false);
      expect(start).not.toHaveBeenCalled();
      expect(modelGateway.json).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });
  it('同一付费人可以同时做多个检查，各开各的浏览器、各自结算；任务删除后记录不留', async () => {
    const { service, start, test, destroy, rows, settles } = fixture(
      testedApp([{ action: 'visible', selector: 'h1' }]),
    );
    try {
      // 两个检查都打开浏览器、做到一半时再放行
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = test.getMockImplementation()!;
      test.mockImplementation(async () => {
        await gate;
        return original();
      });
      const both = Promise.all([
        service.checkLive({ ...input, dir: 'site' }),
        service.checkRun(input),
      ]);
      await vi.waitFor(() => expect(test).toHaveBeenCalledTimes(2));
      expect([...rows.values()].map((row) => row.status)).toEqual(['running', 'running']);
      release();
      expect((await both).map((result) => result.passed)).toEqual([false, false]);
      expect(start).toHaveBeenCalledTimes(2);
      expect(destroy).toHaveBeenCalledTimes(2);
      expect(settles()).toHaveLength(2);
      expect([...rows.values()]).toMatchObject([
        { status: 'stopped', spentMicro: 25 },
        { status: 'stopped', spentMicro: 25 },
      ]);
      // 任务删除（ADR 0012）：结束了的记录真删除
      await service.stopTask(TASK);
      expect(rows.size).toBe(0);
    } finally {
      await service.close();
    }
  });
  it('浏览器没开成：记为失败、留下原因，冻结按 0 时长结清', async () => {
    const { service, start, rows, settles } = fixture(
      testedApp([{ action: 'visible', selector: 'h1' }]),
    );
    start.mockRejectedValueOnce(new Error('Docker 不可用'));
    try {
      await expect(service.checkRun(input)).rejects.toThrow('Docker 不可用');
      expect([...rows.values()]).toMatchObject([
        { status: 'failed', error: 'Docker 不可用', containerId: null },
      ]);
      expect(settles()).toEqual([{ cores: 2, elapsedMs: 0 }]);
    } finally {
      await service.close();
    }
  });
  it('重启后停掉上次留下的浏览器并结算（停到一半的按记下的销毁时间算），再清掉没有记录的容器', async () => {
    const { service, executor, destroy, rows, settles } = fixture();
    const leftover = {
      payerId: PAYER,
      taskId: TASK,
      computeCallId: CALL,
      heldMicro: 500,
      spentMicro: null,
      error: null,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    rows.set('a', {
      ...leftover,
      id: 'a',
      status: 'running',
      containerId: 'old-a',
      stoppedAt: null,
    });
    rows.set('b', {
      ...leftover,
      id: 'b',
      status: 'stopping',
      containerId: null,
      stoppedAt: new Date('2026-01-01T00:00:30Z'),
    });
    try {
      await service.recover();
      expect(destroy).toHaveBeenCalledWith('old-a');
      expect([...rows.values()]).toMatchObject([
        { id: 'a', status: 'stopped', error: '服务重启，检查已停止', spentMicro: 25 },
        { id: 'b', status: 'stopped', error: null, spentMicro: 25 },
      ]);
      // 运行中的按最长时长封顶；停到一半的按当时记下的销毁时间结算，重试不多算
      expect(settles()).toEqual([
        { cores: 2, elapsedMs: 60_000 },
        { cores: 2, elapsedMs: 30_000 },
      ]);
      expect(executor.removeOrphans).toHaveBeenCalledWith(new Set());
    } finally {
      await service.close();
    }
  });
});
