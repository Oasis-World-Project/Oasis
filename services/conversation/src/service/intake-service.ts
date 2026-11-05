// 在私聊里接任务（ADR 0005 §2、§3）：认出任务 → 私聊里的 AI 问需求（问题卡）→ 给出任务单 →
// 用户确认 → 交给 task 建任务（之后由规划员排工作流）。问需求不走 harness：直接经 model-gateway 调模型。
import { randomUUID } from 'node:crypto';
import { ModelRoute } from '@oasis/contracts/agent';
import { MaterialInspectResult } from '@oasis/contracts/harness';
import { OASIS_HEADERS } from '@oasis/contracts/common';
import {
  AUTO_ANSWER,
  CUSTOM_ANSWER_MAX,
  CUSTOM_ANSWER_PREFIX,
  type IntakeQuestion,
  type MessageAttachment,
  type QuestionsCard,
  type SheetCard,
} from '@oasis/contracts/conversation';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import { z } from 'zod';
import type { Conversation, ConversationRepo, Intake, Message } from '../repo/conversation-repo.ts';
import { attachmentsOf, mergeMaterials, withAttachmentNote } from './attachments.ts';
import {
  FALLBACK_SHEET_INTRO,
  fallbackSheet,
  groundRequirements,
  intakeMessages,
  intakeResponseFormat,
  questionsText,
  readIntakeReply,
  sheetText,
  taskBrief,
  withoutImage,
  type IntakeReply,
} from './intake.ts';

const Decision = z.object({
  answers: z.record(z.string(), z.object({ noul: z.number().optional() }).loose()),
});
/** 当前网络地区用不了的模型 */
const Unavailable = z.object({ models: z.array(z.string()) });
/** 建任务的返回里只用得到任务 ID */
const CreatedTask = z.object({ id: z.uuid() }).loose();
const Completion = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

export interface IntakeConfig {
  /** 判断「是不是任务」的决策模型（Jev） */
  detectModel: string;
  /** 概率不低于它就直接开始接需求 */
  detectHigh: number;
  /** 概率不低于它就在回复下面附「当成任务来做」 */
  detectLow: number;
  /** 私聊的 AI 在当前网络地区用不了时，接需求事先改用它（供应商型号） */
  fallbackModel: string;
  /** 最多问几轮（用户定：3） */
  maxRounds: number;
  /** 接需求一步的输出上限；留足余量，不靠截断后重来 */
  maxTokens: number;
}

const IS_TASK = {
  type: 'noul',
  instructions:
    '用户刚说的这句话，是不是在交代 AI 去做一件要交付成果的事（写文档、做图、做网页、做视频、做研究报告等）？',
  criteria: {
    true: '是：要 AI 做出一个东西交给他',
    false: '不是：闲聊、提问、讨论想法，或者只要一个简短的回答',
  },
} as const;

const ABOUT_OPEN = {
  type: 'noul',
  instructions:
    '现在有一件任务正在整理需求、还没确认。用户刚说的这句话，是不是在说这件任务：补充或修改要求、回答问题、让它继续、或者说不做了？',
  criteria: {
    true: '是：说的就是正在整理的这件任务',
    false: '不是：在聊别的事，或者交代了另一件不相干的新任务',
  },
} as const;

/** 正在整理任务时对新消息的判断：about = 说的是这件任务，task = 交代了一件要做的事 */
interface DuringIntakeVerdict {
  about: number;
  task: number;
}

type InspectedFile = MaterialInspectResult['files'][number];

const IMAGE_QUESTION =
  '客观描述这张图：画面里是什么人或物、外观特征（衣着、颜色、标志和文字）、背景场景，有几个视角或几张拼图也说明。200 字以内，只写看得到的，不要猜图片以外的事。';

/**
 * 上一个任务之后的消息（2026-11-05）：上一个任务的原话、修改意见、卡片和交付消息，以及它们带的文件，
 * 都不是这次的上下文，不然新任务会和旧任务搞混。
 */
function sinceLastTask(history: Message[]): Message[] {
  const last = history.findLastIndex((m) => m.kind !== 'text' || m.data.intent === 'task');
  return history.slice(last + 1);
}

function intakeActions(deps: {
  repo: ConversationRepo;
  agent: ServiceClient;
  modelGateway: ServiceClient;
  task: ServiceClient;
  harness?: ServiceClient;
  config: IntakeConfig;
  logger: Logger;
}) {
  const { repo, config, logger } = deps;

  /** 让 Jev 判断这句话是不是在交代一件要交付成果的事；出错时当成不是（照常聊天） */
  async function taskProbability(input: {
    ownerId: string;
    content: string;
    history: Message[];
    requestId: string;
    signal?: AbortSignal;
  }): Promise<number> {
    const recent = input.history
      .slice(-6)
      .map((m) => `${m.authorKind === 'user' ? '用户' : 'AI'}：${m.content.slice(0, 500)}`);
    try {
      const { answers } = await deps.modelGateway.json('POST', '/internal/v1/decisions', {
        body: {
          model: config.detectModel,
          state: [...recent, `用户刚说：${input.content}`],
          questions: {
            is_task: IS_TASK,
          },
        },
        headers: { [OASIS_HEADERS.payerId]: input.ownerId },
        requestId: input.requestId,
        schema: Decision,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return answers.is_task?.noul ?? 0;
    } catch (err) {
      input.signal?.throwIfAborted();
      logger.warn({ err }, '判断是不是任务失败，照常聊天');
      return 0;
    }
  }

  async function complete(
    ownerId: string,
    model: string,
    messages: unknown[],
    requestId: string,
    mustSheet: boolean,
  ) {
    const result = await deps.modelGateway.json('POST', '/internal/v1/chat/completions', {
      body: {
        model,
        messages,
        max_tokens: config.maxTokens,
        stream: false,
        response_format: intakeResponseFormat(mustSheet),
        provider: { require_parameters: true },
        reasoning: { enabled: false },
      },
      headers: { [OASIS_HEADERS.payerId]: ownerId },
      requestId,
      schema: Completion,
    });
    return result.choices[0]!;
  }

  /**
   * 有一件任务还在整理时，判断新消息是不是在说它（2026-11-05 用户：上一条是任务，后面的话不能
   * 一律算成任务）。Jev 一次回答两个问题；出错返回 null，调用方按原来的做法当作补充。
   */
  async function duringIntake(input: {
    ownerId: string;
    content: string;
    intake: Intake;
    history: Message[];
    requestId: string;
    signal?: AbortSignal;
  }): Promise<DuringIntakeVerdict | null> {
    const recent = input.history
      .slice(-6)
      .map((m) => `${m.authorKind === 'user' ? '用户' : 'AI'}：${m.content.slice(0, 500)}`);
    try {
      const { answers } = await deps.modelGateway.json('POST', '/internal/v1/decisions', {
        body: {
          model: config.detectModel,
          state: [
            `正在整理的任务，用户原话：${input.intake.request.slice(0, 1000)}`,
            ...recent,
            `用户刚说：${input.content}`,
          ],
          questions: { about_open: ABOUT_OPEN, is_task: IS_TASK },
        },
        headers: { [OASIS_HEADERS.payerId]: input.ownerId },
        requestId: input.requestId,
        schema: Decision,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const about = answers.about_open?.noul;
      if (about === undefined) return null;
      return { about, task: answers.is_task?.noul ?? 0 };
    } catch (err) {
      input.signal?.throwIfAborted();
      logger.warn({ err }, '判断是不是在说正在整理的任务失败，当作补充');
      return null;
    }
  }

  /**
   * 问需求的 AI 看不了图，只能看到文件名（2026-11-05：外卖骑手的参考图被说成了马车）。
   * 图片先交给看图工具描述一遍，描述写进素材说明；原图本身不进记录和提示词。看不了就照旧只说是图片。
   */
  async function describeImage(file: InspectedFile, ownerId: string, requestId: string) {
    if (!file.image) return file;
    const plain = withoutImage(file);
    try {
      const { text } = await deps.modelGateway.json('POST', '/internal/v1/tools/image.inspect', {
        body: { args: { images: [file.image], question: IMAGE_QUESTION } },
        headers: { [OASIS_HEADERS.payerId]: ownerId },
        requestId,
        schema: z.object({ text: z.string().min(1) }),
      });
      return {
        ...plain,
        reason: `图片素材。看图模型的描述（只用来理解图片内容，不是用户原话）：${text.trim().slice(0, 1000)}`,
      };
    } catch (err) {
      logger.warn(
        { err, requestId, uploadId: file.uploadId },
        '接需求时看图失败，只告诉 AI 这是一张图',
      );
      return plain;
    }
  }

  /** 读不到地区限制时按原模型来，不因此中断 */
  async function blockedModels(requestId: string): Promise<string[]> {
    try {
      const { models } = await deps.modelGateway.json('GET', '/internal/v1/models/unavailable', {
        requestId,
        schema: Unavailable,
      });
      return models;
    } catch (err) {
      logger.warn({ err, requestId }, '读取地区不可用的模型失败，按原模型接需求');
      return [];
    }
  }

  /**
   * 让私聊里的 AI 走一步：问题、任务单或不做了。每一步只调用一次模型，不重试（ADR 0005
   * §2026-11-04）：输出受契约约束，小毛病就地整理；要求来源按原文确定性核对并补齐原话和选择；
   * 回答实在用不了（截断、不是 JSON）就按原话和选择直接列出任务单。只有网络、额度这类调用本身
   * 的错误会抛给调用方。
   */
  async function askModel(
    conversation: Conversation,
    intake: Intake,
    ownerId: string,
    requestId: string,
    skipped: boolean,
    resuming = false,
  ): Promise<IntakeReply> {
    const route = await deps.agent.json(
      'GET',
      `/internal/models/${encodeURIComponent(conversation.modelKey ?? '')}/route`,
      { requestId, schema: ModelRoute },
    );
    const roundsLeft = config.maxRounds - intake.round;
    const mustSheet = skipped || resuming || roundsLeft <= 0;
    const messages = intakeMessages({
      name: route.name,
      request: intake.request,
      context: intake.context,
      turns: intake.turns,
      roundsLeft,
      skipped,
      resuming,
      materials: intake.materials,
    });
    const model = (await blockedModels(requestId)).includes(route.providerModel)
      ? config.fallbackModel
      : route.providerModel;
    const completion = await complete(ownerId, model, messages, requestId, mustSheet);
    const read =
      completion.finish_reason && completion.finish_reason !== 'stop'
        ? { reply: null, problem: `生成未正常结束：${completion.finish_reason}` }
        : readIntakeReply(completion.message.content ?? '', mustSheet);
    if (!read.reply)
      logger.warn(
        { requestId, intakeId: intake.id, model, problem: read.problem },
        '接需求这一步的回答用不了，按原话和选择列出任务单',
      );
    const reply: IntakeReply = read.reply ?? {
      type: 'sheet',
      intro: FALLBACK_SHEET_INTRO,
      sheet: fallbackSheet(intake.request, intake.turns),
    };
    if (reply.type === 'sheet') {
      reply.sheet = groundRequirements(reply.sheet, intake.request, intake.turns);
      reply.sheet.materials = intake.materials.map((m) => m.name);
      reply.sheet.materialWarnings = intake.turns
        .flatMap((t) => (t.kind === 'materials' ? t.files : []))
        .filter((f) => f.status !== 'complete')
        .map((f) => `${f.name}：${f.reason ?? '未取得完整正文，内容未知'}`);
    }
    return reply;
  }

  /** 走一步并把结果变成消息：问题卡、任务单卡，或一句「好的，不做了」 */
  async function step(
    conversation: Conversation,
    intake: Intake,
    ownerId: string,
    requestId: string,
    skipped = false,
    resuming = false,
  ): Promise<Message[]> {
    if (deps.harness && intake.materials.length) {
      const cached = intake.turns
        .filter((t) => t.kind === 'materials')
        .filter((t) => t.parser === 1);
      const ids = intake.materials.map((m) => m.uploadId);
      const latest = cached.at(-1);
      if (
        !latest ||
        latest.files.length !== ids.length ||
        !ids.every((id) => latest.files.some((f) => f.uploadId === id))
      ) {
        const result = await deps.harness.json('POST', '/internal/materials/inspect', {
          body: { ownerId, ids },
          schema: MaterialInspectResult,
          requestId,
        });
        const files = await Promise.all(
          result.files.map((file) => describeImage(file, ownerId, requestId)),
        );
        const turns = [
          ...intake.turns.filter((t) => t.kind !== 'materials'),
          // 原图不存进接需求记录：这里用不上，只会把记录和提示词撑大
          {
            kind: 'materials' as const,
            parser: 1,
            files,
          },
        ];
        await repo.updateIntake(intake.id, { turns });
        intake = { ...intake, turns };
      }
    }
    const reply = await askModel(conversation, intake, ownerId, requestId, skipped, resuming);
    const author = conversation.modelKey ?? 'unknown';
    if (reply.type === 'cancel') {
      return cancelIntake(
        conversation,
        intake,
        reply.intro || '好的，这件事先不做了，我们接着聊。',
      );
    }
    const out: Message[] = [];
    if (reply.type === 'questions') {
      const round = intake.round + 1;
      const card: QuestionsCard = {
        intakeId: intake.id,
        round,
        intro: reply.intro,
        questions: reply.questions,
        answers: null,
      };
      const message = await repo.commitIntakeReply(
        intake.id,
        {
          conversationId: conversation.id,
          authorKind: 'ai',
          authorId: author,
          content: questionsText(reply.intro, reply.questions),
          status: 'complete',
          kind: 'questions',
          data: card,
        },
        {
          status: 'asking',
          round,
          turns: [
            ...intake.turns,
            { kind: 'questions', round, questions: reply.questions, answers: null },
          ],
        },
      );
      out.push(message);
    } else {
      const card: SheetCard = {
        intakeId: intake.id,
        intro: reply.intro,
        sheet: reply.sheet,
        status: 'open',
        taskId: null,
      };
      const message = await repo.commitIntakeReply(
        intake.id,
        {
          conversationId: conversation.id,
          authorKind: 'ai',
          authorId: author,
          content: [reply.intro, sheetText(reply.sheet)].filter(Boolean).join('\n\n'),
          status: 'complete',
          kind: 'sheet',
          data: card,
        },
        {
          status: 'sheet',
          sheet: reply.sheet,
          // 新的任务单换一个任务 ID：旧单确认失败时留下的 ID 不沿用到改过的单上
          taskId: null,
          turns: [...intake.turns, { kind: 'sheet', sheet: reply.sheet }],
        },
      );
      out.push(message);
    }
    await repo.touchConversation(conversation.id);
    return out;
  }

  async function cancelIntake(
    conversation: Conversation,
    intake: Intake,
    text: string,
  ): Promise<Message[]> {
    if (intake.status === 'sheet' && intake.cardMessageId) {
      const card = await repo.findMessage(conversation.id, intake.cardMessageId);
      if (card) await repo.setMessageData(card.id, { ...card.data, status: 'cancelled' });
    }
    await repo.updateIntake(intake.id, { status: 'cancelled', cardMessageId: null });
    const message = await repo.insertMessage({
      conversationId: conversation.id,
      authorKind: 'ai',
      authorId: conversation.modelKey ?? 'unknown',
      content: text,
      status: 'complete',
    });
    await repo.touchConversation(conversation.id);
    return [message];
  }

  async function openIntake(conversation: Conversation): Promise<Intake> {
    const intake = await repo.findOpenIntake(conversation.id);
    if (!intake) throw new HttpError(409, 'no_open_intake', '现在没有正在整理的任务');
    return intake;
  }

  /** 开始接需求：记下需求和开始前的几条聊天，然后走第一步 */
  async function start(input: {
    conversation: Conversation;
    ownerId: string;
    request: string;
    sourceMessageId?: string;
    /** 需求那条消息带的文件 */
    attachments: MessageAttachment[];
    history: Message[];
    requestId: string;
  }): Promise<Message[]> {
    const context = sinceLastTask(input.history)
      .filter((m) => m.kind === 'text')
      .slice(-8);
    const created = await repo.createIntake({
      id: randomUUID(),
      conversationId: input.conversation.id,
      request: input.request,
      context: context.map((m) => ({
        messageId: m.id,
        role: m.authorKind === 'user' ? ('user' as const) : ('assistant' as const),
        content: withAttachmentNote(m.content.slice(0, 2000), attachmentsOf(m)),
      })),
      // 开始前几条聊天里发过的文件也算素材（常见：先发图，再说「用这些做个海报」）
      materials: mergeMaterials([], [...context.flatMap(attachmentsOf), ...input.attachments]),
    });
    if (!created) throw new HttpError(409, 'intake_open', '已经有一件正在整理的任务了');
    if (input.sourceMessageId)
      await repo.mergeMessageData(input.sourceMessageId, { intent: 'task', intakeId: created.id });
    return step(input.conversation, created, input.ownerId, input.requestId);
  }

  return {
    taskProbability,
    duringIntake,
    start,
    findOpen: (conversationId: string) => repo.findOpenIntake(conversationId),

    /** 接需求期间用户在对话里说的话：当作补充或修改意见，AI 接着问或改任务单 */
    async userSaid(input: {
      conversation: Conversation;
      intake: Intake;
      ownerId: string;
      text: string;
      attachments: MessageAttachment[];
      requestId: string;
    }): Promise<Message[]> {
      const intake = await repo.updateIntake(input.intake.id, {
        turns: [
          ...input.intake.turns,
          { kind: 'user', text: withAttachmentNote(input.text, input.attachments) },
        ],
        materials: mergeMaterials(input.intake.materials, input.attachments),
      });
      return step(input.conversation, intake, input.ownerId, input.requestId);
    },

    /** 点了「当成任务来做」：从那条用户消息开始接需求 */
    async startFrom(input: {
      conversation: Conversation;
      ownerId: string;
      messageId: string;
      requestId: string;
    }): Promise<Message[]> {
      const message = await repo.findMessage(input.conversation.id, input.messageId);
      if (message?.authorKind !== 'user') {
        throw new HttpError(404, 'message_not_found', '没有这条消息');
      }
      if ((await repo.taskSourceIds(input.conversation.id)).includes(message.id))
        throw new HttpError(409, 'task_message_locked', '这条消息已作为任务提交');
      const history = await repo.recentComplete(input.conversation.id, 10, message.id);
      await repo.mergeMessageData(message.id, { intent: 'task', stopRequested: false });
      return start({
        conversation: input.conversation,
        ownerId: input.ownerId,
        request: message.content,
        sourceMessageId: message.id,
        attachments: attachmentsOf(message),
        history: history.filter((m) => m.createdAt < message.createdAt),
        requestId: input.requestId,
      });
    },

    /** 回答问题卡（可以只答一部分）；skip = 直接开始 */
    async answer(input: {
      conversation: Conversation;
      ownerId: string;
      answers: Record<string, string>;
      messageId?: string;
      skip: boolean;
      requestId: string;
    }): Promise<Message[]> {
      const intake = await openIntake(input.conversation);
      const card = await repo.findQuestionCard(input.conversation.id, intake.id, intake.round);
      if (intake.status !== 'asking' || card?.kind !== 'questions') {
        throw new HttpError(409, 'no_questions', '现在没有要回答的问题');
      }
      if (input.messageId && input.messageId !== card.id)
        throw new HttpError(409, 'stale_questions', '这张问题卡已经处理，请刷新查看最新状态');
      const saved = intake.turns.findLast(
        (t) => t.kind === 'questions' && t.round === intake.round,
      );
      if (saved?.kind === 'questions' && saved.answers !== null)
        return step(
          input.conversation,
          intake,
          input.ownerId,
          input.requestId,
          saved.skipped ?? false,
          true,
        );
      const questions = (card.data as QuestionsCard).questions;
      const answers = validAnswers(questions, input.answers);
      const turns = intake.turns.map((t) =>
        t.kind === 'questions' && t.round === intake.round
          ? { ...t, answers, ...(input.skip ? { skipped: true } : {}) }
          : t,
      );
      const updated = await repo.saveIntakeAnswers(intake.id, card.id, turns, answers);
      return step(input.conversation, updated, input.ownerId, input.requestId, input.skip);
    },

    /** 不是任务 / 不做了 */
    async cancel(
      conversation: Conversation,
      text = '好的，这件事先不做了，我们接着聊。',
    ): Promise<Message[]> {
      return cancelIntake(conversation, await openIntake(conversation), text);
    },

    /** 确认任务单：交给 task 建任务（之后由规划员排工作流），私聊里出现任务卡 */
    async confirm(input: {
      conversation: Conversation;
      ownerId: string;
      requestId: string;
    }): Promise<Message[]> {
      const intake = await openIntake(input.conversation);
      if (intake.status !== 'sheet' || !intake.sheet || !intake.cardMessageId) {
        throw new HttpError(409, 'no_sheet', '任务单还没写好');
      }
      const { cardMessageId, materials } = intake;
      // 任务单上的素材以用户实际发的文件为准（AI 看不到文件，不让它填）
      const sheet = { ...intake.sheet, materials: materials.map((m) => m.name) };
      // 事先定好任务 ID 并记下：确认超时或断网后再点，task 按同一个 ID 返回已经建好的任务，不会建出第二个
      const taskId = intake.taskId ?? randomUUID();
      if (!intake.taskId) await repo.updateIntake(intake.id, { taskId });
      const task = await deps.task.json('POST', '/internal/tasks', {
        body: {
          id: taskId,
          ownerId: input.ownerId,
          payerId: input.ownerId,
          conversationId: input.conversation.id,
          title: sheet.title,
          brief: taskBrief(intake.request, intake.turns, sheet),
          sheet,
          materials,
        },
        requestId: input.requestId,
        schema: CreatedTask,
      });
      await repo.updateIntake(intake.id, {
        status: 'confirmed',
        taskId: task.id,
        cardMessageId: null,
      });
      const card = await repo.findMessage(input.conversation.id, cardMessageId);
      if (card) {
        await repo.setMessageData(card.id, { ...card.data, status: 'confirmed', taskId: task.id });
      }
      const message = await repo.insertMessage({
        conversationId: input.conversation.id,
        authorKind: 'ai',
        authorId: input.conversation.modelKey ?? 'unknown',
        content: `好的，交给 AI 团队了：「${sheet.title}」。正在搭建工作流，进度会显示在这里。`,
        status: 'complete',
        kind: 'task',
        data: { taskId: task.id },
      });
      await repo.touchConversation(input.conversation.id);
      return [message];
    },
  };
}

/** 只留题目里有的回答；答案必须是选项之一或「你看着办」 */
function validAnswers(questions: IntakeQuestion[], answers: Record<string, string>) {
  const result: Record<string, string> = {};
  for (const q of questions) {
    const answer = answers[q.id];
    if (answer === undefined) continue;
    if (answer.startsWith(CUSTOM_ANSWER_PREFIX)) {
      const text = answer.slice(CUSTOM_ANSWER_PREFIX.length).trim();
      if (!text || text.length > CUSTOM_ANSWER_MAX)
        throw new HttpError(
          400,
          'invalid_answer',
          `「${q.text}」自己写的答案要在 1–${CUSTOM_ANSWER_MAX} 字之间`,
        );
      result[q.id] = `${CUSTOM_ANSWER_PREFIX}${text}`;
      continue;
    }
    if (answer !== AUTO_ANSWER && !q.options.some((o) => o.id === answer)) {
      throw new HttpError(400, 'invalid_answer', `「${q.text}」没有这个选项`);
    }
    result[q.id] = answer;
  }
  return result;
}

/** 所有修改共用同一会话锁与显式连接；模型失败不回滚已经保存的答案。 */
export function createIntakeService(deps: Parameters<typeof intakeActions>[0]) {
  const service = intakeActions(deps);
  const locked = <T extends { conversation: Conversation }>(
    input: T,
    work: (service: ReturnType<typeof intakeActions>, input: T) => Promise<Message[]>,
  ) =>
    deps.repo.withIntakeLock(input.conversation.id, (repo) =>
      work(intakeActions({ ...deps, repo }), input),
    );
  return {
    ...service,
    start: (input: Parameters<typeof service.start>[0]) => locked(input, (s, i) => s.start(i)),
    startFrom: (input: Parameters<typeof service.startFrom>[0]) =>
      deps.repo.withMessageLock(input.conversation.id, (repo) =>
        repo.withIntakeLock(input.conversation.id, (scoped) =>
          intakeActions({ ...deps, repo: scoped }).startFrom(input),
        ),
      ),
    userSaid: (input: Parameters<typeof service.userSaid>[0]) =>
      locked(input, async (s, i) => {
        const current = await s.findOpen(i.conversation.id);
        if (!current) throw new HttpError(409, 'no_open_intake', '任务状态已变化，请刷新重试');
        return s.userSaid({ ...i, intake: current });
      }),
    answer: (input: Parameters<typeof service.answer>[0]) => locked(input, (s, i) => s.answer(i)),
    confirm: (input: Parameters<typeof service.confirm>[0]) =>
      locked(input, (s, i) => s.confirm(i)),
    cancel: (conversation: Conversation, text?: string) =>
      locked({ conversation }, (s, i) => s.cancel(i.conversation, text)),
  };
}
export type IntakeService = ReturnType<typeof createIntakeService>;
