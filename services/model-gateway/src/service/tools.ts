// 工具的定义（ADR 0006）：每个工具 = 参数校验 + 目录信息 + 怎么调供应商、怎么算钱。
// 目录放在这里（和供应商适配在一起），由 model-gateway 对外提供；以后接新供应商（如 fal.ai）只在这里加。
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { HttpError } from '@oasis/service-kit';
import type { ProviderClient } from '../adapters/openrouter.ts';
import type { SearchClient } from '../adapters/tavily.ts';
import type { FalClient } from '../adapters/fal.ts';
import { USD_TO_MICRO, type CostSource } from './pricing.ts';

/** 工具交回给 AI 的文字最多这么长 */
const MAX_TEXT = 20_000;

export interface ToolConfig {
  imageModels: string[];
  visionModels: string[];
  visionMaxTokens: number;
  fetchMaxBytes: number;
  videoModels: string[];
  speechModels: string[];
  transcribeModels: string[];
  jevModel: string;
  /** Tavily 每个积分多少钱（微美元） */
  tavilyCreditMicro: number;
  /** 配音拿不到实际花费时，每个字估多少钱（微美元） */
  speechMicroPerChar: number;
  musicModels?: string[];
  musicMicroPerGeneration?: number;
}

interface ToolDeps {
  openrouter: ProviderClient;
  tavily: SearchClient;
  fal?: FalClient;
  config: ToolConfig;
  /** 发请求给供应商：还没产生费用就失败时，由计量那边退回冻结并抛出给调用方看的错误 */
  upstream: (request: () => Promise<Response>) => Promise<Response>;
  signal: AbortSignal;
}

interface ToolOutcome {
  text: string;
  data?: unknown;
  files: { name: string; mediaType: string; base64?: string; body?: Readable }[];
  cost: { costMicro: number; source: CostSource };
}

interface ToolBase {
  key: string;
  name: string;
  description: string;
  usage: string;
  unit: string;
  estimateMicro: number;
  /** 调用前冻结多少（微美元），按参数算 */
  holdMicro: (args: Record<string, unknown>) => number;
  /** 依赖哪个供应商（没配 Key 就不能用） */
  provider: 'openrouter' | 'tavily' | 'fal';
  /** 可以选的模型；不需要模型的工具返回空 */
  models: (config: ToolConfig) => string[];
  args: z.ZodType<Record<string, unknown>>;
  /** 这次调用记在哪个模型名下（调用记录、地区检查用） */
  modelOf: (args: Record<string, unknown>, models: string[]) => string;
}

/** 马上出结果的工具 */
interface QuickTool extends ToolBase {
  long: false;
  run: (deps: ToolDeps, args: Record<string, unknown>, model: string) => Promise<ToolOutcome>;
}

/** 长任务的进度 */
type LongState =
  | { state: 'pending' }
  | { state: 'failed'; error: string }
  | { state: 'completed'; outcome: ToolOutcome };

/** 长任务（视频）：先提交拿到供应商的任务号，之后查进度，做好了再取结果 */
interface LongTool extends ToolBase {
  long: true;
  start: (deps: ToolDeps, args: Record<string, unknown>, model: string) => Promise<string>;
  check: (deps: ToolDeps, providerJobId: string) => Promise<LongState>;
}

export type ToolDef = QuickTool | LongTool;

const usd = (value: number) => Math.round(value * USD_TO_MICRO);
const clip = (text: string, max = MAX_TEXT) =>
  text.length > max ? `${text.slice(0, max)}\n……（太长，后面省略了）` : text;
const optionalModel = z.string().min(1).max(200).optional();
/** 指定了模型就用指定的，否则用可选模型里的第一个 */
const pickModel = (args: Record<string, unknown>, models: string[]) =>
  typeof args.model === 'string' ? args.model : (models[0] ?? '');

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

/** 不接受远程 URL；图片经既有上传/沙箱通路传入，限制请求和内存占用。 */
const InputImages = z
  .array(
    z
      .object({
        mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
        base64: z.string().min(4).max(28_000_000),
      })
      .refine((image) => {
        if (image.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64))
          return false;
        const bytes = Buffer.from(image.base64, 'base64');
        if (image.mediaType === 'image/png')
          return (
            bytes.length >= 24 &&
            bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
          );
        if (image.mediaType === 'image/jpeg')
          return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        return (
          bytes.length >= 16 &&
          bytes.toString('ascii', 0, 4) === 'RIFF' &&
          bytes.toString('ascii', 8, 12) === 'WEBP'
        );
      }, '图片编码、格式或文件签名无效'),
  )
  .min(1)
  .max(4)
  .refine(
    (images) =>
      images.reduce((n, image) => n + Buffer.byteLength(image.base64, 'base64'), 0) <=
      20 * 1024 * 1024,
    '图片总大小超过 20 MiB',
  );
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

const SpeechArgs = z.object({
  text: z.string().trim().min(1).max(4000),
  voice: z.string().min(1).max(100).optional(),
  instructions: z.string().max(500).optional(),
  model: optionalModel,
});

const MusicArgs = z
  .object({
    prompt: z.string().trim().min(10).max(2000),
    instrumental: z.union([
      z.boolean(),
      z.enum(['true', 'false']).transform((value) => value === 'true'),
    ]),
    lyrics: z.string().max(3500).optional(),
    model: optionalModel,
  })
  .refine(
    (args) => args.instrumental || Boolean(args.lyrics?.trim()),
    '歌曲必须提供歌词；器乐请指定 instrumental=true',
  );

const TranscribeArgs = z.object({
  audio_base64: z.string().min(1),
  format: z.enum(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'webm']),
  language: z.string().min(2).max(10).optional(),
  model: optionalModel,
});

const SearchArgs = z.object({
  query: z.string().trim().min(1).max(400),
  max_results: z.coerce.number().int().min(1).max(10).default(5),
  depth: z.enum(['basic', 'advanced']).default('basic'),
  topic: z.enum(['general', 'news', 'finance']).default('general'),
  time_range: z.enum(['day', 'week', 'month', 'year']).optional(),
});

const FetchArgs = z.object({
  urls: z.array(z.url()).min(1).max(5),
  depth: z.enum(['basic', 'advanced']).default('basic'),
  format: z.enum(['text', 'files']).default('text'),
});

const VideoArgs = z.object({
  prompt: z.string().trim().min(1).max(4000),
  duration: z.coerce.number().int().min(1).max(20).default(5),
  resolution: z.enum(['480p', '720p', '768p', '1080p']).optional(),
  aspect_ratio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4']).optional(),
  model: optionalModel,
});

const DecideArgs = z.object({
  question: z.string().trim().min(1).max(1000),
  /** 选一个：给出选项 */
  options: z.array(z.string().trim().min(1).max(200)).min(2).max(10).optional(),
  /** 打分：从低到高的刻度 */
  scale: z.array(z.string().trim().min(1).max(200)).min(2).max(10).optional(),
  /** 要判断的材料 */
  context: z.string().max(20_000).optional(),
});

const Tavily = z.looseObject({ usage: z.looseObject({ credits: z.number() }).optional() });
const SearchResponse = Tavily.extend({
  results: z.array(z.looseObject({ title: z.string(), url: z.string(), content: z.string() })),
});
const ExtractResponse = Tavily.extend({
  results: z.array(z.looseObject({ url: z.string(), raw_content: z.string().nullable() })),
  failed_results: z.array(z.looseObject({ url: z.string(), error: z.string() })).default([]),
});
const ImagesResponse = z.looseObject({
  data: z.array(z.looseObject({ b64_json: z.string(), media_type: z.string().optional() })),
  usage: z.looseObject({ cost: z.number().optional() }).optional(),
});
const TranscriptionResponse = z.looseObject({
  text: z.string(),
  usage: z.looseObject({ cost: z.number().optional() }).optional(),
});
const VideoSubmitResponse = z.looseObject({ id: z.string() });
const VideoStatusResponse = z.looseObject({
  status: z.string(),
  error: z.unknown().optional(),
  usage: z.looseObject({ cost: z.number().optional() }).optional(),
});
const DecisionResponse = z.looseObject({
  answers: z.record(z.string(), z.looseObject({})),
  usage: z.looseObject({ cost: z.number().optional() }).optional(),
});

/** 实际花费拿不到时的估算 */
const estimate = (costMicro: number) => ({ costMicro, source: 'estimate' as const });
const provider = (costUsd: number) => ({ costMicro: usd(costUsd), source: 'provider' as const });

export const TOOLS: ToolDef[] = [
  {
    key: 'image.generate',
    name: '生成图片',
    description: '按文字描述生成图片（插画、海报、商品图、网页效果图……），结果存成 PNG 文件。',
    usage:
      'oasis-tool image.generate --prompt "描述" [--ref materials/主图.png,materials/风格.jpg] [--aspect_ratio 16:9] [--resolution 2K] [--n 1] --out out/图片.png',
    unit: '张',
    estimateMicro: 40_000,
    holdMicro: (args) => 200_000 * (Number(args.n) || 1),
    long: false,
    provider: 'openrouter',
    models: (config) => config.imageModels,
    args: ImageArgs,
    modelOf: pickModel,
    async run(deps, args, model) {
      const a = ImageArgs.parse(args);
      const response = await deps.upstream(() =>
        deps.openrouter.images(
          {
            model,
            prompt: a.prompt,
            n: a.n,
            output_format: 'png',
            ...(a.references
              ? {
                  input_references: imageParts(a.references),
                  provider: { require_parameters: true },
                }
              : {}),
            ...(a.aspect_ratio ? { aspect_ratio: a.aspect_ratio } : {}),
            ...(a.resolution ? { resolution: a.resolution } : {}),
          },
          deps.signal,
        ),
      );
      const body = ImagesResponse.parse(await response.json());
      const files = body.data.map((d, i) => {
        const mediaType = d.media_type ?? 'image/png';
        return { name: `image-${i + 1}.${extOf(mediaType)}`, mediaType, base64: d.b64_json };
      });
      return {
        text: `生成了 ${files.length} 张图片（${model}）。`,
        files,
        cost:
          typeof body.usage?.cost === 'number'
            ? provider(body.usage.cost)
            : estimate(40_000 * files.length),
      };
    },
  },
  {
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
  },
  {
    key: 'audio.speech',
    name: '文字转语音',
    description: '把一段文字读出来（旁白、配音、提示音），结果存成 MP3 文件。',
    usage:
      'oasis-tool audio.speech --text "要读的文字" [--voice 音色] [--instructions "语气"] --out out/配音.mp3',
    unit: '千字',
    estimateMicro: 20_000,
    holdMicro: (args) => 50_000 + String(args.text ?? '').length * 50,
    long: false,
    provider: 'openrouter',
    models: (config) => config.speechModels,
    args: SpeechArgs,
    modelOf: pickModel,
    async run(deps, args, model) {
      const a = SpeechArgs.parse(args);
      const response = await deps.upstream(() =>
        deps.openrouter.speech(
          {
            model,
            input: a.text,
            response_format: 'mp3',
            ...(a.voice ? { voice: a.voice } : {}),
            ...(a.instructions ? { instructions: a.instructions } : {}),
          },
          deps.signal,
        ),
      );
      const audio = Buffer.from(await response.arrayBuffer());
      const generationId = response.headers.get('x-generation-id');
      // 配音的花费不在返回里：按生成 ID 去查，查不到就按字数估
      let cost: number | undefined;
      for (const wait of [500, 1500, 3000]) {
        if (!generationId) break;
        await new Promise((resolve) => setTimeout(resolve, wait));
        cost = await deps.openrouter.generationCost(generationId).catch(() => undefined);
        if (cost !== undefined) break;
      }
      return {
        text: `生成了一段语音（${model}，${audio.length} 字节）。`,
        files: [{ name: 'speech.mp3', mediaType: 'audio/mpeg', base64: audio.toString('base64') }],
        cost:
          cost !== undefined
            ? provider(cost)
            : estimate(a.text.length * deps.config.speechMicroPerChar),
      };
    },
  },
  {
    key: 'audio.transcribe',
    name: '语音转文字',
    description: '把一段录音转成文字（会议、采访、视频里的说话）。',
    usage: 'oasis-tool audio.transcribe --file in/录音.mp3 [--language zh]',
    unit: '次',
    estimateMicro: 10_000,
    holdMicro: () => 100_000,
    long: false,
    provider: 'openrouter',
    models: (config) => config.transcribeModels,
    args: TranscribeArgs,
    modelOf: pickModel,
    async run(deps, args, model) {
      const a = TranscribeArgs.parse(args);
      const response = await deps.upstream(() =>
        deps.openrouter.transcriptions(
          {
            model,
            input_audio: { data: a.audio_base64, format: a.format },
            ...(a.language ? { language: a.language } : {}),
          },
          deps.signal,
        ),
      );
      const body = TranscriptionResponse.parse(await response.json());
      return {
        text: clip(body.text),
        files: [],
        cost: typeof body.usage?.cost === 'number' ? provider(body.usage.cost) : estimate(10_000),
      };
    },
  },
  {
    key: 'web.search',
    name: '联网搜索',
    description: '在网上搜索资料，返回最相关的几条结果（标题、网址、摘要）。',
    usage:
      'oasis-tool web.search --query "关键词" [--max_results 5] [--depth basic|advanced] [--topic general|news|finance] [--time_range week]',
    unit: '次',
    estimateMicro: 8_000,
    holdMicro: (args) => (args.depth === 'advanced' ? 2 : 1) * 8_000 * 2,
    long: false,
    provider: 'tavily',
    models: () => [],
    args: SearchArgs,
    modelOf: () => 'tavily/search',
    async run(deps, args) {
      const a = SearchArgs.parse(args);
      const response = await deps.upstream(() =>
        deps.tavily.search(
          {
            query: a.query,
            max_results: a.max_results,
            search_depth: a.depth,
            topic: a.topic,
            include_usage: true,
            ...(a.time_range ? { time_range: a.time_range } : {}),
          },
          deps.signal,
        ),
      );
      const body = SearchResponse.parse(await response.json());
      const credits = body.usage?.credits ?? (a.depth === 'advanced' ? 2 : 1);
      const lines = body.results.map(
        (r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${clip(r.content.replace(/\s+/g, ' '), 800)}`,
      );
      return {
        text: lines.length > 0 ? lines.join('\n\n') : '没有搜到结果。',
        data: body.results.map((r) => ({ title: r.title, url: r.url })),
        files: [],
        cost: { costMicro: credits * deps.config.tavilyCreditMicro, source: 'provider' },
      };
    },
  },
  {
    key: 'web.fetch',
    name: '读取网页',
    description: '读取 1–5 个网页的正文（转成 Markdown），用来细看搜索到的资料。',
    usage:
      'oasis-tool web.fetch --urls https://a.com/x,https://b.com/y [--depth basic|advanced] [--out out/资料/（保存全文）]',
    unit: '次',
    estimateMicro: 8_000,
    holdMicro: (args) => (args.depth === 'advanced' ? 2 : 1) * 8_000 * 2,
    long: false,
    provider: 'tavily',
    models: () => [],
    args: FetchArgs,
    modelOf: () => 'tavily/extract',
    async run(deps, args) {
      const a = FetchArgs.parse(args);
      const response = await deps.upstream(() =>
        deps.tavily.extract(
          { urls: a.urls, extract_depth: a.depth, format: 'markdown', include_usage: true },
          deps.signal,
        ),
      );
      const body = ExtractResponse.parse(await response.json());
      if (
        a.format === 'files' &&
        body.results.reduce((total, r) => total + Buffer.byteLength(r.raw_content ?? ''), 0) >
          deps.config.fetchMaxBytes
      ) {
        throw new HttpError(
          413,
          'web_content_too_large',
          '网页正文总大小超过配置上限，请减少一次抓取的网址数',
        );
      }
      const perPage = Math.floor(MAX_TEXT / Math.max(1, body.results.length));
      const parts = body.results.map((r) => `## ${r.url}\n\n${clip(r.raw_content ?? '', perPage)}`);
      for (const f of body.failed_results) parts.push(`## ${f.url}\n\n（没读到：${f.error}）`);
      const credits =
        body.usage?.credits ??
        Math.ceil(body.results.length / 5) * (a.depth === 'advanced' ? 2 : 1);
      return {
        text:
          a.format === 'files'
            ? [
                ...body.results.map((r) => `${r.url}：${(r.raw_content ?? '').length} 字`),
                ...body.failed_results.map((r) => `${r.url}：没读到（${r.error}）`),
              ].join('\n')
            : parts.join('\n\n'),
        data: { sources: body.results.map((r) => r.url), failed: body.failed_results },
        files:
          a.format === 'files'
            ? body.results.map((r, i) => ({
                name: `${i + 1}-${createHash('sha256').update(r.url).digest('hex').slice(0, 12)}.md`,
                mediaType: 'text/markdown',
                base64: Buffer.from(`来源：${r.url}\n\n${r.raw_content ?? ''}`).toString('base64'),
              }))
            : [],
        cost: { costMicro: credits * deps.config.tavilyCreditMicro, source: 'provider' },
      };
    },
  },
  {
    key: 'audio.music',
    name: '生成音乐',
    description: '生成完整器乐曲或带歌词的歌曲；结果为混合音频，不保证分轨或精确时长。',
    usage:
      'oasis-tool audio.music --prompt "音乐风格和段落要求" --instrumental true|false [--lyrics "歌词"] --out out/音乐.mp3',
    unit: '首',
    estimateMicro: 150_000,
    holdMicro: () => 500_000,
    long: true,
    provider: 'fal',
    models: (config) => config.musicModels ?? [],
    args: MusicArgs,
    modelOf: pickModel,
    async start(deps, args, model) {
      if (!deps.fal) throw new Error('音乐供应商未配置');
      const a = MusicArgs.parse(args);
      const response = await deps.upstream(() =>
        deps.fal!.submit(
          model,
          {
            prompt: a.prompt,
            is_instrumental: a.instrumental,
            lyrics: a.instrumental ? '' : a.lyrics,
            audio_setting: { sample_rate: '44100', bitrate: '256000', format: 'mp3' },
          },
          deps.signal,
        ),
      );
      return deps.fal.handle(await response.json());
    },
    async check(deps, id) {
      if (!deps.fal) throw new Error('音乐供应商未配置');
      const status = await deps.fal.status(id);
      if (!status.ok) throw new Error(`查音乐进度失败：${status.status}`);
      const state = z
        .object({ status: z.enum(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED']) })
        .parse(await status.json());
      if (state.status !== 'COMPLETED') return { state: 'pending' };
      const response = await deps.fal.result(id);
      if (response.status === 422 || response.status === 400)
        return { state: 'failed', error: '音乐供应商报告生成失败' };
      if (!response.ok) throw new Error(`取音乐结果失败：${response.status}`);
      const result = z.object({ audio: z.object({ url: z.url() }) }).parse(await response.json());
      const media = await deps.fal.media(result.audio.url);
      if (
        !media.body ||
        !/^(audio\/|application\/octet-stream)/.test(media.headers.get('content-type') ?? '')
      )
        throw new Error('音乐返回格式不合格');
      return {
        state: 'completed',
        outcome: {
          text: '音乐生成完成；这是供应商返回的混合音轨。',
          files: [
            { name: 'music.mp3', mediaType: 'audio/mpeg', body: Readable.fromWeb(media.body) },
          ],
          cost: estimate(deps.config.musicMicroPerGeneration ?? 150_000),
        },
      };
    },
  },
  {
    key: 'video.generate',
    name: '生成视频',
    description:
      '按文字描述生成一段短视频（几秒到十几秒，商品展示、宣传片段、场景镜头……），存成 MP4。',
    usage:
      'oasis-tool video.generate --prompt "画面描述" [--duration 5] [--resolution 720p] [--aspect_ratio 16:9] --out out/视频.mp4（没等到就按提示运行 oasis-tool wait <任务号>）',
    unit: '段（约 5 秒）',
    estimateMicro: 500_000,
    holdMicro: (args) => (Number(args.duration) || 5) * 250_000,
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
          cost:
            typeof body.usage?.cost === 'number' ? provider(body.usage.cost) : estimate(500_000),
        },
      };
    },
  },
  {
    key: 'jev.decide',
    name: '快速判断',
    description:
      '让 Jev 对材料做一个结构化判断并给出概率：是否满足某条件、从几个选项里选一个、或按刻度打分。几乎不花钱，适合挑最好的版本、检查是否达标。',
    usage:
      'oasis-tool jev.decide --question "哪个标题更好" --options "标题A,标题B" [--context "材料"]（或 --scale "差,一般,好"）；批量：--in 问题.jsonl --out out/评分.jsonl --budget_micro 1000000，每行 {id,question,context?,scale?}，uses 按行数计；--resume true 恢复',
    unit: '次',
    estimateMicro: 100,
    holdMicro: (args) => 2_000 + String(args.context ?? '').length,
    long: false,
    provider: 'openrouter',
    models: (config) => [config.jevModel],
    args: DecideArgs,
    modelOf: (_args, models) => models[0] ?? '',
    async run(deps, args, model) {
      const a = DecideArgs.parse(args);
      const question = a.options
        ? {
            type: 'choice',
            instructions: a.question,
            criteria: Object.fromEntries(a.options.map((o) => [o, o])),
          }
        : a.scale
          ? { type: 'score', instructions: a.question, criteria: a.scale }
          : {
              type: 'noul',
              instructions: a.question,
              criteria: { true: '是', false: '不是' },
            };
      const response = await deps.upstream(() =>
        deps.openrouter.decisions(
          { model, state: [a.context ?? a.question], questions: { q: question } },
          deps.signal,
        ),
      );
      const body = DecisionResponse.parse(await response.json());
      const answer = body.answers.q ?? {};
      return {
        text: JSON.stringify(answer),
        data: answer,
        files: [],
        cost: typeof body.usage?.cost === 'number' ? provider(body.usage.cost) : estimate(100),
      };
    },
  },
];
