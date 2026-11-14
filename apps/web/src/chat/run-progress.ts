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

/** 一张长任务卡：一次生成（一步），或交上去后在供应商那边做、之后才等到的一个任务号 */
export interface LongTask {
  key: string;
  label: string;
  status: StepPart['status'];
  startedAt?: string;
  finishedAt?: string;
  expectSeconds?: number;
  detail?: string;
  files: RunFile[];
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
  longTasks: LongTask[];
  /** 这一轮做出的文件（做完的步骤写的、存下的），最新的在前；一轮结束后只剩 out/ 里的 */
  files: RunFile[];
  /** 一轮结束后看不到了的中间文件有几个（不在 out/ 里的不留） */
  gone: number;
}

/** 隐藏的文件（如 oasis-tool 的恢复记录）不算做出的东西 */
const hidden = (path: string) => path.split('/').some((part) => part.startsWith('.'));

/**
 * 长任务卡：生图这类一步做完的，一步一张；视频、音乐交上去没等到的（--wait false，或等到上限还没好），
 * 一个任务号一张，之后等到的那一步按任务号写回它的结局和文件；等的那一步只在等的是这一轮看不到的
 * 任务时自己成卡。一轮结束时还没等到的，说没等到。
 */
function longTasksOf(steps: StepPart[], live: boolean): LongTask[] {
  const cards: LongTask[] = [];
  const byJob = new Map<string, LongTask>();
  const fileOf = (step: StepPart) => (path: string) => ({ path, version: step.finishedAt ?? '' });
  for (const step of steps) {
    if (!step.oasisTool || !LONG_TOOLS.has(step.oasisTool)) continue;
    const handed = (step.jobs ?? []).filter(
      (j) => j.state === 'submitted' || j.state === 'waiting',
    );
    const known = (step.jobs ?? []).filter((j) => byJob.has(j.id));
    for (const job of known) {
      const card = byJob.get(job.id)!;
      if (job.state === 'done' || job.state === 'failed') {
        card.status = job.state;
        card.finishedAt = step.finishedAt;
        card.files = (job.files ?? []).map(fileOf(step));
        if (job.state === 'failed') card.detail = step.detail ?? '没做出来';
      }
    }
    if (step.oasisTool === 'wait' && (known.length || (step.status === 'running' && byJob.size)))
      continue;
    if (step.oasisTool !== 'wait' && handed.length) {
      for (const [index, job] of handed.entries()) {
        const card: LongTask = {
          key: job.id,
          label: handed.length > 1 ? `${step.label}（${index + 1}/${handed.length}）` : step.label,
          status: 'running',
          ...(step.startedAt ? { startedAt: step.startedAt } : {}),
          ...(step.expectSeconds ? { expectSeconds: step.expectSeconds } : {}),
          files: [],
        };
        byJob.set(job.id, card);
        cards.push(card);
      }
      continue;
    }
    cards.push({
      key: step.id,
      label: step.label,
      status: step.status,
      ...(step.startedAt ? { startedAt: step.startedAt } : {}),
      ...(step.finishedAt ? { finishedAt: step.finishedAt } : {}),
      ...(step.expectSeconds ? { expectSeconds: step.expectSeconds } : {}),
      ...(step.detail ? { detail: step.detail } : {}),
      files: step.status === 'running' ? [] : (step.files ?? []).map(fileOf(step)),
    });
  }
  if (!live)
    for (const card of byJob.values())
      if (card.status === 'running')
        Object.assign(card, { status: 'failed', detail: '这一轮结束时还没等到结果' });
  return cards;
}

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
  const made = [...finished].map(([path, version]) => ({ path, version })).reverse();
  // 一轮结束后沙箱就没了，只留 out/ 里的
  const kept = (file: RunFile) => status === 'running' || file.path.startsWith('out/');
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
    longTasks: longTasksOf(steps, status === 'running').map((task) => ({
      ...task,
      files: task.files.filter(kept),
    })),
    files: made.filter(kept),
    gone: made.filter((file) => !kept(file)).length,
  };
}
