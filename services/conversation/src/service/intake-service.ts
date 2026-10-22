// 在私聊里接任务（ADR 0005 §2、§3）：认出任务 → 私聊里的 AI 问需求（问题卡）→ 给出任务单 →
// 用户确认 → 交给 task 建任务（之后由规划员排工作流）。问需求不走 harness：直接经 model-gateway 调模型。
import { randomUUID } from 'node:crypto';
import { ModelRoute } from '@oasis/contracts/agent';
import { OASIS_HEADERS } from '@oasis/contracts/common';
import {
  AUTO_ANSWER,
  type IntakeQuestion,
  type QuestionsCard,
  type SheetCard,
} from '@oasis/contracts/conversation';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import { z } from 'zod';
import type { Conversation, ConversationRepo, Intake, Message } from '../repo/conversation-repo.ts';
import {
  intakeMessages,
  parseIntakeReply,
  questionsText,
  sheetText,
  type IntakeReply,
} from './intake.ts';

const Decision = z.object({
  answers: z.record(z.string(), z.object({ noul: z.number().optional() }).loose()),
});
/** 建任务的返回里只用得到任务 ID */
const CreatedTask = z.object({ id: z.uuid() }).loose();
const Completion = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

export interface IntakeConfig {
  /** 判断「是不是任务」的决策模型（Jev） */
  detectModel: string;
  /** 概率不低于它就直接开始接需求 */
  detectHigh: number;
  /** 概率不低于它就在回复下面附「当成任务来做」 */
  detectLow: number;
  /** 私聊的 AI 写不出合格的 JSON 时换它来做（供应商型号） */
  fallbackModel: string;
  /** 最多问几轮（用户定：3） */
  maxRounds: number;
  maxTokens: number;
}

export function createIntakeService(deps: {
  repo: ConversationRepo;
  agent: ServiceClient;
  modelGateway: ServiceClient;
  task: ServiceClient;
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
            is_task: {
              type: 'noul',
              instructions:
                '用户刚说的这句话，是不是在交代 AI 去做一件要交付成果的事（写文档、做图、做网页、做视频、做研究报告等）？',
              criteria: {
                true: '是：要 AI 做出一个东西交给他',
                false: '不是：闲聊、提问、讨论想法，或者只要一个简短的回答',
              },
            },
          },
        },
        headers: { [OASIS_HEADERS.payerId]: input.ownerId },
        requestId: input.requestId,
        schema: Decision,
      });
      return answers.is_task?.noul ?? 0;
    } catch (err) {
      logger.warn({ err }, '判断是不是任务失败，照常聊天');
      return 0;
    }
  }

  async function complete(ownerId: string, model: string, messages: unknown[], requestId: string) {
    const result = await deps.modelGateway.json('POST', '/internal/v1/chat/completions', {
      body: { model, messages, max_tokens: config.maxTokens, stream: false },
      headers: { [OASIS_HEADERS.payerId]: ownerId },
      requestId,
      schema: Completion,
    });
    return result.choices[0]?.message.content ?? '';
  }

  /**
   * 让私聊里的 AI 走一步：问题、任务单或不做了。它的 JSON 不合格就带着原因再要一次，
   * 还不行就换默认模型来做。
   */
  async function askModel(
    conversation: Conversation,
    intake: Intake,
    ownerId: string,
    requestId: string,
    skipped: boolean,
  ): Promise<IntakeReply> {
    const route = await deps.agent.json(
      'GET',
      `/internal/models/${encodeURIComponent(conversation.modelKey ?? '')}/route`,
      { requestId, schema: ModelRoute },
    );
    const roundsLeft = config.maxRounds - intake.round;
    const mustSheet = skipped || roundsLeft <= 0;
    const messages = intakeMessages({
      name: route.name,
      request: intake.request,
      context: intake.context,
      turns: intake.turns,
      roundsLeft,
      skipped,
    });
    const attempts = [route.providerModel, route.providerModel, config.fallbackModel];
    let feedback: string | undefined;
    for (const model of attempts) {
      const prompt = feedback
        ? [
            ...messages,
            {
              role: 'user',
              content: `刚才的回答不合格：${feedback}。请只输出一个合格的 JSON 对象。`,
            },
          ]
        : messages;
      try {
        const text = await complete(ownerId, model, prompt, requestId);
        return parseIntakeReply(text, mustSheet);
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 402) throw err; // 额度不够
        feedback = err instanceof Error ? err.message : String(err);
        logger.warn({ model, feedback }, '接需求的回答不合格，重试');
      }
    }
    throw new HttpError(502, 'intake_failed', '没能把需求整理好，请换个说法再说一次');
  }

  /** 走一步并把结果变成消息：问题卡、任务单卡，或一句「好的，不做了」 */
  async function step(
    conversation: Conversation,
    intake: Intake,
    ownerId: string,
    requestId: string,
    skipped = false,
  ): Promise<Message[]> {
    const reply = await askModel(conversation, intake, ownerId, requestId, skipped);
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
        questions: reply.questions,
        answers: null,
      };
      const message = await repo.insertMessage({
        conversationId: conversation.id,
        authorKind: 'ai',
        authorId: author,
        content: questionsText(reply.intro, reply.questions),
        status: 'complete',
        kind: 'questions',
        data: card,
      });
      await repo.updateIntake(intake.id, {
        status: 'asking',
        round,
        cardMessageId: message.id,
        turns: [
          ...intake.turns,
          { kind: 'questions', round, questions: reply.questions, answers: null },
        ],
      });
      out.push(message);
    } else {
      // 新任务单替换上一版（只留最新一份）
      await supersede(conversation, intake);
      const card: SheetCard = {
        intakeId: intake.id,
        sheet: reply.sheet,
        status: 'open',
        taskId: null,
      };
      const message = await repo.insertMessage({
        conversationId: conversation.id,
        authorKind: 'ai',
        authorId: author,
        content: [reply.intro, sheetText(reply.sheet)].filter(Boolean).join('\n\n'),
        status: 'complete',
        kind: 'sheet',
        data: card,
      });
      await repo.updateIntake(intake.id, {
        status: 'sheet',
        cardMessageId: message.id,
        sheet: reply.sheet,
        turns: [...intake.turns, { kind: 'sheet', sheet: reply.sheet }],
      });
      out.push(message);
    }
    await repo.touchConversation(conversation.id);
    return out;
  }

  /** 把当前那张任务单卡标成「已被替换」 */
  async function supersede(conversation: Conversation, intake: Intake) {
    if (intake.status !== 'sheet' || !intake.cardMessageId) return;
    const card = await repo.findMessage(conversation.id, intake.cardMessageId);
    if (card?.kind === 'sheet')
      await repo.setMessageData(card.id, { ...card.data, status: 'superseded' });
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
    history: Message[];
    requestId: string;
  }): Promise<Message[]> {
    const created = await repo.createIntake({
      id: randomUUID(),
      conversationId: input.conversation.id,
      request: input.request,
      context: input.history
        .filter((m) => m.kind === 'text')
        .slice(-8)
        .map((m) => ({
          role: m.authorKind === 'user' ? ('user' as const) : ('assistant' as const),
          content: m.content.slice(0, 2000),
        })),
    });
    if (!created) throw new HttpError(409, 'intake_open', '已经有一件正在整理的任务了');
    return step(input.conversation, created, input.ownerId, input.requestId);
  }

  return {
    taskProbability,
    start,
    findOpen: (conversationId: string) => repo.findOpenIntake(conversationId),

    /** 接需求期间用户在对话里说的话：当作补充或修改意见，AI 接着问或改任务单 */
    async userSaid(input: {
      conversation: Conversation;
      intake: Intake;
      ownerId: string;
      text: string;
      requestId: string;
    }): Promise<Message[]> {
      const intake = await repo.updateIntake(input.intake.id, {
        turns: [...input.intake.turns, { kind: 'user', text: input.text }],
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
      const history = await repo.recentComplete(input.conversation.id, 10, message.id);
      return start({
        conversation: input.conversation,
        ownerId: input.ownerId,
        request: message.content,
        history: history.filter((m) => m.createdAt < message.createdAt),
        requestId: input.requestId,
      });
    },

    /** 回答问题卡（可以只答一部分）；skip = 直接开始 */
    async answer(input: {
      conversation: Conversation;
      ownerId: string;
      answers: Record<string, string>;
      skip: boolean;
      requestId: string;
    }): Promise<Message[]> {
      const intake = await openIntake(input.conversation);
      const card = intake.cardMessageId
        ? await repo.findMessage(input.conversation.id, intake.cardMessageId)
        : undefined;
      if (intake.status !== 'asking' || card?.kind !== 'questions') {
        throw new HttpError(409, 'no_questions', '现在没有要回答的问题');
      }
      const questions = (card.data as QuestionsCard).questions;
      const answers = validAnswers(questions, input.answers);
      await repo.setMessageData(card.id, { ...card.data, answers });
      const turns = intake.turns.map((t) =>
        t.kind === 'questions' && t.round === intake.round
          ? { ...t, answers, ...(input.skip ? { skipped: true } : {}) }
          : t,
      );
      const updated = await repo.updateIntake(intake.id, { turns, cardMessageId: null });
      return step(input.conversation, updated, input.ownerId, input.requestId, input.skip);
    },

    /** 不是任务 / 不做了 */
    async cancel(conversation: Conversation): Promise<Message[]> {
      return cancelIntake(
        conversation,
        await openIntake(conversation),
        '好的，这件事先不做了，我们接着聊。',
      );
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
      const { sheet, cardMessageId } = intake;
      const task = await deps.task.json('POST', '/internal/tasks', {
        body: {
          ownerId: input.ownerId,
          payerId: input.ownerId,
          conversationId: input.conversation.id,
          title: sheet.title,
          brief: [`用户的原话：${intake.request}`, sheetText(sheet)].join('\n\n'),
          sheet,
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
    if (answer !== AUTO_ANSWER && !q.options.some((o) => o.id === answer)) {
      throw new HttpError(400, 'invalid_answer', `「${q.text}」没有这个选项`);
    }
    result[q.id] = answer;
  }
  return result;
}

export type IntakeService = ReturnType<typeof createIntakeService>;
