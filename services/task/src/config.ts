import { postgresAndEventBus } from '@oasis/service-kit';
import { z } from 'zod';

export const taskEnv = {
  ...postgresAndEventBus.env,
  /** 节点在 harness 里执行 */
  HARNESS_URL: z.url(),
  /** 报价、规划员调用模型 */
  MODEL_GATEWAY_URL: z.url(),
  HARNESS_CHECK_TIMEOUT_MS: z.coerce.number().int().min(10000).max(180000).default(40000),
  /** 一个任务同时最多跑几个节点（ADR 0004：3） */
  MAX_PARALLEL_NODES: z.coerce.number().int().positive().max(20).default(3),
  /** 规划员查模型目录 */
  AGENT_URL: z.url(),
  /** 修改成果时核对用户附的文件（参考图、标注截图），并标成已用上 */
  CANVAS_URL: z.url().default('http://127.0.0.1:4106'),
  /**
   * 规划员用的模型：不论哪一档、什么任务，一律用最强型号、最高思考档（用户 2026-11-07 决定，取代 ADR 0016
   * 「省钱档用快速型号」）。
   */
  PLANNER_MODEL: z.string().min(1).default('deepseek/deepseek-v4-pro-0813'),
  /** 任务单报价时列草案用的便宜模型（ADR 0016 §4） */
  QUOTE_MODEL: z.string().min(1).default('deepseek/deepseek-v4.1-flash'),
  /** 节点默认用的模型：例子里的型号、地区用不了时换成它（用户定：DeepSeek，用最强的型号） */
  DEFAULT_NODE_MODEL: z.string().min(1).default('deepseek/deepseek-v4-pro-0813'),
  /**
   * 估价兜底（ADR 0016 §4）：只在型号既没有调用记录、价格表也算不出时用，结果标成「粗估」。
   * 干活节点跑一次、讨论里一次发言或汇总（微美元），一个节点大约多少秒。
   */
  ESTIMATE_WORK_RUN_MICRO: z.coerce.number().int().positive().default(300_000),
  ESTIMATE_SPEECH_RUN_MICRO: z.coerce.number().int().positive().default(50_000),
  ESTIMATE_NODE_SECONDS: z.coerce.number().int().positive().default(600),
  /** 每次运行的沙箱算力（2 核 × 约 5 分钟 × $0.015/核时）；算力不计费时设为 0 */
  ESTIMATE_COMPUTE_RUN_MICRO: z.coerce.number().int().nonnegative().default(2_500),
  /** 多久对账一次运行中的节点（防止 harness 的结束事件丢失） */
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(5_000).default(60_000),
};
