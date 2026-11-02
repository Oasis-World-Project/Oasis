import { objectStoreEnv, postgresAndEventBus } from '@oasis/service-kit';
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
  HARNESS_URL: z.url().default('http://127.0.0.1:4107'),
  BROWSERSTACK_USERNAME: z.string().optional(),
  BROWSERSTACK_ACCESS_KEY: z.string().optional(),
  BROWSERSTACK_API_URL: z.url().default('https://api-cloud.browserstack.com'),
  BROWSERSTACK_HUB_URL: z.url().default('https://hub-cloud.browserstack.com/wd/hub'),
  CANVAS_URL: z.url().default('http://127.0.0.1:4106'),
  RUNPOD_API_KEY: z.string().optional(),
  RUNPOD_ENDPOINT_ID: z.string().default(''),
  RUNPOD_BASE_URL: z.url().default('https://api.runpod.ai/v2'),
  RENDER_PROFILE_VERIFIED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  RENDER_HOLD_MICRO: z.coerce.number().int().positive().default(300000),
  // RTX 4090 24GB Serverless 现价 $1.34/h（2026-10-30 目录），向上取整；上线前按 endpoint 现价复核。
  RENDER_PRICE_MICRO_PER_SECOND: z.coerce.number().int().positive().max(10000).default(373),
  RENDER_STARTUP_ALLOWANCE_SECONDS: z.coerce.number().int().nonnegative().max(600).default(90),
  RENDER_IDLE_SECONDS: z.coerce.number().int().nonnegative().max(3600).default(5),
  RENDER_STAGING_S3_ENDPOINT: z.string().default(''),
  RENDER_STAGING_S3_REGION: z.string().default('auto'),
  RENDER_STAGING_S3_BUCKET: z.string().default(''),
  RENDER_STAGING_S3_ACCESS_KEY: z.string().default(''),
  RENDER_STAGING_S3_SECRET_KEY: z.string().default(''),
  ...postgresAndEventBus.env,
  ...objectStoreEnv,
  S3_BUCKET: z.string().default('oasis-model-gateway'),
  FAL_API_KEY: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  FAL_BASE_URL: z.url().default('https://queue.fal.run'),
  FAL_MEDIA_HOSTS: list('fal.media'),
  TOOL_MUSIC_MODELS: list('fal-ai/minimax-music/v2.6'),
  // Opt in only after model price/parameters are verified. A Key alone does not enable 3D.
  TOOL_GEOMETRY_MODELS: list(''),
  TOOL_GEOMETRY_MICRO_PER_GENERATION: z.coerce
    .number()
    .int()
    .positive()
    .max(1_000_000)
    .default(500_000),
  TOOL_MUSIC_MICRO_PER_GENERATION: z.coerce.number().int().positive().max(500_000).default(150_000),
  TOOL_RESULT_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(2 * 1024 ** 3)
    .default(512 * 1024 ** 2),
  TOOL_RESULT_RETENTION_MS: z.coerce
    .number()
    .int()
    .min(3600_000)
    .default(7 * 24 * 3600_000),
  TOOL_SUBMIT_TIMEOUT_MS: z.coerce.number().int().min(5000).max(120_000).default(60_000),
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
  // 按顺序试：前一个被限流或地区用不了时换下一个（不同厂商分摊共享额度上的限流）
  TOOL_VISION_MODELS: list(
    'qwen/qwen3-vl-8b-instruct,qwen/qwen3-vl-30b-a3b-instruct,z-ai/glm-4.6v,google/gemini-2.5-flash',
  ),
  TOOL_VISION_MAX_TOKENS: z.coerce.number().int().min(1).max(8192).default(2048),
  TOOL_FETCH_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(20 * 1024 * 1024)
    .default(5 * 1024 * 1024),
  TOOL_SPEECH_MODELS: list(
    'bytedance-seed/seed-audio-1-0,fish-audio/s2.1-pro,openai/gpt-4o-mini-tts-2025-12-15',
  ),
  TOOL_TRANSCRIBE_MODELS: list('openai/whisper-large-v3,google/chirp-3'),
  /** 都是每秒不超过 $0.20 的（冻结按每秒 $0.25 算）；换贵的模型要同时调冻结 */
  TOOL_VIDEO_MODELS: list('alibaba/wan-3.0,minimax/hailuo-2.3,kwaivgi/kling-v3.0-std'),
  /** 长任务（视频）最多等多久，超时就算失败、退回冻结 */
  TOOL_JOB_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(30 * 60_000),
  /** jev.decide 用的决策模型 */
  TOOL_JEV_MODEL: z.string().min(1).default('typesafe/jev-1.14'),
  /** 配音拿不到实际花费时每个字估多少（微美元） */
  TOOL_SPEECH_MICRO_PER_CHAR: z.coerce.number().int().nonnegative().default(20),
  /** 沙箱算力每核每小时多少钱（微美元；按云服务器成本价约 $0.015）。为 0 时不计费 */
  COMPUTE_PRICE_MICRO_PER_CORE_HOUR: z.coerce.number().int().nonnegative().default(15_000),
  /** 实时数字人（LiveAvatar，ADR 0013）；没配置时开数字人会话返回 503 */
  LIVEAVATAR_API_KEY: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  LIVEAVATAR_BASE_URL: z.url().default('https://api.liveavatar.com'),
  /** 给 LiveAvatar 回调的大模型入口：单独端口，只有 /avatar/v1/chat/completions；0 表示不开 */
  AVATAR_LLM_HOST: z.string().min(1).default('127.0.0.1'),
  AVATAR_LLM_PORT: z.coerce.number().int().min(0).max(65535).default(4118),
  /** LiveAvatar 从公网访问上面那个入口的地址，写到 /avatar/v1 为止（它自己补 /chat/completions） */
  AVATAR_PUBLIC_BASE_URL: z
    .union([z.literal(''), z.url()])
    .optional()
    .transform((value) => value || undefined),
  /** 数字人回答用的模型：要出字快 */
  AVATAR_MODEL: z.string().min(1).default('deepseek/deepseek-v4.1-flash'),
  /** 开发期：所有数字人会话都用 LiveAvatar 沙箱（不扣积分，只有官方测试形象，约 1 分钟自动结束） */
  AVATAR_SANDBOX: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** LiveAvatar 每个积分多少钱（微美元；Essential 超额价 $0.095）；FULL 模式每分钟 2 积分 */
  AVATAR_CREDIT_MICRO: z.coerce.number().int().positive().max(1_000_000).default(95_000),
  /** 多久清扫一次数字人会话（结束、拆资源、结算） */
  AVATAR_SWEEP_MS: z.coerce.number().int().min(5_000).default(60_000),
  /** 查不到价格时按这个金额冻结（$0.20） */
  FALLBACK_HOLD_MICRO: z.coerce.number().int().positive().default(200_000),
};
