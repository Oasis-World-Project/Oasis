// 工作台「任务」页签上的任务：群里 AI 动过手（有步骤）、交过文件，或在等人回答的每一轮是一张卡。
// 从群消息里拼出来：这一轮里 AI 的话（带步骤、待办）和它的任务卡（任务名、花费、交的文件）。
import type { MessagePart, TaskFile, TodoItem } from '@oasis/contracts/conversation';
import type { GroupMessage } from '@oasis/contracts/group';
import { splitBlocks } from '../../chat/blocks.ts';

export type TaskColumn = 'doing' | 'review' | 'done';
export const TASK_COLUMNS: { id: TaskColumn; title: string }[] = [
  { id: 'doing', title: '进行中' },
  { id: 'review', title: '等你确认' },
  { id: 'done', title: '完成' },
];

export interface RoomTask {
  runId: string;
  /** 哪个 AI 的 */
  key: string;
  title: string;
  column: TaskColumn;
  /** 卡片上的那句说明：正在做哪一步、在等什么、做了几步 */
  note: string;
  /** 进行中：待办做完了百分之几（没列待办就没有） */
  percent?: number;
  /** 过程：这一轮按先后的每一段（步骤、边做边说的话、提示） */
  parts: MessagePart[];
  todos?: TodoItem[];
  files: TaskFile[];
  spentMicro: number;
  startedAt: string;
  finishedAt: string | null;
  live: boolean;
}

type Text = Extract<GroupMessage, { kind: 'text' }>;
type Card = Extract<GroupMessage, { kind: 'task' }>;

/** 话里还有没答的问卷、没确认的任务单 */
const asks = (message: Text) =>
  message.status === 'complete' &&
  splitBlocks(message.content).some((block) => block.kind !== 'text');

/**
 * 把消息拼成任务，新的在前。messages 里可以有重复（工作台另读的和聊天里已有的）：同一条以后面的为准。
 */
export function tasksOf(messages: GroupMessage[]): RoomTask[] {
  const unique = [...new Map(messages.map((message) => [message.id, message])).values()].sort(
    (a, b) => a.seq - b.seq,
  );
  const runs = new Map<string, { texts: Text[]; card?: Card }>();
  /** 每个 AI 最新说的那条话：只有它上面的问卷还等着人答，只有它出错、停下了还等着人说「继续」 */
  const latest = new Map<string, string>();
  for (const message of unique) {
    if (message.role !== 'assistant') continue;
    const runId = message.kind === 'topic' ? undefined : message.data.runId;
    if (!runId) continue;
    const run = runs.get(runId) ?? { texts: [] };
    runs.set(runId, run);
    if (message.kind === 'text') {
      run.texts.push(message);
      latest.set(message.authorId, message.id);
    } else if (message.kind === 'task') run.card = message;
  }
  const tasks: RoomTask[] = [];
  for (const [runId, { texts, card }] of runs) {
    const last = texts.at(-1);
    const parts = texts.flatMap((message) => message.data.parts ?? []);
    const steps = parts.filter((part) => part.type === 'step');
    const newest = last !== undefined && latest.get(last.authorId) === last.id;
    const asking = last !== undefined && newest && asks(last);
    if (!steps.length && !card && !asking) continue;
    const live = texts.some((message) => message.status === 'streaming');
    const running = live || card?.data.status === 'running';
    const failed = last?.status === 'failed' || card?.data.status === 'failed';
    const stopped = Boolean(last?.data.stopped) || card?.data.status === 'stopped';
    const column: TaskColumn = running
      ? 'doing'
      : asking || (newest && (failed || stopped))
        ? 'review'
        : 'done';
    const todos = texts.findLast((message) => message.data.todos?.length)?.data.todos;
    const doing = steps.findLast((step) => step.status === 'running');
    const files = card?.data.files ?? [];
    const did = `做了 ${steps.length} 步${files.length ? `，交了 ${files.length} 个文件` : ''}`;
    tasks.push({
      runId,
      key: (last ?? card)!.authorId,
      title: card?.data.title ?? texts.find((message) => message.data.title)?.data.title ?? '任务',
      column,
      note: running
        ? (doing?.label ?? '正在想…')
        : failed
          ? `出错了${column === 'review' ? '，可以让它继续' : ''}`
          : stopped
            ? `停下了${column === 'review' ? '，可以让它继续' : ''}`
            : asking
              ? '在等人回答它的问题'
              : did,
      ...(running && todos?.length
        ? {
            percent: Math.round(
              (todos.filter((todo) => todo.status === 'done').length / todos.length) * 100,
            ),
          }
        : {}),
      parts,
      ...(todos ? { todos } : {}),
      files,
      spentMicro:
        card?.data.spentMicro ?? texts.reduce((sum, m) => sum + (m.data.spentMicro ?? 0), 0),
      startedAt: card?.data.startedAt ?? texts[0]?.createdAt ?? card!.createdAt,
      finishedAt: running ? null : (card?.data.finishedAt ?? null),
      live: Boolean(running),
    });
  }
  return tasks.reverse();
}

/** 任务有没有变的记号：有任务开始、结束、换了状态，工作台就重新读一遍 */
export const workMark = (messages: GroupMessage[]) =>
  messages
    .filter((message) => message.role === 'assistant' && message.kind !== 'topic')
    .map((message) =>
      message.kind === 'task'
        ? `${message.id}:${message.data.status}`
        : message.status === 'streaming'
          ? `${message.id}:live`
          : '',
    )
    .filter(Boolean)
    .join(',');
