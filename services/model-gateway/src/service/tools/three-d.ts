// 3D 工具：云 GPU 渲染、从参考图生成 GLB。
import { Readable, Transform } from 'node:stream';
import { z } from 'zod';
import { RenderArgs } from '../../adapters/runpod.ts';
import { estimate, InputImages, MODEL_ARG, optionalModel, pickModel, type ToolDef } from './kit.ts';

const GeometryArgs = z.strictObject({
  image: InputImages.max(1),
  resolution: z.enum(['512', '1024', '1536']).default('1024'),
  model: optionalModel,
});
const GlbFile = z.object({ url: z.url() }).nullish();
const GeometryResult = z.looseObject({
  model_glb: GlbFile,
  model_mesh: GlbFile,
  model_urls: z.looseObject({ glb: GlbFile, pbr_model: GlbFile }).nullish(),
});
/**
 * fal 上的图生 3D 型号：入参、GLB 放在结果的哪一项、价钱各不相同，差别只写在这张表里，
 * 目录只列表里有的（ADR 0029 §8）。micro 是这个精度下一次的标价（微美元）。
 */
const GEOMETRY_MODELS: Record<
  string,
  {
    input: (image: string, resolution: number) => Record<string, unknown>;
    glb: (result: z.infer<typeof GeometryResult>) => string | undefined;
    micro: (resolution: number) => number;
  }
> = {
  'fal-ai/trellis-2': {
    input: (image_url, resolution) => ({ image_url, resolution }),
    glb: (r) => r.model_glb?.url,
    micro: (resolution) => (resolution <= 512 ? 250_000 : resolution <= 1024 ? 300_000 : 350_000),
  },
  // 不分精度：单张图、不带 PBR 的标准档。同系列的 rapid 便宜，但回的是 OBJ + MTL + 贴图，没有 GLB
  'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d': {
    input: (input_image_url) => ({ input_image_url }),
    glb: (r) => (r.model_urls?.glb ?? r.model_glb)?.url,
    micro: () => 375_000,
  },
  // 不分精度：标准几何 + 标准贴图
  'tripo3d/h3.1/image-to-3d': {
    input: (image_url) => ({ image_url }),
    glb: (r) => (r.model_urls?.glb ?? r.model_urls?.pbr_model ?? r.model_mesh)?.url,
    micro: () => 300_000,
  },
  // 只有 1024、1536 两档
  'fal-ai/pixal3d': {
    input: (image_url, resolution) => ({ image_url, resolution: Math.max(1024, resolution) }),
    glb: (r) => r.model_glb?.url,
    micro: (resolution) => (resolution <= 1024 ? 300_000 : 420_000),
  },
};
/** 任务号里没记型号的旧任务：那时只有这一个型号 */
const GEOMETRY_BEFORE_MEMO = { model: 'fal-ai/trellis-2', micro: 350_000 };

/** Bounded container validation; full geometry and visual checks remain in the harness worker. */
function glbStream(body: NonNullable<Response['body']>) {
  let header = Buffer.alloc(0),
    size = 0;
  const check = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (header.length < 12)
        header = Buffer.concat([header, chunk.subarray(0, 12 - header.length)]);
      if (size > 200 * 1024 ** 2) return callback(new Error('GLB 超过大小上限'));
      callback(null, chunk);
    },
    flush(callback) {
      callback(
        header.length === 12 &&
          header.toString('ascii', 0, 4) === 'glTF' &&
          header.readUInt32LE(4) === 2 &&
          header.readUInt32LE(8) === size
          ? null
          : new Error('GLB 容器或长度无效'),
      );
    },
  });
  const input = Readable.fromWeb(body);
  input.on('error', (error) => check.destroy(error));
  check.on('close', () => input.destroy());
  return input.pipe(check);
}

export const render3d: ToolDef = {
  key: '3d.render',
  name: '云 GPU 渲染',
  description:
    '渲染受限 scene JSON 与已授权 GLB，只返回 PNG；可编辑工程用沙箱里 oasis-3d 由同一 scene.json 构建的那份。需通过已核验的云 profile。',
  usage:
    'oasis-tool 3d.render --scene 工程/scene.json --width 512 --height 512 --samples 32 --out out/渲染.png',
  unit: '作业',
  // 按 GPU 回执计量，常见一次 $0.01–0.05；冻结上限见 RENDER_HOLD_MICRO。
  estimateMicro: 50000,
  holdMicro: () => 1000000,
  provider: 'runpod',
  long: true,
  deferred: true,
  models: () => ['oasis/blender-cuda'],
  args: RenderArgs,
  cli: [
    {
      name: 'scene',
      kind: 'path',
      required: true,
      description: 'oasis-3d 的 scene.json（引用的 GLB 放同一目录）',
    },
    { name: 'width', kind: 'number', min: 64, max: 2048, description: '宽（像素，默认 512）' },
    { name: 'height', kind: 'number', min: 64, max: 2048, description: '高（像素，默认 512）' },
    { name: 'samples', kind: 'number', min: 1, max: 128, description: '采样数（默认 32）' },
    { name: 'backend', kind: 'choice', choices: ['CUDA', 'OPTIX'], description: '渲染后端' },
  ],
  modelOf: () => 'oasis/blender-cuda',
  async start() {
    throw new Error('渲染须经准备/上传/提交接口');
  },
  async check(deps, id) {
    if (!deps.render) throw new Error('GPU profile 不可用');
    return deps.render.check(id, deps.receipt);
  },
  async cancel(deps, id) {
    if (!deps.render) throw new Error('GPU profile 不可用');
    await deps.render.cancel(id);
  },
};

export const generate3d: ToolDef = {
  key: '3d.generate',
  name: '生成 3D 模型',
  description: '从一张本地参考图生成外观概念 GLB；不保证真实尺寸、背面、拓扑或可打印性。',
  usage: 'oasis-tool 3d.generate --image materials/参考.png --resolution 1024 --out out/模型.glb',
  unit: '模型',
  estimateMicro: 500_000,
  holdMicro: () => 1_000_000,
  long: true,
  provider: 'fal',
  models: (config) =>
    (config.geometryModels ?? []).filter((model) => Object.hasOwn(GEOMETRY_MODELS, model)),
  priceMicro: (model) => GEOMETRY_MODELS[model]?.micro(1024),
  args: GeometryArgs,
  cli: [
    { name: 'image', kind: 'path', required: true, description: '一张参考图' },
    {
      name: 'resolution',
      kind: 'choice',
      choices: ['512', '1024', '1536'],
      description: '精度（trellis-2 三档都有，pixal3d 最低 1024，其余型号不分精度）',
    },
    MODEL_ARG,
  ],
  modelOf: pickModel,
  async start(deps, args, model) {
    if (!deps.fal) throw new Error('3D 供应商未配置');
    const spec = GEOMETRY_MODELS[model];
    if (!spec) throw new Error(`3D 型号 ${model} 还没有对接`);
    const a = GeometryArgs.parse(args),
      image = a.image[0]!,
      resolution = Number(a.resolution);
    const input = spec.input(`data:${image.mediaType};base64,${image.base64}`, resolution);
    return deps.fal.handle(
      await (
        await deps.upstream(() => deps.fal!.submit(model, input, deps.signal, { noRetry: true }))
      ).json(),
      { model, micro: spec.micro(resolution) },
    );
  },
  async cancel(deps, id) {
    if (!deps.fal) throw new Error('3D 供应商未配置');
    const response = await deps.fal.cancel(id);
    if (response.status === 400) {
      const body = (await response.json().catch(() => null)) as { status?: string } | null;
      if (body?.status === 'ALREADY_COMPLETED') return;
      throw new Error('取消未确认');
    }
    await response.body?.cancel();
    if (!response.ok) throw new Error('取消未确认');
  },
  async check(deps, id) {
    if (!deps.fal) throw new Error('3D 供应商未配置');
    const response = await deps.fal.status(id);
    if (!response.ok) throw new Error('3D 状态暂不可取');
    const state = z.object({ status: z.string() }).parse(await response.json());
    if (['FAILED', 'CANCELLED'].includes(state.status))
      return { state: 'uncertain', error: '供应商已终止，但费用未确认，保留对账' };
    if (state.status !== 'COMPLETED') return { state: 'pending' };
    const result = await deps.fal.result(id);
    if (!result.ok) throw new Error('3D 结果暂不可取');
    const memo = deps.fal.memo(id) ?? GEOMETRY_BEFORE_MEMO;
    const url = GEOMETRY_MODELS[memo.model]?.glb(GeometryResult.parse(await result.json()));
    if (!url) throw new Error('3D 结果里没有 GLB');
    const media = await deps.fal.media(url);
    if (!media.body) throw new Error('3D 结果无内容流');
    return {
      state: 'completed',
      outcome: {
        text: '参考图生成的外观概念 GLB；真实尺寸、背面、拓扑和可打印性未检查。',
        data: {
          source: 'fal',
          format: 'glb',
          unchecked: ['真实尺寸', '背面', '拓扑', '可打印性'],
        },
        files: [{ name: 'model.glb', mediaType: 'model/gltf-binary', body: glbStream(media.body) }],
        cost: estimate(memo.micro),
      },
    };
  },
};
