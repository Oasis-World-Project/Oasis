// 各种节点共用的部分：节点看得到的上下文、上游交来的文件、接着原会话改的一步、接不上原会话时重新做。
import type { RunInputFile } from '@oasis/contracts/harness';
import type { Node, NodeRun, Snapshot } from '../../repo/task-store.ts';
import { childrenOf, pad2, rootOf } from '../groups.ts';
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

/** 上游：子节点看它所在的工作流图节点的上游（ADR 0026） */
export function upstreamOf(snapshot: Snapshot, node: Node): Node[] {
  return incoming(rootOf(snapshot.nodes, node), snapshot.edges)
    .map((e) => snapshot.nodes.find((n) => n.id === e.fromNodeId))
    .filter((n): n is Node => n !== undefined);
}

/**
 * 一个上游交来的产出：普通节点是交出产出的那次运行，放进 in/<上游>/；
 * 展开节点是每一条各自的那次运行，放进 in/<上游>/01/、02/……（ADR 0026）
 */
export function refsOf(snapshot: Snapshot, upstream: Node): { runId: string; as: string }[] {
  if (upstream.kind !== 'foreach')
    return upstream.config.outputsRunId && upstream.outputs.length
      ? [{ runId: upstream.config.outputsRunId, as: upstream.key }]
      : [];
  return childrenOf(snapshot.nodes, upstream).flatMap((c) =>
    c.config.outputsRunId && c.outputs.length && c.slot
      ? [{ runId: c.config.outputsRunId, as: `${upstream.key}/${pad2(c.slot)}` }]
      : [],
  );
}

/** 工具子节点的步骤点名用到了这个目录（in/<as>/，或整个展开节点 in/<key>/*、in/<key>/index.json） */
function mentions(text: string, as: string): boolean {
  if (text.includes(`in/${as}/`)) return true;
  const [key, slot] = as.split('/');
  return slot !== undefined && new RegExp(`in/${key}/(?!\\d{2}/)`, 'u').test(text);
}

/** 工具子节点只放步骤里点名用到的上游文件：12 个镜头不用每个都把别的镜头搬一遍 */
const scopedText = (node: Node) =>
  node.parentId && node.kind === 'tool' ? JSON.stringify(node.config.steps ?? []) : undefined;

/**
 * 直接放进 in/ 的小文件（ADR 0026）：上游展开节点的 in/<上游>/index.json（按顺序列出每一条和它的文件），
 * 展开出来的 AI 节点还有 in/_item.json（它负责的这一条）。
 */
export function inlineInputsOf(snapshot: Snapshot, node: Node): RunInputFile[] {
  const files: RunInputFile[] = [];
  const text = scopedText(node);
  for (const upstream of upstreamOf(snapshot, node)) {
    if (upstream.kind !== 'foreach') continue;
    if (text !== undefined && !mentions(text, `${upstream.key}/index`)) continue;
    const index = childrenOf(snapshot.nodes, upstream).map((c) => ({
      index: pad2(c.slot ?? 0),
      item: c.config.item ?? null,
      files: c.outputs.map((f) => `${pad2(c.slot ?? 0)}/${f.path}`),
    }));
    files.push(json(`${upstream.key}/index.json`, index));
  }
  if (node.kind === 'work' && node.config.item !== undefined) {
    // 某一版的节点：条目号在它的父节点（那一条）上
    const parent = node.config.version ? snapshot.nodes.find((n) => n.id === node.parentId) : node;
    files.push(json('_item.json', { index: pad2(parent?.slot ?? 0), item: node.config.item }));
  }
  return files;
}

const json = (path: string, value: unknown): RunInputFile => ({
  path,
  contentBase64: Buffer.from(JSON.stringify(value, null, 2)).toString('base64'),
});

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
export function inputsOf(snapshot: Snapshot, node: Node) {
  const text = scopedText(node);
  const refs = upstreamOf(snapshot, node).flatMap((u) => refsOf(snapshot, u));
  return [
    ...(text === undefined ? refs : refs.filter((r) => mentions(text, r.as))),
    ...(node.config.previousRunId ? [{ runId: node.config.previousRunId, as: PREVIOUS_DIR }] : []),
  ];
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
