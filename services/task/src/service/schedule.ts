// 调度决定（纯函数）：看一眼整张图，算出哪些节点该开跑、哪些断开了、任务是否该结束或需要用户处理。
import type { Attention, NodeStatus, TaskStatus } from '@oasis/contracts/task';
import type { Edge, Node } from '../repo/task-store.ts';

/** 已经开始、还没结束（占着并发名额）的状态 */
const ACTIVE: readonly NodeStatus[] = ['running', 'checking'];
/** 不会再变的状态 */
const FINAL: readonly NodeStatus[] = ['succeeded', 'failed', 'cancelled'];

export interface ScheduleDecision {
  /** 可以开跑的节点（已按并发上限截取） */
  start: Node[];
  /** 新发现断开的节点（有进来的连线是空的） */
  blocked: Node[];
  /** 任务该进入的状态（不需要改时为 undefined） */
  task?: { status: TaskStatus; attention: Attention | null };
}

/** 某个节点进来的连线 */
export const incoming = (node: Node, edges: Edge[]) => edges.filter((e) => e.toNodeId === node.id);

export function decide(input: {
  taskStatus: TaskStatus;
  nodes: Node[];
  edges: Edge[];
  maxParallel: number;
}): ScheduleDecision {
  const { nodes, edges } = input;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const blocked: Node[] = [];
  const ready: Node[] = [];
  for (const node of nodes.filter((n) => n.status === 'waiting' || n.status === 'blocked')) {
    const links = incoming(node, edges);
    if (links.some((e) => e.fromNodeId === null)) {
      if (node.status === 'waiting') blocked.push(node);
      continue;
    }
    if (
      node.status === 'waiting' &&
      links.every((e) => byId.get(e.fromNodeId ?? '')?.status === 'succeeded')
    ) {
      ready.push(node);
    }
  }
  if (input.taskStatus !== 'running') return { start: [], blocked };

  const active = nodes.filter((n) => ACTIVE.includes(n.status)).length;
  const start = ready.slice(0, Math.max(0, input.maxParallel - active));
  if (active > 0 || ready.length > 0) return { start, blocked };

  // 没有在跑的、也没有能跑的了：要么全部完成，要么卡住了需要用户处理
  if (nodes.every((n) => n.status === 'succeeded')) {
    return { start, blocked, task: { status: 'succeeded', attention: null } };
  }
  const failed = nodes.find((n) => n.status === 'failed');
  const broken = [...blocked, ...nodes.filter((n) => n.status === 'blocked')][0];
  const attention: Attention = failed
    ? { reason: 'node_failed', nodeId: failed.id, message: `「${failed.title}」没能完成` }
    : broken
      ? {
          reason: 'workflow_broken',
          nodeId: broken.id,
          message: `「${broken.title}」前面的连线断开了`,
        }
      : {
          reason: 'workflow_broken',
          nodeId: null,
          message: '有节点的上游没有完成，工作流走不下去了',
        };
  const stuck = nodes.some((n) => !FINAL.includes(n.status));
  return {
    start,
    blocked,
    task: stuck || failed ? { status: 'needs_attention', attention } : undefined,
  };
}
