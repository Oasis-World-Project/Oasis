// 工具运行（ADR 0025）：不起 dsh、不查模型目录，沙箱里跑步骤执行器；事件、结局、停止后接着做都和 AI 运行一样。
import { StartRunBody, TOOL_RUN_MODEL } from '@oasis/contracts/harness';
import { HttpError } from '@oasis/service-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STEPS_RUNNER } from '../src/executor/executor.ts';
import { stepEvent } from '../src/service/run/steps.ts';
import {
  base,
  destroyed,
  events,
  executor,
  finished,
  lifecycle,
  methods,
  rows,
  service,
  started,
  TOOL_ENVIRONMENT,
  until,
} from './support/run-fixture.ts';

const tool = (steps: { tool: string; args?: Record<string, unknown>; out?: string }[]) => ({
  ...base,
  model: TOOL_RUN_MODEL,
  prompt: '工具节点「拼成片」',
  steps,
});

beforeEach(() => {
  executor.environment = async () => TOOL_ENVIRONMENT;
});
afterEach(() => {
  delete executor.environment;
});

describe('工具运行', () => {
  it('跑步骤执行器而不是 dsh：步骤交进沙箱，过程记成事件，做完存产出', async () => {
    const run = await service.start(
      tool([
        { tool: 'video.generate', args: { prompt: '猫' }, out: 'out/1.mp4' },
        { tool: 'op.video.concat', args: { in: ['out/1.mp4', 'out/1.mp4'] }, out: 'out/成片.mp4' },
      ]),
    );
    const row = await finished(run.id);
    expect(row).toMatchObject({ status: 'succeeded', summary: '2 步都做完了。' });
    expect(row.outputs).toMatchObject([{ path: 'result.md' }]);
    expect(started[0]?.command).toEqual(['node', '--no-warnings', STEPS_RUNNER]);
    expect(methods).toEqual([]); // 没有 dsh
    const calls = events.filter((e) => e.kind === 'tool_call').map((e) => e.data.arguments);
    expect(calls).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'tool_result').every((e) => e.data.ok)).toBe(true);
  });

  it('有一步没做成：运行失败，原因是执行器给的', async () => {
    const run = await service.start(tool([{ tool: 'image.fail', args: {} }]));
    const row = await finished(run.id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('第 1 步（image.fail）没做成：供应商拒绝了提交');
  });

  it('镜像里没有步骤执行器：准入就拒绝，不登记运行', async () => {
    executor.environment = async () => ({ ...TOOL_ENVIRONMENT, capabilities: [] });
    const err = await service.start(tool([{ tool: 'web.search' }])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('execution_capability_unavailable');
    expect((err as HttpError).message).toContain('pnpm sandbox:build');
    expect(rows.size).toBe(0);
  });

  it('停止：存下已经做好的产出；继续时接着原工作目录，照样跑执行器（做完的步骤由它跳过）', async () => {
    const run = await service.start(tool([{ tool: 'video.slow' }]));
    await until(() => events.find((e) => e.kind === 'tool_call'));
    await service.stop(run.id);
    expect((await finished(run.id)).status).toBe('stopped');
    expect(lifecycle.slice(0, 3)).toEqual(['pause', 'archive', 'destroy']);
    expect(destroyed).toContain(run.id);
    const next = await service.start({
      ...tool([{ tool: 'video.generate' }]),
      continueFrom: run.id,
    });
    expect((await finished(next.id)).status).toBe('succeeded');
    expect(started[1]).toMatchObject({ workspaceId: run.id, restore: true });
    expect(started[1]?.command).toEqual(['node', '--no-warnings', STEPS_RUNNER]);
  });

  it('契约：工具运行必须带步骤、写 oasis/tool；别的运行不能带步骤', () => {
    const body = { payerId: base.payerId, prompt: 'p' };
    expect(StartRunBody.safeParse({ ...body, model: TOOL_RUN_MODEL }).success).toBe(false);
    expect(
      StartRunBody.safeParse({ ...body, model: 'deepseek/x', steps: [{ tool: 'web.search' }] })
        .success,
    ).toBe(false);
    expect(
      StartRunBody.safeParse({ ...body, model: TOOL_RUN_MODEL, steps: [{ tool: 'web.search' }] })
        .success,
    ).toBe(true);
    // 结果路径写在 out 里，不能强制重新提交
    expect(
      StartRunBody.safeParse({
        ...body,
        model: TOOL_RUN_MODEL,
        steps: [{ tool: 'web.search', args: { new: 'true' } }],
      }).success,
    ).toBe(false);
  });

  it('执行器的输出：认得的行记成事件，过长的截断，认不出的忽略', () => {
    expect(stepEvent('not json')).toBeUndefined();
    expect(stepEvent('{"type":"weird"}')).toBeUndefined();
    expect(stepEvent('{"type":"done","ok":true}')).toEqual({ kind: 'done', data: { ok: true } });
    const long = stepEvent(
      JSON.stringify({ type: 'tool_result', callId: 'c', ok: true, text: 'x'.repeat(30_000) }),
    );
    expect(long?.kind).toBe('tool_result');
    expect(String(long?.data.text)).toContain('（已截断）');
    expect(String(long?.data.text).length).toBeLessThan(21_000);
  });
});
