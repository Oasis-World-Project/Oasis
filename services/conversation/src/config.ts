import { databaseEnv } from '@oasis/service-kit';
import { z } from 'zod';

export const conversationEnv = {
  GROUP_MAX_MEMBERS: z.coerce.number().int().min(2).max(100).default(50),
  GROUP_MAX_PER_USER: z.coerce.number().int().positive().max(100).default(20),
  GROUP_MESSAGES_PER_MINUTE: z.coerce.number().int().positive().max(120).default(30),
  GROUP_STREAMS_PER_USER: z.coerce.number().int().positive().max(10).default(3),
  /** 一个人最多几个好友、最多几条发出去还没回的好友申请 */
  FRIEND_MAX: z.coerce.number().int().positive().max(5000).default(500),
  FRIEND_REQUESTS_PENDING: z.coerce.number().int().positive().max(500).default(50),
  /** 一个群最多几个 AI（契约里的上限是 8） */
  GROUP_MAX_AIS: z.coerce.number().int().positive().max(8).default(8),
  ...databaseEnv,
  /** 开一轮时拿这个 AI 的型号、人设和用户的设置 */
  AGENT_URL: z.url(),
  /** 账号的名字、头像在 identity */
  IDENTITY_URL: z.url(),
  /** 一轮的花费；删对话时清掉工具的结果 */
  MODEL_GATEWAY_URL: z.url(),
  /** 私聊里的 AI 在沙箱里干活：开一轮、插话、停止、读进度 */
  HARNESS_URL: z.url(),
  /** 核对用户随消息发的文件；一轮结束时把成品登记进画布 */
  CANVAS_URL: z.url(),
  /** 跟进一轮的间隔（毫秒） */
  TURN_POLL_MS: z.coerce.number().int().min(100).max(10_000).default(700),
};
