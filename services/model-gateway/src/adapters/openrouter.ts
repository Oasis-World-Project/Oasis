// OpenRouter 的最小客户端：价格表、chat completions（OpenAI 兼容）、结构化决策（Decisions API），
// 以及多模态：生图、配音、转写和查询某次生成的实际花费。
// 换供应商只换这个文件。
import { z } from 'zod';
import { ModelCapabilities } from '@oasis/contracts/model-gateway';

const ModelsResponse = z.object({
  data: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string().optional(),
      context_length: z.number().int().positive().nullish(),
      top_provider: z
        .looseObject({ max_completion_tokens: z.number().int().positive().nullish() })
        .nullish(),
      architecture: z
        .looseObject({
          input_modalities: z.array(z.string()).optional(),
          output_modalities: z.array(z.string()).optional(),
        })
        .nullish(),
      supported_parameters: z.array(z.string()).optional(),
      pricing: z.looseObject({ prompt: z.string(), completion: z.string() }).optional(),
    }),
  ),
});

export interface ModelPrice {
  capabilities?: ModelCapabilities;
  /** 目录里写的全部输入种类（text、image、video、audio、file）：挑看图听音的型号用它 */
  inputs?: string[];
  /** 每个输入 token 的美元价格 */
  prompt: number;
  /** 每个输出 token 的美元价格 */
  completion: number;
}

const VideoModel = z.looseObject({
  id: z.string(),
  supported_durations: z.array(z.number()).nullable().optional(),
  supported_resolutions: z.array(z.string()).nullable().optional(),
  supported_aspect_ratios: z.array(z.string()).nullable().optional(),
  supported_frame_images: z.array(z.string()).nullable().optional(),
  pricing_skus: z.record(z.string(), z.string()).nullable().optional(),
});
type VideoModel = z.infer<typeof VideoModel>;

export interface ProviderClient {
  readonly configured: boolean;
  listPrices(): Promise<Map<string, ModelPrice>>;
  /** 所有支持参考图的端点中，最保守的参考图数量上限；未知或不支持返回 0。 */
  imageReferenceLimit(model: string): Promise<number>;
  listVideoModels(): Promise<VideoModel[]>;
  /** 目录里这个配音型号能用的音色（多数配音型号必须点名一个）；目录里没有它返回空 */
  speechVoices(model: string): Promise<string[]>;
  /**
   * suspects：这个型号眼下丢内容的供应商（见 provider-health.ts），先避开它们；避开后没有别家可走
   * （这个型号只有它一家）时照常送。
   */
  chatCompletions(
    body: Record<string, unknown>,
    signal: AbortSignal,
    suspects?: readonly string[],
  ): Promise<Response>;
  decisions(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
  images(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
  speech(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
  transcriptions(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
  /** 视频：提交、查进度、下载（长任务） */
  submitVideo(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
  videoStatus(id: string): Promise<Response>;
  videoContent(id: string, index: number): Promise<Response>;
  /** 某次生成的实际花费（美元）；查不到返回 undefined */
  generationCost(id: string): Promise<number | undefined>;
}

/**
 * 不送的供应商：型号 → OpenRouter 上供应商的名字（slug，如 amazon-bedrock；放进 `provider.ignore`）。
 * 只写实测有问题的，带上日期和现象；那家修好了就删掉。实测办法：发一段带工具结果的对话，看那家报回的
 * 输入 token 有没有把工具结果算进去、模型答不答得出里面的内容。
 */
const PROVIDERS_TO_AVOID: Readonly<Record<string, readonly string[]>> = {
  // 2026-11-26：不把工具结果交给模型。9,759 个字符的工具结果只算了 36 个 token，模型说「文件是空的」；
  // 线上一轮因此空转了 83 次调用。同一天 Bedrock 上的 Kimi K3.1 Pro、Grok 4.7 是好的。
  // 去掉它之后这个型号只剩 SiliconFlow 一家（int4 量化）。
  'moonshotai/kimi-k2.5': ['amazon-bedrock'],
};

/**
 * 聊天请求依次试的供应商范围。账号里放开了「会拿请求训练的付费供应商」，只为用 DeepSeek 官方（用户
 * 11-14 定）：DeepSeek 的型号先只走官方，官方出错再换别家；别的型号、换的别家，只走不拿请求训练的。
 * 写了不送的供应商（PROVIDERS_TO_AVOID）哪个范围都不送；眼下丢内容的（suspects）先避开，
 * 最后留一个不避开它们的范围：这个型号只有它一家时还能用。
 */
function routesOf(
  body: Record<string, unknown>,
  suspects: readonly string[] = [],
): Record<string, unknown>[] {
  const model = String(body.model);
  const own = (body.provider ?? {}) as Record<string, unknown>;
  const never = [
    ...(Array.isArray(own.ignore) ? (own.ignore as string[]) : []),
    ...(PROVIDERS_TO_AVOID[model] ?? []),
  ];
  const within = (scope: Record<string, unknown>, ignore: readonly string[]) => ({
    ...own,
    ...scope,
    ...(ignore.length ? { ignore: [...new Set(ignore)] } : {}),
  });
  const safe = { data_collection: 'deny' };
  const avoiding = [...never, ...suspects];
  const official =
    model.startsWith('deepseek/') && !avoiding.some((name) => name.toLowerCase() === 'deepseek');
  return [
    ...(official ? [within({ only: ['deepseek'], allow_fallbacks: false }, never)] : []),
    within(safe, avoiding),
    ...(suspects.length ? [within(safe, never)] : []),
  ];
}

export function createOpenRouterClient(options: {
  baseUrl: string;
  /** Decisions API 不在 /api/v1 下，单独配置 */
  decisionsUrl: string;
  apiKey: string | undefined;
}): ProviderClient {
  const base = options.baseUrl.replace(/\/$/, '');
  const post = (url: string, body: Record<string, unknown>, signal: AbortSignal) =>
    fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey ?? ''}`,
        'content-type': 'application/json',
        'x-title': 'Oasis',
      },
      body: JSON.stringify(body),
      signal,
    });
  const get = (url: string, timeoutMs: number) =>
    fetch(url, {
      headers: { authorization: `Bearer ${options.apiKey ?? ''}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  /** 配音型号不在默认目录里，要按输出种类另取；音色不常变，取一次用 10 分钟 */
  let voices: { at: number; byModel: Map<string, string[]> } | undefined;
  return {
    configured: Boolean(options.apiKey),

    async speechVoices(model) {
      if (!voices || Date.now() - voices.at > 10 * 60_000) {
        const response = await fetch(`${base}/models?output_modalities=speech`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`读取配音型号目录失败：${response.status}`);
        const { data } = z
          .object({
            data: z.array(
              z.looseObject({ id: z.string(), supported_voices: z.array(z.unknown()).nullish() }),
            ),
          })
          .parse(await response.json());
        voices = {
          at: Date.now(),
          byModel: new Map(
            data.map((entry) => [
              entry.id,
              (entry.supported_voices ?? []).filter(
                (voice): voice is string => typeof voice === 'string' && voice.length > 0,
              ),
            ]),
          ),
        };
      }
      return voices.byModel.get(model) ?? [];
    },

    async listVideoModels() {
      const response = await get(`${base}/videos/models`, 15_000);
      if (!response.ok) throw new Error(`读取视频能力失败：${response.status}`);
      return z.object({ data: z.array(VideoModel) }).parse(await response.json()).data;
    },

    async imageReferenceLimit(model) {
      const slug = model.split('/').map(encodeURIComponent).join('/');
      const response = await get(`${base}/images/models/${slug}/endpoints`, 15_000);
      if (!response.ok) throw new Error(`读取参考图能力失败：${response.status}`);
      const body = z
        .object({
          endpoints: z.array(
            z.looseObject({
              supported_parameters: z.record(z.string(), z.unknown()).optional(),
            }),
          ),
        })
        .parse(await response.json());
      const limits = body.endpoints
        .map((endpoint) => {
          const range = z
            .object({ type: z.literal('range'), max: z.number().int().nonnegative() })
            .safeParse(endpoint.supported_parameters?.input_references);
          return range.success ? range.data.max : 0;
        })
        .filter((limit) => limit > 0);
      return limits.length ? Math.min(...limits) : 0;
    },

    async listPrices() {
      // 价格表是公开接口，不需要 Key
      const response = await fetch(`${base}/models`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`拉取价格表失败：${response.status}`);
      const { data } = ModelsResponse.parse(await response.json());
      const prices = new Map<string, ModelPrice>();
      for (const model of data) {
        const prompt = Number(model.pricing?.prompt);
        const completion = Number(model.pricing?.completion);
        if (
          Number.isFinite(prompt) &&
          Number.isFinite(completion) &&
          prompt >= 0 &&
          completion >= 0
        ) {
          const parsed = ModelCapabilities.safeParse({
            id: model.id,
            name: model.name ?? model.id,
            contextWindow: model.context_length,
            maxTokens: model.top_provider?.max_completion_tokens,
            input: model.architecture?.input_modalities?.filter(
              (m) => m === 'text' || m === 'image',
            ),
            reasoning:
              model.supported_parameters?.some(
                (p) => p === 'reasoning' || p === 'reasoning_effort',
              ) ?? false,
          });
          const chat = model.architecture?.output_modalities?.includes('text');
          prices.set(model.id, {
            prompt,
            completion,
            inputs: model.architecture?.input_modalities ?? [],
            ...(chat && parsed.success ? { capabilities: parsed.data } : {}),
          });
        }
      }
      return prices;
    },

    async chatCompletions(body, signal, suspects) {
      const [first, ...rest] = routesOf(body, suspects);
      let response = await post(`${base}/chat/completions`, { ...body, provider: first }, signal);
      // 前一个范围没接（出错、没有可用的供应商）就换下一个；还没开始返回内容，换了不会重复收费
      for (const provider of rest) {
        if (response.ok) break;
        await response.body?.cancel();
        response = await post(`${base}/chat/completions`, { ...body, provider }, signal);
      }
      return response;
    },

    decisions(body, signal) {
      return post(options.decisionsUrl, body, signal);
    },

    images: (body, signal) => post(`${base}/images`, body, signal),
    speech: (body, signal) => post(`${base}/audio/speech`, body, signal),
    transcriptions: (body, signal) => post(`${base}/audio/transcriptions`, body, signal),

    submitVideo: (body, signal) => post(`${base}/videos`, body, signal),
    videoStatus: (id) => get(`${base}/videos/${encodeURIComponent(id)}`, 30_000),
    videoContent: (id, index) =>
      get(`${base}/videos/${encodeURIComponent(id)}/content?index=${index}`, 300_000),

    async generationCost(id) {
      const response = await fetch(`${base}/generation?id=${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${options.apiKey ?? ''}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { data?: { total_cost?: number } };
      return typeof body.data?.total_cost === 'number' ? body.data.total_cost : undefined;
    },
  };
}
