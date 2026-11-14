// 运行服务：一轮进行中的插话、停止、取消和重复提交。
import { HttpError } from '@oasis/service-kit';
import { describe, expect, it } from 'vitest';
import {
  fake,
  methods,
  started,
  destroyed,
  lifecycle,
  rows,
  events,
  finishes,
  stored,
  issued,
  revoked,
  service,
  until,
  finished,
  base,
} from './support/run-fixture.ts';

describe('对话里的一轮：插话、停止和取消', () => {
  it('进行中插话：排在用户的话之后处理，处理完才收尾；结束后再插话是 409', async () => {
    const run = await service.start({ ...base, prompt: '先做这个' });
    await until(() => events.find((e) => e.kind === 'user_message'));
    await service.message(run.id, '再补一句');
    const row = await finished(run.id);
    expect(row.status).toBe('succeeded');
    const said = events
      .filter((e) => e.kind === 'user_message')
      .map((e) => [e.data.text, e.data.interjection]);
    expect(said).toEqual([
      ['先做这个', undefined],
      ['再补一句', true],
    ]);
    const err = await service.message(run.id, '还在吗').catch((e: unknown) => e);
    expect((err as HttpError).statusCode).toBe(409);
  });

  it('AI 还没开始（排队、起沙箱、装 dsh）时插话：先存着，开头那句交出去后按顺序送到', async () => {
    const run = await service.start({ ...base, prompt: '先做这个' });
    expect(events.some((e) => e.kind === 'user_message')).toBe(false);
    await service.message(run.id, '顺便加个标题');
    await service.message(run.id, '标题用红色');
    expect((await finished(run.id)).status).toBe('succeeded');
    const said = events
      .filter((e) => e.kind === 'user_message')
      .map((e) => [e.data.text, e.data.interjection]);
    expect(said).toEqual([
      ['先做这个', undefined],
      ['顺便加个标题', true],
      ['标题用红色', true],
    ]);
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

  it('前面的话 completed 不遮住插话缺少结束通知', async () => {
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
    expect(finishes[0]?.outcome).toMatchObject({ status: 'cancelled' });
  });

  it('停止：先存下已经做出来的产出，再销毁沙箱；会话留在持久工作目录里，下一轮接着做', async () => {
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
    expect(await service.get(run.id)).toMatchObject({ resumable: true });
    expect(destroyed).toContain(run.id);
    expect(revoked).toHaveLength(1);
    expect(finishes[0]?.outcome).toMatchObject({ status: 'stopped' });

    const next = await service.start({ ...base, prompt: '接着做', continueFrom: run.id });
    expect((await finished(next.id)).status).toBe('succeeded');
    expect(methods).toContain('session/resume');
    expect(started[1]).toMatchObject({ workspaceId: run.id, restore: true });
  });

  it('停止后马上发下一句：等那一轮停好再接着，不当成「还没结束」拒掉', async () => {
    // 2026-11-08 回归测试发现：存会话时下一轮就到了，被 409 拒掉
    fake.archiveDelayMs = 200;
    const run = await service.start({ ...base, prompt: 'SLOW 慢慢做' });
    await until(() => events.find((e) => e.kind === 'user_message'));
    await service.stop(run.id);
    const next = await service.start({ ...base, prompt: '接着做', continueFrom: run.id });
    expect((await finished(run.id)).status).toBe('stopped');
    expect((await finished(next.id)).status).toBe('succeeded');
    expect(methods).toContain('session/resume');
  });

  it('冻结失败不归档仍在变动的检查点，并明确告知保存失败', async () => {
    fake.pauseFails = true;
    const run = await service.start({ ...base, prompt: 'SLOW 等待' });
    await until(() => events.find((e) => e.kind === 'user_message'));
    await service.stop(run.id);
    const row = await finished(run.id);
    expect(row.error).toContain('保存失败');
    expect(lifecycle).not.toContain('archive');
    expect(stored.has(`runs/${run.id}/outputs.tar`)).toBe(false);
  });

  it('沙箱还在启动时被取消：起好后立刻销毁，不再交用户的话', async () => {
    fake.startDelayMs = 200;
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

  it('打开了「只用国内模型」：国外厂商的模型开不了这一轮（不登记运行）；国内的照常开，临时 Key 带着这个设置', async () => {
    const paused = await service
      .start({ ...base, model: 'anthropic/claude-haiku-5.5', domesticOnly: true, prompt: '你好' })
      .catch((e: unknown) => e);
    expect(paused).toMatchObject({ statusCode: 409, code: 'model_out_of_scope' });
    expect(rows.size).toBe(0);
    const run = await service.start({ ...base, domesticOnly: true, prompt: '你好' });
    await finished(run.id);
    expect(issued.at(-1)).toMatchObject({ runId: run.id, domesticOnly: true });
    // 关着时国外厂商的模型照常能开
    const open = await service.start({
      ...base,
      model: 'anthropic/claude-haiku-5.5',
      prompt: '嗨',
    });
    await finished(open.id);
    expect(issued.at(-1)).toMatchObject({ runId: open.id, domesticOnly: false });
  });
});
