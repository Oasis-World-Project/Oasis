// 估算冻结金额、按用量计算实际花费（纯函数，便于单测）。金额单位：微美元。
import type { ChatMessage } from '@oasis/contracts/model-gateway';
import type { ModelCapabilities } from '@oasis/contracts/model-gateway';
import type { ModelPrice } from '../adapters/openrouter.ts';
import type { TypicalUsage } from '../repo/calls-repo.ts';

export const USD_TO_MICRO = 1_000_000;

/**
 * 一张图片（或一段音频、一个文件）按这么多输入 token 估。供应商按尺寸计费，一张大图一两千 token；
 * 不能按 base64 字符数算：一张 500 KB 的渲染图有 70 万字符，会被估成 45 万 token（2026-11-08 雨夜便利店）。
 */
export const MEDIA_TOKENS = 1_500;
/** 消息里的多媒体片段（OpenAI 兼容格式） */
const MEDIA_PARTS = new Set([
  'image_url',
  'input_image',
  'input_audio',
  'video_url',
  'input_video',
  'file',
]);

/** 结构化内容的字符数和其中的多媒体片段数（多媒体不计字符，内嵌的 data: 地址也算一个多媒体） */
function measure(value: unknown): { chars: number; media: number } {
  let media = 0;
  const json = JSON.stringify(value, (_key, part: unknown) => {
    if (
      part &&
      typeof part === 'object' &&
      MEDIA_PARTS.has(String((part as { type?: unknown }).type))
    ) {
      media += 1;
      return null;
    }
    if (typeof part === 'string' && part.length > 1024 && part.startsWith('data:')) {
      media += 1;
      return '';
    }
    return part;
  });
  return { chars: json?.length ?? 0, media };
}

/** 一条消息里参与计费的字符数和多媒体片段数：文字内容、多段内容和工具调用都算上。 */
function messageSize(message: ChatMessage): { chars: number; media: number } {
  const { content, tool_calls: toolCalls } = message;
  const parts =
    typeof content === 'string'
      ? { chars: content.length, media: 0 }
      : content
        ? measure(content)
        : { chars: 0, media: 0 };
  return { chars: parts.chars + (toolCalls ? measure(toolCalls).chars : 0), media: parts.media };
}

/**
 * 输入 token 数的保守估计：文字按 1.5 个字符 1 个 token 算（中文接近 1:1，英文约 4:1，宁可多冻结），
 * 每条消息再加 8 个 token 的格式开销，每个图片等多媒体片段按 MEDIA_TOKENS。
 * extraChars 是消息以外也要发给模型的内容（如工具定义）。
 */
export function estimateInputTokens(messages: readonly ChatMessage[], extraChars = 0): number {
  let chars = extraChars;
  let media = 0;
  for (const message of messages) {
    const size = messageSize(message);
    chars += size.chars;
    media += size.media;
  }
  return Math.ceil(chars / 1.5) + messages.length * 8 + media * MEDIA_TOKENS;
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
 * 工具目录里视频型号的每秒单价（微美元）：默认 720p（工具不写清晰度时用的）的单价，加上各清晰度的
 * 单价（有和默认不同的才列，估价按步骤写的清晰度取）。供应商没给价格返回 undefined。
 */
export function videoCatalogRate(
  pricing: Record<string, string>,
  resolutions: string[],
): { costMicro: number; by?: { arg: string; costMicro: Record<string, number> } } | undefined {
  const micro = (resolution: string) => {
    const usd = videoSecondRate(pricing, resolution, false);
    return Number.isFinite(usd) && usd > 0 ? Math.ceil(usd * USD_TO_MICRO) : undefined;
  };
  const costMicro = micro('720p');
  if (costMicro === undefined) return undefined;
  const tiers = Object.fromEntries(
    resolutions.flatMap((resolution) => {
      const price = micro(resolution);
      return price === undefined ? [] : [[resolution, price] as const];
    }),
  );
  return Object.values(tiers).some((price) => price !== costMicro)
    ? { costMicro, by: { arg: 'resolution', costMicro: tiers } }
    : { costMicro };
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
