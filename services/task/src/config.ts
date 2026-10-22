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
  /** 多久对账一次运行中的节点（防止 harness 的结束事件丢失） */
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(5_000).default(60_000),
};
