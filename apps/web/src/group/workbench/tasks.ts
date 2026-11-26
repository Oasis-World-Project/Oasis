// 工作台「任务」页签上的任务，四栏：待开始、进行中、已完成、修改中。
// 群里 AI 动过手（有步骤）、交过文件，或在等人回答的每一轮是一条；让 AI 改一个任务的成果，那几轮算在同一条上
// （改的时候在「修改中」，改完回「已完成」）；分工单里还没开工的每一项也是一条（在「待开始」）。
// 从群消息里拼出来：AI 的话（带步骤、待办）和它的任务卡（任务名、花费、交的文件、做过的每一轮）。
import type { AssignItem, MessagePart, TaskFile, TodoItem } from '@oasis/contracts/conversation';
import type { GroupMessage } from '@oasis/contracts/group';
import { splitBlocks } from '../../chat/blocks.ts';

export type TaskColumn = 'wait' | 'doing' | 'done' | 'fixing';
export const TASK_COLUMNS: { id: TaskColumn; title: string }[] = [
  { id: 'wait', title: '待开始' },
  { id: 'doing', title: '进行中' },
  { id: 'done', title: '已完成' },
  { id: 'fixing', title: '修改中' },
];

export interface RoomTask {
  runId: string;
  /** 做它的那份会话（云端任务的、席位的）：让它继续、让它改时点名交给它；私聊家里做的没有 */
  seat?: string;
  /** 哪个 AI 的 */
  key: string;
  title: string;
  column: TaskColumn;
  /** 那句说明：正在做哪一步、在等什么、做了几步 */
  note: string;
  /** 在等人：回答它的问题、点确认卡（这一条上亮一个红点） */
  asking?: boolean;
  /** 出错或停下了，还能让它继续 */
  resumable?: boolean;
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
  /** 这张卡是分工单里的一项：哪份单子、哪一项、单子关上没有、谁发的、谁引来的（他们和群主能改） */
  plan?: { messageId: string; item: AssignItem; open: boolean; lead: string; callers: string[] };
}

type Text = Extract<GroupMessage, { kind: 'text' }>;
type Card = Extract<GroupMessage, { kind: 'task' }>;
type Assign = Extract<GroupMessage, { kind: 'assign' }>;

/** 分工单里的一项现在到哪了，写成一句话 */
export function itemNote(item: AssignItem): string {
  const why = item.note ? `：${item.note}` : '';
  switch (item.status) {
    case 'waiting':
      return item.after.length ? `等第 ${item.after.join('、')} 项交了再开工` : '等它有空就开工';
    case 'running':
      return '正在做';
    case 'done':
      return '交了';
    case 'declined':
      return `没接${why}`;
    case 'failed':
      return `没做成${why}`;
    case 'stopped':
      return `停下了${why}`;
    case 'dropped':
      return '人撤掉了';
  }
}

const planOf = (message: Assign, item: AssignItem): NonNullable<RoomTask['plan']> => ({
  messageId: message.id,
  item,
  open: message.data.status === 'open',
  lead: message.authorId,
  callers: message.data.callers ?? [],
});

/** 分工单里还没有自己那一轮可看的几项（还没开工的、刚开工还没动手的、没接的）：各一张卡 */
function itemTasks(message: Assign, shown: Set<string>): RoomTask[] {
  return message.data.items
    .filter((item) => !item.runId || !shown.has(item.runId))
    .map((item) => ({
      runId: `${message.id}:${item.id}`,
      key: item.key,
      title: item.task,
      column: item.status === 'waiting' ? 'wait' : item.status === 'running' ? 'doing' : 'done',
      note: itemNote(item),
      parts: [],
      files: [],
      spentMicro: 0,
      startedAt: message.createdAt,
      finishedAt: null,
      live: item.status === 'running',
      plan: planOf(message, item),
    }));
}

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
  const cards = unique.filter((message): message is Card => message.kind === 'task');
  /** 一轮算在哪个任务上：改过的任务，它做过的每一轮都算在最近那一轮名下 */
  const taskOf = new Map(
    cards.flatMap((card) =>
      (card.data.runs ?? []).map((runId): [string, string] => [runId, card.data.runId]),
    ),
  );
  const runs = new Map<string, { texts: Text[]; card?: Card }>();
  const plans: Assign[] = [];
  /** 每个 AI 最新说的那条话：只有它上面的问卷还等着人答，只有它出错、停下了还等着人说「继续」 */
  const latest = new Map<string, string>();
  for (const message of unique) {
    if (message.role !== 'assistant') continue;
    if (message.kind === 'assign') {
      plans.push(message);
      continue;
    }
    const own = message.kind === 'topic' ? undefined : message.data.runId;
    if (!own) continue;
    const runId = taskOf.get(own) ?? own;
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
    const answering = last !== undefined && newest && asks(last);
    if (!steps.length && !card && !answering) continue;
    const live = texts.some((message) => message.status === 'streaming');
    const running = live || card?.data.status === 'running';
    const failed = last?.status === 'failed' || card?.data.status === 'failed';
    const stopped = Boolean(last?.data.stopped) || card?.data.status === 'stopped';
    // 问了人还没等到回答的，这件事还没完：留在进行中
    const column: TaskColumn =
      running || answering ? (card?.data.revision ? 'fixing' : 'doing') : 'done';
    const resumable = !running && newest && (failed || stopped);
    const asking = answering || Boolean(running && card?.data.asking);
    const todos = texts.findLast((message) => message.data.todos?.length)?.data.todos;
    const doing = steps.findLast((step) => step.status === 'running');
    const files = card?.data.files ?? [];
    const did = `做了 ${steps.length} 步${files.length ? `，交了 ${files.length} 个文件` : ''}`;
    tasks.push({
      runId,
      ...(card?.data.seat ? { seat: card.data.seat } : {}),
      key: (last ?? card)!.authorId,
      title: card?.data.title ?? texts.find((message) => message.data.title)?.data.title ?? '任务',
      column,
      note: answering
        ? '在等人回答它的问题'
        : running
          ? card?.data.asking
            ? '在等确认'
            : (doing?.label ?? '正在想…')
          : failed
            ? `出错了${resumable ? '，可以让它继续' : ''}`
            : stopped
              ? `停下了${resumable ? '，可以让它继续' : ''}`
              : did,
      ...(asking ? { asking } : {}),
      ...(resumable ? { resumable } : {}),
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
  const shown = new Set(tasks.map((task) => task.runId));
  // 已经开工、有自己那一轮的项：那一轮的卡上也记着它是分工单里的哪一项
  for (const message of plans)
    for (const item of message.data.items) {
      const task = tasks.find((found) => found.runId === item.runId);
      if (task) task.plan = planOf(message, item);
    }
  return [...tasks, ...plans.flatMap((plan) => itemTasks(plan, shown))].reverse();
}

/** 任务有没有变的记号：有任务开始、结束、换了状态，工作台就重新读一遍 */
export const workMark = (messages: GroupMessage[]) =>
  messages
    .filter((message) => message.role === 'assistant' && message.kind !== 'topic')
    .map((message) =>
      message.kind === 'assign'
        ? `${message.id}:${message.data.status}:${message.data.items.map((item) => `${item.status}${item.key}${item.task.length}`).join('')}`
        : message.kind === 'task'
          ? `${message.id}:${message.data.status}:${message.data.runId}:${message.data.asking ?? ''}`
          : message.status === 'streaming'
            ? `${message.id}:live`
            : '',
    )
    .filter(Boolean)
    .join(',');
