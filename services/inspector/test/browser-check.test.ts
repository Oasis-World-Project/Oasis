// 网页的浏览器检查（ADR 0017、0021、0024）：交付关卡读运行产出包、节点自查用随调用带来的文件、外站测试。
// 检查浏览器用假的：真容器里的检查由 pnpm browser:smoke 和全链路回归覆盖。
import { Readable } from 'node:stream';
import type { BrowserTestPlan } from '@oasis/contracts/ui-test';
import { packFiles } from '@oasis/service-kit';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserChecks } from '../src/browser/browser-check.ts';
import type { BrowserExecutor } from '../src/browser/executor.ts';
import { createWebsiteFetch, websiteUrl } from '../src/browser/website-fetch.ts';
import type { Sources } from '../src/service/sources.ts';

const SOURCE = { url: 'http://store.test/runs/1/outputs.tar' };
/** 交付关卡：检查产出包里 out/site 的应用 */
const gate = (cores = 2) => ({ source: SOURCE, manifest: 'site/oasis-app.json', cores });

function fixture(
  files: Record<string, string> = {},
  options: { concurrency?: number; websiteOrigins?: string[] } = {},
) {
  const destroy = vi.fn(async () => undefined);
  const test = vi.fn(async () => ({
    report: {
      version: 1 as const,
      target: 'application' as const,
      passed: false,
      steps: [
        {
          index: 0,
          action: 'text' as const,
          status: 'failed' as const,
          error: '第 1 步 text h1：等到页面安定后文字不含「expected」，实际为「actual」',
        },
      ],
      diagnostics: [] as string[],
      unchecked: [] as string[],
    },
    screenshots: [{ name: 'step-0.jpg', base64: '/9j/2Q==' }],
  }));
  let alive = true;
  const look = vi.fn(async (): Promise<{ blank: boolean; color?: string }> => ({ blank: false }));
  const start = vi.fn(async (_spec: Parameters<BrowserExecutor['start']>[0]) => ({
    id: 'container-1',
    frame: () => ({ seq: 1, jpegBase64: 'AA==' }),
    look,
    ready: async () => undefined,
    diagnostics: () => ['页面错误：boom（共 2 次）'],
    alive: () => alive,
    test,
    destroy,
  }));
  const check = vi.fn(async () => undefined);
  const executor = { check, start } as unknown as BrowserExecutor;
  // 和 harness 存的 outputs.tar 一样：第一层是 out/
  const opened: string[] = [];
  const sources = {
    async open(url: string) {
      opened.push(url);
      const entries = Object.entries(files).map(([path, content]) => ({
        path: `out/${path}`,
        content: Buffer.from(content),
      }));
      return Readable.from([await packFiles(entries)]);
    },
  } as unknown as Sources;
  const checks = createBrowserChecks({
    executor,
    sources,
    websiteOrigins: options.websiteOrigins ?? [],
    maxArchiveBytes: 200 * 1024 * 1024,
    concurrency: options.concurrency ?? 3,
  });
  return {
    checks,
    start,
    check,
    destroy,
    test,
    look,
    opened,
    setAlive: (value: boolean) => {
      alive = value;
    },
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

/** 节点自查带来的文件：沙箱里的 oasis-tool 读好 out/<dir>，路径相对 dir */
const uploaded = (files: Record<string, string>, dir = 'site') =>
  Object.entries(files)
    .filter(([path]) => path.startsWith(`${dir}/`))
    .map(([path, content]) => ({
      path: path.slice(dir.length + 1),
      contentBase64: Buffer.from(content).toString('base64'),
    }));

describe('网页的浏览器检查', () => {
  it('清单字段缺失给出实际路径与字段错误，不开浏览器、不计算力', async () => {
    const { checks, start, opened } = fixture({
      'site/oasis-app.json': JSON.stringify({ version: 1, kind: 'static', entry: 'index.html' }),
      'site/index.html': '<h1>actual</h1>',
    });
    const result = await checks.checkOutputs(gate());
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('root');
    expect(result.reason).toContain('out/site/oasis-app.json');
    expect(result.reason).toContain('in/.oasis-formats.json');
    expect(result.usage).toEqual({ cores: 2, elapsedMs: 0 });
    expect(opened).toEqual([SOURCE.url]);
    expect(start).not.toHaveBeenCalled();
  });

  it('产出包里没有这份清单：报错，由关卡记为没检查到', async () => {
    const { checks, start } = fixture(staticApp({ 'site/index.html': '<h1>ok</h1>' }));
    await expect(
      checks.checkOutputs({ ...gate(), manifest: 'other/oasis-app.json' }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'manifest_missing' });
    expect(start).not.toHaveBeenCalled();
  });

  it('节点自查用随调用带来的文件跑同一套检查，不留档；目录里没有清单时直接说明', async () => {
    const app = testedApp([{ action: 'text', selector: 'h1', text: 'expected' }]);
    const { checks, test, destroy, opened } = fixture();
    const result = await checks.checkFiles({ dir: 'site', files: uploaded(app), cores: 1 });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('实际为「actual」');
    expect(result.reason).toContain('页面错误：boom');
    // 当场看结论就够了：不带留档用的应用、摘要和截图
    expect(result.application).toBeUndefined();
    expect(result.screenshots).toBeUndefined();
    expect(result.usage.cores).toBe(1);
    expect(test).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(opened).toEqual([]);
    const missing = await checks.checkFiles({
      dir: 'other',
      files: [{ path: 'index.html', contentBase64: 'AA==' }],
      cores: 1,
    });
    expect(missing).toEqual({
      passed: false,
      reason: expect.stringContaining('out/other 里没有 oasis-app.json'),
      frameCaptured: false,
      usage: { cores: 1, elapsedMs: 0 },
    });
  });

  it('静态网页按画布的方式打开：入口换成只放隔离框的外壳，多文件模块也一并装进框里（ADR 0021）', async () => {
    const app = staticApp({
      'site/index.html':
        '<script type="importmap">{"imports":{"three":"./js/three.js"}}</script><script type="module" src="./js/app.js"></script>',
      'site/js/app.js': "import * as T from 'three'; T.go();",
      'site/js/three.js': "export const go = () => document.body.append('ok');",
    });
    const { checks, start } = fixture();
    const result = await checks.checkFiles({ dir: 'site', files: uploaded(app), cores: 1 });
    expect(result.reason).toContain('页面错误：boom');
    const spec = start.mock.calls[0]![0];
    expect(spec).toMatchObject({ cores: 1, kind: 'static', entry: 'index.html' });
    const entry = spec.files.find((file) => file.path === 'index.html')!.content.toString('utf8');
    expect(entry).toContain(
      '<iframe title="oasis-live" sandbox="allow-scripts allow-pointer-lock"',
    );
    expect(entry).toContain('Content-Security-Policy');
    expect(entry).toContain('oasis-file:/js/three.js');
    // 其余交付文件原样带上
    expect(spec.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(['js/app.js', 'js/three.js', 'oasis-app.json']),
    );
  });

  it('画布里加载不了的文件、放错目录的测试计划，开浏览器前就说清楚', async () => {
    const broken = fixture(
      staticApp({
        'site/index.html': '<script type="module" src="./app.js"></script>',
        'site/app.js': "import { x } from './gone.js'; x();",
      }),
    );
    const result = await broken.checks.checkOutputs(gate());
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('这些文件在画布里加载不了：site/gone.js');
    expect(result.reason).toContain('fetch/XHR');
    expect(broken.start).not.toHaveBeenCalled();
    // 测试计划放在应用目录外：产出包里别处的文件也要认得出来
    const misplaced = fixture(
      staticApp({
        'site/index.html': '<h1>ok</h1>',
        'oasis-test.json': JSON.stringify({
          version: 1,
          steps: [{ action: 'visible', selector: 'h1' }],
        }),
      }),
    );
    expect((await misplaced.checks.checkOutputs(gate())).reason).toBe(
      'oasis-test.json 放在了 out/oasis-test.json，要和 oasis-app.json 一起放进 out/site/ 才会执行。',
    );
    expect(misplaced.start).not.toHaveBeenCalled();
  });

  it('画面一直是一整片纯色时检查不通过（ADR 0021）', async () => {
    const { checks, look } = fixture(staticApp({ 'site/index.html': '<canvas></canvas>' }));
    look.mockResolvedValueOnce({ blank: true, color: '#080808' });
    const result = await checks.checkOutputs(gate());
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('画面检查：打开后一直是一整片纯色（#080808）');
    expect(result.report?.unchecked[0]).toContain('要和 oasis-app.json 放在同一目录');
  });

  it('外站代理拒绝非白名单、写请求、内网地址及非 HTTPS', async () => {
    expect(() => websiteUrl('https://evil.example', ['https://example.com'])).toThrow();
    expect(() => websiteUrl('http://example.com', ['http://example.com'])).toThrow();
    const get = createWebsiteFetch(['https://127.0.0.1', 'https://169.254.169.254']);
    await expect(get({ url: 'https://127.0.0.1', method: 'GET' })).rejects.toThrow('公网');
    await expect(get({ url: 'https://169.254.169.254', method: 'GET' })).rejects.toThrow('公网');
    await expect(get({ url: 'https://127.0.0.1', method: 'POST' })).rejects.toThrow('限制');
  });

  it('交付关卡：业务断言失败说清楚哪一步，结论带上检查的应用、输入摘要和平台截的画面，报回实际用量', async () => {
    const { checks, test, destroy, start } = fixture(
      testedApp([{ action: 'text', selector: 'h1', text: 'expected' }]),
    );
    const result = await checks.checkOutputs(gate());
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
    // 首屏画面和步骤截图随结果返回（task 存回 harness 供下载）
    expect(result.screenshots).toEqual([
      { name: 'opening.jpg', base64: 'AA==' },
      { name: 'step-0.jpg', base64: '/9j/2Q==' },
    ]);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ cores: 2 }));
    expect(result.usage.cores).toBe(2);
    expect(result.usage.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(test).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('检查不设时限：调用方断开即回收浏览器；检查用的浏览器自己退出记为未完成', async () => {
    const app = testedApp([{ action: 'visible', selector: 'h1' }]);
    const { checks, test, destroy } = fixture(app);
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
    const checking = checks.checkOutputs(gate(), abort.signal);
    await vi.waitFor(() => expect(test).toHaveBeenCalledTimes(1));
    abort.abort();
    await expect(checking).rejects.toMatchObject({ statusCode: 499, code: 'check_aborted' });
    expect(destroy).toHaveBeenCalled();
    const dead = fixture(app);
    dead.setAlive(false);
    await expect(dead.checks.checkOutputs(gate())).rejects.toMatchObject({
      statusCode: 503,
      code: 'check_incomplete',
    });
    expect(dead.test).not.toHaveBeenCalled();
    expect(dead.destroy).toHaveBeenCalled();
  });

  it('不合法计划在开浏览器前拒绝', async () => {
    const { checks, start } = fixture(
      staticApp({
        'site/index.html': '<h1>actual</h1>',
        'site/oasis-test.json': '{"version":1,"steps":[{"action":"eval","script":"anything"}]}',
      }),
    );
    const result = await checks.checkOutputs(gate());
    expect(result.passed).toBe(false);
    expect(result.usage.elapsedMs).toBe(0);
    expect(start).not.toHaveBeenCalled();
  });

  it('同时开的检查浏览器有上限，多出的排队；各开各的浏览器、各报各的用量', async () => {
    const app = testedApp([{ action: 'visible', selector: 'h1' }]);
    const { checks, start, test, destroy } = fixture(app, { concurrency: 1 });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = test.getMockImplementation()!;
    test.mockImplementation(async () => {
      await hold;
      return original();
    });
    const both = Promise.all([
      checks.checkFiles({ dir: 'site', files: uploaded(app), cores: 1 }),
      checks.checkOutputs(gate(2)),
    ]);
    await vi.waitFor(() => expect(test).toHaveBeenCalledTimes(1));
    // 第二个还在排队，没开浏览器
    expect(start).toHaveBeenCalledTimes(1);
    release();
    const results = await both;
    expect(results.map((result) => result.passed)).toEqual([false, false]);
    expect(results.map((result) => result.usage.cores)).toEqual([1, 2]);
    expect(start).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it('检查浏览器用不了时说明白（503），不开容器；容器没开成照实报错', async () => {
    const { checks, check, start } = fixture(testedApp([{ action: 'visible', selector: 'h1' }]));
    check.mockRejectedValueOnce(
      new Error(
        '检查浏览器镜像 oasis/inspector-browser:1.64.0 不存在，请先运行 pnpm browser:build',
      ),
    );
    await expect(checks.checkOutputs(gate())).rejects.toMatchObject({
      statusCode: 503,
      code: 'browser_unavailable',
      message: expect.stringContaining('pnpm browser:build'),
    });
    expect(start).not.toHaveBeenCalled();
    start.mockRejectedValueOnce(new Error('Docker 不可用'));
    await expect(checks.checkOutputs(gate())).rejects.toThrow('Docker 不可用');
  });

  it('外站测试只访问放行的来源；页面自己打不开算测试没通过；报回用量', async () => {
    const { checks, start, test } = fixture({}, { websiteOrigins: ['https://example.com'] });
    const plan: BrowserTestPlan = { version: 1, steps: [{ action: 'visible', selector: 'h1' }] };
    await expect(
      checks.checkWebsite({ url: 'https://evil.example/', plan, cores: 1 }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'website_not_allowed' });
    expect(start).not.toHaveBeenCalled();
    const result = await checks.checkWebsite({ url: 'https://example.com/', plan, cores: 1 });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'website',
        cores: 1,
        website: expect.objectContaining({ url: 'https://example.com/' }),
      }),
    );
    // 页面诊断里有报错：测试不通过
    expect(result.report.passed).toBe(false);
    expect(result.report.unchecked).toContain(
      '仅测试放行来源的 HTTPS GET/HEAD；登录、写请求、WebSocket 和 IPv6 未检查',
    );
    expect(result.usage.cores).toBe(1);
    test.mockRejectedValueOnce(new Error('首页返回 502'));
    await expect(
      checks.checkWebsite({ url: 'https://example.com/', plan, cores: 1 }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'website_failed' });
  });
});
