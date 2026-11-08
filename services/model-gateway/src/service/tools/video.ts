// 视频工具：按文字或首帧生成短视频（长任务：提交 → 查进度 → 取结果）。
import { Readable } from 'node:stream';
import { z } from 'zod';
import { estimate, InputImages, optionalModel, pickModel, provider, type ToolDef } from './kit.ts';

const VideoArgs = z.object({
  prompt: z.string().trim().min(1).max(4000),
  duration: z.coerce.number().int().min(1).max(20).default(5),
  resolution: z.enum(['480p', '720p', '768p', '1080p']).default('720p'),
  aspect_ratio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4']).optional(),
  first_frame: InputImages.max(1).optional(),
  model: optionalModel,
});

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
