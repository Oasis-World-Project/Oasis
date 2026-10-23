// conversation 的对外接口：私聊和在私聊里接任务（ADR 0005；群聊在后续阶段）。
import { z } from 'zod';
import { TaskSheet } from './task.ts';

export const ConversationBody = z.object({
  id: z.uuid(),
  kind: z.enum(['dm', 'group']),
  title: z.string(),
  modelKey: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastMessageAt: z.iso.datetime().nullable(),
});
export type ConversationBody = z.infer<typeof ConversationBody>;

export const ConversationList = z.object({ conversations: z.array(ConversationBody) });

export const CreateDmBody = z.object({ modelKey: z.string().min(1).max(50) });

/** 问题卡里的一道选择题（每题都自带「你看着办」，不用列在选项里） */
export const IntakeQuestion = z
  .object({
    id: z.string().regex(/^q\d{1,2}$/),
    text: z.string().trim().min(1).max(120),
    options: z
      .array(z.object({ id: z.string().regex(/^[a-e]$/), label: z.string().trim().min(1).max(60) }))
      .min(2)
      .max(5),
    /** 默认选项的 id */
    default: z.string(),
  })
  .refine((q) => q.options.some((o) => o.id === q.default), '默认项必须是选项之一');
export type IntakeQuestion = z.infer<typeof IntakeQuestion>;

/** 回答：选项 id，或 auto（你看着办） */
export const AUTO_ANSWER = 'auto';

/** 问题卡：第几轮、几道题，以及用户的回答（还没答时为 null） */
export const QuestionsCard = z.object({
  intakeId: z.uuid(),
  round: z.number().int().min(1),
  /** AI 在卡片上方说的一句话（旧消息没有） */
  intro: z.string().default(''),
  questions: z.array(IntakeQuestion).min(1).max(4),
  answers: z.record(z.string(), z.string()).nullable(),
});
export type QuestionsCard = z.infer<typeof QuestionsCard>;

/** 任务单卡：open 等确认；confirmed 已建任务；superseded 被改过的新任务单替换；cancelled 不做了 */
export const SheetCard = z.object({
  intakeId: z.uuid(),
  /** AI 在卡片上方说的一句话（旧消息没有） */
  intro: z.string().default(''),
  sheet: TaskSheet,
  status: z.enum(['open', 'confirmed', 'superseded', 'cancelled']),
  taskId: z.uuid().nullable(),
});
export type SheetCard = z.infer<typeof SheetCard>;

/** 任务卡：进度和花费由前端按 taskId 去 task 查 */
export const TaskCard = z.object({ taskId: z.uuid() });

/** 交付消息：每样交付物的文件（下载走 task 的 /v1/tasks/:id/files/:nodeId/*）和没满足的地方 */
export const DeliveryCard = z.object({
  taskId: z.uuid(),
  title: z.string(),
  files: z.array(
    z.object({
      deliverable: z.string(),
      nodeId: z.uuid(),
      path: z.string(),
      size: z.number().int().nonnegative(),
    }),
  ),
  /** 整体验收没满足的地方 */
  unmet: z.array(z.string()),
  /** 过程中节点留下的提醒 */
  warnings: z.array(z.string()),
});
export type DeliveryCard = z.infer<typeof DeliveryCard>;

/** 任务需要用户处理、或没能完成时的提醒 */
export const NoticeCard = z.object({
  taskId: z.uuid(),
  status: z.enum(['needs_attention', 'failed']),
  message: z.string(),
});
export type NoticeCard = z.infer<typeof NoticeCard>;

const MessageBase = {
  id: z.uuid(),
  role: z.enum(['user', 'assistant']),
  /** 文字内容；卡片消息也有一段给人看的文字（只显示文字的地方用） */
  content: z.string(),
  status: z.enum(['complete', 'streaming', 'failed']),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
};

/** 私聊里的一条消息：普通文字，或问题卡、任务单卡、任务卡、交付消息、任务提醒（ADR 0005 §7） */
export const MessageBody = z.discriminatedUnion('kind', [
  z.object({
    ...MessageBase,
    kind: z.literal('text'),
    /** suggestTask：AI 觉得这可能是个任务，回复下面附「当成任务来做」 */
    data: z.object({ suggestTask: z.boolean().optional() }),
  }),
  z.object({ ...MessageBase, kind: z.literal('questions'), data: QuestionsCard }),
  z.object({ ...MessageBase, kind: z.literal('sheet'), data: SheetCard }),
  z.object({ ...MessageBase, kind: z.literal('task'), data: TaskCard }),
  z.object({ ...MessageBase, kind: z.literal('delivery'), data: DeliveryCard }),
  z.object({ ...MessageBase, kind: z.literal('notice'), data: NoticeCard }),
]);
export type MessageBody = z.infer<typeof MessageBody>;
export type MessageKind = MessageBody['kind'];

export const MessageList = z.object({ messages: z.array(MessageBody) });

export const SendMessageBody = z.object({
  content: z.string().trim().min(1).max(8000),
  /** 用户点了「发任务」：不用判断，直接当成任务 */
  asTask: z.boolean().default(false),
});

/** 回答问题卡：题目 id → 选项 id 或 auto；skip = 直接开始（没答的都按默认） */
export const IntakeAnswersBody = z.object({
  answers: z.record(z.string(), z.string()).default({}),
  skip: z.boolean().default(false),
});

/** 从某条用户消息开始接需求（点了「当成任务来做」） */
export const StartIntakeBody = z.object({ messageId: z.uuid() });

/** 接需求的几个接口都返回这次新增的消息 */
export const IntakeResult = z.object({ messages: z.array(MessageBody) });
export type IntakeResult = z.infer<typeof IntakeResult>;

/**
 * 发消息的响应是 SSE 流，每个事件的 data 是下面三种之一：
 * accepted（用户消息已存）→ 若干 delta（AI 回复片段）→ done（AI 回复完整存库）或 error。
 */
export const StreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('accepted'), userMessage: MessageBody }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('done'), message: MessageBody }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type StreamEvent = z.infer<typeof StreamEvent>;
