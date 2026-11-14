// 图片工具：生成图片；看图、看视频、听音频回答问题（media.inspect）。
import { z } from 'zod';
import {
  estimate,
  InputImages,
  InputMedia,
  MODEL_ARG,
  optionalModel,
  pickModel,
  provider,
  type ToolDef,
} from './kit.ts';

/**
 * 按文件头认出图片的真实格式；认不出返回 undefined。供应商声明的格式不可靠（2026-11-05：
 * 要 PNG 却回 JPEG，存成 .png 后看图工具报签名无效）。
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

/** 一次最多出几张（描述数 × 每个描述几张）：几张同时生成 */
const MAX_IMAGES = 4;
const Prompt = z.string().trim().min(1).max(4000);
const ImageArgs = z
  .object({
    prompt: Prompt.optional(),
    /** 几个不同的描述一次交：同时生成，按顺序存 */
    prompts: z.array(Prompt).min(1).max(MAX_IMAGES).optional(),
    aspect_ratio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9']).optional(),
    resolution: z.enum(['1K', '2K', '4K']).optional(),
    n: z.coerce.number().int().min(1).max(MAX_IMAGES).default(1),
    model: optionalModel,
    references: z.lazy(() => InputImages).optional(),
  })
  .refine((a) => !a.prompt !== !a.prompts, '--prompt 和 --prompts 写一个')
  .refine(
    (a) => (a.prompts?.length ?? 1) * a.n <= MAX_IMAGES,
    `一次最多 ${MAX_IMAGES} 张（描述数 × 张数）`,
  );
/** 这次一共几张 */
const imageCount = (args: Record<string, unknown>) =>
  (Array.isArray(args.prompts) ? args.prompts.length : 1) * (Number(args.n) || 1);

const InspectArgs = z.object({
  files: InputMedia,
  question: z.string().trim().min(1).max(4000),
  model: optionalModel,
});

/** 文件按给的顺序带给型号：图片、视频是 data: 地址，音频是 base64 加格式（供应商的三种内容块） */
const mediaParts = (files: InputMedia) =>
  files.map((file) =>
    file.kind === 'image'
      ? { type: 'image_url', image_url: { url: `data:${file.mediaType};base64,${file.base64}` } }
      : file.kind === 'video'
        ? { type: 'video_url', video_url: { url: `data:${file.mediaType};base64,${file.base64}` } }
        : { type: 'input_audio', input_audio: { data: file.base64, format: file.format } },
  );

/** 这次要读的种类（image、video、audio），去重 */
export const mediaKinds = (args: Record<string, unknown>): string[] => {
  const files = Array.isArray(args.files) ? (args.files as { kind?: unknown }[]) : [];
  return [...new Set(files.map((f) => f.kind).filter((k): k is string => typeof k === 'string'))];
};

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
    '按文字描述生成图片（插画、海报、商品图、网页效果图……）。按供应商实际返回的格式保存（PNG/JPEG/WebP），后缀可能与 --out 不同，以输出里「已保存」的路径为准。要几张图就一次交：几个不同的画面用 --prompts（JSON 数组），同一个画面要几张用 --n，一次最多 4 张、同时生成，比一张张调快得多。',
  usage:
    'oasis-tool image.generate --prompt "描述" [--ref materials/主图.png,materials/风格.jpg] [--aspect_ratio 16:9] [--resolution 2K] [--n 1] --out out/图片.png；几个画面一起：oasis-tool image.generate --prompts \'["第一个画面","第二个画面"]\' --out out/关键帧/帧.png（存成 帧-1.png、帧-2.png，和描述顺序一致）',
  unit: '张',
  estimateMicro: 150_000,
  holdMicro: (args) => 500_000 * imageCount(args),
  long: false,
  provider: 'openrouter',
  models: (config) => config.imageModels,
  args: ImageArgs,
  cli: [
    { name: 'prompt', kind: 'text', description: '画面描述（和 --prompts 写一个）' },
    {
      name: 'prompts',
      kind: 'list',
      min: 1,
      max: MAX_IMAGES,
      description: '几个不同的画面一次交，写成 JSON 数组；同时生成，按顺序存',
    },
    { name: 'ref', kind: 'paths', min: 1, max: 4, description: '参考图（1–4 张 PNG/JPEG/WebP）' },
    {
      name: 'aspect_ratio',
      kind: 'choice',
      choices: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'],
      description: '画面比例',
    },
    { name: 'resolution', kind: 'choice', choices: ['1K', '2K', '4K'], description: '清晰度档位' },
    { name: 'n', kind: 'number', min: 1, max: 4, description: '张数（默认 1，几张同时生成）' },
    MODEL_ARG,
  ],
  per: { arg: 'n', default: 1 },
  modelOf: pickModel,
  async run(deps, args, model) {
    const a = ImageArgs.parse(args);
    // 不少供应商不接受一次多张（2026-11-05 Seedream 连拒 --n 4）：每张单独请求、同时发出，不排队
    const prompts = a.prompts ?? [a.prompt!];
    const shots = prompts.flatMap((prompt) => Array.from({ length: a.n }, () => prompt));
    const one = async (prompt: string) => {
      const request = {
        model,
        prompt,
        n: 1,
        output_format: 'png',
        ...(a.references
          ? { input_references: imageParts(a.references), provider: { require_parameters: true } }
          : {}),
        ...(a.aspect_ratio ? { aspect_ratio: a.aspect_ratio } : {}),
      };
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
    const settled = await Promise.allSettled(shots.map(one));
    const done = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (!done.length) throw (settled[0] as PromiseRejectedResult).reason;
    // 文件名带第几张（没生成出来的空着号），oasis-tool 存的时候用同一个号，和描述的顺序对得上
    const files = settled.flatMap((r, i) =>
      r.status === 'fulfilled'
        ? r.value.data.slice(0, 1).map((d) => {
            const mediaType = sniffImageType(d.b64_json) ?? d.media_type ?? 'image/png';
            return { name: `image-${i + 1}.${extOf(mediaType)}`, mediaType, base64: d.b64_json };
          })
        : [],
    );
    const failed = settled.length - done.length;
    const costs = done.map((body) => body.usage?.cost);
    const order =
      prompts.length > 1
        ? `按顺序：${settled
            .map(
              (r, i) =>
                `第 ${i + 1} 张是第 ${Math.floor(i / a.n) + 1} 个描述${r.status === 'fulfilled' ? '' : '（没生成出来）'}`,
            )
            .join('；')}。`
        : '';
    return {
      text: `生成了 ${files.length} 张图片（${model}）${failed ? `；另有 ${failed} 张没生成出来，没收费` : ''}。${order}`,
      files,
      cost: costs.every((c) => typeof c === 'number')
        ? provider(costs.reduce<number>((sum, c) => sum + (c ?? 0), 0))
        : estimate(40_000 * files.length),
    };
  },
};

export const mediaInspect: ToolDef = {
  key: 'media.inspect',
  name: '看图、看视频、听音频',
  description:
    '把 1–4 个本地文件（图片、视频、音频可以混着给）交给能看能听的型号，回答画面、文字、动作、听感或几个文件之间差别的问题；看不清、听不清时应明确说明。',
  usage:
    'oasis-tool media.inspect --files out/封面.png --question "图中写了什么？"；oasis-tool media.inspect --files out/a.mp3 out/b.mp3 --question "哪一段更像八音盒摇篮曲？"',
  unit: '次',
  estimateMicro: 2_000,
  holdMicro: () => 200_000,
  long: false,
  provider: 'openrouter',
  models: (config) => config.inspectModels,
  args: InspectArgs,
  cli: [
    {
      name: 'files',
      kind: 'paths',
      required: true,
      min: 1,
      max: 4,
      description:
        '要看、要听的文件（1–4 个，合计不超过 20 MiB）：图片 png/jpg/webp，视频 mp4/webm/mov，音频 mp3/wav/m4a/flac/ogg',
    },
    { name: 'question', kind: 'text', required: true, description: '要回答的问题' },
    MODEL_ARG,
  ],
  modelOf: pickModel,
  async run(deps, args, model) {
    const a = InspectArgs.parse(args);
    const response = await deps.upstream(() =>
      deps.openrouter.chatCompletions(
        {
          model,
          stream: false,
          max_tokens: deps.config.inspectMaxTokens,
          usage: { include: true },
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: a.question }, ...mediaParts(a.files)],
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
