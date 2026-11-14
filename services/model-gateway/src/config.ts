import { DOMESTIC_VENDORS, lineupIds } from '@oasis/contracts/lineup';
import { databaseEnv, objectStoreEnv } from '@oasis/service-kit';
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
  /** 长会话和内嵌图片的模型请求；与沙箱入口代理的 50 MiB 边界一致。 */
  MODEL_REQUEST_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(50 * 1024 ** 2)
    .default(50 * 1024 ** 2),
  /** 专用决策模型地区不可用时，noul 证据判断经同一计费链路回退；留空关闭。 */
  DECISION_FALLBACK_MODEL: z
    .string()
    .default(lineupIds('decisionFallback'))
    .transform((value) => value || undefined),
  /** 网络短暂断开（请求没发出去）时等多久再报错；超过才让这一轮停下（2026-11-05） */
  UPSTREAM_RECONNECT_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(10 * 60_000),
  /** 浏览器检查（website.test、app.check）在 inspector 里做 */
  INSPECTOR_URL: z.url().default('http://127.0.0.1:4109'),
  /**
   * 检查浏览器用几核、一次冻结多久的算力（记在调用它的那一轮上）。检查本身不设时限
   * （2026-11-04 用户决定），超过冻结时长的部分不再计费。
   */
  BROWSER_CHECK_CPUS: z.coerce.number().positive().max(8).default(2),
  BROWSER_CHECK_MAX_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(24 * 3600_000)
    .default(3600_000),
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
  ...databaseEnv,
  ...objectStoreEnv,
  S3_BUCKET: z.string().default('oasis-model-gateway'),
  FAL_API_KEY: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  FAL_BASE_URL: z.url().default('https://queue.fal.run'),
  FAL_MEDIA_HOSTS: list('fal.media'),
  // 各工具用哪些型号、按什么顺序都写在型号清单（@oasis/contracts/lineup）里，下面的默认值从那里读；
  // .env 只在要临时换时填。fal 上的型号只认 tools/audio.ts、tools/three-d.ts 的表里对接过的
  TOOL_MUSIC_MODELS: list(lineupIds('music')),
  TOOL_GEOMETRY_MODELS: list(lineupIds('geometry')),
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
  /**
   * 单次回答最多输出多少 token（含推理）：调用方要得更多时压到这里。供应商按输出上限预先核算花费，
   * 冻结金额也按它算；dsh 会按整个上下文窗口要（约 93 万），远超一轮实际用到的（2026-11-06）。
   */
  MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(131_072),
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
  /**
   * 各工具可以用的型号，逗号分隔，排在前面的是默认；按顺序试，前一个被限流或地区用不了时换下一个。
   * 默认值和每个型号的来历都在型号清单里（@oasis/contracts/lineup）。
   */
  TOOL_IMAGE_MODELS: list(lineupIds('image')),
  TOOL_INSPECT_MODELS: list(lineupIds('inspect')),
  /** 输出上限：前面几个是推理型号，推理也占这个额度，给小了会只想不答 */
  TOOL_INSPECT_MAX_TOKENS: z.coerce.number().int().min(1).max(32_000).default(16_000),
  TOOL_FETCH_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(20 * 1024 * 1024)
    .default(5 * 1024 * 1024),
  TOOL_SPEECH_MODELS: list(lineupIds('speech')),
  TOOL_TRANSCRIBE_MODELS: list(lineupIds('transcribe')),
  TOOL_VIDEO_MODELS: list(lineupIds('video')),
  /** 长任务（视频）最多等多久，超时就算失败、退回冻结 */
  TOOL_JOB_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(30 * 60_000),
  /** model.ask（问另一个模型）能问的型号，第一个是不指定时用的 */
  TOOL_ASK_MODELS: list(lineupIds('ask')),
  /** jev.decide 用的决策模型 */
  TOOL_JEV_MODEL: z.string().min(1).default(lineupIds('jev')),
  /** 上面的决策模型用不了时（如「只用国内模型」）回答 jev.decide 的聊天模型：三个国内的轻量型号 */
  TOOL_DECIDE_CHAT_MODELS: list(lineupIds('decideChat')),
  /** 「只用国内模型」认的国内厂商（模型 ID 里「/」前面的部分），默认是型号清单里的 */
  DOMESTIC_MODEL_VENDORS: list(DOMESTIC_VENDORS.join(',')),
  /** 配音拿不到实际花费时每个字估多少（微美元） */
  TOOL_SPEECH_MICRO_PER_CHAR: z.coerce.number().int().nonnegative().default(20),
  /**
   * 估价要不要参考调用记录。开发阶段的记录多半来自失控的运行，样本再多也不可信，先关掉，
   * 只按价格表估（2026-11-07 用户决定；稳定后再打开）。
   */
  ESTIMATE_FROM_HISTORY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** 沙箱算力每核每小时多少钱（微美元；按云服务器成本价约 $0.015）。为 0 时不计费 */
  COMPUTE_PRICE_MICRO_PER_CORE_HOUR: z.coerce.number().int().nonnegative().default(15_000),
  /** 实时数字人（LiveAvatar）；没配置时开数字人会话返回 503 */
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
  AVATAR_MODEL: z.string().min(1).default(lineupIds('avatar')),
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
  /**
   * 聊天、决策调用开始多久还没收尾就当作网关中途重启丢下的，退回冻结、记为失败（每 5 分钟查一次）。
   * 要比冻结有效期（billing HOLD_TTL_MS，默认 10 分钟）加上等网络恢复（UPSTREAM_RECONNECT_MS）更长。
   */
  STALE_CALL_MS: z.coerce
    .number()
    .int()
    .min(15 * 60_000)
    .default(30 * 60_000),
};
