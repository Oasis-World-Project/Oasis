// OpenRouter 的最小客户端：价格表、chat completions（OpenAI 兼容）、结构化决策（Decisions API）。
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
  };
}
