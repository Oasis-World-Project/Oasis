// 视频工具：按文字或首帧生成短视频（长任务：提交 → 查进度 → 取结果）。
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { ProviderClient } from '../../adapters/openrouter.ts';
import {
  estimate,
  InputImages,
  MODEL_ARG,
  optionalModel,
  pickModel,
  provider,
  type ToolDef,
} from './kit.ts';

const VideoArgs = z.object({
  prompt: z.string().trim().min(1).max(4000),
  duration: z.coerce.number().int().min(1).max(20).default(5),
  resolution: z.enum(['480p', '720p', '768p', '1080p']).default('720p'),
  aspect_ratio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4']).optional(),
  first_frame: InputImages.max(1).optional(),
  model: optionalModel,
});

type VideoEntry = Awaited<ReturnType<ProviderClient['listVideoModels']>>[number];

const choices = (values: readonly (string | number)[] | null | undefined) =>
  values?.length ? values.join('、') : '目录里没写';

/** 这个视频模型和所选参数哪几项对不上（逐项对照供应商目录）；全对得上返回空数组 */
export function videoProblems(entry: VideoEntry, args: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (!entry.supported_durations?.includes(Number(args.duration)))
    problems.push(`时长 ${args.duration} 秒不支持（可选：${choices(entry.supported_durations)}）`);
  if (!entry.supported_resolutions?.includes(String(args.resolution)))
    problems.push(
      `清晰度 ${args.resolution} 不支持（可选：${choices(entry.supported_resolutions)}）`,
    );
  if (args.aspect_ratio && !entry.supported_aspect_ratios?.includes(String(args.aspect_ratio)))
    problems.push(
      `画面比例 ${args.aspect_ratio} 不支持（可选：${choices(entry.supported_aspect_ratios)}）`,
    );
  if (args.first_frame && !entry.supported_frame_images?.includes('first_frame'))
    problems.push('不能用首帧图');
  return problems;
}

/**
 * 参数或价格对不上、没提交给供应商时说清楚：点名的模型（没点名就是能用的每一个）哪项不行、能选什么，
 * 还有哪些模型能按这组参数做。以前只说「无法确认支持所选参数」，AI 只能一项项瞎试（2026-11-13 视频任务）。
 */
export function videoRejection(input: {
  catalogue: VideoEntry[];
  /** 这个用户能用的视频模型 */
  usable: string[];
  /** 其中参数全对得上的 */
  fitting: string[];
  args: Record<string, unknown>;
  /** 选中的模型参数都对得上，只是价格表里查不到这一档的价格 */
  unpriced?: string;
}): string {
  const { args } = input;
  const head = '这组参数没有提交给供应商，没有花钱。';
  if (input.unpriced)
    return `${head}${input.unpriced} 的价格表里查不到 ${args.resolution}${args.first_frame ? '带首帧' : ''} 这一档的价格，没法先算钱；换个清晰度或模型再试。`;
  const named = typeof args.model === 'string' ? [args.model] : input.usable;
  const lines = named.map((id) => {
    const entry = input.catalogue.find((candidate) => candidate.id === id);
    return entry
      ? `${id}：${videoProblems(entry, args).join('；')}`
      : `${id}：不在供应商的视频目录里`;
  });
  const others = input.fitting.filter((id) => !named.includes(id));
  return [
    head,
    ...lines,
    others.length
      ? `按这组参数能做的模型：${others.join('、')}（用 --model 指定）`
      : '能用的视频模型都不支持这组参数，按上面「可选」的值改一下。',
  ].join('\n');
}

const VideoSubmitResponse = z.looseObject({ id: z.string() });
const VideoStatusResponse = z.looseObject({
  status: z.string(),
  error: z.unknown().optional(),
  usage: z.looseObject({ cost: z.number().optional() }).optional(),
});

export const videoGenerate: ToolDef = {
  key: 'video.generate',
  name: '生成视频',
  description:
    '按文字或一张本地首帧生成短视频素材，存成 MP4；按实时目录确认参数，不支持参考图时明确拒绝。',
  usage:
    'oasis-tool video.generate --prompt "画面描述" [--first_frame materials/首帧.png] [--duration 5] [--resolution 720p] [--aspect_ratio 16:9] --out out/视频.mp4（没等到就按提示运行 oasis-tool wait <任务号>；首帧内联输入仍需当前供应商实际验证）',
  unit: '秒',
  estimateMicro: 400_000,
  holdMicro: (args) => (Number(args.duration) || 5) * 700_000,
  long: true,
  provider: 'openrouter',
  models: (config) => config.videoModels,
  args: VideoArgs,
  cli: [
    { name: 'prompt', kind: 'text', required: true, description: '画面描述' },
    { name: 'first_frame', kind: 'path', description: '首帧图片（PNG/JPEG/WebP）' },
    { name: 'duration', kind: 'number', min: 1, max: 20, description: '秒数（默认 5）' },
    {
      name: 'resolution',
      kind: 'choice',
      choices: ['480p', '720p', '768p', '1080p'],
      description: '清晰度（默认 720p）',
    },
    {
      name: 'aspect_ratio',
      kind: 'choice',
      choices: ['16:9', '9:16', '1:1', '4:3', '3:4'],
      description: '画面比例',
    },
    MODEL_ARG,
  ],
  per: { arg: 'duration', default: 5 },
  modelOf: pickModel,
  async start(deps, args, model) {
    const a = VideoArgs.parse(args);
    const response = await deps.upstream(() =>
      deps.openrouter.submitVideo(
        {
          model,
          prompt: a.prompt,
          duration: a.duration,
          ...(a.resolution ? { resolution: a.resolution } : {}),
          ...(a.aspect_ratio ? { aspect_ratio: a.aspect_ratio } : {}),
          ...(a.first_frame
            ? {
                frame_images: [
                  {
                    type: 'image_url',
                    frame_type: 'first_frame',
                    image_url: {
                      url: `data:${a.first_frame[0]!.mediaType};base64,${a.first_frame[0]!.base64}`,
                    },
                  },
                ],
              }
            : {}),
        },
        deps.signal,
      ),
    );
    return VideoSubmitResponse.parse(await response.json()).id;
  },
  async check(deps, id) {
    const response = await deps.openrouter.videoStatus(id);
    if (!response.ok) throw new Error(`查视频进度失败：${response.status}`);
    const body = VideoStatusResponse.parse(await response.json());
    if (body.status === 'failed' || body.status === 'cancelled' || body.status === 'expired') {
      return {
        state: 'failed',
        error: `视频没生成出来：${JSON.stringify(body.error ?? body.status)}`,
      };
    }
    if (body.status !== 'completed') return { state: 'pending' };
    const content = await deps.openrouter.videoContent(id, 0);
    if (!content.ok) throw new Error(`下载视频失败：${content.status}`);
    if (!content.body) throw new Error('视频没有内容流');
    return {
      state: 'completed',
      outcome: {
        text: '视频生成好了。',
        files: [
          {
            name: 'video.mp4',
            mediaType: content.headers.get('content-type') ?? 'video/mp4',
            body: Readable.fromWeb(content.body),
          },
        ],
        cost: typeof body.usage?.cost === 'number' ? provider(body.usage.cost) : estimate(500_000),
      },
    };
  },
};
