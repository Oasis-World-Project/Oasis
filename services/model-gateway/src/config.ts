import { postgresAndEventBus } from '@oasis/service-kit';
import { z } from 'zod';

/** 逗号分隔的列表 */
const list = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );

export const modelGatewayEnv = {
  ...postgresAndEventBus.env,
  BILLING_URL: z.url(),
  OPENROUTER_BASE_URL: z.url().default('https://openrouter.ai/api/v1'),
  /** Jev 等结构化决策模型的接口 */
  OPENROUTER_DECISIONS_URL: z.url().default('https://openrouter.ai/api/alpha/decisions'),
  /** 没配置时服务照常启动，但模型调用返回 503 */
  OPENROUTER_API_KEY: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  /** 调用方没给输出上限（max_tokens / max_completion_tokens）时用这个（也用于估算冻结金额） */
  DEFAULT_MAX_TOKENS: z.coerce.number().int().positive().max(32_000).default(2048),
  /** 模型价格表多久刷新一次 */
  PRICING_REFRESH_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(60 * 60_000),
  /** 联网搜索和网页抓取（Tavily）；没配置时这两个工具不可用 */
  TAVILY_API_KEY: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  TAVILY_BASE_URL: z.url().default('https://api.tavily.com'),
  /** Tavily 每个积分的价格（微美元；按量付费 $0.008） */
  TAVILY_CREDIT_MICRO: z.coerce.number().int().positive().default(8_000),
  /** 各工具可以用的模型，逗号分隔，排在前面的是默认（地区用不了的会自动跳过） */
  TOOL_IMAGE_MODELS: list(
    'bytedance-seed/seedream-4.5,black-forest-labs/flux.2-pro,google/gemini-2.5-flash-image,openai/gpt-image-2',
  ),
  TOOL_SPEECH_MODELS: list(
    'bytedance-seed/seed-audio-1-0,fish-audio/s2.1-pro,openai/gpt-4o-mini-tts-2025-12-15',
  ),
  TOOL_TRANSCRIBE_MODELS: list('openai/whisper-large-v3,google/chirp-3'),
  /** jev.decide 用的决策模型 */
  TOOL_JEV_MODEL: z.string().min(1).default('typesafe/jev-1.14'),
  /** 配音拿不到实际花费时每个字估多少（微美元） */
  TOOL_SPEECH_MICRO_PER_CHAR: z.coerce.number().int().nonnegative().default(20),
  /** 查不到价格时按这个金额冻结（$0.20） */
  FALLBACK_HOLD_MICRO: z.coerce.number().int().positive().default(200_000),
};
