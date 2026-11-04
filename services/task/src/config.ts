import { postgresAndEventBus } from '@oasis/service-kit';
import { z } from 'zod';

export const taskEnv = {
  ...postgresAndEventBus.env,
  /** 节点在 harness 里执行 */
  HARNESS_URL: z.url(),
  /** 节点出口关卡用决策模型判断验收点 */
  MODEL_GATEWAY_URL: z.url(),
  /** 判断验收点的决策模型（ADR 0004 §2：Jev） */
  GATE_MODEL: z.string().min(1).default('typesafe/jev-1.14'),
  /** 长证据提取和没结论时的复核（2026-11-05：用强力模型，快速模型会写「placeholder」糊弄） */
  GATE_EVIDENCE_MODEL: z.string().min(1).default('deepseek/deepseek-v4-pro-0813'),
  /** 「满足验收点」的概率低于这个值算没满足 */
  GATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  GATE_TEXT_MAX_CHARS: z.coerce.number().int().min(1).max(50_000).default(50_000),
  GATE_VISION_MAX_IMAGES: z.coerce.number().int().min(1).max(4).default(4),
  GATE_VISION_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024)
    .default(20 * 1024 * 1024),
  HARNESS_CHECK_TIMEOUT_MS: z.coerce.number().int().min(10000).max(180000).default(40000),
  /** 一个任务同时最多跑几个节点（ADR 0004：3） */
  MAX_PARALLEL_NODES: z.coerce.number().int().positive().max(20).default(3),
  /** 规划员查模型目录 */
  AGENT_URL: z.url(),
  /**
   * 规划员用的模型（ADR 0005 §4）。2026-11-05 用户决定：用 DeepSeek 最强的型号，开深度思考（harness
   * 默认用型号支持的最高推理档）、可以联网查资料（web.search / web.fetch 工具）。
   */
  PLANNER_MODEL: z.string().min(1).default('deepseek/deepseek-v4-pro-0813'),
  /** 节点默认用的模型：例子里的型号、地区用不了时换成它（用户定：DeepSeek，用最强的型号） */
  DEFAULT_NODE_MODEL: z.string().min(1).default('deepseek/deepseek-v4-pro-0813'),
  /**
   * 估算单价（微美元）：干活节点跑一次、讨论里一次发言或汇总。2026-11-05 改用旗舰型号后按
   * 马车任务的记账数据（一次干活运行 500 万–2400 万输入 token）粗估，以后用记账数据校准。
   */
  ESTIMATE_WORK_RUN_MICRO: z.coerce.number().int().positive().default(1_000_000),
  ESTIMATE_SPEECH_RUN_MICRO: z.coerce.number().int().positive().default(200_000),
  /** 每次运行的沙箱算力（2 核 × 约 5 分钟 × $0.015/核时）；算力不计费时设为 0 */
  ESTIMATE_COMPUTE_RUN_MICRO: z.coerce.number().int().nonnegative().default(2_500),
  /** 多久对账一次运行中的节点（防止 harness 的结束事件丢失） */
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(5_000).default(60_000),
};
