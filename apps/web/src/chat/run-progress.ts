// 一轮的进度页用的：从私聊的消息里挑出这一轮的，算出任务名、整体状态、正在做的一步、待办，
// 成果（按类型分框：做好的文件，还在做、没做出来的长任务）和过程（AI 每说一句话是一段，带着那段做的步骤）。
// 进度以真实发生的步骤为准（步骤由 harness 的事件写成，一轮结束时没做完的步骤也收了尾）。用户的话不放进来。
import type {
  MessageBody,
  MessageList,
  StepPart,
  TaskCard,
  TodoItem,
} from '@oasis/contracts/conversation';
import { GENERATION_TOOLS } from '@oasis/contracts/model-gateway';
import { previewKindOf } from './files.ts';

type TextMessage = Extract<MessageBody, { kind: 'text' }>;

/** 进度页上单独成卡的长任务：生图、视频、音乐这类，和等它们的结果 */
const LONG_TOOLS = new Set([...GENERATION_TOOLS, 'wait']);
/** 通常不到这么多秒就做完的生成（如配音）不单独成卡：做出的文件直接放进成果 */
const QUICK_SECONDS = 20;
/** 素材放在 out/素材/ 下（成品直接放 out/） */
export const MATERIALS = '素材/';

interface RunFile {
  /** 工作目录里的路径（out/…） */
  path: string;
  /** 做出它的那一步结束的时间（同一路径重新生成时换新的预览） */
  version: string;
}

/** 一张长任务卡：一次生成（一步），或交上去后在供应商那边做、之后才等到的一个任务号 */
export interface LongTask {
  key: string;
  label: string;
  status: StepPart['status'];
  oasisTool?: string;
  startedAt?: string;
  finishedAt?: string;
  expectSeconds?: number;
  detail?: string;
  files: RunFile[];
}

/** 成果按类型分框 */
export type OutputKind = 'image' | 'video' | 'audio' | 'doc' | 'other';
export const OUTPUT_BOXES: [OutputKind, string][] = [
  ['image', '图片'],
  ['video', '视频'],
  ['audio', '声音'],
  ['doc', '文档'],
  ['other', '其他'],
];

/**
 * 一个成果：做好的文件（登记进画布了的用画布里的，还没登记的从这一轮的工作目录读），
 * 或还在做、没做出来的长任务
 */
export interface OutputItem {
  key: string;
  kind: OutputKind;
  /** 文件在 out/ 里的路径（长任务没有） */
  path?: string;
  artifactId?: string;
  live?: RunFile;
  size?: number;
  /** 放在 out/素材/ 里的 */
  material: boolean;
  task?: LongTask;
}

/** 过程里的一段：AI 说的一句话（开头就动手、没说话的是空的），和接着做的步骤、系统提示 */
export interface Stage {
  key: string;
  text: string;
  steps: StepPart[];
  notices: string[];
  status: StepPart['status'];
  startedAt?: string;
  finishedAt?: string;
}

export interface RunProgress {
  /** 这一轮在不在（消息里有它的 AI 消息或任务卡） */
  found: boolean;
  title: string;
  card: TaskCard | undefined;
  status: TaskCard['status'];
  startedAt: string | undefined;
  finishedAt: string | undefined;
  spentMicro: number;
  /** 正在做的一步（一轮在做时） */
  current: StepPart | undefined;
  todos: TodoItem[];
  outputs: OutputItem[];
  stages: Stage[];
  /** 这一轮出错时的说明 */
  error: string | undefined;
}

/** 隐藏的文件（如 oasis-tool 的恢复记录）不算做出的东西 */
const hidden = (path: string) => path.split('/').some((part) => part.startsWith('.'));

const KIND_OF_TOOL: Record<string, OutputKind> = {
  'image.generate': 'image',
  'video.generate': 'video',
  'audio.speech': 'audio',
  'audio.music': 'audio',
  'text.batch': 'doc',
};

function kindOf(path: string): OutputKind {
  const kind = previewKindOf(path);
  if (kind === 'image' || kind === 'video' || kind === 'audio') return kind;
  if (kind === 'pdf' || kind === 'document' || kind === 'presentation') return 'doc';
  return /\.(md|txt)$/i.test(path) ? 'doc' : 'other';
}

/**
 * 长任务卡：生图这类一步做完的，一步一张（通常几秒就好的配音这类不算）；视频、音乐交上去没等到的
 * （--wait false，或等到上限还没好），一个任务号一张，之后哪一步等到了（等的命令，或放到后台后看它
 * 输出的那一步）按任务号写回结局和文件。只说到这些任务号的步骤、等它们的那一步不另成卡；等的是这一轮
 * 看不到的任务时，等的那一步自己成卡。一轮结束时还没等到的，说没等到。
 */
function longTasksOf(steps: StepPart[], live: boolean): LongTask[] {
  const cards: LongTask[] = [];
  const byJob = new Map<string, LongTask>();
  const fileOf = (step: StepPart) => (path: string) => ({ path, version: step.finishedAt ?? '' });
  for (const step of steps) {
    const jobs = step.jobs ?? [];
    for (const job of jobs) {
      const card = byJob.get(job.id);
      if (!card || (job.state !== 'done' && job.state !== 'failed')) continue;
      card.status = job.state;
      card.finishedAt = step.finishedAt;
      card.files = (job.files ?? []).map(fileOf(step));
      if (job.state === 'failed') card.detail = step.detail ?? '没做出来';
    }
    if (!step.oasisTool || !LONG_TOOLS.has(step.oasisTool)) continue;
    if (!jobs.length && (step.expectSeconds ?? Infinity) < QUICK_SECONDS) continue;
    const handed = jobs.filter(
      (j) => !byJob.has(j.id) && (j.state === 'submitted' || j.state === 'waiting'),
    );
    const onlyKnown = jobs.length > 0 && jobs.every((j) => byJob.has(j.id));
    if (onlyKnown || (step.oasisTool === 'wait' && !jobs.length && byJob.size)) continue;
    const base = {
      oasisTool: step.oasisTool,
      ...(step.startedAt ? { startedAt: step.startedAt } : {}),
      ...(step.expectSeconds ? { expectSeconds: step.expectSeconds } : {}),
    };
    if (handed.length) {
      for (const [index, job] of handed.entries()) {
        const card: LongTask = {
          key: job.id,
          label: handed.length > 1 ? `${step.label}（${index + 1}/${handed.length}）` : step.label,
          status: 'running',
          ...base,
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
      ...base,
      ...(step.finishedAt ? { finishedAt: step.finishedAt } : {}),
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

/**
 * 成果：登记进画布的文件（结束后只看它们，一直留着），一轮在做时加上做完的步骤存进 out/ 的、还没登记的；
 * 还在做、没做出来的长任务按工具放进对应的框
 */
function outputsOf(steps: StepPart[], card: TaskCard | undefined, running: boolean): OutputItem[] {
  const items = new Map<string, OutputItem>();
  const file = (path: string, extra: Partial<OutputItem>): OutputItem => ({
    key: path,
    kind: kindOf(path),
    path,
    material: path.startsWith(MATERIALS),
    ...extra,
  });
  for (const registered of card?.files ?? [])
    items.set(
      registered.path,
      file(registered.path, { artifactId: registered.artifactId, size: registered.size }),
    );
  if (running)
    for (const step of steps) {
      if (step.status === 'running') continue;
      for (const path of step.files ?? []) {
        if (!path.startsWith('out/') || hidden(path)) continue;
        const relative = path.slice('out/'.length);
        const known = items.get(relative);
        const live = { path, version: step.finishedAt ?? '' };
        if (!known) items.set(relative, file(relative, { live }));
        else if (!known.artifactId) known.live = live;
      }
    }
  const tasks = longTasksOf(steps, running)
    .filter((task) => task.status !== 'done')
    .map((task): OutputItem => ({
      key: task.key,
      kind: KIND_OF_TOOL[task.oasisTool ?? ''] ?? 'other',
      material: false,
      task,
    }));
  return [...items.values(), ...tasks];
}

/** 过程：AI 每说一句话开始一段，之后做的步骤、系统提示归到这一段；一轮在做时最后一段算在做 */
function stagesOf(ai: TextMessage[], running: boolean): Stage[] {
  const stages: Stage[] = [];
  const open = (key: string, text: string) => {
    const stage: Stage = { key, text, steps: [], notices: [], status: 'done' };
    stages.push(stage);
    return stage;
  };
  let current: Stage | undefined;
  for (const message of ai)
    for (const [index, part] of (message.data.parts ?? []).entries()) {
      if (part.type === 'text') {
        current = open(`${message.id}-${index}`, part.text);
        continue;
      }
      current ??= open(`${message.id}-${index}`, '');
      if (part.type === 'step') current.steps.push(part);
      else current.notices.push(part.text);
    }
  for (const stage of stages) {
    const steps = stage.steps;
    stage.status = steps.some((s) => s.status === 'running')
      ? 'running'
      : steps.some((s) => s.status === 'failed')
        ? 'failed'
        : 'done';
    stage.startedAt = steps.find((s) => s.startedAt)?.startedAt;
    stage.finishedAt = steps.findLast((s) => s.finishedAt)?.finishedAt;
  }
  if (running && stages.length) stages.at(-1)!.status = 'running';
  return stages;
}

/** 没有任务卡上的任务名时：这一轮开头那句话的第一行 */
function titleOf(opening: TextMessage | undefined): string {
  const line = opening?.content.trim().split('\n')[0]?.trim() ?? '';
  if (!line) return '这一轮';
  return line.length > 30 ? `${line.slice(0, 30)}…` : line;
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
  const running = status === 'running';
  const steps = ai.flatMap((m) =>
    (m.data.parts ?? []).filter((part): part is StepPart => part.type === 'step'),
  );
  return {
    found: ai.length > 0 || !!card,
    title: card?.title ?? titleOf(messages.find((m) => m.role === 'user' && !m.data.interjection)),
    card,
    status,
    startedAt: card?.startedAt ?? (live ? list?.turn?.startedAt : messages[0]?.createdAt),
    finishedAt:
      card?.finishedAt ?? (running ? undefined : steps.findLast((s) => s.finishedAt)?.finishedAt),
    spentMicro:
      card?.spentMicro ?? ai.findLast((m) => m.data.spentMicro !== undefined)?.data.spentMicro ?? 0,
    current: running ? steps.findLast((s) => s.status === 'running') : undefined,
    todos: ai.findLast((m) => m.data.todos?.length)?.data.todos ?? [],
    outputs: outputsOf(steps, card, running),
    stages: stagesOf(ai, running),
    error: last?.status === 'failed' ? (last.error ?? '这一轮出错了') : undefined,
  };
}
