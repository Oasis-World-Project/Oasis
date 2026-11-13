// 节点的状态怎么显示、现在能做什么（和 task 的规则一致），运行记录怎么写成普通话，
// 以及一样成果做到哪了（AI 自己列的任务清单）。
import type { RunEventBody } from '@oasis/contracts/harness';
import type {
  NodeBody,
  NodeRunBody,
  NodeStatus,
  RevisionChange,
  TaskBody,
  TaskStatus,
} from '@oasis/contracts/task';

const TASK_STATUS: Record<TaskStatus, { label: string; tone: 'muted' | 'accent' | 'solid' }> = {
  planning: { label: '正在搭建工作流', tone: 'muted' },
  running: { label: '进行中', tone: 'muted' },
  accepting: { label: '正在验收', tone: 'muted' },
  stopped: { label: '已停止', tone: 'muted' },
  needs_attention: { label: '需要你处理', tone: 'accent' },
  succeeded: { label: '已完成', tone: 'solid' },
  failed: { label: '没能完成', tone: 'accent' },
  cancelled: { label: '已取消', tone: 'muted' },
};

type Tone = 'done' | 'active' | 'trouble' | 'idle';

const NODE_STATUS: Record<NodeStatus, { label: string; tone: Tone }> = {
  waiting: { label: '等上游', tone: 'idle' },
  running: { label: '进行中', tone: 'active' },
  checking: { label: '检查中', tone: 'active' },
  succeeded: { label: '完成', tone: 'done' },
  failed: { label: '失败', tone: 'trouble' },
  stopped: { label: '已停止', tone: 'idle' },
  cancelled: { label: '已取消', tone: 'idle' },
};

/** 节点状态给人看的说法和色调 */
export const nodeState = (node: NodeBody) => NODE_STATUS[node.status];

/** 只依据真实连线与节点状态解释等待，不把所有下游都说成检查失败。 */
export function waitingOn(task: TaskBody, node: NodeBody): { id: string | null; title: string }[] {
  return task.edges
    .filter((e) => e.to === node.id)
    .flatMap((e) => {
      const upstream = task.nodes.find((n) => n.id === e.from);
      return upstream?.status === 'succeeded'
        ? []
        : [{ id: upstream?.id ?? null, title: upstream?.title ?? '缺失的上游节点' }];
    });
}

const ACTIVE: NodeStatus[] = ['running', 'checking'];
/** 任务这几个状态下工作流不能操作 */
const FROZEN: TaskBody['status'][] = ['planning', 'accepting', 'succeeded', 'failed', 'cancelled'];

/** 能不能停止、继续、发话；修改方案在排、等确认时也不能（方案按现在的节点排） */
export const canOperate = (task: TaskBody) => !FROZEN.includes(task.status) && !task.revision;

/** 任务状态的叫法：修改时规划员在排方案叫「正在规划修改」，等确认叫「修改方案待确认」 */
export function taskStatusOf(
  task: Pick<TaskBody, 'status' | 'revising'> & { revision?: TaskBody['revision'] },
) {
  if (task.revising && task.status === 'planning')
    return { label: '正在规划修改', tone: 'muted' as const };
  if (task.revision?.stage === 'confirm')
    return { label: '修改方案待确认', tone: 'accent' as const };
  return TASK_STATUS[task.status];
}

/** 修改方案里每个节点怎么处理 */
export const REVISION_CHANGE: Record<RevisionChange, string> = {
  reuse: '沿用',
  continue: '接着改',
  fresh: '重新做',
  new: '新增',
  remove: '删除',
};

/** 失败的再试要求上游都已完成（停止后继续不用），和 task 的 runNode 一致 */
function upstreamReady(task: TaskBody, node: NodeBody): boolean {
  if (node.status === 'stopped') return true;
  return task.edges
    .filter((e) => e.to === node.id)
    .every((e) => task.nodes.find((n) => n.id === e.from)?.status === 'succeeded');
}

/** 展开节点、做几版的节点：自己不跑，开子节点去做 */
const isGroup = (node: NodeBody) => node.kind === 'foreach' || (node.variants?.n ?? 0) > 1;

/** 一个 AI 从头做到交付的成果：不在生产线里、自己干活的节点 */
export const isAgentOutcome = (node: NodeBody) =>
  node.kind === 'work' && !node.parentId && !node.line && !isGroup(node);

/** 某个节点的子节点（展开出来的条目、各版），按顺序 */
export const childrenOf = (task: TaskBody, node: NodeBody) =>
  task.nodes.filter((n) => n.parentId === node.id).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));

/** 一样成果现在能做什么：停止、继续、发话。节点和连线不能改 */
export function nodeActions(task: TaskBody, node: NodeBody) {
  const open = canOperate(task);
  // 子节点跟着父节点：父节点在跑时可以单独再跑它
  const parent = node.parentId ? task.nodes.find((n) => n.id === node.parentId) : undefined;
  return {
    /** 停下的继续、失败的再试 */
    run:
      open &&
      ['stopped', 'failed'].includes(node.status) &&
      (node.parentId ? parent?.status === 'running' : upstreamReady(task, node)),
    stop: open && ACTIVE.includes(node.status),
    /** 追问（运行中的干活节点直接送达）或补要求（开跑、继续时带上）；工具节点没有 AI，不收 */
    message:
      open &&
      node.kind !== 'tool' &&
      !isGroup(node) &&
      ['waiting', 'stopped', 'running'].includes(node.status),
  };
}

/** 工具节点一步的参数写成一行给人看：名字=值，太长的截断 */
export function stepArgs(step: { args: Record<string, unknown> }): string {
  const parts = Object.entries(step.args).map(([name, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return `${name}=${text.length > 60 ? `${text.slice(0, 60)}…` : text}`;
  });
  return parts.join('，') || '（没有参数）';
}

/** 一次运行叫什么 */
export function runLabel(run: NodeRunBody): string {
  if (run.purpose === 'speech') return `第 ${run.round ?? 1} 轮 · ${run.participant ?? '发言'}`;
  if (run.purpose === 'summary') return '汇总结论';
  if (run.purpose === 'pick') return '挑一版';
  if (run.purpose === 'adjust') return '提出调整，规划员答复';
  if (run.purpose === 'rework') return '关卡没过，接着改';
  if (run.continued) return '停止后继续';
  return run.attempt > 1 ? `第 ${run.attempt} 次（重做）` : '第 1 次';
}

/** 这次运行还在动 */
export const isLiveRun = (run: NodeRunBody) => run.status === 'pending' || run.status === 'running';

export const RUN_STATUS: Record<NodeRunBody['status'], string> = {
  pending: '准备中',
  running: '进行中',
  succeeded: '完成',
  failed: '失败',
  cancelled: '已取消',
  stopped: '已停止',
};

export type Step =
  | { kind: 'said'; text: string }
  | { kind: 'you'; text: string }
  | { kind: 'did'; text: string; detail?: string; tool?: string; failed?: boolean }
  | { kind: 'error'; text: string };

/** dsh 自带的几个动作 → 普通话 */
const ACTIONS: Record<string, string> = {
  write: '写文件',
  edit: '改文件',
  read: '读文件',
  ls: '看目录',
  glob: '找文件',
  grep: '搜内容',
  bash: '运行命令',
  shell: '运行命令',
  exec: '运行命令',
  todo_write: '更新任务清单',
  read_image: '看图片',
};

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/**
 * 一次工具调用写成一步：用了外部工具（oasis-tool）或沙箱里的本地操作（oasis-op，工具目录里叫 op.*）的
 * 单独标出来
 */
function describeCall(data: Record<string, unknown>): Extract<Step, { kind: 'did' }> {
  const name = text(data.name);
  const args = parseArgs(data.arguments);
  const command = text(args.command) || text(args.cmd) || text(args.script);
  const match = /oasis-(tool|op)\s+(?:wait\s+)?([a-z0-9]+(?:\.[a-z0-9_-]+)+)/.exec(command);
  const tool = match ? (match[1] === 'op' ? `op.${match[2]}` : match[2]) : undefined;
  if (tool) return { kind: 'did', text: '调用工具', tool, detail: command };
  const path = text(args.path) || text(args.file_path) || text(args.filePath);
  return {
    kind: 'did',
    text: ACTIONS[name] ?? `用了 ${name || '工具'}`,
    detail: path || command || undefined,
  };
}

/** 运行过程 → 一步一步：AI 说了什么、做了什么、你说了什么、出了什么错 */
export function stepsOf(events: RunEventBody[]): Step[] {
  const steps: Step[] = [];
  const calls = new Map<string, Extract<Step, { kind: 'did' }>>();
  for (const event of events) {
    const data = event.data;
    if (event.kind === 'assistant_text') steps.push({ kind: 'said', text: text(data.text) });
    else if (event.kind === 'user_message') steps.push({ kind: 'you', text: text(data.text) });
    else if (event.kind === 'error')
      steps.push({ kind: 'error', text: text(data.message) || '出错了' });
    else if (event.kind === 'tool_call') {
      const step = describeCall(data);
      calls.set(text(data.callId), step);
      steps.push(step);
    } else if (event.kind === 'tool_result' && data.ok === false) {
      const call = calls.get(text(data.callId));
      if (call) call.failed = true;
    }
  }
  return steps;
}

interface Todo {
  text: string;
  state: 'done' | 'doing' | 'todo';
}

/** 一样成果做到哪了：AI 自己列的任务清单（没列过为 null）和最近几步 */
export interface Progress {
  todos: Todo[] | null;
  recent: Step[];
}

const TODO_STATE: Record<string, Todo['state']> = { completed: 'done', in_progress: 'doing' };

/** AI 自己列的任务清单（dsh 的 todo_write，每次整份重写）：取这次运行里最后一次列的 */
function todosOf(events: RunEventBody[]): Todo[] | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const { kind, data } = events[i]!;
    if (kind !== 'tool_call' || data.name !== 'todo_write') continue;
    const list = parseArgs(data.arguments).todos;
    if (!Array.isArray(list)) continue;
    return list.flatMap((item: unknown) => {
      const todo = (item ?? {}) as { content?: unknown; status?: unknown };
      const content = text(todo.content);
      return content ? [{ text: content, state: TODO_STATE[text(todo.status)] ?? 'todo' }] : [];
    });
  }
  return null;
}

/** runs：这样成果各次运行的事件，按先后。清单往回找最后一次列的；最近几步只看最后一次运行 */
export function progressOf(runs: RunEventBody[][]): Progress {
  let todos: Todo[] | null = null;
  for (let i = runs.length - 1; i >= 0 && !todos; i -= 1) todos = todosOf(runs[i]!);
  const recent = stepsOf(runs.at(-1) ?? []).filter((s) => s.kind === 'said' || s.kind === 'did');
  return { todos, recent: recent.slice(-3) };
}

export interface FrameRow {
  mark: Todo['state'] | 'note' | 'adjust';
  text: string;
}

/** 中途调整写成一句：规划员还在答复时是「正在调整」，之后是改了什么 */
export const adjustText = (node: NodeBody) =>
  node.adjust ? `${node.adjust.asking ? '正在调整' : '调整'}：${node.adjust.note}` : null;

/** 清单太长时框里只显示这么多项，完整的在详情里 */
const FRAME_TODOS = 10;

/** 框里显示的几行：有清单显示清单（太长只显示正在做的那一段，末行写总数），没有就显示最近几步 */
export function frameRows(
  progress: Progress | undefined,
  toolName: (key: string) => string,
): FrameRow[] {
  const todos = progress?.todos ?? [];
  if (todos.length > 0) {
    const rows = todos.map((t): FrameRow => ({ mark: t.state, text: t.text }));
    if (rows.length <= FRAME_TODOS) return rows;
    const current = Math.max(
      0,
      todos.findIndex((t) => t.state !== 'done'),
    );
    const start = Math.min(Math.max(0, current - 2), rows.length - FRAME_TODOS);
    const done = todos.filter((t) => t.state === 'done').length;
    return [
      ...rows.slice(start, start + FRAME_TODOS),
      { mark: 'note', text: `共 ${rows.length} 项，完成了 ${done} 项` },
    ];
  }
  return (progress?.recent ?? []).map((step) => ({
    mark: 'note',
    text:
      step.kind === 'did'
        ? step.tool
          ? `调用工具「${toolName(step.tool)}」`
          : [step.text, step.detail].filter(Boolean).join(' ')
        : step.text,
  }));
}
