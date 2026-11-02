import { postgresAndEventBus } from '@oasis/service-kit';
import { z } from 'zod';

export const conversationEnv = {
  GROUP_MAX_MEMBERS: z.coerce.number().int().min(2).max(100).default(50),
  GROUP_MAX_PER_USER: z.coerce.number().int().positive().max(100).default(20),
  GROUP_MESSAGES_PER_MINUTE: z.coerce.number().int().positive().max(120).default(30),
  GROUP_STREAMS_PER_USER: z.coerce.number().int().positive().max(10).default(3),
  ...postgresAndEventBus.env,
  AGENT_URL: z.url(),
  MODEL_GATEWAY_URL: z.url(),
  /** 非流式模型生成需要覆盖正常推理时长，不沿用普通服务查询的短超时。 */
  MODEL_GATEWAY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(180_000),
  /** 每次回复带上最近多少条消息作为上下文 */
  HISTORY_LIMIT: z.coerce.number().int().min(1).max(200).default(20),
  /** 一次回复最多多少 token */
  REPLY_MAX_TOKENS: z.coerce.number().int().min(64).max(32_000).default(1024),
  /** 用户确认任务单后交给 task 建任务 */
  TASK_URL: z.url(),
  /** 核对用户随消息发的文件 */
  CANVAS_URL: z.url(),
  HARNESS_URL: z.url(),
  /** 判断「是不是在交代任务」的决策模型（ADR 0005 §2） */
  TASK_DETECT_MODEL: z.string().min(1).default('typesafe/jev-1.14'),
  /** 概率不低于它就直接开始接需求 */
  TASK_DETECT_HIGH: z.coerce.number().min(0).max(1).default(0.7),
  /** 概率不低于它就在回复下面附「当成任务来做」 */
  TASK_DETECT_LOW: z.coerce.number().min(0).max(1).default(0.4),
  /** 私聊的 AI 写不出合格的任务单 JSON 时换它来做（供应商型号，默认 DeepSeek） */
  INTAKE_FALLBACK_MODEL: z.string().min(1).default('deepseek/deepseek-v4.1-flash'),
  /** 最多问几轮（用户定：3） */
  INTAKE_MAX_ROUNDS: z.coerce.number().int().min(1).max(5).default(3),
  INTAKE_MAX_TOKENS: z.coerce.number().int().min(256).max(8000).default(4096),
};
