import { postgresAndEventBus } from '@oasis/service-kit';
import { z } from 'zod';

export const taskEnv = {
  ...postgresAndEventBus.env,
  /** 节点在 harness 里执行 */
  HARNESS_URL: z.url(),
  /** 关卡检查成果 */
  INSPECTOR_URL: z.url(),
  /** 报价、规划员调用模型 */
  MODEL_GATEWAY_URL: z.url(),
  HARNESS_CHECK_TIMEOUT_MS: z.coerce.number().int().min(10000).max(180000).default(40000),
  /** 关卡的音视频解码检查：inspector 开的检查容器用几核、最多跑多久（算力记在任务上） */
  MEDIA_CHECK_CPUS: z.coerce.number().positive().max(8).default(2),
  MEDIA_CHECK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(10 * 60_000)
    .default(90_000),
  /**
   * 关卡的浏览器检查：inspector 开的检查浏览器用几核、一次冻结多久的算力。检查本身不设时限
   * （2026-11-04 用户决定），超过冻结时长的部分不再计费。
   */
  BROWSER_CHECK_CPUS: z.coerce.number().positive().max(8).default(2),
  BROWSER_CHECK_MAX_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(24 * 3600_000)
    .default(3600_000),
  /** 一个任务同时最多跑几个节点（3） */
  MAX_PARALLEL_NODES: z.coerce.number().int().positive().max(20).default(3),
  /**
   * 展开、做几版开出来的工具子节点另算一个池，同时最多跑几个（用户 2026-11-08 定 6）：
   * 它们只是等外部工具（生图、生视频），不占 AI 的名额。
   */
  MAX_PARALLEL_TOOL_CHILDREN: z.coerce.number().int().positive().max(24).default(6),
  /** 规划员查模型目录 */
  AGENT_URL: z.url(),
  /** 修改成果时核对用户附的文件（参考图、标注截图），并标成已用上 */
  CANVAS_URL: z.url().default('http://127.0.0.1:4106'),
  /** 规划员用的模型：不论什么任务，一律用最强型号、最高思考档（用户 2026-11-07 决定） */
  PLANNER_MODEL: z.string().min(1).default('deepseek/deepseek-v4-pro-0813'),

  /** 节点默认用的模型：例子里的型号、地区用不了时换成它（用户定：DeepSeek，用最强的型号） */
  DEFAULT_NODE_MODEL: z.string().min(1).default('deepseek/deepseek-v4-pro-0813'),
  /** 多久对账一次运行中的节点（防止 harness 的结束事件丢失） */
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(5_000).default(60_000),
};
