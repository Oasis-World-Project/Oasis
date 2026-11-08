// 运行服务：一次运行从输入到产出（素材、上游产出、持久工作目录、产出文件和给 inspector 的下载链接）。
import { extractFiles, HttpError } from '@oasis/service-kit';
import { describe, expect, it } from 'vitest';
import {
  PAYER,
  methods,
  started,
  destroyed,
  workspaces,
  rows,
  events,
  outbox,
  stored,
  issued,
  revoked,
  compute,
  PHOTO,
  BIG,
  service,
  finished,
  base,
} from './support/run-fixture.ts';

describe('一次 agent 运行：输入和产出', () => {
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

  it('产出包的临时下载链接只给这次运行的付费人和任务；没有产出就 404', async () => {
    const taskId = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
    const run = await service.start({ ...base, taskId, prompt: '写' });
    await finished(run.id);
    const link = await service.outputsLink(run.id, PAYER, taskId);
    expect(link.url).toBe(
      `http://s3.test/oasis-harness/runs/${run.id}/outputs.tar?method=GET&expires=3600`,
    );
    expect(new Date(link.expiresAt).getTime()).toBeGreaterThan(Date.now());
    await expect(service.outputsLink(run.id, PAYER, PAYER)).rejects.toMatchObject({
      statusCode: 404,
    });
    rows.set(run.id, { ...rows.get(run.id)!, outputKey: null });
    await expect(service.outputsLink(run.id, PAYER, taskId)).rejects.toMatchObject({
      statusCode: 404,
      code: 'outputs_not_found',
    });
  });

  it('交付关卡的浏览器检查报告：task 交来留档、再查一次就覆盖；只给这次运行的付费人和任务读', async () => {
    const taskId = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
    const run = await service.start({ ...base, taskId, prompt: '写' });
    await finished(run.id);
    await expect(service.applicationReport(run.id, PAYER, taskId)).rejects.toMatchObject({
      statusCode: 404,
      code: 'check_not_found',
    });
    const failed = { passed: false, reason: '首页脚本报错', frameCaptured: true };
    await service.saveApplicationReport(run.id, { payerId: PAYER, taskId, report: failed });
    const passed = { passed: true, reason: null, frameCaptured: true };
    await service.saveApplicationReport(run.id, { payerId: PAYER, taskId, report: passed });
    const saved = await service.applicationReport(run.id, PAYER, taskId);
    expect(JSON.parse(saved.toString('utf8'))).toEqual(passed);
    // 别人的任务既存不进来，也读不到
    await expect(
      service.saveApplicationReport(run.id, { payerId: PAYER, taskId: PAYER, report: failed }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'run_not_found' });
    await expect(service.applicationReport(run.id, PAYER, PAYER)).rejects.toMatchObject({
      statusCode: 404,
      code: 'run_not_found',
    });
  });
});
