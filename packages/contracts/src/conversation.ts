// conversation 的对外接口：私聊和在私聊里接任务（ADR 0005；群聊在后续阶段）。
import { z } from 'zod';
import { UploadBody } from './canvas.ts';
import { BudgetQuote, TaskSheet } from './task.ts';

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

/** 回答：选项 id，或 auto（你看着办），或 custom: 开头的用户自己写的答案（2026-11-05） */
export const AUTO_ANSWER = 'auto';
export const CUSTOM_ANSWER_PREFIX = 'custom:';
/** 自己写的答案最多几个字 */
export const CUSTOM_ANSWER_MAX = 300;

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
  /** 三档预算和用时（ADR 0016）；报价没拿到时为 null，确认时按标准档的默认方式做 */
  quote: BudgetQuote.nullable().default(null),
  status: z.enum(['open', 'confirmed', 'superseded', 'cancelled']),
  taskId: z.uuid().nullable(),
});
export type SheetCard = z.infer<typeof SheetCard>;

/**
 * 任务被删除后留在私聊里的卡片标记（ADR 0012）：replacedBy 是替换它的新版任务，
 * 为 null 表示用户删除了它。卡片只留文字，不再提供下载和工作流入口。
 */
export const RemovedMark = z.object({ replacedBy: z.uuid().nullable() });
export type RemovedMark = z.infer<typeof RemovedMark>;

/** 任务卡：进度和花费由前端按 taskId 去 task 查；revisionOf 表示这是对某个任务成果的修改 */
export const TaskCard = z.object({
  taskId: z.uuid(),
  revisionOf: z.uuid().optional(),
  removed: RemovedMark.optional(),
});

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
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      runId: z.uuid().optional(),
    }),
  ),
  /** 整体验收没满足的地方 */
  unmet: z.array(z.string()),
  /** 过程中节点留下的提醒 */
  warnings: z.array(z.string()),
  unchecked: z.array(z.string()).optional(),
  removed: RemovedMark.optional(),
});
export type DeliveryCard = z.infer<typeof DeliveryCard>;

/** 任务需要用户处理、或没能完成时的提醒 */
export const NoticeCard = z.object({
  taskId: z.uuid(),
  status: z.enum(['needs_attention', 'failed']),
  message: z.string(),
  removed: RemovedMark.optional(),
});
export type NoticeCard = z.infer<typeof NoticeCard>;

/** 消息上的附件：canvas 里的一个上传文件 */
export const MessageAttachment = UploadBody.pick({
  id: true,
  name: true,
  size: true,
  contentType: true,
});
export type MessageAttachment = z.infer<typeof MessageAttachment>;

/** 一条消息最多带几个文件 */
export const MAX_ATTACHMENTS = 10;

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
    data: z.object({
      /** AI 觉得这可能是个任务，回复下面附「当成任务来做」 */
      suggestTask: z.boolean().optional(),
      /** 用户随消息发的文件（存在 canvas，ADR 0007 §3） */
      attachments: z.array(MessageAttachment).optional(),
      /** 任务原话与补充一经提交即锁定。 */
      intent: z.enum(['chat', 'task']).optional(),
      /** 普通聊天回复对应的用户消息。 */
      replyTo: z.uuid().optional(),
      stopped: z.boolean().optional(),
      resumable: z.boolean().optional(),
    }),
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
  /** 先传到 canvas 的文件 id */
  attachments: z.array(z.uuid()).max(MAX_ATTACHMENTS).default([]),
});

/** 回答问题卡：题目 id → 选项 id 或 auto；skip = 直接开始（没答的都按默认） */
export const IntakeAnswersBody = z.object({
  messageId: z.uuid(),
  answers: z.record(z.string(), z.string()).default({}),
  skip: z.boolean().default(false),
});

/**
 * 确认任务单时选的预算（ADR 0016）：三档之一，或自定义金额（不能低于报价里的最低预算）。
 * 不传按标准档；没有报价时按任务单原样交给 AI 团队。
 */
export const IntakeConfirmBody = z
  .object({
    tier: z.enum(['economy', 'standard', 'premium', 'custom']).default('standard'),
    customMicro: z.number().int().positive().optional(),
  })
  .refine((b) => b.tier !== 'custom' || b.customMicro !== undefined, {
    message: '自定义预算要填金额',
  });
export type IntakeConfirmBody = z.infer<typeof IntakeConfirmBody>;

/** 从某条用户消息开始接需求（点了「当成任务来做」） */
export const StartIntakeBody = z.object({ messageId: z.uuid() });

/** 不传 content 为重生成；传入则修改本轮用户消息并替换回复。 */
export const ReplaceReplyBody = z
  .object({
    content: z.string().trim().min(1).max(8000).optional(),
    continue: z.boolean().optional(),
  })
  .refine((body) => !body.continue || body.content === undefined, '继续回复不能同时修改原消息');

/** 修改时带上的一条批注（ADR 0012 §9）：在哪个文件、哪里、什么意见，见哪张标注截图 */
export const RevisionNote = z.object({
  file: z.string().trim().min(1).max(200),
  number: z.number().int().min(1).max(99),
  /** 给人看的位置，如「第 2 页」「0:12」「画面左上」 */
  where: z.string().trim().max(120).default(''),
  note: z.string().trim().min(1).max(500),
  quote: z.string().trim().max(300).optional(),
  /** 随修改上传的标注截图的文件名 */
  snapshot: z.string().trim().max(200).optional(),
});
export type RevisionNote = z.infer<typeof RevisionNote>;

/** 参数面板里改的一项成品参数（ADR 0012 §12），如「字幕字号：大」 */
export const RevisionParameter = z.object({
  file: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(40),
  value: z.string().trim().min(1).max(200),
});
export type RevisionParameter = z.infer<typeof RevisionParameter>;

/**
 * 修改成果（ADR 0012）：把修改意见发到这个私聊，新建一条工作流做出新版。
 * 不再问需求、不再确认任务单；新版交付后整体替换 taskId 那一版。
 */
export const RevisionBody = z
  .object({
    /** 要修改的是哪个任务的成果（必须已经交付） */
    taskId: z.uuid(),
    /** 修改意见；带了批注或参数时可以不写 */
    request: z.string().trim().max(8000).default(''),
    annotations: z.array(RevisionNote).max(100).default([]),
    parameters: z.array(RevisionParameter).max(40).default([]),
    /** 先传到 canvas 的文件 id（如参考图、标注截图） */
    attachments: z.array(z.uuid()).max(MAX_ATTACHMENTS).default([]),
  })
  .refine(
    (body) => body.request.length > 0 || body.annotations.length > 0 || body.parameters.length > 0,
    { message: '写下修改意见，或者带上批注、参数' },
  );

/** 接需求的几个接口都返回这次新增的消息 */
export const IntakeResult = z.object({ messages: z.array(MessageBody) });
export type IntakeResult = z.infer<typeof IntakeResult>;

/**
 * 发消息的响应是 SSE 流，每个事件的 data 是下面三种之一：
 * accepted（用户消息已存）→ 若干 delta（AI 回复片段）→ done（AI 回复完整存库）或 error。
 */
export const StreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('accepted'), userMessage: MessageBody }),
  z.object({ type: z.literal('activity'), phase: z.enum(['chat', 'intake']) }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('done'), message: MessageBody }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type StreamEvent = z.infer<typeof StreamEvent>;
