// 把 harness 的运行事件写进 AI 的消息：AI 说的话、做的步骤、待办、系统提示。
// AI 看到用户的插话时分段：之后的写进一条新的 AI 消息，插话排在前一段后面。
import {
  TodoItem,
  type MessagePart,
  type StepPart,
  type TodoItem as Todo,
} from '@oasis/contracts/conversation';
import type { RunBody, RunEventBody } from '@oasis/contracts/harness';
import { HttpError } from '@oasis/service-kit';
import { z } from 'zod';
import type { Conversation, ConversationRepo, Message } from '../repo/conversation-repo.ts';

/** 一段 AI 消息：按顺序的几段内容，和最新的待办 */
export interface Segment {
  parts: MessagePart[];
  todos?: Todo[];
}

/** 消息里存的 AI 那一段 */
export const segmentOf = (message: Message): Segment => {
  const data = message.data as Partial<Segment>;
  return { parts: data.parts ?? [], ...(data.todos ? { todos: data.todos } : {}) };
};

/** 这段 AI 消息的文字内容：它说过的话连起来 */
export const contentOf = (segment: Segment) =>
  segment.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n\n');

const brief = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** 运行状态里要让用户知道的几种 */
const NOTICES: Record<string, string> = {
  recovery_wait: '服务连接中断了，恢复后接着做',
  recovering: '服务恢复了，接着做',
};

/**
 * 按顺序把一批事件写进这一段，返回写好的新一段（不改原来的）。
 * AI 派出去的子任务（带 parentSessionId 的事件）不写：子任务本身是主 AI 的一步。
 */
export function applyEvents(current: Segment, events: RunEventBody[]): Segment {
  const segment: Segment = {
    parts: current.parts.map((part) => ({ ...part })),
    ...(current.todos ? { todos: current.todos } : {}),
  };
  for (const { kind, data } of events) {
    if (typeof data.parentSessionId === 'string') continue;
    if (kind === 'assistant_text') {
      const text = String(data.text ?? '');
      if (text.trim()) segment.parts.push({ type: 'text', text });
    } else if (kind === 'tool_call') {
      const tool = String(data.name ?? '');
      segment.parts.push({
        type: 'step',
        id: String(data.callId ?? ''),
        tool,
        label: String(data.label ?? tool),
        status: 'running',
      });
    } else if (kind === 'tool_result') {
      const step = segment.parts.find(
        (part): part is StepPart => part.type === 'step' && part.id === String(data.callId ?? ''),
      );
      if (!step) continue;
      step.status = data.ok === false ? 'failed' : 'done';
      if (data.ok === false) step.detail = brief(String(data.error ?? data.text ?? ''), 300);
    } else if (kind === 'todos') {
      const items = z.array(TodoItem).safeParse(data.items);
      if (items.success) segment.todos = items.data;
    } else if (kind === 'status') {
      const notice = NOTICES[String(data.status)];
      if (notice) segment.parts.push({ type: 'notice', text: notice });
    }
  }
  return segment;
}

/** 一轮结束时还没做完的步骤：正常做完的算完成，停下、出错的算没做完 */
export function settleSteps(segment: Segment, succeeded: boolean): Segment {
  return {
    ...segment,
    parts: segment.parts.map((part) =>
      part.type === 'step' && part.status === 'running'
        ? succeeded
          ? { ...part, status: 'done' }
          : { ...part, status: 'failed', detail: '没做完' }
        : part,
    ),
  };
}

/** 一段话的第一行，太长截短 */
export const firstLine = (text: string, max: number) => {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/** 一轮失败给用户看的说明（技术细节截短；说「继续」可以接着做） */
export function failure(error: string | null | undefined): string {
  return error
    ? `这一轮出错了：${firstLine(error, 300)}。说「继续」可以接着做`
    : '这一轮没做完，原因不明。说「继续」可以接着做';
}

/** 开一轮前就失败（没开成）给用户看的说明 */
export function refused(err: unknown): string {
  if (err instanceof HttpError && err.statusCode < 500) return err.message;
  if (err instanceof HttpError && err.code === 'harness_closing')
    return '执行服务正在重启，请稍后再发一次';
  return '这一轮没能开始，请稍后再发一次';
}

export const terminal = (status: RunBody['status']) =>
  ['succeeded', 'failed', 'cancelled', 'stopped'].includes(status);

/** 把一段事件写进这条 AI 消息 */
async function append(
  store: ConversationRepo,
  conversationId: string,
  segmentId: string,
  events: RunEventBody[],
) {
  const message = events.length ? await store.findMessage(conversationId, segmentId) : undefined;
  if (!message) return;
  const next = applyEvents(segmentOf(message), events);
  await store.updateMessage(message.id, {
    content: contentOf(next),
    data: { ...message.data, parts: next.parts, ...(next.todos ? { todos: next.todos } : {}) },
  });
}

/**
 * AI 看到了一条插话：正在写的那条到此为止（什么都没写的去掉），之后的写进新的一条，排在插话后面。
 * 还在做的步骤一起挪过去：它的结果在那之后才到。返回新的那条。
 */
async function afterInterjection(
  store: ConversationRepo,
  conversation: Conversation,
  runId: string,
  segmentId: string,
): Promise<string> {
  const previous = await store.findMessage(conversation.id, segmentId);
  const before: Segment = previous ? segmentOf(previous) : { parts: [] };
  const running = before.parts.filter((p) => p.type === 'step' && p.status === 'running');
  const kept = { parts: before.parts.filter((p) => !running.includes(p)) };
  if (previous && !kept.parts.length) await store.deleteMessage(previous.id);
  else if (previous)
    await store.updateMessage(previous.id, {
      status: 'complete',
      content: contentOf(kept),
      data: { ...previous.data, parts: kept.parts },
    });
  const segment = await store.insertMessage({
    conversationId: conversation.id,
    authorKind: 'ai',
    authorId: conversation.modelKey ?? 'unknown',
    content: '',
    status: 'streaming',
    kind: 'text',
    data: { runId, parts: running, ...(before.todos ? { todos: before.todos } : {}) },
  });
  return segment.id;
}

/**
 * 把这一批事件写进正在写的那条 AI 消息。插话在 AI 看到时（这一轮里又来一条用户的话）分段：
 * AI 在那之前说的、做的留在插话前面。拿着 message 锁写，和用户发话错开；锁被占着（用户正在发话）
 * 就这次不写、返回 false，下次再拉这批事件。
 */
export async function writeEvents(
  store: ConversationRepo,
  conversationId: string,
  runId: string,
  events: RunEventBody[],
): Promise<boolean> {
  try {
    return await store.withLock('message', conversationId, async (locked) => {
      const conversation = await locked.find(conversationId);
      const turn = conversation?.turn;
      if (!conversation || turn?.runId !== runId) return false;
      let { segmentId, unheard = 0 } = turn;
      let pending: RunEventBody[] = [];
      for (const event of events) {
        // 开头那句（和服务恢复时的提醒）不算：只有送进来、AI 还没看到的插话才分段
        const heard =
          unheard > 0 &&
          event.kind === 'user_message' &&
          typeof event.data.parentSessionId !== 'string';
        if (!heard) {
          pending.push(event);
          continue;
        }
        await append(locked, conversationId, segmentId, pending);
        pending = [];
        segmentId = await afterInterjection(locked, conversation, runId, segmentId);
        unheard -= 1;
      }
      await append(locked, conversationId, segmentId, pending);
      await locked.updateTurn(conversationId, runId, {
        cursor: events.at(-1)!.seq,
        segmentId,
        unheard,
      });
      return true;
    });
  } catch (err) {
    if (err instanceof HttpError && err.code === 'conversation_busy') return false;
    throw err;
  }
}
