// 调度决定（纯函数）：看一眼整张图，算出哪些节点该开跑、哪些断开了或接好了、任务是否该结束、停下或需要用户处理。
// 子节点（ADR 0026）没有连线：父节点开跑后就能跑。组节点（展开、做几版）自己不跑、不占名额；
// 其余节点分两个池：工具子节点最多 maxToolChildren 个同时跑，其他节点（AI、工作流图里的工具节点）最多 maxParallel 个。
import type { Attention, NodeStatus, TaskStatus } from '@oasis/contracts/task';
import type { Edge, Node } from '../repo/task-store.ts';
import { isGroup, isRoot, isToolChild } from './groups.ts';

/** 已经开始、还没结束（占着并发名额）的状态 */
const ACTIVE: readonly NodeStatus[] = ['running', 'checking'];
/** 不会再变的状态 */
const FINAL: readonly NodeStatus[] = ['succeeded', 'failed', 'cancelled'];

export interface ScheduleDecision {
  /** 可以开跑的节点（已按并发上限截取） */
  start: Node[];
  /** 新发现断开的节点（有进来的连线是空的） */
  blocked: Node[];
  /** 断开的线已经接好、回到等待的节点 */
  unblocked: Node[];
  /** 任务该进入的状态（不需要改时为 undefined） */
  task?: { status: TaskStatus; attention: Attention | null };
}

/** 某个节点进来的连线 */
export const incoming = (node: Node, edges: Edge[]) => edges.filter((e) => e.toNodeId === node.id);

/** 正在干活、占着名额的节点（组节点不算） */
const working = (nodes: Node[]) => nodes.filter((n) => ACTIVE.includes(n.status) && !isGroup(n));

/**
 * 两个并发池各占了几个：工具子节点 + 看图挑选的运行；其他节点 + AI 比较的挑选运行（ADR 0026）。
 * 组节点自己不占名额，只有它开的挑选运行占。
 */
export function poolUse(nodes: Node[]): { tools: number; others: number } {
  const busy = working(nodes);
  const picks = nodes.filter((n) => n.status === 'running' && n.config.picking);
  const toolPicks = picks.filter((n) => n.config.picking === 'tool').length;
  const tools = busy.filter(isToolChild).length;
  return {
    tools: tools + toolPicks,
    others: busy.length - tools + picks.length - toolPicks,
  };
}

/**
 * 组节点还在忙自己的事：展开节点在读清单；做几版的节点在挑，或者各版都结束了、等名额开挑选
 */
function settling(nodes: Node[], n: Node): boolean {
  if (!isGroup(n) || n.status !== 'running') return false;
  if (n.kind === 'foreach') return n.config.items === undefined;
  if (n.config.picking) return true;
  const children = nodes.filter((c) => c.parentId === n.id);
  return children.length > 0 && children.every((c) => FINAL.includes(c.status));
}

export function decide(input: {
  taskStatus: TaskStatus;
  nodes: Node[];
  edges: Edge[];
  maxParallel: number;
  /** 工具子节点同时最多几个（ADR 0026，用户 2026-11-08 定 6） */
  maxToolChildren: number;
}): ScheduleDecision {
  const { nodes, edges } = input;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const blocked: Node[] = [];
  const unblocked: Node[] = [];
  const ready: Node[] = [];
  // 新建（draft）的节点不自动开跑，等用户点运行
  for (const node of nodes.filter((n) => n.status === 'waiting' || n.status === 'blocked')) {
    if (node.parentId) {
      if (node.status === 'waiting' && byId.get(node.parentId)?.status === 'running')
        ready.push(node);
      continue;
    }
    const links = incoming(node, edges);
    if (links.some((e) => e.fromNodeId === null)) {
      if (node.status === 'waiting') blocked.push(node);
      continue;
    }
    if (node.status === 'blocked') unblocked.push(node);
    if (links.every((e) => byId.get(e.fromNodeId ?? '')?.status === 'succeeded')) {
      ready.push(node);
    }
  }
  // 任务不在整体运行（如只运行了一个节点）：工作流图里的节点不往下跑，但正在跑的组节点要把子节点跑完
  const running = input.taskStatus === 'running';
  const busy = working(nodes);
  let { tools, others } = poolUse(nodes);
  const start: Node[] = [];
  for (const node of running ? ready : ready.filter((n) => n.parentId)) {
    if (isGroup(node)) start.push(node);
    else if (isToolChild(node)) {
      if (tools < input.maxToolChildren) {
        start.push(node);
        tools += 1;
      }
    } else if (others < input.maxParallel) {
      start.push(node);
      others += 1;
    }
  }
  if (!running || busy.length > 0 || ready.length > 0 || nodes.some((n) => settling(nodes, n)))
    return { start, blocked, unblocked };

  // 没有在跑的、也没有能跑的了：全部完成；或者有节点停下 / 新建着，等用户点运行；或者卡住了需要用户处理。
  // 已经挑好一版的节点下面没做成的那几版不算（ADR 0026）
  if (nodes.filter(isRoot).every((n) => n.status === 'succeeded')) {
    return { start, blocked, unblocked, task: { status: 'succeeded', attention: null } };
  }
  const relevant = nodes.filter((n) => !n.parentId || byId.get(n.parentId)?.status !== 'succeeded');
  const failed = relevant.find((n) => n.status === 'failed');
  const broken = [...blocked, ...nodes.filter((n) => n.status === 'blocked')].find(
    (n) => !unblocked.includes(n),
  );
  if (!failed && !broken && relevant.some((n) => n.status === 'stopped' || n.status === 'draft')) {
    return { start, blocked, unblocked, task: { status: 'stopped', attention: null } };
  }
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
  const stuck = relevant.some((n) => !FINAL.includes(n.status));
  return {
    start,
    blocked,
    unblocked,
    task: stuck || failed ? { status: 'needs_attention', attention } : undefined,
  };
}
