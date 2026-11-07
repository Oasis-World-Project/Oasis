// 库里的任务、节点、运行 → 给前端和其他服务看的样子（契约见 @oasis/contracts/task）。
import type { EdgeBody, NodeBody, NodeRunBody, TaskBody } from '@oasis/contracts/task';
import type { Node, NodeRun, Snapshot } from '../../repo/task-store.ts';
import { kindOf } from '../kinds/index.ts';
import { deliveryManifest } from '../output-files.ts';
import { FINAL } from './shared.ts';

const iso = (d: Date | null) => d?.toISOString() ?? null;

export function toNodeBody(node: Node): NodeBody {
  const c = node.config;
  return {
    id: node.id,
    key: node.key,
    title: node.title,
    kind: node.kind,
    role: node.role,
    goal: node.goal,
    model: node.model,
    checks: c.checks ?? [],
    expects: c.expects ?? [],
    ...(c.requires ? { requires: c.requires } : {}),
    ...(c.deliver === undefined ? {} : { deliver: c.deliver }),
    ...kindOf(node).body(node),
    status: node.status,
    attempts: node.attempts,
    reworks: node.reworks,
    userNotes: node.userNotes,
    warning: node.warning,
    summary: node.summary,
    outputs: node.outputs,
    spentMicro: node.spentMicro,
    startedAt: iso(node.startedAt),
    finishedAt: iso(node.finishedAt),
  };
}

export function toRunBody(run: NodeRun): NodeRunBody {
  return {
    id: run.id,
    purpose: run.purpose,
    status: run.status,
    attempt: run.attempt,
    round: run.meta.round ?? null,
    participant: run.meta.participant ?? null,
    continued: Boolean(run.request.continueFrom),
    summary: run.summary,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    finishedAt: iso(run.finishedAt),
  };
}

/** 修改中：规划员在排修改方案、等用户确认，或确认后新版还没结束（停下的也算，ADR 0022） */
export const isRevising = (task: Snapshot['task']) =>
  !!task.revision || (!FINAL.includes(task.status) && !!task.acceptance?.revision);

/** 进行中的修改给前端看的样子（ADR 0022） */
function toRevisionBody(task: Snapshot['task']): TaskBody['revision'] {
  const r = task.revision;
  if (!r) return null;
  return {
    version: r.version,
    stage: r.plan ? 'confirm' : 'planning',
    request: r.request,
    summary: r.plan?.summary ?? null,
    estimateMicro: r.estimateMicro ?? null,
    changes: r.changes ?? [],
  };
}

export const toEdgeBody = (e: Snapshot['edges'][number]): EdgeBody => ({
  id: e.id,
  from: e.fromNodeId,
  to: e.toNodeId,
});

export function toTaskBody({ task, nodes, edges, versions }: Snapshot): TaskBody {
  const deliveryFiles = deliveryManifest(task.deliverables, nodes);
  return {
    id: task.id,
    title: task.title,
    brief: task.brief,
    status: task.status,
    attention: task.attention,
    estimateMicro: task.estimateMicro,
    spentMicro: task.spentMicro,
    budgetLimitMicro: task.budgetLimitMicro,
    sheet: task.sheet,
    materials: task.materials,
    // 验收返工次数、这轮的修改意见只给控制面用，不返回；修改还没验收时没有验收记录
    acceptance:
      task.acceptance &&
      (({ repairs: _repairs, revision, ...rest }) =>
        revision !== undefined && !FINAL.includes(task.status) ? null : rest)(task.acceptance),
    deliverables: task.deliverables,
    ...(deliveryFiles === undefined ? {} : { deliveryFiles }),
    nodes: nodes.map(toNodeBody),
    edges: edges.map(toEdgeBody),
    version: task.version,
    versions: versions.map((v) => ({
      version: v.version,
      request: v.request,
      createdAt: v.createdAt.toISOString(),
      frozenAt: v.frozenAt.toISOString(),
    })),
    revision: toRevisionBody(task),
    revising: isRevising(task),
    createdAt: task.createdAt.toISOString(),
    finishedAt: iso(task.finishedAt),
  };
}
