// 各种节点共用的部分：节点看得到的上下文、上游交来的文件、接着原会话改的一步、接不上原会话时重新做。
import type { Node, NodeRun, Snapshot } from '../../repo/task-store.ts';
import { materialPaths } from '../materials.ts';
import {
  PREVIOUS_DIR,
  redoPrompt,
  reworkPrompt,
  revisionPrompt,
  type NodeContext,
} from '../prompt.ts';
import { incoming } from '../schedule.ts';
import type { RunRequest, Step } from './kind.ts';

/** 还没结束的运行 */
export const isOpen = (r: NodeRun) => r.status === 'pending' || r.status === 'running';

/** 节点还没结束的运行（讨论同一轮里的几条发言可能同时在跑） */
export const openRuns = (snapshot: Snapshot, nodeId: string) =>
  snapshot.activeRuns.filter((r) => r.nodeId === nodeId && isOpen(r));

function upstreamOf(snapshot: Snapshot, node: Node): Node[] {
  return incoming(node, snapshot.edges)
    .map((e) => snapshot.nodes.find((n) => n.id === e.fromNodeId))
    .filter((n): n is Node => n !== undefined);
}

/** 节点看得到的上下文：任务、任务单、角色和目标、上游交来的东西、用户追加的要求、预算和进度 */
export function contextOf(snapshot: Snapshot, node: Node): NodeContext {
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
export const inputsOf = (snapshot: Snapshot, node: Node) => [
  ...upstreamOf(snapshot, node)
    .filter((u) => u.config.outputsRunId && u.outputs.length > 0)
    .map((u) => ({ runId: u.config.outputsRunId as string, as: u.key })),
  ...(node.config.previousRunId ? [{ runId: node.config.previousRunId, as: PREVIOUS_DIR }] : []),
];

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

/**
 * 接不上原会话时重新做这一步（ADR 0022 的「重新做」）：full 是这一步从头做时的完整请求；
 * 节点上一版交出的产出放进 in/_previous/，关卡发现的问题、用户的修改意见附在后面。
 */
export function redoOf(node: Node, run: NodeRun, full: RunRequest): Step {
  // 修改时重新做的节点已经带着上一版（previousRunId）；其余用这个节点上一次交出的产出
  const previous = node.config.previousRunId ? undefined : node.config.outputsRunId;
  return {
    requests: [
      {
        ...full,
        purpose: run.purpose,
        prompt: redoPrompt(
          full.prompt,
          Boolean(previous ?? node.config.previousRunId),
          run.purpose === 'rework' ? run.request.prompt : undefined,
        ),
        inputsFrom: [
          ...full.inputsFrom,
          ...(previous ? [{ runId: previous, as: PREVIOUS_DIR }] : []),
        ],
        meta: run.meta,
      },
    ],
  };
}
