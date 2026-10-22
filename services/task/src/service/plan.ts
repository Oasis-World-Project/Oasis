// 工作流方案的校验，以及把方案变成库里的节点和连线（ADR 0004 §3、§9）。
import { randomUUID } from 'node:crypto';
import type { PlanNode, WorkflowPlan } from '@oasis/contracts/task';
import { HttpError } from '@oasis/service-kit';

/** 找环：返回环上的一个节点名，没有环返回 undefined（Kahn 拓扑排序剩下的就是环上的） */
export function findCycle(
  keys: string[],
  links: { from: string; to: string }[],
): string | undefined {
  const indegree = new Map(keys.map((k) => [k, 0]));
  for (const { to } of links) indegree.set(to, (indegree.get(to) ?? 0) + 1);
  const queue = keys.filter((k) => indegree.get(k) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const key = queue.shift() as string;
    visited += 1;
    for (const link of links.filter((l) => l.from === key)) {
      const left = (indegree.get(link.to) ?? 0) - 1;
      indegree.set(link.to, left);
      if (left === 0) queue.push(link.to);
    }
  }
  return visited === keys.length ? undefined : keys.find((k) => (indegree.get(k) ?? 0) > 0);
}

/** 校验方案；有问题时抛 400，并把所有问题一起列出来 */
export function validatePlan(plan: WorkflowPlan): void {
  const problems: string[] = [];
  const keys = plan.nodes.map((n) => n.key);
  const duplicated = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (duplicated.length > 0) problems.push(`节点名重复：${[...new Set(duplicated)].join('、')}`);
  const known = new Set(keys);
  for (const edge of plan.edges) {
    if (!known.has(edge.from)) problems.push(`连线的起点「${edge.from}」不存在`);
    if (!known.has(edge.to)) problems.push(`连线的终点「${edge.to}」不存在`);
    if (edge.from === edge.to) problems.push(`节点「${edge.from}」不能连向自己`);
  }
  for (const node of plan.nodes) {
    if (node.kind !== 'discussion') continue;
    const names = node.participants.map((p) => p.name);
    if (new Set(names).size !== names.length)
      problems.push(`讨论「${node.title}」里有重名的参与者`);
  }
  const pairs = plan.edges.map((e) => `${e.from}→${e.to}`);
  if (new Set(pairs).size !== pairs.length) problems.push('有重复的连线');
  if (problems.length === 0) {
    const cycle = findCycle(keys, plan.edges);
    if (cycle) problems.push(`工作流里有环（经过「${cycle}」）`);
  }
  if (problems.length > 0) throw new HttpError(400, 'invalid_plan', problems.join('；'));
}

/** 方案里的一个节点 → 库里的一行（status 由调用方定：方案里的是等待，用户新建的是新建） */
export function nodeRow(n: PlanNode, id: string, status: 'waiting' | 'draft') {
  return {
    id,
    key: n.key,
    title: n.title,
    kind: n.kind,
    role: n.role,
    goal: n.goal,
    model: n.model,
    status,
    config: {
      checks: n.checks,
      expects: n.expects,
      ...(n.kind === 'discussion'
        ? { participants: n.participants, rounds: n.rounds, round: 0, transcript: [] }
        : {}),
    },
  };
}

/** 把方案变成节点和连线的行（节点名 → 生成的节点 ID） */
export function planToRows(plan: WorkflowPlan) {
  const ids = new Map(plan.nodes.map((n) => [n.key, randomUUID()]));
  const nodes = plan.nodes.map((n) => nodeRow(n, ids.get(n.key) as string, 'waiting'));
  const edges = plan.edges.map((e) => ({
    id: randomUUID(),
    fromNodeId: ids.get(e.from) as string,
    toNodeId: ids.get(e.to) as string,
  }));
  return { nodes, edges };
}
