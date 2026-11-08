// 修改的规划（ADR 0022）：用户看过成果提了修改意见，由规划员看上一版工作流决定这次怎么改——
// 沿用、接着原会话改、重新做、加减节点；规划门检查方案，代码只算要跑的节点的花费。
import type { CatalogEntry } from '@oasis/contracts/agent';
import type { ExecutionEnvironment } from '@oasis/contracts/harness';
import type { ToolEntry } from '@oasis/contracts/model-gateway';
import {
  DiscussionPlanNode,
  ForeachPlanNode,
  NodeKey,
  PlanEdge,
  ToolPlanNode,
  WorkPlanNode,
  type PlanNode,
  type RevisionChange,
  type TaskSheet,
} from '@oasis/contracts/task';
import { z } from 'zod';
import type { RevisionPlanNode, RevisionState } from '../repo/schema.ts';
import type { Edge, Node } from '../repo/task-store.ts';
import { kindOf } from './kinds/index.ts';
import { withInputExpects } from './plan.ts';
import {
  estimatePlan,
  exampleNode,
  issuesOf,
  NODE_FORMAT_RULES,
  PLAN_FILE,
  readPlanJson,
  resourceSections,
  workflowProblems,
  type PlannerPlan,
  type PlannerResources,
} from './planner.ts';
import { PREVIOUS_DIR } from './prompt.ts';
import type { Fallback, PricedModel } from './quote.ts';

const origin = {
  from: NodeKey.optional(),
  mode: z.enum(['continue', 'fresh']).default('fresh'),
};
const RevisionPlanFile = z.object({
  summary: z.string().trim().min(1).max(500),
  nodes: z
    .array(
      z.union([
        z.object({ key: NodeKey, reuse: NodeKey }),
        z.discriminatedUnion('kind', [
          WorkPlanNode.extend(origin),
          DiscussionPlanNode.extend(origin),
          ToolPlanNode.extend(origin),
          ForeachPlanNode.extend(origin),
        ]),
      ]),
    )
    .min(1),
  edges: z.array(PlanEdge).default([]),
  deliverables: z.record(z.string(), NodeKey),
});
export type RevisionPlan = NonNullable<RevisionState['plan']>;

const isReuse = (n: RevisionPlanNode): n is { key: string; reuse: string } => 'reuse' in n;

/** 上一版的节点 → 方案里的完整节点（沿用的节点照搬，规划门和估价用） */
export function asPlanNode(node: Node): PlanNode {
  const c = node.config;
  return kindOf(node).plan(node, {
    key: node.key,
    title: node.title,
    role: node.role,
    goal: node.goal,
    model: node.model,
    checks: c.checks ?? [],
    expects: c.expects ?? [],
    ...(c.requires ? { requires: c.requires } : {}),
    ...(c.deliver ? { deliver: c.deliver } : {}),
  });
}

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
/** 节点用过的工具（给规划员看；没有就不写） */
function toolsOf(n: Node) {
  const { tools } = kindOf(n).body(n);
  return tools.length ? { tools: tools.map((t) => t.key) } : {};
}
const minutesOf = (n: Node) =>
  n.startedAt && n.finishedAt
    ? Math.max(1, Math.round((n.finishedAt.getTime() - n.startedAt.getTime()) / 60_000))
    : null;

/** 上一版工作流：给规划员看的事实（每个节点做什么、交了什么、花了多少） */
function previousWorkflow(nodes: Node[], edges: Edge[], deliverables: Record<string, string>) {
  const keyOf = new Map(nodes.map((n) => [n.id, n.key]));
  return JSON.stringify(
    {
      nodes: nodes.map((n) => ({
        key: n.key,
        title: n.title,
        kind: n.kind,
        model: n.model,
        status: n.status,
        goal: n.goal.length > 800 ? `${n.goal.slice(0, 800)}…` : n.goal,
        ...toolsOf(n),
        // 展开节点、做几版的节点（ADR 0026）：展开了几条、挑了第几版
        ...(n.kind === 'foreach'
          ? { foreach: { over: n.config.over, items: n.config.items ?? null } }
          : {}),
        ...(n.config.variants
          ? { variants: { n: n.config.variants.n, chosen: n.config.chosen ?? null } }
          : {}),
        ...(n.config.deliver ? { deliver: n.config.deliver } : {}),
        outputs: n.outputs.slice(0, 40).map((f) => f.path),
        ...(n.summary ? { said: n.summary.slice(0, 300) } : {}),
        spent: usd(n.spentMicro),
        ...(minutesOf(n) ? { minutes: minutesOf(n) } : {}),
      })),
      edges: edges
        .filter((e) => e.fromNodeId && e.toNodeId)
        .map((e) => `${keyOf.get(e.fromNodeId!)} → ${keyOf.get(e.toNodeId!)}`),
      deliverables,
    },
    null,
    1,
  );
}

/** 给规划员的修改说明（ADR 0022）：只讲事实和方案格式，怎么改由规划员判断 */
export function revisionPlannerPrompt(
  input: PlannerResources & {
    brief: string;
    sheet: TaskSheet;
    request: string;
    /** 意见针对的节点（批注、参数所在成果是它们交出的） */
    targets: string[];
    nodes: Node[];
    edges: Edge[];
    deliverables: Record<string, string>;
  },
): string {
  const first = input.nodes[0];
  const example = {
    summary: '只改网页的灯光，模型和预览图沿用上一版。',
    nodes: [
      ...(first ? [{ key: first.key, reuse: first.key }] : []),
      {
        ...exampleNode(
          'web',
          '调亮网页',
          '基于 in/_previous/ 里上一版网页……',
          'site/index.html',
          input.defaultModel,
        ),
        from: 'web',
        deliver: ['site/**'],
      },
    ],
    edges: first ? [{ from: first.key, to: 'web' }] : [],
    deliverables: input.deliverables,
  };
  return [
    '你是 Oasis 的规划员。用户看了上一版成果，提出了修改意见。你来决定 AI 团队这次怎么改：哪些节点沿用、哪些接着原会话改、哪些重新做、要不要加减节点。你只排方案，不要动手做。',
    `【任务】\n${input.brief}`,
    `【任务单】\n${JSON.stringify(input.sheet)}`,
    `【修改意见】\n${input.request}`,
    input.targets.length
      ? `【意见针对的成果】是这些节点交出的：${input.targets.join('、')}`
      : '【意见针对的成果】没指到具体成果，按意见内容判断。',
    `【上一版工作流】（spent 是花费，minutes 是用时）\n${previousWorkflow(input.nodes, input.edges, input.deliverables)}`,
    ...resourceSections(input),
    [
      `【方案格式】写成 out/${PLAN_FILE}（只放 JSON），例如：`,
      JSON.stringify(example, null, 2),
      '- summary：一两句话告诉用户你打算怎么改，用户确认后才开跑。',
      '- 沿用：{"key":"旧节点名","reuse":"旧节点名"}，不重跑，上一版的产出原样交给下游。它的上游也必须是沿用（上游重做了，它拿不到新产出）。',
      `- 重新做：完整节点 + "from":"旧节点名"。新会话，上一版这个节点交出的文件放在 in/${PREVIOUS_DIR}/，goal 写清基于哪些文件改什么。`,
      '- 接着原会话改：完整节点 + "from":"旧节点名","mode":"continue"，必须用原来的模型，goal 写这次要改什么。会话里有上一版的全部过程，会话越长每次调用越贵（参考上一版的花费和用时），只适合会话短、改动小的节点。',
      '- 新节点：完整节点，不写 from。上一版的节点没出现在方案里就删掉。',
      '- 只动和意见有关的节点，其余沿用；同一个旧节点只能引用一次。',
      ...NODE_FORMAT_RULES,
    ].join('\n'),
    '写完用一两句话说明你的安排。',
  ].join('\n\n');
}

/**
 * 修改的规划门：方案格式、引用的旧节点、沿用和接着改的条件，再按普通方案检查一遍（沿用的节点照搬，不重查）。
 * 通过时给出方案、照搬后的完整工作流（建节点和估价用）和每个节点的处理。
 */
export function checkRevisionPlan(
  text: string | undefined,
  input: {
    sheet: TaskSheet;
    catalog: CatalogEntry[];
    tools: ToolEntry[];
    environment?: ExecutionEnvironment;
    nodes: Node[];
  },
):
  | {
      plan: RevisionPlan;
      workflow: PlannerPlan;
      changes: { key: string; title: string; change: RevisionChange }[];
    }
  | { problems: string[] } {
  const read = readPlanJson(text);
  if ('problems' in read) return read;
  const parsed = RevisionPlanFile.safeParse(read.raw);
  if (!parsed.success) return { problems: issuesOf(parsed.error) };
  const plan = parsed.data as RevisionPlan;
  const old = new Map(input.nodes.map((n) => [n.key, n]));
  const problems: string[] = [];
  const referenced = plan.nodes.map((n) => (isReuse(n) ? n.reuse : n.from)).filter(Boolean);
  const twice = referenced.filter((k, i) => referenced.indexOf(k) !== i);
  if (twice.length) problems.push(`上一版的节点只能引用一次：${[...new Set(twice)].join('、')}`);
  const reused = new Set<string>();
  const nodes: PlanNode[] = [];
  for (const entry of plan.nodes) {
    if (isReuse(entry)) {
      const source = old.get(entry.reuse);
      if (!source) {
        problems.push(`沿用的「${entry.reuse}」不是上一版的节点`);
        continue;
      }
      if (entry.key !== entry.reuse) problems.push(`沿用的节点 key 要和旧节点一样：${entry.reuse}`);
      // 展开节点没有单独交出产出的运行，看它是不是每一条都做完了（ADR 0026）
      const hasOutputs =
        source.kind === 'foreach'
          ? source.status === 'succeeded'
          : Boolean(source.config.outputsRunId);
      if (!hasOutputs || source.outputs.length === 0)
        problems.push(`「${entry.reuse}」上一版没有可沿用的产出，要重新做`);
      reused.add(entry.key);
      nodes.push(asPlanNode(source));
      continue;
    }
    const { from, mode, ...node } = entry;
    nodes.push(node as PlanNode);
    const source = from ? old.get(from) : undefined;
    if (from && !source) problems.push(`节点「${entry.key}」的 from「${from}」不是上一版的节点`);
    else if (source && source.kind !== entry.kind)
      problems.push(`节点「${entry.key}」和上一版的「${from}」类型不同，不能写 from，当新节点排`);
    if (mode === 'continue') {
      if (!source) problems.push(`接着原会话改要写 from（节点「${entry.key}」）`);
      else if (!kindOf(source).continuable || !kindOf(entry).continuable || !source.currentRunId)
        problems.push(`只有上一版跑过的干活节点能接着原会话改（节点「${entry.key}」）`);
      else if (entry.model !== source.model)
        problems.push(`节点「${entry.key}」接着原会话改要用原来的模型 ${source.model}`);
    }
  }
  for (const edge of plan.edges)
    if (reused.has(edge.to) && !reused.has(edge.from))
      problems.push(
        `沿用的「${edge.to}」的上游「${edge.from}」要重新做，它拿不到新产出：把它也改成重新做，或去掉这条线`,
      );
  const workflow: PlannerPlan = { nodes, edges: plan.edges, deliverables: plan.deliverables };
  problems.push(
    ...workflowProblems(
      workflow,
      input.sheet,
      input.catalog,
      input.tools,
      input.environment,
      reused,
    ),
  );
  // 工具节点直接用的上游文件（ADR 0025）：沿用的上游要已经交出过它；重新做的上游由下面补成必须交出的文件
  for (const node of nodes)
    for (const file of kindOf(node).inputFiles?.(node) ?? []) {
      const source = reused.has(file.from) ? old.get(file.from) : undefined;
      if (source && !source.outputs.some((o) => o.path === file.path))
        problems.push(
          `沿用的「${file.from}」上一版没有交出 ${file.path}，节点「${node.key}」要用它`,
        );
    }
  if (problems.length) return { problems };
  const expected = new Map(withInputExpects(workflow).nodes.map((n) => [n.key, n.expects]));
  const kept = new Set(referenced);
  const changes = [
    ...plan.nodes.map((n) => ({
      key: n.key,
      title: isReuse(n) ? (old.get(n.reuse)?.title ?? n.key) : n.title,
      change: (isReuse(n) ? 'reuse' : n.from ? n.mode : 'new') as RevisionChange,
    })),
    ...input.nodes
      .filter((n) => !kept.has(n.key))
      .map((n) => ({ key: n.key, title: n.title, change: 'remove' as const })),
  ];
  const withExpects: RevisionPlan = {
    ...plan,
    nodes: plan.nodes.map((n) =>
      isReuse(n) ? n : { ...n, expects: expected.get(n.key) ?? n.expects },
    ),
  };
  return {
    plan: withExpects,
    workflow: {
      ...workflow,
      nodes: workflow.nodes.map((n) =>
        reused.has(n.key) ? n : { ...n, expects: expected.get(n.key) ?? n.expects },
      ),
    },
    changes,
  };
}

/** 修改的预估：只算要跑的节点（沿用的不花钱） */
export function estimateRevision(
  plan: RevisionPlan,
  workflow: PlannerPlan,
  models: PricedModel[],
  tools: ToolEntry[],
  fallback: Fallback,
): number {
  const reused = new Set(plan.nodes.filter(isReuse).map((n) => n.key));
  return estimatePlan(
    { nodes: workflow.nodes.filter((n) => !reused.has(n.key)), edges: [] },
    models,
    tools,
    fallback,
  ).totalMicro;
}
