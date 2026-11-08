// 工具服务：3D 生成（复用长任务）和云渲染（准备、恢复、归档、对账）。
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { registerRoutes } from '../src/api/routes.ts';
import {
  knobs,
  PAYER,
  TASK,
  billingCalls,
  jobRows,
  jobs,
  mediaFiles,
} from './support/tool-fakes.ts';
import {
  tools,
  falCalls,
  geometryImage,
  stagingReads,
  useTools,
  call,
} from './support/tool-fixture.ts';

describe('3D 生成复用长任务', () => {
  it('取消与完成竞争时取回已完成成果，不把 ALREADY_COMPLETED 当成终止确认', async () => {
    knobs.geometryMode = true;
    knobs.geometryCancelCompleted = true;
    useTools('key', true);
    const id = (await call('3d.generate', { image: geometryImage })).job!.id;
    await tools.cancel({ payerId: PAYER }, id);
    await tools.close();
    expect(jobRows.get(id)?.status).toBe('completed');
    expect(billingCalls.map((r) => r.path)).toEqual(['hold', 'settle']);
  });
  it('只接受本地单图，未配置模型不启用；预算不足不提交', async () => {
    expect((await tools.list()).find((t) => t.key === '3d.generate')?.available).toBe(false);
    await expect(call('3d.generate', { image: geometryImage })).rejects.toMatchObject({
      statusCode: 503,
    });
    useTools('key', true);
    await expect(
      call('3d.generate', { image_url: 'https://example.com/private' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      tools.call({
        caller: { payerId: PAYER },
        key: '3d.generate',
        args: { image: geometryImage },
        requestId: 'budget',
        signal: AbortSignal.timeout(1000),
        maxCostMicro: 1,
      }),
    ).rejects.toMatchObject({ code: 'call_budget_exceeded' });
    expect(falCalls).toHaveLength(0);
    expect(billingCalls).toHaveLength(0);
  });
  it('同请求只提交一次；结算中断从归档恢复，保留未知检查项', async () => {
    knobs.geometryMode = true;
    useTools('key', true);
    const input = {
      caller: { payerId: PAYER, taskId: TASK },
      key: '3d.generate',
      args: { image: geometryImage },
      requestId: 'geometry',
      idempotencyKey: '00000000-0000-4000-8000-000000000077',
      signal: AbortSignal.timeout(5000),
    };
    const first = await tools.call(input),
      same = await tools.call(input);
    expect(first.job?.id).toBe(same.job?.id);
    expect(falCalls.filter((r) => r.input)).toHaveLength(1);
    expect(falCalls[0]?.input).toMatchObject({ resolution: 1024 });
    knobs.settleFails = true;
    await tools.job(input.caller, first.job!.id, AbortSignal.timeout(1000));
    expect(jobRows.get(first.job!.id)?.phase).toBe('stored');
    const count = falCalls.length;
    knobs.settleFails = false;
    useTools('key', true);
    const done = await tools.job(input.caller, first.job!.id, AbortSignal.timeout(1000));
    expect(done.status).toBe('completed');
    expect(done.result?.files[0]).toMatchObject({ mediaType: 'model/gltf-binary', size: 24 });
    expect(done.result?.data).toMatchObject({
      unchecked: ['真实尺寸', '背面', '拓扑', '可打印性'],
    });
    expect(falCalls).toHaveLength(count);
    expect(billingCalls.filter((r) => r.path === 'settle')).toHaveLength(1);
  });
  it('坏 GLB 不归档结算，也不重新生成；原请求提交断连保留未知', async () => {
    knobs.geometryMode = true;
    knobs.geometryMalformed = true;
    useTools('key', true);
    const id = (await call('3d.generate', { image: geometryImage })).job!.id;
    await tools.job({ payerId: PAYER }, id, AbortSignal.timeout(1000));
    expect(mediaFiles.size).toBe(0);
    expect(billingCalls.map((r) => r.path)).toEqual(['hold']);
    knobs.falSubmitFails = true;
    const unknown = (await call('3d.generate', { image: geometryImage })).job!.id;
    expect((await tools.job({ payerId: PAYER }, unknown, AbortSignal.timeout(1000))).status).toBe(
      'uncertain',
    );
    expect(falCalls.filter((r) => r.input)).toHaveLength(2);
  });
  it('取消意图持久化且检查归属；接受取消不等于费用可退回', async () => {
    knobs.geometryMode = true;
    useTools('key', true);
    const id = (await call('3d.generate', { image: geometryImage }, TASK)).job!.id;
    await expect(tools.cancel({ payerId: PAYER, taskId: PAYER }, id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await tools.cancel({ payerId: PAYER, taskId: TASK }, id);
    await tools.close();
    expect(jobRows.get(id)?.call.cancelRequested).toBe(true);
    expect(jobRows.get(id)?.phase).toBe('uncertain');
    expect(knobs.geometryCancelled).toBe(true);
    expect(billingCalls.map((r) => r.path)).toEqual(['hold']);
  });
});

describe('云渲染的准备、恢复、归档和对账', () => {
  const caller = { payerId: PAYER };
  const args = {
    scene: {
      version: 1,
      units: 'm',
      objects: [{ id: 'cube', kind: 'box', size: [1, 1, 1], position: [0, 0, 0] }],
      camera: { position: [3, 3, 3], target: [0, 0, 0] },
    },
    assets: [],
    render: { width: 128, height: 128, samples: 8, backend: 'CUDA' },
  };
  const pollRender = (id: string) => tools.job(caller, id, AbortSignal.timeout(2000));
  it.each(['lease-lost', 'already-finished'])(
    '原提交进程恢复时 %s，不能迟到发起 GPU 请求',
    async (mode) => {
      useTools('key', false, true);
      const id = (await call('3d.render', args)).job!.id;
      const original = jobs.claim;
      let claims = 0;
      const spy = vi.spyOn(jobs, 'claim').mockImplementation(async (key, token, until) => {
        claims++;
        if (claims === 2) {
          if (mode === 'lease-lost') {
            jobRows.get(id)!.leaseToken = 'another-process';
            return false;
          }
          await jobs.finish(id, 'failed');
        }
        return original(key, token, until);
      });
      try {
        await tools.submit(caller, id);
      } finally {
        spy.mockRestore();
      }
      expect(knobs.renderSubmits).toBe(0);
      if (mode === 'already-finished') expect(jobRows.get(id)?.phase).toBe('failed');
      else expect(jobRows.get(id)?.leaseToken).toBe('another-process');
    },
  );
  it('场景引用和灯光方向错误在冻结和 GPU 提交前拒绝', async () => {
    useTools('key', false, true);
    for (const scene of [
      { ...args.scene, objects: [{ ...args.scene.objects[0], kind: 'asset', asset: 'missing' }] },
      { ...args.scene, lights: [{ position: [0, 0, 0] }] },
    ]) {
      await expect(call('3d.render', { ...args, scene })).rejects.toMatchObject({
        code: 'invalid_tool_args',
      });
    }
    expect(billingCalls).toEqual([]);
    expect(knobs.renderSubmits).toBe(0);
  });
  it('真实 HTTP 路由串接准备、二进制上传和幂等提交', async () => {
    useTools('key', false, true);
    const app = Fastify({ loggerInstance: pino({ level: 'silent' }) });
    registerRoutes(app, {
      modelRequestMaxBytes: 50 * 1024 ** 2,
      tools,
      runKeys: { authenticate: async () => caller },
      chat: {},
      compute: {},
      decisions: {},
      unavailableModels: async () => [],
    } as unknown as Parameters<typeof registerRoutes>[1]);
    try {
      const bytes = Buffer.from('uploaded mesh fixture'),
        sha256 = createHash('sha256').update(bytes).digest('hex');
      const prepared = await app.inject({
        method: 'POST',
        url: '/run/v1/tools/3d.render',
        payload: {
          args: {
            ...args,
            scene: {
              ...args.scene,
              assets: [{ id: 'a', path: 'assets/a.glb', origin: 'fixture', sha256 }],
            },
            assets: [{ id: 'a', size: bytes.length, sha256 }],
          },
        },
      });
      expect(prepared.statusCode).toBe(200);
      const id = prepared.json().job.id as string;
      const uploaded = await app.inject({
        method: 'PUT',
        url: `/run/v1/tools/jobs/${id}/inputs/0`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: bytes,
      });
      expect(uploaded.statusCode).toBe(200);
      expect(mediaFiles.get(`tool-inputs/${id}/0`)).toEqual(bytes);
      const submitted = await app.inject({
        method: 'POST',
        url: `/run/v1/tools/jobs/${id}/submit`,
        payload: {},
      });
      expect(submitted.statusCode).toBe(200);
      expect(knobs.renderSubmits).toBe(1);
    } finally {
      await app.close();
    }
  });
  it('回执缺执行时长时先归档等人工对账；重启不重复生成，结算后回收暂存', async () => {
    useTools('key', false, true);
    knobs.renderReceiptMissing = true;
    const id = (await call('3d.render', args)).job!.id;
    expect(jobRows.get(id)?.phase).toBe('uploading');
    expect(knobs.renderSubmits).toBe(0);
    await tools.submit(caller, id);
    await tools.submit(caller, id);
    expect(knobs.renderSubmits).toBe(1);
    const waiting = await tools.job(caller, id, AbortSignal.timeout(2000));
    expect(waiting).toMatchObject({ status: 'pending', phase: 'awaiting_cost' });
    expect(billingCalls.map((c) => c.path)).toEqual(['hold']);
    expect(jobRows.get(id)?.result?.files).toHaveLength(1);
    useTools('key', false, true);
    knobs.settleFails = true;
    await expect(
      tools.reconcile(caller, id, { costMicro: 12345, billId: 'bill-line-one', stopped: true }),
    ).rejects.toThrow('结算未确认');
    expect(jobRows.get(id)?.phase).toBe('stored');
    knobs.settleFails = false;
    expect((await tools.job(caller, id, AbortSignal.timeout(2000))).status).toBe('completed');
    expect(jobRows.get(id)?.result?.costMicro).toBe(12345);
    expect(knobs.renderSubmits).toBe(1);
    expect([...mediaFiles.keys()].some((k) => k.startsWith('jobs/'))).toBe(false);
    expect(billingCalls.filter((c) => c.path === 'settle')).toHaveLength(1);
    await expect(tools.file({ payerId: TASK }, id, '0')).rejects.toMatchObject({ statusCode: 404 });
  });
  it('输入不齐不提交、坏摘要不保存；取消上传不调用 GPU', async () => {
    useTools('key', false, true);
    const bytes = Buffer.from('mesh-data'),
      sha256 = createHash('sha256').update(bytes).digest('hex');
    const id = (
      await call('3d.render', {
        ...args,
        scene: {
          ...args.scene,
          assets: [{ id: 'asset', path: 'assets/a.glb', sha256, origin: 'authorized fixture' }],
        },
        assets: [{ id: 'asset', size: bytes.length, sha256 }],
      })
    ).job!.id;
    await expect(tools.submit(caller, id)).rejects.toMatchObject({ code: 'inputs_missing' });
    await expect(
      tools.upload(caller, id, '0', Readable.from([Buffer.from('bad')])),
    ).rejects.toThrow();
    await tools.upload(caller, id, '0', Readable.from([bytes]));
    await tools.cancel(caller, id);
    await tools.close();
    expect(jobRows.get(id)?.status).toBe('failed');
    expect(knobs.renderSubmits).toBe(0);
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'release']);
  });
  it('按 GPU 回执计量即时结算并交付：执行秒 + 封顶启动秒 + 空闲秒，只扣一次', async () => {
    useTools('key', false, true);
    const id = (await call('3d.render', args)).job!.id;
    await tools.submit(caller, id);
    const done = await tools.job(caller, id, AbortSignal.timeout(2000));
    expect(done.status).toBe('completed');
    // ceil(3.172)=4 + min(ceil(120.4)=121, 90) + 5 = 99 s × 373
    expect(billingCalls.filter((c) => c.path === 'settle').map((c) => c.body.costMicro)).toEqual([
      36927,
    ]);
    expect(jobRows.get(id)?.result?.data).toMatchObject({
      gpuBilling: { billedSeconds: 99, microPerSecond: 373 },
    });
    await tools.job(caller, id, AbortSignal.timeout(2000));
    expect(billingCalls.filter((c) => c.path === 'settle')).toHaveLength(1);
    expect(knobs.renderSubmits).toBe(1);
  });
  it('只取回渲染图：工程包留在暂存不下载（只记摘要），随作业清理删除；曝光调整写进给 AI 的说明', async () => {
    useTools('key', false, true);
    knobs.renderExposure = -3;
    const id = (await call('3d.render', args)).job!.id;
    await tools.submit(caller, id);
    expect((await pollRender(id)).status).toBe('completed');
    const result = jobRows.get(id)!.result!;
    expect(result.files.map((f) => f.name)).toEqual(['image.png']);
    expect(stagingReads.some((k) => k.endsWith('/project.zip'))).toBe(false);
    expect(stagingReads.some((k) => k.endsWith('/image.png'))).toBe(true);
    expect(result.data).toMatchObject({
      project: { retrieved: false, size: 'zip-fixture'.length },
    });
    expect(result.text).toContain('RTX 4090');
    expect(result.text).toContain('降低了 3 EV');
    expect(result.text).toContain('曝光设为 -3');
    expect([...mediaFiles.keys()].some((k) => k.startsWith('jobs/'))).toBe(false);
  });
  it('GPU 失败不向用户扣款，退回冻结', async () => {
    useTools('key', false, true);
    knobs.renderStatus = 'FAILED';
    const id = (await call('3d.render', args)).job!.id;
    await tools.submit(caller, id);
    const done = await tools.job(caller, id, AbortSignal.timeout(2000));
    expect(done.status).toBe('failed');
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'release']);
    knobs.renderStatus = 'COMPLETED';
  });
  it('提交断连保留未知且不重发；终态成本超过冻结的部分记平台风险', async () => {
    useTools('key', false, true);
    knobs.renderSubmitLost = true;
    const id = (await call('3d.render', args)).job!.id;
    await tools.submit(caller, id);
    await tools.submit(caller, id);
    expect(knobs.renderSubmits).toBe(1);
    expect(jobRows.get(id)?.phase).toBe('uncertain');
    await tools.reconcile(caller, id, { costMicro: 1500000, billId: 'risk-line', stopped: true });
    expect(jobRows.get(id)?.status).toBe('failed');
    expect(jobRows.get(id)?.call.platformRiskMicro).toBe(500000);
    expect(billingCalls.find((c) => c.path === 'settle')?.body.costMicro).toBe(1000000);
  });
  it('取结果中断后供应商回执过期，仍按已保存的回执交付并计量结算一次', async () => {
    useTools('key', false, true);
    const id = (await call('3d.render', args)).job!.id;
    await tools.submit(caller, id);
    knobs.archiveFails = true;
    expect((await pollRender(id)).status).toBe('pending');
    expect(jobRows.get(id)?.call.providerReceipt).toMatchObject({ status: 'COMPLETED' });
    knobs.archiveFails = false;
    knobs.renderStatusGone = true;
    const done = await pollRender(id);
    expect(done.status).toBe('completed');
    expect(billingCalls.filter((c) => c.path === 'settle').map((c) => c.body.costMicro)).toEqual([
      36927,
    ]);
    expect(knobs.renderSubmits).toBe(1);
  });
  it('提交断连过了排队与执行时限、GPU 空闲后自动结案退回冻结；GPU 仍忙或未到时限则继续等', async () => {
    useTools('key', false, true);
    knobs.renderSubmitLost = true;
    const id = (await call('3d.render', args)).job!.id;
    await tools.submit(caller, id);
    const submittedAt = jobRows.get(id)!.call.submittedAt as number;
    expect(submittedAt).toBeGreaterThan(0);
    expect((await pollRender(id)).status).toBe('uncertain');
    jobRows.get(id)!.call.submittedAt = submittedAt - 43 * 60000;
    knobs.renderBusy = true;
    expect((await pollRender(id)).status).toBe('uncertain');
    expect(billingCalls.map((c) => c.path)).toEqual(['hold']);
    knobs.renderBusy = false;
    const closed = await pollRender(id);
    expect(closed).toMatchObject({ status: 'failed' });
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'release']);
    expect(jobRows.get(id)?.call.lostSubmitClosed).toBe(true);
    expect([...mediaFiles.keys()].some((k) => k.startsWith('jobs/'))).toBe(false);
    expect(knobs.renderSubmits).toBe(1);
  });
});
