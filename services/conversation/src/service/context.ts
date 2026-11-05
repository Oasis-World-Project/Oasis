// 私聊和问需求的上下文（ADR 0016 §8）：默认带整段对话，按任务给历史分段；
// 只有快到模型的上下文窗口时，才把较早的部分交给便宜的模型压缩成摘要（存下来，之后增量更新）。
// 不按条数截断：窗口大小取自模型目录。
import { OASIS_HEADERS } from '@oasis/contracts/common';
import type { SheetCard } from '@oasis/contracts/conversation';
import { ExecutionModels } from '@oasis/contracts/model-gateway';
import type { Logger, ServiceClient } from '@oasis/service-kit';
import { z } from 'zod';
import type { Conversation, ConversationRepo, Message } from '../repo/conversation-repo.ts';
import { attachmentsOf, withAttachmentNote } from './attachments.ts';

/** 输入 token 的保守估计：和模型网关一样按 1.5 个字符 1 个 token */
export const tokensOf = (text: string) => Math.ceil(text.length / 1.5);

/** 消息所属任务的标签，如「任务「3D 马车」·已交付」；finished = 任务已经结束（交出去了或不做了） */
export interface TaskLabel {
  text: string;
  finished: boolean;
  /** 所属的接需求 ID（问需求时用来认出这次任务自己的消息） */
  intakeId?: string;
}

/**
 * 每条消息属于哪个任务：问题卡、任务单卡、任务卡、交付消息和任务原话都记着 intakeId 或 taskId。
 * 返回 消息 ID → 标签；普通聊天没有标签。
 */
export function taskLabels(messages: Message[]): Map<string, TaskLabel> {
  const title = new Map<string, string>();
  const taskOfIntake = new Map<string, string>();
  const status = new Map<string, string>();
  for (const m of messages) {
    if (m.kind !== 'sheet') continue;
    const card = m.data as Partial<SheetCard>;
    if (!card.intakeId || !card.sheet) continue;
    title.set(card.intakeId, card.sheet.title);
    if (card.taskId) {
      taskOfIntake.set(card.intakeId, card.taskId);
      title.set(card.taskId, card.sheet.title);
    }
    if (card.status === 'cancelled') status.set(card.intakeId, '不做了');
    if (card.status === 'confirmed' && card.taskId) status.set(card.taskId, '已交给 AI 团队');
  }
  for (const m of messages) {
    const taskId = (m.data as { taskId?: string }).taskId;
    if (m.kind === 'delivery' && taskId) status.set(taskId, '已交付');
  }
  const intakeOfTask = new Map([...taskOfIntake].map(([intake, task]) => [task, intake]));
  const labels = new Map<string, TaskLabel>();
  for (const m of messages) {
    const data = m.data as { intakeId?: string; taskId?: string; intent?: string };
    const intakeId = data.intakeId;
    const taskId = data.taskId ?? (intakeId ? taskOfIntake.get(intakeId) : undefined);
    const key = taskId ?? intakeId;
    if (!key) continue;
    const name = title.get(key) ?? (intakeId ? title.get(intakeId) : undefined);
    const state =
      (taskId ? status.get(taskId) : undefined) ??
      (intakeId ? status.get(intakeId) : undefined) ??
      '没整理完';
    const owner = intakeId ?? (taskId ? intakeOfTask.get(taskId) : undefined);
    labels.set(m.id, {
      text: `任务「${name ?? '没起名'}」·${state}`,
      finished: state !== '没整理完',
      ...(owner ? { intakeId: owner } : {}),
    });
  }
  return labels;
}

/** 一条消息交给模型时的文字：带上所属任务的标签和附件说明；结束了的任务注明只作背景 */
export function rendered(m: Message, labels: Map<string, TaskLabel>): string {
  const label = labels.get(m.id);
  const text = withAttachmentNote(m.content, attachmentsOf(m));
  if (!label) return text;
  return `【${label.text}${label.finished ? '，只作背景' : ''}】${text}`;
}

/** 一条消息写成对话里的一行 */
export const line = (m: Message, labels: Map<string, TaskLabel>, you = 'AI') =>
  `${m.authorKind === 'user' ? '用户' : you}：${rendered(m, labels)}`;

const Completion = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({ content: z.string().nullish() }),
      }),
    )
    .min(1),
});

export interface ConversationContext {
  /** 较早部分的摘要；没压缩过为 null */
  summary: string | null;
  /** 摘要之后的全部已完成消息，按时间正序 */
  messages: Message[];
  /** 消息 ID → 所属任务的标签 */
  labels: Map<string, TaskLabel>;
}

export function createContext(deps: {
  repo: Pick<ConversationRepo, 'completeMessages' | 'setContextSummary'>;
  modelGateway: ServiceClient;
  /** 压缩较早对话用的便宜模型 */
  summaryModel: string;
  logger: Logger;
}) {
  let windows: { at: number; byId: Map<string, number> } | undefined;
  /** 模型的上下文窗口（token）；查不到返回 undefined（这时不压缩） */
  async function windowOf(providerModel: string, requestId: string): Promise<number | undefined> {
    // 模型目录很少变：同一个进程里十分钟查一次
    if (!windows || Date.now() - windows.at > 10 * 60_000) {
      try {
        const { models } = await deps.modelGateway.json('GET', '/internal/v1/models/execution', {
          requestId,
          schema: ExecutionModels,
        });
        windows = { at: Date.now(), byId: new Map(models.map((m) => [m.id, m.contextWindow])) };
      } catch (err) {
        deps.logger.warn({ err, requestId }, '查不到模型的上下文窗口，这次不压缩');
        return undefined;
      }
    }
    return windows.byId.get(providerModel);
  }

  /** 把较早的消息（和原来的摘要）压成一段新摘要；失败返回 undefined */
  async function summarize(
    previous: string | null,
    older: Message[],
    labels: Map<string, TaskLabel>,
    input: { ownerId: string; requestId: string },
  ): Promise<string | undefined> {
    const transcript = older.map((m) => line(m, labels)).join('\n');
    try {
      const result = await deps.modelGateway.json('POST', '/internal/v1/chat/completions', {
        body: {
          model: deps.summaryModel,
          stream: false,
          messages: [
            {
              role: 'user',
              content: [
                '把下面这段较早的私聊压缩成要点，后面的对话会接着用。',
                '- 按任务分段：每个任务写名称、状态（已交付 / 已交给 AI 团队 / 不做了 / 没整理完）、用户的关键要求和决定、发过的文件名；已经结束的任务标明「已结束，只作背景」。',
                '- 普通聊天只留之后还可能用到的事实和用户偏好。',
                '- 只写事实，不加评论，不编造。',
                previous ? `【原来的摘要】\n${previous}` : '',
                `【要压缩的对话】\n${transcript}`,
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        },
        headers: { [OASIS_HEADERS.payerId]: input.ownerId },
        requestId: input.requestId,
        schema: Completion,
      });
      const choice = result.choices[0]!;
      const text = choice.message.content?.trim();
      if ((choice.finish_reason && choice.finish_reason !== 'stop') || !text)
        throw new Error(`摘要没写完：${choice.finish_reason ?? '空回答'}`);
      return text;
    } catch (err) {
      deps.logger.warn({ err, requestId: input.requestId }, '压缩较早的对话失败');
      return undefined;
    }
  }

  return {
    /**
     * 交给模型的历史：摘要之后的整段对话。估计的 token 超过「窗口 − 预留」时，把较早的部分压成摘要，
     * 留下的原文不超过可用空间的一半（给之后的对话留地方）；压缩失败时这次只带放得下的最近部分。
     * 同一份历史要交给几个模型时（如聊天模型和 Jev），按其中最小的窗口算。
     */
    async history(input: {
      conversation: Conversation;
      /** 不算进历史的那条（如正在生成的回复） */
      excludeId?: string;
      beforeSeq?: number;
      providerModels: string[];
      /** 系统提示、输出上限等不属于历史、但要占窗口的 token */
      reserveTokens: number;
      ownerId: string;
      requestId: string;
    }): Promise<ConversationContext> {
      // 摘要只在它覆盖的范围都在这次之前时可用（重新生成更早的回复时不用）
      const stored = input.conversation.contextSummary ?? null;
      const saved =
        stored && (input.beforeSeq === undefined || stored.throughSeq < input.beforeSeq)
          ? stored
          : null;
      const all = await deps.repo.completeMessages(
        input.conversation.id,
        input.excludeId,
        input.beforeSeq,
      );
      // 标签按整段对话认（任务单卡可能在摘要覆盖的范围里）
      const labels = taskLabels(all);
      const messages = saved ? all.filter((m) => m.seq > saved.throughSeq) : all;
      const sizes = messages.map((m) => tokensOf(rendered(m, labels)) + 8);
      const total = sizes.reduce((a, b) => a + b, 0) + (saved ? tokensOf(saved.text) : 0);
      const windows = await Promise.all(
        input.providerModels.map((model) => windowOf(model, input.requestId)),
      );
      const known = windows.filter((w): w is number => w !== undefined);
      const room = known.length ? Math.min(...known) - input.reserveTokens : Infinity;
      if (total <= room) return { summary: saved?.text ?? null, messages, labels };
      // 从最近往前留，留到可用空间的一半为止，更早的压成摘要
      let kept = 0;
      let start = messages.length;
      while (start > 0 && kept + sizes[start - 1]! <= room / 2) kept += sizes[--start]!;
      const older = messages.slice(0, start);
      const recent = messages.slice(start);
      const text = older.length
        ? await summarize(saved?.text ?? null, older, labels, input)
        : undefined;
      if (text === undefined) return { summary: saved?.text ?? null, messages: recent, labels };
      const summary = { throughSeq: older.at(-1)!.seq, text };
      await deps.repo.setContextSummary(input.conversation.id, summary);
      // 同一轮里后面再取历史（如判断完再聊天）直接用新摘要，不再压一次
      input.conversation.contextSummary = summary;
      return { summary: text, messages: recent, labels };
    },
  };
}
export type ContextService = ReturnType<typeof createContext>;
