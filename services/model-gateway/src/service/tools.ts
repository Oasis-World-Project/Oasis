// 工具的定义（ADR 0006）：每个工具 = 参数校验 + 目录信息 + 怎么调供应商、怎么算钱。
// 目录放在这里（和供应商适配在一起），由 model-gateway 对外提供；以后接新供应商（如 fal.ai）只在这里加。
import { z } from 'zod';
import type { ProviderClient } from '../adapters/openrouter.ts';
import type { SearchClient } from '../adapters/tavily.ts';
import { USD_TO_MICRO, type CostSource } from './pricing.ts';

/** 工具交回给 AI 的文字最多这么长 */
const MAX_TEXT = 20_000;

export interface ToolConfig {
  imageModels: string[];
  videoModels: string[];
  speechModels: string[];
  transcribeModels: string[];
  jevModel: string;
  /** Tavily 每个积分多少钱（微美元） */
  tavilyCreditMicro: number;
  /** 配音拿不到实际花费时，每个字估多少钱（微美元） */
  speechMicroPerChar: number;
}

interface ToolDeps {
  openrouter: ProviderClient;
  tavily: SearchClient;
  config: ToolConfig;
  /** 发请求给供应商：还没产生费用就失败时，由计量那边退回冻结并抛出给调用方看的错误 */
  upstream: (request: () => Promise<Response>) => Promise<Response>;
  signal: AbortSignal;
}

interface ToolOutcome {
  text: string;
  data?: unknown;
  files: { name: string; mediaType: string; base64: string }[];
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
  provider: 'openrouter' | 'tavily';
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
});

const SpeechArgs = z.object({
  text: z.string().trim().min(1).max(4000),
  voice: z.string().min(1).max(100).optional(),
  instructions: z.string().max(500).optional(),
  model: optionalModel,
});

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
      'oasis-tool image.generate --prompt "描述" [--aspect_ratio 16:9] [--resolution 2K] [--n 1] --out out/图片.png',
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
    usage: 'oasis-tool web.fetch --urls https://a.com/x,https://b.com/y [--depth basic|advanced]',
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
      const perPage = Math.floor(MAX_TEXT / Math.max(1, body.results.length));
      const parts = body.results.map((r) => `## ${r.url}\n\n${clip(r.raw_content ?? '', perPage)}`);
      for (const f of body.failed_results) parts.push(`## ${f.url}\n\n（没读到：${f.error}）`);
      const credits =
        body.usage?.credits ??
        Math.ceil(body.results.length / 5) * (a.depth === 'advanced' ? 2 : 1);
      return {
        text: parts.join('\n\n'),
        files: [],
        cost: { costMicro: credits * deps.config.tavilyCreditMicro, source: 'provider' },
      };
    },
  },
  {
    key: 'video.generate',
    name: '生成视频',
    description:
      '按文字描述生成一段短视频（几秒到十几秒，商品展示、宣传片段、场景镜头……），存成 MP4。要等几分钟。',
    usage:
      'oasis-tool video.generate --prompt "画面描述" [--duration 5] [--resolution 720p] [--aspect_ratio 16:9] --out out/视频.mp4（没等到就按提示运行 oasis-tool wait <任务号>）',
    unit: '秒',
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
      const video = Buffer.from(await content.arrayBuffer());
      return {
        state: 'completed',
        outcome: {
          text: `视频生成好了（${video.length} 字节）。`,
          files: [
            {
              name: 'video.mp4',
              mediaType: content.headers.get('content-type') ?? 'video/mp4',
              base64: video.toString('base64'),
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
      'oasis-tool jev.decide --question "哪个标题更好" --options "标题A,标题B" [--context "要判断的材料"]（或 --scale "差,一般,好"；都不给就是判断是/否）',
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
