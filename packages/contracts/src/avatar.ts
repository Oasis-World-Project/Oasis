// 实时数字人（ADR 0013）：成果里的数字人配置，以及开、结束、查看会话的接口形状。
import { z } from 'zod';

/** 配置文件的后缀；canvas 认出它就登记为数字人成果 */
export const AVATAR_SPEC_SUFFIX = '.oasis-avatar.json';

export const AvatarKnowledgeItem = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(4000),
  /** 来源：网址、文件名或「用户提供」 */
  source: z.string().trim().max(500).optional(),
});
export type AvatarKnowledgeItem = z.infer<typeof AvatarKnowledgeItem>;

export const AvatarHandoff = z.object({
  /** 什么情况转人工（写给模型看的规则） */
  when: z.string().trim().min(1).max(1000),
  /** 转人工时数字人说的话；会话页据此记一次「转人工」 */
  message: z.string().trim().min(1).max(300),
});
export type AvatarHandoff = z.infer<typeof AvatarHandoff>;

/** 节点交付的 `<名字>.oasis-avatar.json` */
export const AvatarSpec = z
  .object({
    version: z.literal(1).default(1),
    name: z.string().trim().min(1).max(64),
    language: z.string().min(2).max(10).default('zh'),
    avatarId: z.uuid(),
    /** 形象预览图（取自 LiveAvatar 的 preview_url），交付卡和画布上显示 */
    avatarPreviewUrl: z.url().optional(),
    voiceId: z.uuid().optional(),
    prompt: z.string().trim().min(1).max(8000),
    openingText: z.string().trim().max(1000).default(''),
    knowledge: z.array(AvatarKnowledgeItem).max(200).default([]),
    handoff: AvatarHandoff.optional(),
    /** 预览单次最长分钟数 */
    maxMinutes: z.number().int().min(1).max(15).default(5),
  })
  .refine((spec) => spec.knowledge.reduce((sum, item) => sum + item.content.length, 0) <= 30_000, {
    message: '知识要点合计不能超过 30,000 字',
    path: ['knowledge'],
  });
export type AvatarSpec = z.infer<typeof AvatarSpec>;

/**
 * POST /internal/avatar/sessions（model-gateway），付费人在 x-oasis-payer-id 头里。
 * canvas 读出成果里的配置后转过来；沙箱与否由 model-gateway 的配置决定。
 */
export const AvatarSessionStartBody = z.object({
  spec: AvatarSpec,
  artifactId: z.uuid().optional(),
  taskId: z.uuid().optional(),
});
export type AvatarSessionStartBody = z.input<typeof AvatarSessionStartBody>;

export const AvatarSessionStarted = z.object({
  sessionId: z.uuid(),
  livekitUrl: z.string(),
  livekitToken: z.string(),
  sandbox: z.boolean(),
  maxSeconds: z.number().int(),
  /** 每分钟多少钱（微美元）；沙箱为 0 */
  pricePerMinuteMicro: z.number().int().nonnegative(),
  startedAt: z.iso.datetime(),
});
export type AvatarSessionStarted = z.infer<typeof AvatarSessionStarted>;

/** 每一轮问答：用户说了什么、数字人答了什么、查了哪些资料、等了多久 */
export const AvatarTurn = z.object({
  at: z.iso.datetime(),
  question: z.string(),
  answer: z.string(),
  sources: z.array(z.string()),
  handoff: z.boolean(),
  /** 收到请求到模型吐出第一个字 */
  firstTokenMs: z.number().int().nonnegative().nullable(),
  totalMs: z.number().int().nonnegative(),
});
export type AvatarTurn = z.infer<typeof AvatarTurn>;

export const AvatarSessionStatus = z.enum(['starting', 'live', 'ended']);

/** 会话结束的原因（和 LiveAvatar 的 end_reason 一致） */
export const AvatarEndReason = z.enum([
  'USER_CLOSED',
  'USER_DISCONNECTED',
  'IDLE_TIMEOUT',
  'MAX_DURATION_REACHED',
  'NO_CREDITS',
  'SERVER_ERROR',
  'UNKNOWN',
]);

/** 结束会话：页面知道原因时带上（LiveAvatar 先结束的情况），默认是用户自己结束 */
export const AvatarStopBody = z.object({ reason: AvatarEndReason.default('USER_CLOSED') });
export type AvatarStopBody = z.input<typeof AvatarStopBody>;

export const AvatarSessionView = z.object({
  sessionId: z.uuid(),
  status: AvatarSessionStatus,
  sandbox: z.boolean(),
  maxSeconds: z.number().int(),
  startedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  endReason: z.string().nullable(),
  turns: z.array(AvatarTurn),
  pricePerMinuteMicro: z.number().int().nonnegative(),
  /** 结算后的实际扣费；没结算时为 null（页面按分钟显示估算） */
  chargedMicro: z.number().int().nonnegative().nullable(),
});
export type AvatarSessionView = z.infer<typeof AvatarSessionView>;
