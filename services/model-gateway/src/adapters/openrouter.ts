// OpenRouter 的最小客户端：价格表、chat completions（OpenAI 兼容）、结构化决策（Decisions API），
// 以及多模态：生图、配音、转写和查询某次生成的实际花费（ADR 0006）。
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
  chatCompletions(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
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
  return {
    configured: Boolean(options.apiKey),

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
            ...(chat && parsed.success ? { capabilities: parsed.data } : {}),
          });
        }
      }
      return prices;
    },

    chatCompletions(body, signal) {
      return post(`${base}/chat/completions`, body, signal);
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
