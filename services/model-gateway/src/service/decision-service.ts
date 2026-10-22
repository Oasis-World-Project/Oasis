// 结构化决策（Jev 等，OpenRouter Decisions API）：冻结 → 调上游 → 按 usage.cost 结算。
// 决策模型只按输入收费、不生成文字，所以冻结金额只按输入估算，并留出余量。
import type { DecisionRequest } from '@oasis/contracts/model-gateway';
import { HttpError, type Logger } from '@oasis/service-kit';
import type { ModelPrice, ProviderClient } from '../adapters/openrouter.ts';
import { upstreamError } from './chat-service.ts';
import type { Caller, Meter } from './metering.ts';
import type { Usage } from './pricing.ts';

const USD_TO_MICRO = 1_000_000;
/** 输入 token 的保守估计：与聊天一致，按 1.5 个字符 1 个 token；图片按 1,500 token 一张 */
const CHARS_PER_TOKEN = 1.5;
const IMAGE_TOKENS = 1_500;

function estimateDecisionTokens(body: DecisionRequest): number {
  const state = typeof body.state === 'string' ? [body.state] : body.state;
  let tokens = 0;
  for (const part of state) {
    if (typeof part === 'string') tokens += Math.ceil(part.length / CHARS_PER_TOKEN);
    else if ((part as { type?: string }).type === 'image_url') tokens += IMAGE_TOKENS;
    else tokens += Math.ceil(JSON.stringify(part).length / CHARS_PER_TOKEN);
  }
  return tokens + Math.ceil(JSON.stringify(body.questions).length / CHARS_PER_TOKEN);
}

export function createDecisionService(deps: {
  provider: ProviderClient;
  meter: Meter;
  prices: () => Map<string, ModelPrice>;
  fallbackHoldMicro: number;
  logger: Logger;
}) {
  const { provider, meter, logger } = deps;

  return {
    async decide(input: {
      caller: Caller;
      requestId: string;
      body: DecisionRequest;
      signal: AbortSignal;
    }): Promise<unknown> {
      if (!provider.configured) {
        throw new HttpError(503, 'provider_not_configured', '模型服务还没有配置 API Key');
      }
      const { body } = input;
      const price = deps.prices().get(body.model);
      const inputTokens = estimateDecisionTokens(body);
      // 余量 2 倍：决策模型的分词和计费方式与聊天模型不同
      const amountMicro = price
        ? Math.max(1, Math.ceil(inputTokens * price.prompt * 2 * USD_TO_MICRO))
        : deps.fallbackHoldMicro;
      const call = await meter.hold({
        caller: input.caller,
        kind: 'decision',
        model: body.model,
        amountMicro,
        requestId: input.requestId,
      });

      let response: Response;
      try {
        response = await provider.decisions(body, input.signal);
      } catch (err) {
        await meter.release(call, `上游连接失败：${String(err)}`);
        throw new HttpError(503, 'provider_unavailable', '模型服务暂时连不上', { cause: err });
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 500);
        await meter.release(call, `上游返回 ${response.status}：${detail}`);
        logger.warn({ status: response.status, detail, model: body.model }, '决策模型拒绝了请求');
        throw upstreamError(response.status, detail);
      }

      const result = (await response.json()) as { usage?: Usage };
      const usage = result.usage;
      const cost =
        typeof usage?.cost === 'number' && usage.cost >= 0
          ? { costMicro: Math.round(usage.cost * USD_TO_MICRO), source: 'provider' as const }
          : price && typeof usage?.prompt_tokens === 'number'
            ? {
                costMicro: Math.ceil(usage.prompt_tokens * price.prompt * USD_TO_MICRO),
                source: 'tokens' as const,
              }
            : {
                costMicro: price ? Math.ceil(inputTokens * price.prompt * USD_TO_MICRO) : 0,
                source: 'estimate' as const,
              };
      await meter.settle(call, cost, usage);
      return result;
    },
  };
}

export type DecisionService = ReturnType<typeof createDecisionService>;
