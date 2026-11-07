// 估算冻结金额、按用量计算实际花费（纯函数，便于单测）。金额单位：微美元。
import type { ChatMessage } from '@oasis/contracts/model-gateway';
import type { ModelCapabilities } from '@oasis/contracts/model-gateway';
import type { ModelPrice } from '../adapters/openrouter.ts';
import type { TypicalUsage } from '../repo/calls-repo.ts';

export const USD_TO_MICRO = 1_000_000;

/** 一条消息里参与计费的字符数：文字内容、多段内容和工具调用都算上。 */
function messageChars(message: ChatMessage): number {
  const { content, tool_calls: toolCalls } = message;
  const contentChars =
    typeof content === 'string' ? content.length : content ? JSON.stringify(content).length : 0;
  return contentChars + (toolCalls ? JSON.stringify(toolCalls).length : 0);
}

/**
 * 输入 token 数的保守估计：按 1.5 个字符 1 个 token 算（中文接近 1:1，英文约 4:1，宁可多冻结），
 * 每条消息再加 8 个 token 的格式开销。extraChars 是消息以外也要发给模型的内容（如工具定义）。
 */
export function estimateInputTokens(messages: readonly ChatMessage[], extraChars = 0): number {
  const chars = messages.reduce((total, message) => total + messageChars(message), extraChars);
  return Math.ceil(chars / 1.5) + messages.length * 8;
}

/** 最多可能花多少：全部输入 + 输出写满 max_tokens。至少 1 微美元。 */
export function estimateHoldMicro(
  price: ModelPrice,
  messages: readonly ChatMessage[],
  maxTokens: number,
  extraChars = 0,
): number {
  const usd =
    estimateInputTokens(messages, extraChars) * price.prompt + maxTokens * price.completion;
  return Math.max(1, Math.ceil(usd * USD_TO_MICRO));
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** OpenRouter 返回的本次实际花费（美元） */
  cost?: number;
}

export type CostSource = 'provider' | 'tokens' | 'estimate';

/**
 * 实际花费：优先用供应商返回的 cost；没有就按 token 数和价格算；
 * 都没有（比如中途断开）就按已生成的字数估算。
 */
export function actualCostMicro(input: {
  usage: Usage | undefined;
  price: ModelPrice | undefined;
  messages: readonly ChatMessage[];
  completionChars: number;
  extraChars?: number;
}): { costMicro: number; source: CostSource } {
  const { usage, price } = input;
  if (typeof usage?.cost === 'number' && usage.cost >= 0) {
    return { costMicro: Math.round(usage.cost * USD_TO_MICRO), source: 'provider' };
  }
  if (
    price &&
    typeof usage?.prompt_tokens === 'number' &&
    typeof usage.completion_tokens === 'number'
  ) {
    const usd = usage.prompt_tokens * price.prompt + usage.completion_tokens * price.completion;
    return { costMicro: Math.ceil(usd * USD_TO_MICRO), source: 'tokens' };
  }
  if (!price) return { costMicro: 0, source: 'estimate' };
  const usd =
    estimateInputTokens(input.messages, input.extraChars) * price.prompt +
    Math.ceil(input.completionChars / 1.5) * price.completion;
  return { costMicro: Math.ceil(usd * USD_TO_MICRO), source: 'estimate' };
}

/**
 * 视频每秒多少美元：供应商目录里同时有按美元/秒和按美分/秒命名的 SKU；音频由供应商决定，取较高档。
 * 没有可用 SKU 时返回 NaN。冻结和估价共用这一份算法。
 */
export function videoSecondRate(
  pricing: Record<string, string>,
  resolution: string,
  firstFrame: boolean,
): number {
  const rates = [
    'duration_seconds',
    'duration_seconds_with_audio',
    `duration_seconds_${resolution}`,
    `duration_seconds_${resolution}_with_audio`,
    `${firstFrame ? 'image' : 'text'}_to_video_duration_seconds_${resolution}`,
  ]
    .filter((key) => pricing[key] !== undefined)
    .map((key) => Number(pricing[key]));
  for (const key of [
    'cents_per_video_output_second',
    `cents_per_video_output_second_${resolution}`,
  ])
    if (pricing[key] !== undefined) rates.push(Number(pricing[key]) / 100);
  return rates.length ? Math.max(...rates) : NaN;
}

/**
 * 型号能力 + 它负责一个干活节点的典型花费和用时（ADR 0016 §4）：给了调用记录且有这个型号的记录就用记录；
 * 否则按价格表 × 典型 token 用量估（记录里的典型用量，没有就用配置的假设值；用时未知）。
 */
export function withNodeRate(
  price: ModelPrice,
  usage: TypicalUsage | undefined,
  assumed: { prompt: number; completion: number },
): ModelCapabilities {
  const capabilities = price.capabilities!;
  const seen = usage?.nodes.get(capabilities.id);
  if (seen)
    return {
      ...capabilities,
      node: { costMicro: seen.costMicro, seconds: seen.seconds, basis: 'history' },
    };
  const tokens = usage?.nodeTokens ?? assumed;
  const costMicro = Math.ceil(
    (tokens.prompt * price.prompt + tokens.completion * price.completion) * USD_TO_MICRO,
  );
  return { ...capabilities, node: { costMicro, seconds: null, basis: 'catalog' } };
}
