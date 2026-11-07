import type { ServiceClient } from '@oasis/service-kit';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/service/tools.ts';

const tool = TOOLS.find((t) => t.key === 'app.check')!;
const IDS = {
  payerId: '00000000-0000-4000-8000-000000000001',
  taskId: '00000000-0000-4000-8000-000000000002',
  runId: '00000000-0000-4000-8000-000000000003',
};

function fakeHarness(result: unknown) {
  const calls: { path: string; body: unknown }[] = [];
  const harness = {
    stream: async (_method: string, path: string, options: { body: unknown }) => {
      calls.push({ path, body: options.body });
      return Response.json(result);
    },
  } as unknown as ServiceClient;
  return { harness, calls };
}

const run = (harness: ServiceClient, dir: string, ids: Partial<typeof IDS> = IDS) =>
  (
    tool as unknown as { run: (deps: unknown, args: { dir: string }) => Promise<{ text: string }> }
  ).run({ harness, ...ids, upstream: (request: () => Promise<Response>) => request() }, { dir });

describe('网页应用自查 app.check（ADR 0017）', () => {
  it('读调用它的那次运行沙箱里的目录，--dir 可以带 out/ 前缀', async () => {
    const { harness, calls } = fakeHarness({ passed: true, reason: null, frameCaptured: true });
    const result = await run(harness, 'out/site/');
    expect(calls).toEqual([
      {
        path: `/internal/runs/${IDS.runId}/application-check/live`,
        body: { payerId: IDS.payerId, taskId: IDS.taskId, dir: 'site' },
      },
    ]);
    expect(result.text).toContain('浏览器检查通过');
  });
  it('没通过时把原因、失败步骤和没检查到的地方原样交回节点', async () => {
    const { harness } = fakeHarness({
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
    });
    const { text } = await run(harness, 'site');
    expect(text).toContain('THREE is not defined');
    expect(text).toContain('第 2 步 click：找不到 #start');
    expect(text).toContain('没检查到：音频未检查');
  });
  it('不在任务节点里调用时拒绝', async () => {
    const { harness } = fakeHarness({});
    await expect(run(harness, 'site', { payerId: IDS.payerId })).rejects.toMatchObject({
      code: 'run_required',
    });
  });
});
