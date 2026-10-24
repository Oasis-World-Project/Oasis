// 节点的状态怎么显示、现在能做什么（和 task 的规则一致，见 ADR 0004 §3–4），以及运行记录怎么写成普通话。
import type { RunEventBody } from '@oasis/contracts/harness';
import type { NodeBody, NodeRunBody, NodeStatus, TaskBody } from '@oasis/contracts/task';

export type Tone = 'done' | 'active' | 'trouble' | 'idle';

export const NODE_STATUS: Record<NodeStatus, { label: string; tone: Tone }> = {
  draft: { label: '新建，还没运行', tone: 'idle' },
  waiting: { label: '等上游', tone: 'idle' },
  running: { label: '进行中', tone: 'active' },
  checking: { label: '检查中', tone: 'active' },
  succeeded: { label: '完成', tone: 'done' },
  failed: { label: '失败', tone: 'trouble' },
  stopped: { label: '已停止', tone: 'idle' },
  blocked: { label: '连线断开', tone: 'trouble' },
  cancelled: { label: '已取消', tone: 'idle' },
};

/** 还没开始的节点：可以改、删、往里接线 */
const NOT_STARTED: NodeStatus[] = ['draft', 'waiting', 'blocked'];
const ACTIVE: NodeStatus[] = ['running', 'checking'];
/** 任务这几个状态下工作流不能动 */
const FROZEN: TaskBody['status'][] = ['planning', 'accepting', 'succeeded', 'failed', 'cancelled'];

export const canEditWorkflow = (task: TaskBody) => !FROZEN.includes(task.status);

/** 单独运行要求上游都已完成（停止后继续除外），和 task 的 runNode 一致 */
function upstreamReady(task: TaskBody, node: NodeBody): boolean {
  if (node.status === 'stopped') return true;
  return task.edges
    .filter((e) => e.to === node.id)
    .every((e) => task.nodes.find((n) => n.id === e.from)?.status === 'succeeded');
}

export function nodeActions(task: TaskBody, node: NodeBody) {
  const open = canEditWorkflow(task);
  const notStarted = NOT_STARTED.includes(node.status);
  return {
    edit: open && notStarted,
    remove: open && notStarted,
    run:
      open &&
      ['draft', 'waiting', 'stopped', 'failed'].includes(node.status) &&
      upstreamReady(task, node),
    stop: open && ACTIVE.includes(node.status),
    /** 能往这个节点里接线 */
    acceptsInput: open && notStarted,
    /** 能从这个节点往外接线 */
    givesOutput: open && node.status !== 'cancelled',
    /** 追问（运行中的干活节点直接送达）或补要求（开跑、继续时带上） */
    message:
      open &&
      (['draft', 'waiting', 'blocked', 'stopped'].includes(node.status) ||
        node.status === 'running'),
  };
}

/** 一次运行叫什么 */
export function runLabel(run: NodeRunBody): string {
  if (run.purpose === 'speech') return `第 ${run.round ?? 1} 轮 · ${run.participant ?? '发言'}`;
  if (run.purpose === 'summary') return '汇总结论';
  if (run.purpose === 'rework') return '关卡没过，接着改';
  if (run.continued) return '停止后继续';
  return run.attempt > 1 ? `第 ${run.attempt} 次（重做）` : '第 1 次';
}

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

/** 一次工具调用写成一步：用了外部工具（oasis-tool）的单独标出来 */
function describeCall(data: Record<string, unknown>): Extract<Step, { kind: 'did' }> {
  const name = text(data.name);
  const args = parseArgs(data.arguments);
  const command = text(args.command) || text(args.cmd) || text(args.script);
  const tool = /oasis-tool\s+(?:wait\s+)?([a-z0-9]+(?:\.[a-z0-9_-]+)+)/.exec(command)?.[1];
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
