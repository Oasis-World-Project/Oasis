// 用户编辑工作流图的规则（纯函数，ADR 0004 §3）：
// - 只能改、删还没开始的节点；连线的终点必须是还没开始的节点；连上后不能成环。
// - 删节点留下断开的线头；整体运行前检查整张图，有断开的线头或环就列出问题、不开跑。
import type { PlanNode, UpdateNodeBody } from '@oasis/contracts/task';
import { HttpError } from '@oasis/service-kit';
import type { NodeConfig } from '../repo/schema.ts';
import type { Edge, Node, Snapshot } from '../repo/task-store.ts';
import { findCycle } from './plan.ts';

/** 还没开始的节点：可以改、删，可以往里接线 */
const NOT_STARTED: readonly Node['status'][] = ['draft', 'waiting', 'blocked'];

const conflict = (code: string, message: string) => new HttpError(409, code, message);
const label = (node: Node | undefined) => (node ? `「${node.title}」` : '（空）');

export function nodeOf(snapshot: Snapshot, nodeId: string): Node {
  const node = snapshot.nodes.find((n) => n.id === nodeId);
  if (!node) throw new HttpError(404, 'node_not_found', '没有这个节点');
  return node;
}

export function edgeOf(snapshot: Snapshot, edgeId: string): Edge {
  const edge = snapshot.edges.find((e) => e.id === edgeId);
  if (!edge) throw new HttpError(404, 'edge_not_found', '没有这条连线');
  return edge;
}

export function requireNotStarted(node: Node, action: string): void {
  if (!NOT_STARTED.includes(node.status)) {
    throw conflict('node_started', `${label(node)}已经开始了，不能${action}`);
  }
}

/** 参与者不能重名 */
function checkParticipants(title: string, participants: { name: string }[] | undefined): void {
  const names = (participants ?? []).map((p) => p.name);
  if (new Set(names).size !== names.length) {
    throw new HttpError(400, 'invalid_node', `讨论「${title}」里有重名的参与者`);
  }
}

/** 新建节点：节点名在任务里不能重复 */
export function checkNewNode(snapshot: Snapshot, node: PlanNode): void {
  if (snapshot.nodes.some((n) => n.key === node.key)) {
    throw conflict('node_key_taken', `已经有叫「${node.key}」的节点了`);
  }
  if (node.kind === 'discussion') checkParticipants(node.title, node.participants);
}

/** 修改节点：算出要写的列和配置 */
export function nodeChanges(node: Node, body: UpdateNodeBody) {
  const { title, role, goal, model, checks, expects, participants, rounds } = body;
  if (node.kind !== 'discussion' && (participants !== undefined || rounds !== undefined)) {
    throw new HttpError(400, 'invalid_node', '只有讨论节点有参与者和轮数');
  }
  if (participants) checkParticipants(title ?? node.title, participants);
  const config: NodeConfig = {
    ...node.config,
    ...(checks ? { checks } : {}),
    ...(expects ? { expects } : {}),
    ...(participants ? { participants } : {}),
    ...(rounds ? { rounds } : {}),
  };
  return {
    ...(title !== undefined ? { title } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(goal !== undefined ? { goal } : {}),
    ...(model !== undefined ? { model } : {}),
    config,
  };
}

/** 两端都在时：不能连向自己、不能重复、不能成环 */
function checkLink(
  snapshot: Snapshot,
  edgeId: string | null,
  from: string | null,
  to: string | null,
) {
  if (!from || !to) return;
  if (from === to) throw new HttpError(400, 'invalid_edge', '节点不能连向自己');
  const others = snapshot.edges.filter((e) => e.id !== edgeId);
  if (others.some((e) => e.fromNodeId === from && e.toNodeId === to)) {
    throw conflict('edge_exists', '这两个节点之间已经有连线了');
  }
  const links = [...others, { fromNodeId: from, toNodeId: to }]
    .filter((e) => e.fromNodeId && e.toNodeId)
    .map((e) => ({ from: e.fromNodeId as string, to: e.toNodeId as string }));
  if (
    findCycle(
      snapshot.nodes.map((n) => n.id),
      links,
    )
  ) {
    throw conflict('edge_cycle', '连上之后工作流会成环');
  }
}

/** 线的起点：已取消的节点不会再有产出 */
function checkSource(node: Node): void {
  if (node.status === 'cancelled') throw conflict('node_cancelled', `${label(node)}已经取消了`);
}

/** 新建连线 */
export function checkNewEdge(snapshot: Snapshot, from: string, to: string): void {
  checkSource(nodeOf(snapshot, from));
  requireNotStarted(nodeOf(snapshot, to), '再往里接线');
  checkLink(snapshot, null, from, to);
}

/** 接上线头 / 改连线的一端；返回改完后的两端 */
export function edgeChanges(
  snapshot: Snapshot,
  edge: Edge,
  body: { from?: string; to?: string },
): { fromNodeId: string | null; toNodeId: string | null } {
  const from = body.from ?? edge.fromNodeId;
  const to = body.to ?? edge.toNodeId;
  // 改动会影响终点的输入：旧终点和新终点都必须还没开始
  if (edge.toNodeId) requireNotStarted(nodeOf(snapshot, edge.toNodeId), '改它的连线');
  if (to) requireNotStarted(nodeOf(snapshot, to), '再往里接线');
  if (body.from) checkSource(nodeOf(snapshot, body.from));
  checkLink(snapshot, edge.id, from, to);
  return { fromNodeId: from, toNodeId: to };
}

/** 删除连线：终点还没开始（或终点是空的） */
export function checkDeleteEdge(snapshot: Snapshot, edge: Edge): void {
  if (edge.toNodeId) requireNotStarted(nodeOf(snapshot, edge.toNodeId), '删它的连线');
}

/** 整体运行前检查整张图：断开的线头、环。返回问题清单（普通话），没问题返回空数组 */
export function graphProblems(snapshot: Snapshot): string[] {
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const problems: string[] = [];
  for (const edge of snapshot.edges) {
    if (!edge.fromNodeId) {
      problems.push(`${label(byId.get(edge.toNodeId ?? ''))}前面的连线没接上`);
    } else if (!edge.toNodeId) {
      problems.push(`${label(byId.get(edge.fromNodeId))}后面的连线没接上`);
    }
  }
  const links = snapshot.edges
    .filter((e) => e.fromNodeId && e.toNodeId)
    .map((e) => ({ from: e.fromNodeId as string, to: e.toNodeId as string }));
  const cycle = findCycle([...byId.keys()], links);
  if (cycle) problems.push(`工作流里有环（经过${label(byId.get(cycle))}）`);
  return problems;
}
