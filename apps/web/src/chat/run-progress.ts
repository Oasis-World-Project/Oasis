// 一轮的进度页用的：从私聊的消息里挑出这一轮的，算出整体状态、正在做的一步、待办、长任务和做出的文件。
// 进度以真实发生的步骤为准（步骤由 harness 的事件写成，一轮结束时没做完的步骤也收了尾）。
import type {
  MessageBody,
  MessageList,
  StepPart,
  TaskCard,
  TodoItem,
} from '@oasis/contracts/conversation';
import { GENERATION_TOOLS } from '@oasis/contracts/model-gateway';

export type TextMessage = Extract<MessageBody, { kind: 'text' }>;

/** 进度页上单独成卡的长任务：生图、视频、音乐这类，和等它们的结果 */
const LONG_TOOLS = new Set([...GENERATION_TOOLS, 'wait']);

export interface RunFile {
  path: string;
  /** 做出它的那一步结束的时间（同一路径重新生成时换新的预览） */
  version: string;
}

export interface RunProgress {
  /** 这一轮的消息：用户的话（开头那句和插话）、AI 的话，按顺序 */
  messages: TextMessage[];
  card: TaskCard | undefined;
  status: TaskCard['status'];
  startedAt: string | undefined;
  finishedAt: string | undefined;
  spentMicro: number;
  /** 正在做的一步（一轮在做时） */
  current: StepPart | undefined;
  todos: TodoItem[];
  longTasks: StepPart[];
  /** 这一轮做出的文件（做完的步骤写的、存下的），最新的在前 */
  files: RunFile[];
}

/** 隐藏的文件（如 oasis-tool 的恢复记录）不算做出的东西 */
const hidden = (path: string) => path.split('/').some((part) => part.startsWith('.'));

export function runProgress(list: MessageList | undefined, runId: string): RunProgress {
  const all = list?.messages ?? [];
  const messages = all.filter((m): m is TextMessage => m.kind === 'text' && m.data.runId === runId);
  const card = all.find(
    (m): m is Extract<MessageBody, { kind: 'task' }> => m.kind === 'task' && m.data.runId === runId,
  )?.data;
  const ai = messages.filter((m) => m.role === 'assistant');
  const last = ai.at(-1);
  const live = list?.turn?.runId === runId;
  const status: TaskCard['status'] =
    card?.status ??
    (live
      ? 'running'
      : last?.status === 'failed'
        ? 'failed'
        : last?.data.stopped
          ? 'stopped'
          : 'done');
  const steps = ai.flatMap((m) =>
    (m.data.parts ?? []).filter((part): part is StepPart => part.type === 'step'),
  );
  const finished = new Map<string, string>();
  for (const step of steps) {
    if (step.status === 'running') continue;
    for (const path of step.files ?? []) {
      if (hidden(path)) continue;
      finished.delete(path);
      finished.set(path, step.finishedAt ?? '');
    }
  }
  return {
    messages,
    card,
    status,
    startedAt: card?.startedAt ?? (live ? list?.turn?.startedAt : messages[0]?.createdAt),
    finishedAt:
      card?.finishedAt ??
      (status === 'running' ? undefined : steps.findLast((s) => s.finishedAt)?.finishedAt),
    spentMicro:
      card?.spentMicro ?? ai.findLast((m) => m.data.spentMicro !== undefined)?.data.spentMicro ?? 0,
    current: status === 'running' ? steps.findLast((s) => s.status === 'running') : undefined,
    todos: ai.findLast((m) => m.data.todos?.length)?.data.todos ?? [],
    longTasks: steps.filter((s) => s.oasisTool && LONG_TOOLS.has(s.oasisTool)),
    files: [...finished].map(([path, version]) => ({ path, version })).reverse(),
  };
}
