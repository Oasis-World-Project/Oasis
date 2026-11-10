// 工作流方案的校验，以及把方案变成库里的节点和连线（ADR 0004 §3、§9）。
import { randomUUID } from 'node:crypto';
import type { PlanNode, WorkflowPlan } from '@oasis/contracts/task';
import { HttpError } from '@oasis/service-kit';
import type { NodeConfig } from '../repo/schema.ts';
import { GROUP_KEY_MAX } from './groups.ts';
import { kindOf, listSource } from './kinds/index.ts';

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

/**
 * 展开节点、做几版的节点（ADR 0026）：名字后面要接 -01、-v1，留出长度、别和别的节点撞名；
 * 清单要从普通节点来（展开节点交的是一个个目录）；一次最多开 48 个子节点。
 */
function groupProblems(plan: WorkflowPlan): string[] {
  const problems: string[] = [];
  const byKey = new Map(plan.nodes.map((n) => [n.key, n]));
  for (const node of plan.nodes) {
    const variants =
      node.kind === 'foreach' ? node.each.variants : 'variants' in node ? node.variants : undefined;
    if (node.kind !== 'foreach' && !variants) continue;
    if (node.key.length > GROUP_KEY_MAX)
      problems.push(`节点「${node.key}」要开子节点，名字最长 ${GROUP_KEY_MAX} 个字符`);
    const clash = plan.nodes.find((n) => n.key.startsWith(`${node.key}-`));
    if (clash)
      problems.push(`节点名「${clash.key}」会和「${node.key}」开出来的子节点撞名，换个名字`);
    if (node.kind !== 'foreach') continue;
    const source = byKey.get(listSource(node.over).from);
    if (source?.kind === 'foreach')
      problems.push(`节点「${node.key}」的清单要由普通节点交出，不能来自展开节点「${source.key}」`);
    if (node.count * (variants?.n ?? 1) > 48)
      problems.push(
        `节点「${node.key}」预计 ${node.count} 条 × ${variants?.n ?? 1} 版，太多了（最多 48 个）`,
      );
  }
  return problems;
}

/** 文字里写到的 in/<节点名>/；前面紧挨着字母、数字或 . / _ - 的不算（plug-in/x/、src/in/x/ 不是沙箱目录） */
const MENTIONED_INPUT = /(?<![A-Za-z0-9_./-])in\/([\p{L}\p{N}_-]{1,40})\//gu;

/**
 * AI 节点的说明里写到 in/<别的节点>/：只有直接连过来的上游才会放进它的 in/，隔着一个节点的不算。
 * 没有连线它开跑后找不到这些文件，只能照着说明重做一遍，所以在规划时就退回。
 * 只查方案里有的节点名：in/_previous/（修改时上一版的文件）和别的文字不在这里管。
 */
function mentionProblems(plan: WorkflowPlan, known: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const node of plan.nodes) {
    const text = (kindOf(node).texts?.(node) ?? []).join('\n');
    const mentioned = new Set([...text.matchAll(MENTIONED_INPUT)].map((m) => m[1] as string));
    for (const from of mentioned) {
      if (from === node.key || !known.has(from)) continue;
      if (plan.edges.some((e) => e.from === from && e.to === node.key)) continue;
      problems.push(
        `节点「${node.key}」的说明里写到 in/${from}/，但没有连线 ${from} → ${node.key}，它拿不到「${from}」交出的文件：要用就连上这条线，不用就不要写`,
      );
    }
  }
  return problems;
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
  for (const node of plan.nodes) problems.push(...kindOf(node).problems(node));
  // 工具节点参数里直接写的上游文件 in/<上游>/…：上游要存在，还要有连线把它的产出交过来
  for (const node of plan.nodes)
    for (const from of new Set((kindOf(node).inputFiles?.(node) ?? []).map((f) => f.from)))
      if (!known.has(from))
        problems.push(`节点「${node.key}」用到的 in/${from}/ 不是任何节点交来的`);
      else if (!plan.edges.some((e) => e.from === from && e.to === node.key))
        problems.push(`节点「${node.key}」用到 in/${from}/ 里的文件，要连线 ${from} → ${node.key}`);
  problems.push(...mentionProblems(plan, known));
  problems.push(...groupProblems(plan));
  const pairs = plan.edges.map((e) => `${e.from}→${e.to}`);
  if (new Set(pairs).size !== pairs.length) problems.push('有重复的连线');
  if (problems.length === 0) {
    const cycle = findCycle(keys, plan.edges);
    if (cycle) problems.push(`工作流里有环（经过「${cycle}」）`);
  }
  if (problems.length > 0) throw new HttpError(400, 'invalid_plan', problems.join('；'));
}

/**
 * 下游工具节点直接用到的上游文件，成为上游必须交出的文件（ADR 0025）：上游没交出来时关卡让它改一次，
 * 免得工具节点开跑才发现缺文件。已经写了的不重复加。
 */
export function withInputExpects<P extends WorkflowPlan>(plan: P): P {
  const wanted = new Map<string, Set<string>>();
  const foreach = new Set(plan.nodes.filter((n) => n.kind === 'foreach').map((n) => n.key));
  for (const node of plan.nodes)
    for (const file of kindOf(node).inputFiles?.(node) ?? [])
      // 带 {{…}} 模板的路径、展开节点交的条目（ADR 0026）事先定不下来，不加
      if (!file.path.includes('{{') && !foreach.has(file.from))
        wanted.set(file.from, (wanted.get(file.from) ?? new Set()).add(file.path));
  if (!wanted.size) return plan;
  return {
    ...plan,
    nodes: plan.nodes.map((node) => {
      const paths = wanted.get(node.key);
      if (!paths) return node;
      const listed = new Set(node.expects.map((e) => (typeof e === 'string' ? e : e.pattern)));
      const added = [...paths].filter((p) => !listed.has(p));
      return added.length ? { ...node, expects: [...node.expects, ...added] } : node;
    }),
  };
}

/** 方案里的一个节点 → 库里的一行（status 由调用方定：方案里的是等待，用户新建的是新建） */
export function nodeRow(
  n: PlanNode,
  id: string,
  status: 'waiting' | 'draft',
  budgetMicro?: number,
) {
  const config: NodeConfig = {
    ...(budgetMicro ? { budgetMicro } : {}),
    ...(n.requires ? { requires: n.requires } : {}),
    checks: n.checks,
    expects: n.expects,
    ...(n.deliver === undefined ? {} : { deliver: n.deliver }),
    ...kindOf(n).config(n),
  };
  return {
    id,
    key: n.key,
    title: n.title,
    kind: n.kind,
    role: n.role,
    goal: n.goal,
    model: n.model,
    status,
    config,
  };
}

/** 把方案变成节点和连线的行（节点名 → 生成的节点 ID）；budgetOf 给出每个节点分到的预算 */
export function planToRows(plan: WorkflowPlan, budgetOf?: (key: string) => number | undefined) {
  const ids = new Map(plan.nodes.map((n) => [n.key, randomUUID()]));
  const nodes = plan.nodes.map((n) =>
    nodeRow(n, ids.get(n.key) as string, 'waiting', budgetOf?.(n.key)),
  );
  const edges = plan.edges.map((e) => ({
    id: randomUUID(),
    fromNodeId: ids.get(e.from) as string,
    toNodeId: ids.get(e.to) as string,
  }));
  return { nodes, edges };
}
