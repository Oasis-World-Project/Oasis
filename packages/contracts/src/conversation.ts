// conversation 的对外接口：私聊（群聊见 group.ts）。私聊里的 AI 就是干活的主 AI：用户说一句话开一轮
// （harness 的一次运行），一轮进行中再说的话是插话；AI 说的话和做的每一步写进 AI 的消息里。
import { z } from 'zod';
import { ArtifactCategory, UploadBody } from './canvas.ts';
import { Permissions, Workplace } from './harness.ts';
import { Confirmation, ConfirmDecision } from './model-gateway.ts';

/** 正在进行的一轮 */
export const TurnState = z.object({
  runId: z.uuid(),
  startedAt: z.iso.datetime(),
  /** 这一轮在等用户点的确认卡（AI 要做超出权限的事、要用花钱的工具） */
  confirmations: z.array(Confirmation).default([]),
});
export type TurnState = z.infer<typeof TurnState>;

export const ConversationBody = z.object({
  id: z.uuid(),
  kind: z.enum(['dm', 'group']),
  title: z.string(),
  modelKey: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastMessageAt: z.iso.datetime().nullable(),
  /** 正在进行的一轮；没有为 null */
  turn: TurnState.nullable(),
  /** 这个私聊在哪干活、权限（下一轮起用） */
  workplace: Workplace,
  permissions: Permissions,
});
export type ConversationBody = z.infer<typeof ConversationBody>;

/** 改在哪干活和权限：换地方从新话题开始（AI 的记忆在原来那边）；一轮进行中不能换地方 */
export const SetupBody = z.object({ workplace: Workplace, permissions: Permissions });
export type SetupBody = z.infer<typeof SetupBody>;

/** 用户点确认卡 */
export const ConfirmBody = z.object({ decision: ConfirmDecision });

export const ConversationList = z.object({ conversations: z.array(ConversationBody) });

export const CreateDmBody = z.object({ modelKey: z.string().min(1).max(50) });

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

/**
 * 「让 AI 改」时消息带上的画布成果：还在 AI 这个话题工作目录里的直接改原文件，
 * 之前话题做的连同它用到的文件拷一份进去。name 是给人看的（应用是应用目录名）。
 */
export const MessageArtifact = z.object({
  id: z.uuid(),
  name: z.string(),
  path: z.string(),
});
export type MessageArtifact = z.infer<typeof MessageArtifact>;

/** 一步里一个长任务的进展（见 StepPart.jobs） */
export const StepJob = z.object({
  id: z.string(),
  state: z.enum(['submitted', 'waiting', 'done', 'failed']),
  files: z.array(z.string()).optional(),
});
export type StepJob = z.infer<typeof StepJob>;

/** AI 在一轮里做的一步：调了什么工具（读写文件、跑命令、生图……），给人看的一句话和结果 */
export const StepPart = z.object({
  type: z.literal('step'),
  /** 工具调用的编号 */
  id: z.string(),
  /** dsh 的工具名，如 bash、write */
  tool: z.string(),
  label: z.string(),
  status: z.enum(['running', 'done', 'failed']),
  /** 失败的原因（截断过） */
  detail: z.string().optional(),
  /** 开始、结束的时间 */
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
  /** 跑的是 oasis-tool 的哪个工具（如 image.generate）：生图、视频这类在进度页上是长任务 */
  oasisTool: z.string().optional(),
  /** 生图、视频这类工具通常要多久（秒，按调用记录）；没有记录时没有 */
  expectSeconds: z.number().int().positive().optional(),
  /**
   * 这一步写的、存下的文件（相对工作目录，如 out/海报.png）：写文件那一步还在做时是要写的文件，
   * 做完才算数；oasis-tool 说已保存的都算
   */
  files: z.array(z.string()).optional(),
  /**
   * 这一步里长任务（视频、音乐……）的进展，按任务号：submitted 交上去没等、waiting 等到上限还没好、
   * done 做好了（连同存下的文件）、failed 没做出来。几段先交后一起等时，进度页按任务号把交的那一步
   * 和等到的结果连成一张卡。
   */
  jobs: z.array(StepJob).optional(),
});
export type StepPart = z.infer<typeof StepPart>;

/** AI 消息按发生的顺序由几段组成：说的话、做的步骤、系统的提示（如服务中断后恢复） */
export const MessagePart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  StepPart,
  z.object({ type: z.literal('notice'), text: z.string() }),
]);
export type MessagePart = z.infer<typeof MessagePart>;

/** AI 列的待办（只作参考，进度以真实发生的步骤为准） */
export const TodoItem = z.object({
  text: z.string(),
  status: z.enum(['pending', 'doing', 'done']),
});
export type TodoItem = z.infer<typeof TodoItem>;

/** 一轮做出或改了的成品（已登记进画布） */
export const TaskFile = z.object({
  artifactId: z.uuid(),
  name: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  category: ArtifactCategory,
});
export type TaskFile = z.infer<typeof TaskFile>;

/**
 * 任务卡：调用了生图、视频、配音这类工具，或交了文件的那一轮。进行中实时更新状态、花费和登记进画布的
 * 成果（做好一个进一个），结束时写上用时、花费和全部成果。
 */
export const TaskCard = z.object({
  runId: z.uuid(),
  /** 任务名：任务单的标题，没有就是用户要求的开头（以前的任务卡没有） */
  title: z.string().optional(),
  status: z.enum(['running', 'done', 'stopped', 'failed']),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  spentMicro: z.number().int().nonnegative(),
  files: z.array(TaskFile),
});
export type TaskCard = z.infer<typeof TaskCard>;

/** 画布上的一个任务：任务卡，加上它在哪个私聊 */
export const TaskSummary = TaskCard.extend({ conversationId: z.uuid() });
export type TaskSummary = z.infer<typeof TaskSummary>;
export const TaskList = z.object({ tasks: z.array(TaskSummary) });

const MessageBase = {
  id: z.uuid(),
  role: z.enum(['user', 'assistant']),
  /** 文字内容（AI 消息是它说过的话连起来） */
  content: z.string(),
  status: z.enum(['complete', 'streaming', 'failed']),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
};

/** 私聊里的一条消息：文字（用户的话、AI 一轮里说的话和步骤）、任务卡、开新话题的分隔 */
export const MessageBody = z.discriminatedUnion('kind', [
  z.object({
    ...MessageBase,
    kind: z.literal('text'),
    data: z.object({
      /** 用户随消息发的文件（存在 canvas） */
      attachments: z.array(MessageAttachment).optional(),
      /** 「让 AI 改」：要改的画布成果 */
      artifacts: z.array(MessageArtifact).optional(),
      /** 属于哪一轮：用户的话开了这一轮或插话进这一轮；AI 的话是这一轮说的 */
      runId: z.uuid().optional(),
      /** 用户：这句是插话，点「引导」送进了正在进行的一轮 */
      interjection: z.boolean().optional(),
      /** 用户：AI 干活时发的，还排着队（显示在输入框上面）；这一轮做完接着开下一轮 */
      pending: z.boolean().optional(),
      /** AI：按顺序说的话和做的步骤 */
      parts: z.array(MessagePart).optional(),
      /** AI：最新的待办 */
      todos: z.array(TodoItem).optional(),
      /** AI：用户停下了这一轮 */
      stopped: z.boolean().optional(),
      /** AI：这一轮结束时的花费（写在这一轮最后一段话上） */
      spentMicro: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({ ...MessageBase, kind: z.literal('task'), data: TaskCard }),
  /** 用户开了新话题：AI 从这里起不记得之前的事，之前的工作目录清空 */
  z.object({ ...MessageBase, kind: z.literal('topic'), data: z.object({}) }),
]);
export type MessageBody = z.infer<typeof MessageBody>;
export type MessageKind = MessageBody['kind'];

/** 消息列表，带上正在进行的一轮（前端据此显示停止按钮、刷新进度） */
export const MessageList = z.object({
  messages: z.array(MessageBody),
  turn: TurnState.nullable(),
});
export type MessageList = z.infer<typeof MessageList>;

export const SendMessageBody = z.object({
  content: z.string().trim().min(1).max(8000),
  /** 先传到 canvas 的文件 id */
  attachments: z.array(z.uuid()).max(MAX_ATTACHMENTS).default([]),
  /** 「让 AI 改」：画布里要改的成果 id（画布里批注后点「让 AI 改」时带上） */
  artifacts: z.array(z.uuid()).max(MAX_ATTACHMENTS).default([]),
});

/** 发消息的结果：这次新增的消息（用户的话，开了新一轮时还有 AI 的消息）和正在进行的一轮 */
export const SendResult = z.object({
  messages: z.array(MessageBody),
  turn: TurnState.nullable(),
});
export type SendResult = z.infer<typeof SendResult>;

/** 改了在哪干活和权限：改好的私聊；换了地方时还有一条新话题的分隔消息 */
export const SetupResult = z.object({
  conversation: ConversationBody,
  message: MessageBody.nullable(),
});
export type SetupResult = z.infer<typeof SetupResult>;

// ---- AI 回复里的卡片：AI 用代码块写，前端画成卡片；用户的回答是一条普通消息 ----

/** ```oasis-questions 代码块：要用户选的几道题（用户也可以自己写答案） */
export const QuestionsBlock = z.object({
  questions: z
    .array(
      z.object({
        id: z.string().min(1).max(20),
        text: z.string().trim().min(1).max(200),
        options: z.array(z.string().trim().min(1).max(80)).min(2).max(5),
      }),
    )
    .min(1)
    .max(4),
});
export type QuestionsBlock = z.infer<typeof QuestionsBlock>;

/** ```oasis-plan 代码块：大活开工前给用户看的任务单，用户确认后照着做 */
export const PlanBlock = z.object({
  title: z.string().trim().min(1).max(100),
  steps: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
  estimate: z.string().trim().max(100).optional(),
});
export type PlanBlock = z.infer<typeof PlanBlock>;
