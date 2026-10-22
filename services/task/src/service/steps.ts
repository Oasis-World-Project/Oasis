// 节点的下一步要开哪些运行（纯函数）：
// - 干活节点：一次运行；失败重做从头再来；关卡没过接着原会话改一次。
// - 讨论节点：第一轮每位参与者各说一次（并行）→ 之后每轮每人接着自己的会话回应上一轮别人的发言
//   → 最后汇总者写结论（之后和干活节点一样过关卡）。
import type { NodeConfig, NodeRunPurpose, RunMeta } from '../repo/schema.ts';
import type { Node, NodeRun, Snapshot } from '../repo/task-store.ts';
import {
  reworkPrompt,
  speechPrompt,
  summaryPrompt,
  workPrompt,
  type NodeContext,
  type Speech,
} from './prompt.ts';
import { incoming } from './schedule.ts';

interface RunRequest {
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
  };
}

/** 上游节点最近一次成功运行的产出，放进 in/<上游节点名>/ */
const inputsOf = (snapshot: Snapshot, node: Node) =>
  upstreamOf(snapshot, node)
    .filter((u) => u.currentRunId)
    .map((u) => ({ runId: u.currentRunId as string, as: u.key }));

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
        model: node.model,
        prompt: workPrompt(contextOf(snapshot, node)),
        inputsFrom: inputsOf(snapshot, node),
        meta: {},
      },
    ],
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
  // 干活和修改失败：从头再做一次（修改也重新来过，之后照常过关卡）
  return firstStep(snapshot, node);
}

/** 关卡没过：接着刚交出产出的那次运行改一次 */
export function reworkStep(node: Node, unmet: string[]): Step {
  return {
    requests: [
      {
        purpose: 'rework',
        model: node.model,
        prompt: reworkPrompt(unmet),
        inputsFrom: [],
        continueFrom: node.currentRunId ?? undefined,
        meta: {},
      },
    ],
  };
}
