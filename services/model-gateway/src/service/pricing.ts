// 估算冻结金额、按用量计算实际花费（纯函数，便于单测）。金额单位：微美元。
import type { ChatMessage } from '@oasis/contracts/model-gateway';
import type { ModelPrice } from '../adapters/openrouter.ts';

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
