// 浏览器检查工具（ADR 0017、0024）：app.check 把沙箱带来的文件交给 inspector，website.test 交网址和计划；
// 检查浏览器的算力由网关冻结、按 inspector 报回的实际用时结算，记在调用的任务和节点上。
import { HttpError, type ServiceClient } from '@oasis/service-kit';
import { describe, expect, it, vi } from 'vitest';
import { TOOLS } from '../src/service/tools.ts';

const IDS = {
  payerId: '00000000-0000-4000-8000-000000000001',
  taskId: '00000000-0000-4000-8000-000000000002',
  runId: '00000000-0000-4000-8000-000000000003',
  nodeId: '00000000-0000-4000-8000-000000000004',
};
const FILES = [
  { path: 'oasis-app.json', contentBase64: 'e30=' },
  { path: 'index.html', contentBase64: 'PGgxPm9rPC9oMT4=' },
];

/** 假 inspector：记下请求，按给定的回答返回（Error 照 ServiceClient 的样子抛出） */
function fakeChecks(result: unknown) {
  const calls: { path: string; body: unknown }[] = [];
  const inspector = {
    stream: async (_method: string, path: string, options: { body: unknown }) => {
      calls.push({ path, body: options.body });
      if (result instanceof Error) throw result;
      return Response.json(result);
    },
  } as unknown as ServiceClient;
  const compute = {
    hold: vi.fn(async () => ({ callId: 'call-1', heldMicro: 30 })),
    settle: vi.fn(async () => undefined),
  };
  return { checks: { inspector, compute, cores: 2, maxMs: 3_600_000 }, calls, compute };
}

type Run = (
  deps: unknown,
  args: Record<string, unknown>,
) => Promise<{ text: string; data?: unknown }>;
const runOf = (key: string) => (TOOLS.find((t) => t.key === key) as unknown as { run: Run }).run;
const call = (
  key: string,
  checks: ReturnType<typeof fakeChecks>['checks'],
  args: Record<string, unknown>,
  ids: Partial<typeof IDS> = IDS,
) =>
  runOf(key)(
    {
      checks,
      ...ids,
      signal: new AbortController().signal,
      upstream: (request: () => Promise<Response>) => request(),
    },
    args,
  );

describe('网页应用自查 app.check（ADR 0017）', () => {
  it('沙箱带来的文件交给 inspector 检查，--dir 可以带 out/ 前缀；算力按实际用时记在任务和节点上', async () => {
    const { checks, calls, compute } = fakeChecks({
      passed: true,
      reason: null,
      frameCaptured: true,
      usage: { cores: 2, elapsedMs: 5000 },
    });
    const result = await call('app.check', checks, { dir: 'out/site/', files: FILES });
    expect(calls).toEqual([
      {
        path: '/internal/applications/check-files',
        body: { dir: 'site', files: FILES, cores: 2 },
      },
    ]);
    expect(result.text).toContain('浏览器检查通过');
    expect(compute.hold).toHaveBeenCalledWith(
      expect.objectContaining({
        payerId: IDS.payerId,
        taskId: IDS.taskId,
        nodeId: IDS.nodeId,
        cores: 2,
        maxMs: 3_600_000,
        purpose: 'application-check',
      }),
    );
    expect(compute.settle).toHaveBeenCalledWith('call-1', { cores: 2, elapsedMs: 5000 });
  });
  it('没通过时把原因、失败步骤和没检查到的地方原样交回节点', async () => {
    const { checks } = fakeChecks({
      passed: false,
      reason: '页面诊断：页面错误：THREE is not defined',
      frameCaptured: true,
      report: {
        version: 1,
        target: 'application',
        passed: false,
        steps: [{ index: 1, action: 'click', status: 'failed', error: '找不到 #start' }],
        diagnostics: ['页面错误：THREE is not defined'],
        unchecked: ['音频未检查'],
      },
      usage: { cores: 2, elapsedMs: 100 },
    });
    const { text } = await call('app.check', checks, { dir: 'site', files: FILES });
    expect(text).toContain('THREE is not defined');
    expect(text).toContain('第 2 步 click：找不到 #start');
    expect(text).toContain('没检查到：音频未检查');
  });
  it('不在任务节点里调用、旧版沙箱没带文件时拒绝，不开浏览器、不冻结算力', async () => {
    const { checks, calls, compute } = fakeChecks({});
    await expect(
      call('app.check', checks, { dir: 'site', files: FILES }, { payerId: IDS.payerId }),
    ).rejects.toMatchObject({ code: 'task_required' });
    await expect(call('app.check', checks, { dir: 'site' })).rejects.toMatchObject({
      code: 'sandbox_outdated',
      message: expect.stringContaining('pnpm sandbox:build'),
    });
    expect(calls).toEqual([]);
    expect(compute.hold).not.toHaveBeenCalled();
  });
  it('检查没做完（inspector 出错）不收算力钱', async () => {
    const { checks, compute } = fakeChecks(
      new HttpError(503, 'browser_unavailable', '检查浏览器镜像不存在'),
    );
    await expect(call('app.check', checks, { dir: 'site', files: FILES })).rejects.toMatchObject({
      code: 'browser_unavailable',
    });
    expect(compute.settle).toHaveBeenCalledWith('call-1', { cores: 2, elapsedMs: 0 });
  });
});

describe('外站浏览器测试 website.test', () => {
  it('网址和计划交给 inspector，带上核数；报告和截图交回节点，算力照样结算', async () => {
    const report = {
      version: 1,
      target: 'website',
      passed: true,
      steps: [],
      diagnostics: [],
      unchecked: [],
    };
    const { checks, calls, compute } = fakeChecks({
      report,
      screenshots: [{ name: 'step-0.jpg', base64: '/9j/2Q==' }],
      usage: { cores: 2, elapsedMs: 800 },
    });
    const plan = { version: 1, steps: [{ action: 'visible', selector: 'h1' }] };
    const result = await call('website.test', checks, { url: 'https://example.com/', plan });
    expect(calls).toEqual([
      {
        path: '/internal/websites/check',
        body: { url: 'https://example.com/', plan, cores: 2 },
      },
    ]);
    expect(result.data).toEqual(report);
    expect(compute.settle).toHaveBeenCalledWith('call-1', { cores: 2, elapsedMs: 800 });
  });
});
