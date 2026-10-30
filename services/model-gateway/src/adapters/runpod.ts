// Queue credentials stay here; signed exchange URLs are never persisted or returned to agents.
import { z } from 'zod';
import type { ObjectStore } from '@oasis/service-kit';

const vec = (low: number, high: number) => z.array(z.number().min(low).max(high)).length(3);
const Scene = z
  .strictObject({
    version: z.literal(1),
    units: z.literal('m'),
    objects: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(100),
          kind: z.enum(['box', 'sphere', 'cylinder', 'asset']),
          asset: z.string().optional(),
          size: vec(0.0001, 10000),
          position: vec(-10000, 10000),
          rotation: vec(-3600, 3600).optional(),
          color: z.array(z.number().min(0).max(1)).length(4).optional(),
          roughness: z.number().min(0).max(1).optional(),
          metallic: z.number().min(0).max(1).optional(),
          emission: z.number().min(0).max(100).optional(),
        }),
      )
      .min(1)
      .max(100),
    camera: z.strictObject({
      position: vec(-10000, 10000),
      target: vec(-10000, 10000),
      lens: z.number().min(10).max(200).optional(),
    }),
    lights: z
      .array(
        z.strictObject({
          position: vec(-10000, 10000),
          target: vec(-10000, 10000).optional(),
          power: z.number().positive().max(100000).optional(),
          size: z.number().positive().max(100).optional(),
          color: vec(0, 1).optional(),
        }),
      )
      .max(8)
      .optional(),
    background: vec(0, 1).optional(),
    assets: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(100),
          path: z
            .string()
            .min(1)
            .max(400)
            .refine(
              (p) =>
                !p.startsWith('.') &&
                !p.startsWith('/') &&
                !p.includes('..') &&
                !p.includes('\\') &&
                !p.includes(':'),
            ),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          origin: z.string().min(1).max(1000),
        }),
      )
      .max(20)
      .default([]),
  })
  .refine(
    (s) =>
      new Set(s.objects.map((o) => o.id)).size === s.objects.length &&
      new Set(s.assets.map((a) => a.id)).size === s.assets.length &&
      s.objects.every(
        (o) =>
          o.kind !== 'asset' ||
          (s.assets.some((a) => a.id === o.asset) &&
            o.color === undefined &&
            o.roughness === undefined &&
            o.metallic === undefined &&
            o.emission === undefined),
      ) &&
      JSON.stringify(s.camera.position) !== JSON.stringify(s.camera.target) &&
      (s.lights ?? []).every(
        (l) => JSON.stringify(l.position) !== JSON.stringify(l.target ?? [0, 0, 0]),
      ),
    'Invalid scene identity, reference, material override or direction',
  );
export const RenderArgs = z
  .strictObject({
    scene: Scene,
    assets: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(100),
          size: z
            .number()
            .int()
            .positive()
            .max(100 * 1024 ** 2),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .max(20)
      .default([]),
    render: z.strictObject({
      width: z.number().int().min(64).max(2048),
      height: z.number().int().min(64).max(2048),
      samples: z.number().int().min(1).max(128),
      backend: z.enum(['CUDA', 'OPTIX']),
    }),
  })
  .refine(
    (a) =>
      a.scene.assets.length === a.assets.length &&
      a.assets.every(
        (v, i) => v.id === a.scene.assets[i]?.id && v.sha256 === a.scene.assets[i]?.sha256,
      ),
    'Asset closure mismatch',
  )
  .refine(
    (v) =>
      v.assets.reduce((s, a) => s + a.size, 0) <= 200 * 1024 ** 2 &&
      JSON.stringify(v.scene).length <= 1024 ** 2,
    'Scene exceeds limits',
  );
/** 提交给 Runpod 的作业时限：排队超过 TTL 即丢弃，执行超过 executionTimeout 即终止。 */
const SUBMIT_TTL_MS = 1800000,
  EXECUTION_TIMEOUT_MS = 600000;
export function createRenderClient(options: {
  baseUrl: string;
  endpointId: string;
  apiKey?: string;
  verified: boolean;
  holdMicro: number;
  staging?: ObjectStore;
  archive: ObjectStore;
  fetcher?: typeof fetch;
  /** 按 GPU 回执计量：执行秒数 + 有上限的启动秒数 + 空闲超时，乘以锁定单价（ADR 0011 §21） */
  metering: { microPerSecond: number; startupCapSeconds: number; idleSeconds: number };
}) {
  const fetcher = options.fetcher ?? fetch;
  const base = options.baseUrl.replace(/\/$/, '');
  const key = (id: string, name: string) => `jobs/${id.replaceAll('-', '')}/${name}`;
  const inputKey = (id: string, i: number) => `tool-inputs/${id}/${i}`;
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    signal = AbortSignal.timeout(30000),
  ) {
    return fetcher(`${base}/${encodeURIComponent(options.endpointId)}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.apiKey ?? ''}`,
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
      redirect: 'error',
    });
  }
  return {
    configured: Boolean(
      options.verified && options.apiKey && options.endpointId && options.staging?.sign,
    ),
    holdMicro: options.holdMicro,
    async start(
      value: Record<string, unknown>,
      jobId: string,
      signal: AbortSignal,
      beforeSubmit?: () => Promise<void>,
    ) {
      const args = RenderArgs.parse(value),
        staging = options.staging!;
      const sceneAssets = args.scene.assets;
      const assets = [];
      for (const [i, asset] of args.assets.entries()) {
        const source = sceneAssets[i];
        if (source?.id !== asset.id || source.sha256 !== asset.sha256)
          throw new Error('Asset identity mismatch');
        await staging.putStream(
          key(jobId, `input-${i}.glb`),
          await options.archive.read(inputKey(jobId, i)),
          'model/gltf-binary',
          { maxBytes: asset.size, size: asset.size, sha256: asset.sha256 },
        );
        assets.push({
          ...asset,
          url: await staging.sign!(key(jobId, `input-${i}.glb`), 'GET', 3600),
        });
      }
      const outputs = {
        image: await staging.sign!(key(jobId, 'image.png'), 'PUT', 3600),
        project: await staging.sign!(key(jobId, 'project.zip'), 'PUT', 3600),
      };
      signal.throwIfAborted();
      await beforeSubmit?.();
      signal.throwIfAborted();
      const response = await request(
        'run',
        'POST',
        {
          input: {
            version: 1,
            operation: 'render',
            transferId: jobId.replaceAll('-', ''),
            scene: args.scene,
            assets,
            render: args.render,
            outputs,
          },
          policy: { executionTimeout: EXECUTION_TIMEOUT_MS, ttl: SUBMIT_TTL_MS },
        },
        signal,
      );
      if (!response.ok) throw new Error('Render submission not confirmed');
      const result = z
        .object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/) })
        .parse(await response.json());
      return JSON.stringify({ id: result.id, jobId, count: args.assets.length });
    },
    async cancel(handle: string) {
      const { id } = JSON.parse(handle) as { id: string };
      const response = await request(`cancel/${encodeURIComponent(id)}`, 'POST');
      await response.body?.cancel();
      if (!response.ok && response.status !== 404)
        throw new Error('Render cancellation unconfirmed');
    },
    async check(
      handle: string,
      receipt?: { saved?: unknown; save(value: unknown): Promise<void> },
    ) {
      const h = JSON.parse(handle) as { id: string; jobId: string };
      let raw = receipt?.saved;
      if (raw === undefined) {
        const response = await request(`status/${encodeURIComponent(h.id)}`);
        if (!response.ok) throw new Error('Render status unavailable');
        raw = await response.json();
      }
      const value = z
        .object({
          status: z.string(),
          output: z.unknown().optional(),
          delayTime: z.number().int().nonnegative().optional(),
          executionTime: z.number().int().nonnegative().optional(),
        })
        .parse(raw);
      // Runpod 只保留终态回执约 30 分钟；取回结果可能更慢，先存下来，之后重试不再依赖它。
      if (value.status === 'COMPLETED' && receipt && receipt.saved === undefined)
        await receipt.save(value);
      if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(value.status))
        return {
          state: 'failed' as const,
          error: `GPU 渲染未完成（${value.status}）；GPU 时长由平台承担，未向用户扣款`,
        };
      if (value.status !== 'COMPLETED') return { state: 'pending' as const };
      const artifact = z.object({
        size: z
          .number()
          .int()
          .positive()
          .max(200 * 1024 ** 2),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      });
      const output = z
        .object({
          transferId: z.literal(h.jobId.replaceAll('-', '')),
          artifacts: z.object({ image: artifact, project: artifact }),
          device: z
            .object({
              gpuUsed: z.literal(true),
              // 只用于给 AI 的说明；格式异常时忽略，不能挡住已完成的渲染交付。
              devices: z
                .array(z.object({ name: z.string().max(200) }).passthrough())
                .optional()
                .catch(undefined),
              exposureAdjustEv: z.number().min(-3).max(0).optional().catch(undefined),
            })
            .passthrough(),
          boundary: z
            .object({
              filesystem: z.literal(true),
              networkSocketsDenied: z.literal(true),
              secretEnvironmentEmpty: z.literal(true),
            })
            .passthrough(),
        })
        .parse(value.output);
      const meter = options.metering;
      const billedSeconds =
        value.executionTime !== undefined
          ? Math.ceil(value.executionTime / 1000) +
            Math.min(Math.ceil((value.delayTime ?? 0) / 1000), meter.startupCapSeconds) +
            meter.idleSeconds
          : undefined;
      const cost =
        billedSeconds === undefined
          ? null
          : {
              // 用户扣款不超过冻结上限；超出部分（理论上执行超时才会出现）由平台承担。
              costMicro: Math.min(billedSeconds * meter.microPerSecond, options.holdMicro),
              source: 'provider' as const,
            };
      const gpu = output.device.devices?.[0]?.name;
      const exposure = output.device.exposureAdjustEv ?? 0;
      // 只取回渲染图：worker 的工程包重复带上 .blend 和资产（实测 82 MB），慢网络下取回会让节点超时；
      // 沙箱里用同一份 scene.json 构建的工程就是可编辑工程（ADR 0011 §23）。
      const notes = [
        `云 GPU${gpu ? `（${gpu}）` : ''}渲染图已取回并核对摘要`,
        '只取回渲染图，可编辑工程用沙箱里由同一份 scene.json 构建的那份',
        ...(exposure < 0
          ? [
              `为防过曝，渲染时曝光自动降低了 ${-exposure} EV，沙箱工程仍是原曝光：请在说明里写明，用户在 Blender 的色彩管理里把曝光设为 ${exposure} 即可得到同样的亮度`,
            ]
          : []),
        cost ? '按 GPU 回执计量结算。' : '回执缺少执行时长，人工对账后交付。',
      ];
      return {
        state: 'completed' as const,
        outcome: {
          text: notes.join('；'),
          data: {
            device: output.device,
            boundary: output.boundary,
            // GPU 侧工程包未取回，只记下大小和摘要以便追溯；暂存里的副本随作业清理删除。
            project: { retrieved: false, ...output.artifacts.project },
            ...(billedSeconds === undefined
              ? {}
              : {
                  gpuBilling: {
                    executionMs: value.executionTime,
                    delayMs: value.delayTime ?? 0,
                    billedSeconds,
                    microPerSecond: meter.microPerSecond,
                  },
                }),
          },
          files: [
            {
              name: 'image.png',
              mediaType: 'image/png',
              body: await options.staging!.read(key(h.jobId, 'image.png')),
              ...output.artifacts.image,
            },
          ],
          cost,
        },
      };
    },
    /** 断连的提交过了此时长，要么从未到达、要么已被丢弃或执行完，不会再产生 GPU 时长。 */
    lostSubmitQuietMs: SUBMIT_TTL_MS + EXECUTION_TIMEOUT_MS + 120000,
    /** endpoint 只接本网关的提交；排队和执行中都为 0 说明没有作业还在占用 GPU。 */
    async idle() {
      const response = await request('health');
      if (!response.ok) throw new Error('Render health unavailable');
      const count = z.number().int().nonnegative();
      const { jobs } = z
        .object({ jobs: z.object({ inQueue: count, inProgress: count }) })
        .parse(await response.json());
      return jobs.inQueue === 0 && jobs.inProgress === 0;
    },
    async cleanup(jobId: string, count: number) {
      if (!options.staging) return;
      for (const name of [
        'image.png',
        'project.zip',
        ...Array.from({ length: count }, (_, i) => `input-${i}.glb`),
      ])
        await options.staging.delete(key(jobId, name));
      for (let i = 0; i < count; i++) await options.archive.delete(inputKey(jobId, i));
    },
    inputKey,
  };
}
export type RenderClient = ReturnType<typeof createRenderClient>;
