// 节点的下一步要开哪些运行（纯函数）：
// - 干活节点：持续目标；失败优先恢复原会话；关卡未过在原会话修复一轮（不用持续目标，ADR 0017）。
// - 讨论节点：第一轮每位参与者各说一次（并行）→ 之后每轮每人接着自己的会话回应上一轮别人的发言
//   → 最后汇总者写结论（之后和干活节点一样过关卡）。
// - 停止后继续：干活节点接着停下的那次运行的会话；讨论节点把这一步没说完的重新说。
import type { NodeConfig, NodeRunPurpose, RunMeta } from '../repo/schema.ts';
import type { Node, NodeRun, Snapshot } from '../repo/task-store.ts';
import {
  resumePrompt,
  reworkPrompt,
  revisionPrompt,
  speechPrompt,
  summaryPrompt,
  workPrompt,
  PREVIOUS_DIR,
  type NodeContext,
  type Speech,
} from './prompt.ts';
import { materialPaths } from './materials.ts';
import { incoming } from './schedule.ts';

interface RunRequest {
  goal?: boolean;
  purpose: NodeRunPurpose;
  model: string;
  prompt: string;
  inputsFrom: { runId: string; as: string }[];
  /** 接着哪次运行的会话和工作区 */
  continueFrom?: string;
  meta: RunMeta;
}

/** 开这些运行时节点配置要跟着改的地方（讨论的轮次、已交出去的追加要求） */
export interface Step {
  requests: RunRequest[];
  config?: NodeConfig;
}

function upstreamOf(snapshot: Snapshot, node: Node): Node[] {
  return incoming(node, snapshot.edges)
    .map((e) => snapshot.nodes.find((n) => n.id === e.fromNodeId))
    .filter((n): n is Node => n !== undefined);
}

function contextOf(snapshot: Snapshot, node: Node): NodeContext {
  return {
    brief: snapshot.task.brief,
    ...(snapshot.task.sheet ? { sheet: snapshot.task.sheet } : {}),
    title: node.title,
    role: node.role,
    goal: node.goal,
    upstream: upstreamOf(snapshot, node).map((u) => ({
      key: u.key,
      title: u.title,
      summary: u.summary,
      outputs: u.outputs,
    })),
    userNotes: node.userNotes,
    tools: (node.config.tools ?? []).map((t) => t.key),
    materials: materialPaths(snapshot.task.materials).map((m) => m.path),
    ...(node.config.deliver === undefined ? {} : { deliver: node.config.deliver }),
    checks: (node.config.checks ?? []).map((c) => (typeof c === 'string' ? c : c.text)),
    ...(node.config.previousRunId ? { previous: true } : {}),
    budget: {
      ...(node.config.budgetMicro ? { nodeMicro: node.config.budgetMicro } : {}),
      ...(snapshot.task.sheet?.budget
        ? {
            taskMicro: snapshot.task.sheet.budget.micro,
            taskMinutes: snapshot.task.sheet.budget.minutes,
          }
        : {}),
      spentMicro: snapshot.task.spentMicro,
      elapsedMinutes: Math.max(
        0,
        Math.round((Date.now() - snapshot.task.createdAt.getTime()) / 60_000),
      ),
    },
  };
}

/**
 * 上游节点交出的产出（交出它们的那次运行），放进 in/<上游节点名>/；没有产出的上游不放。
 * 修改时重新做的节点再带上上一版自己交出的文件（in/_previous/，ADR 0022）。
 */
const inputsOf = (snapshot: Snapshot, node: Node) => [
  ...upstreamOf(snapshot, node)
    .filter((u) => u.config.outputsRunId && u.outputs.length > 0)
    .map((u) => ({ runId: u.config.outputsRunId as string, as: u.key })),
  ...(node.config.previousRunId ? [{ runId: node.config.previousRunId, as: PREVIOUS_DIR }] : []),
];

const speechesOf = (config: NodeConfig): Speech[] =>
  (config.transcript ?? []).map(({ round, name, text }) => ({ round, name, text }));

/** 某位参与者某一轮的发言 */
function speech(snapshot: Snapshot, node: Node, name: string, round: number): RunRequest {
  const config = node.config;
  const participant = (config.participants ?? []).find((p) => p.name === name);
  if (!participant) throw new Error(`讨论里没有参与者「${name}」`);
  const rounds = config.rounds ?? 1;
  const transcript = config.transcript ?? [];
  const previous = transcript.filter((t) => t.name === name && t.round === round - 1).at(-1);
  const others = speechesOf(config).filter((s) => s.round === round - 1 && s.name !== name);
  return {
    purpose: 'speech',
    model: participant.model,
    prompt: speechPrompt({
      context: contextOf(snapshot, node),
      name,
      stance: participant.stance,
      round,
      rounds,
      others,
      newNotes: node.userNotes.slice(config.notesSeen ?? 0),
    }),
    inputsFrom: round === 1 ? inputsOf(snapshot, node) : [],
    ...(round > 1 && previous ? { continueFrom: previous.runId } : {}),
    meta: { round, participant: name },
  };
}

function summary(snapshot: Snapshot, node: Node): RunRequest {
  return {
    purpose: 'summary',
    goal: true,
    model: node.model,
    prompt: summaryPrompt({
      context: contextOf(snapshot, node),
      transcript: speechesOf(node.config),
    }),
    inputsFrom: inputsOf(snapshot, node),
    meta: {},
  };
}

/** 一轮发言：每位参与者各一次 */
function round(snapshot: Snapshot, node: Node, n: number): Step {
  const requests = (node.config.participants ?? []).map((p) => speech(snapshot, node, p.name, n));
  return { requests, config: { ...node.config, round: n, notesSeen: node.userNotes.length } };
}

/** 节点开跑 */
export function firstStep(snapshot: Snapshot, node: Node): Step {
  if (node.kind === 'discussion') return round(snapshot, node, 1);
  return {
    requests: [
      {
        purpose: 'work',
        goal: true,
        model: node.model,
        prompt: workPrompt(contextOf(snapshot, node)),
        inputsFrom: inputsOf(snapshot, node),
        meta: {},
      },
    ],
    config: { ...node.config, notesSeen: node.userNotes.length },
  };
}

/** 停止后继续 */
export function resumeStep(snapshot: Snapshot, node: Node, interrupted = false): Step {
  const config = node.config;
  if (node.kind === 'discussion') {
    const current = config.round ?? 0;
    if (current === 0) return firstStep(snapshot, node);
    const spoke = new Set(
      (config.transcript ?? []).filter((t) => t.round === current).map((t) => t.name),
    );
    const missing = (config.participants ?? []).filter((p) => !spoke.has(p.name));
    if (missing.length === 0) return afterRound(snapshot, node);
    return { requests: missing.map((p) => speech(snapshot, node, p.name, current)) };
  }
  // 还没真正跑起来就停了（没有运行）：从头做
  if (!node.currentRunId) return firstStep(snapshot, node);
  return {
    requests: [
      {
        purpose: 'work',
        goal: true,
        model: node.model,
        prompt: resumePrompt(node.userNotes.slice(config.notesSeen ?? 0), interrupted),
        inputsFrom: [],
        continueFrom: node.currentRunId,
        meta: {},
      },
    ],
    config: { ...config, notesSeen: node.userNotes.length },
  };
}

/** 讨论的一轮发言都结束了：下一轮，或者汇总 */
export function afterRound(snapshot: Snapshot, node: Node): Step {
  const current = node.config.round ?? 1;
  if (current < (node.config.rounds ?? 1)) return round(snapshot, node, current + 1);
  return { requests: [summary(snapshot, node)] };
}

/** 失败后重做同一步 */
export function retryStep(snapshot: Snapshot, node: Node, failed: NodeRun): Step {
  if (failed.purpose === 'speech' && failed.meta.participant && failed.meta.round) {
    return { requests: [speech(snapshot, node, failed.meta.participant, failed.meta.round)] };
  }
  if (failed.purpose === 'summary') return { requests: [summary(snapshot, node)] };
  // 有归档就恢复当前子任务，而不是把已付费的工作从头重放。
  return failed.meta.resumable
    ? resumeStep(snapshot, { ...node, currentRunId: failed.id }, true)
    : firstStep(snapshot, node);
}

/**
 * 接着刚交出产出的那次运行再改：关卡没过、交付文件不齐时修复，用户提出修改意见时按意见改。
 * 修复是单轮的，跑完回到关卡重查（ADR 0017）；用户的修改是一轮新工作，照常用持续目标（ADR 0015）。
 */
export function reworkStep(node: Node, unmet: string[], revision?: string): Step {
  return {
    requests: [
      {
        purpose: 'rework',
        goal: revision !== undefined,
        model: node.model,
        prompt: revision !== undefined ? revisionPrompt(revision, node.goal) : reworkPrompt(unmet),
        inputsFrom: [],
        continueFrom: node.currentRunId ?? undefined,
        meta: {},
      },
    ],
  };
}
