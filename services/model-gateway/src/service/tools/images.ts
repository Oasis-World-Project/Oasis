// 图片工具：生成图片、看图回答问题。
import { z } from 'zod';
import { estimate, InputImages, optionalModel, pickModel, provider, type ToolDef } from './kit.ts';

/**
 * 按文件头认出图片的真实格式；认不出返回 undefined。供应商声明的格式不可靠（2026-11-05：
 * 要 PNG 却回 JPEG，存成 .png 后看图工具报签名无效、节点因此返工）。
 */
function sniffImageType(base64: string): string | undefined {
  const head = Buffer.from(base64.slice(0, 24), 'base64');
  if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return 'image/jpeg';
  if (
    head.length >= 12 &&
    head.toString('ascii', 0, 4) === 'RIFF' &&
    head.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  if (head.length >= 4 && head.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  return undefined;
}

const extOf = (mediaType: string) =>
  ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' })[
    mediaType
  ] ?? 'png';

const ImageArgs = z.object({
  prompt: z.string().trim().min(1).max(4000),
  aspect_ratio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9']).optional(),
  resolution: z.enum(['1K', '2K', '4K']).optional(),
  n: z.coerce.number().int().min(1).max(4).default(1),
  model: optionalModel,
  references: z.lazy(() => InputImages).optional(),
});

const InspectArgs = z.object({
  images: InputImages,
  question: z.string().trim().min(1).max(4000),
  model: optionalModel,
});

const imageParts = (images: z.infer<typeof InputImages>) =>
  images.map((image) => ({
    type: 'image_url',
    image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
  }));

const ImagesResponse = z.looseObject({
  data: z.array(z.looseObject({ b64_json: z.string(), media_type: z.string().optional() })),
  usage: z.looseObject({ cost: z.number().optional() }).optional(),
});

export const imageGenerate: ToolDef = {
  key: 'image.generate',
  name: '生成图片',
  description:
    '按文字描述生成图片（插画、海报、商品图、网页效果图……）。按供应商实际返回的格式保存（PNG/JPEG/WebP），后缀可能与 --out 不同，以输出里「已保存」的路径为准；--n 大于 1 时并行生成。',
  usage:
    'oasis-tool image.generate --prompt "描述" [--ref materials/主图.png,materials/风格.jpg] [--aspect_ratio 16:9] [--resolution 2K] [--n 1] --out out/图片.png',
  unit: '张',
  estimateMicro: 150_000,
  holdMicro: (args) => 500_000 * (Number(args.n) || 1),
  long: false,
  provider: 'openrouter',
  models: (config) => config.imageModels,
  args: ImageArgs,
  modelOf: pickModel,
  async run(deps, args, model) {
    const a = ImageArgs.parse(args);
    // 不少供应商不接受一次多张（2026-11-05 Seedream 连拒 --n 4）：每张单独请求、同时发出，不排队
    const request = {
      model,
      prompt: a.prompt,
      n: 1,
      output_format: 'png',
      ...(a.references
        ? { input_references: imageParts(a.references), provider: { require_parameters: true } }
        : {}),
      ...(a.aspect_ratio ? { aspect_ratio: a.aspect_ratio } : {}),
    };
    const one = async () => {
      const response = await deps.upstream(async () => {
        if (!a.resolution) return deps.openrouter.images(request, deps.signal);
        const first = await deps.openrouter.images(
          { ...request, resolution: a.resolution },
          deps.signal,
        );
        if (first.status !== 400) return first;
        // 供应商目录里列出的档位不一定真能用（如 seedream-4.5 拒绝 1K）；分辨率被拒时按其提示改用默认档重试一次。
        const detail = await first.text();
        if (!/resolution|pixels/i.test(detail))
          return new Response(detail, { status: 400, headers: first.headers });
        return deps.openrouter.images(request, deps.signal);
      });
      return ImagesResponse.parse(await response.json());
    };
    const settled = await Promise.allSettled(Array.from({ length: a.n }, one));
    const done = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (!done.length) throw (settled[0] as PromiseRejectedResult).reason;
    const files = done
      .flatMap((body) => body.data)
      .map((d, i) => {
        const mediaType = sniffImageType(d.b64_json) ?? d.media_type ?? 'image/png';
        return { name: `image-${i + 1}.${extOf(mediaType)}`, mediaType, base64: d.b64_json };
      });
    const failed = settled.length - done.length;
    const costs = done.map((body) => body.usage?.cost);
    return {
      text: `生成了 ${files.length} 张图片（${model}）${failed ? `；另有 ${failed} 张没生成出来，没收费` : ''}。`,
      files,
      cost: costs.every((c) => typeof c === 'number')
        ? provider(costs.reduce<number>((sum, c) => sum + (c ?? 0), 0))
        : estimate(40_000 * files.length),
    };
  },
};

export const imageInspect: ToolDef = {
  key: 'image.inspect',
  name: '查看图片',
  description: '读取 1–4 张本地图片，回答画面、文字或图表问题；无法看清时应明确说明。',
  usage: 'oasis-tool image.inspect --images materials/图.png --question "图中写了什么？"',
  unit: '次',
  estimateMicro: 2_000,
  holdMicro: () => 200_000,
  long: false,
  provider: 'openrouter',
  models: (config) => config.visionModels,
  args: InspectArgs,
  modelOf: pickModel,
  async run(deps, args, model) {
    const a = InspectArgs.parse(args);
    const response = await deps.upstream(() =>
      deps.openrouter.chatCompletions(
        {
          model,
          stream: false,
          max_tokens: deps.config.visionMaxTokens,
          usage: { include: true },
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: a.question }, ...imageParts(a.images)],
            },
          ],
        },
        deps.signal,
      ),
    );
    const body = z
      .object({
        choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }) })).min(1),
        usage: z.object({ cost: z.number().nonnegative().optional() }).optional(),
      })
      .parse(await response.json());
    return {
      text: body.choices[0]!.message.content,
      files: [],
      cost: body.usage?.cost !== undefined ? provider(body.usage.cost) : estimate(2_000),
    };
  },
};
