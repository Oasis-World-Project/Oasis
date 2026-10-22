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
  /** 「满足验收点」的概率低于这个值算没满足 */
  GATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  /** 关卡没过时最多退回修改几次（ADR 0004：1） */
  MAX_NODE_REWORKS: z.coerce.number().int().min(0).max(3).default(1),
  /** 一个任务同时最多跑几个节点（ADR 0004：3） */
  MAX_PARALLEL_NODES: z.coerce.number().int().positive().max(20).default(3),
  /** 节点失败后自动重做几次（ADR 0004：2，即最多跑 3 次） */
  MAX_NODE_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** 花费超过预估的几倍时暂停问用户（ADR 0004：3） */
  BUDGET_MULTIPLIER: z.coerce.number().int().min(1).max(100).default(3),
  /** 规划员查模型目录 */
  AGENT_URL: z.url(),
  /** 规划员用的模型（ADR 0005 §4，默认 DeepSeek） */
  PLANNER_MODEL: z.string().min(1).default('deepseek/deepseek-v4.1-flash'),
  /** 节点默认用的模型（告诉规划员；用户定：DeepSeek） */
  DEFAULT_NODE_MODEL: z.string().min(1).default('deepseek/deepseek-v4.1-flash'),
  /** 一个方案最多几个节点 */
  MAX_PLAN_NODES: z.coerce.number().int().min(1).max(50).default(12),
  /** 规划员最多跑几次（含规划门退回后的修改） */
  MAX_PLAN_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  /** 估算单价（微美元）：干活节点跑一次、讨论里一次发言或汇总（5.2 实测，以后用记账数据校准） */
  ESTIMATE_WORK_RUN_MICRO: z.coerce.number().int().positive().default(3_000),
  ESTIMATE_SPEECH_RUN_MICRO: z.coerce.number().int().positive().default(3_000),
  /** 每次运行的沙箱算力（2 核 × 约 5 分钟 × $0.015/核时）；算力不计费时设为 0 */
  ESTIMATE_COMPUTE_RUN_MICRO: z.coerce.number().int().nonnegative().default(2_500),
  /** 多久对账一次运行中的节点（防止 harness 的结束事件丢失） */
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(5_000).default(60_000),
};
