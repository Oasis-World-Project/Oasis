// OpenRouter 的最小客户端：价格表、chat completions（OpenAI 兼容）、结构化决策（Decisions API），
// 以及多模态：生图、配音、转写和查询某次生成的实际花费（ADR 0006）。
// 换供应商只换这个文件。
import { z } from 'zod';

const ModelsResponse = z.object({
  data: z.array(
    z.looseObject({
      id: z.string(),
      pricing: z.looseObject({ prompt: z.string(), completion: z.string() }).optional(),
    }),
  ),
});

export interface ModelPrice {
  /** 每个输入 token 的美元价格 */
  prompt: number;
  /** 每个输出 token 的美元价格 */
  completion: number;
}

export interface ProviderClient {
  readonly configured: boolean;
  listPrices(): Promise<Map<string, ModelPrice>>;
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
          prices.set(model.id, { prompt, completion });
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
