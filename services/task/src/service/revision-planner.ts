// 修改的规划（ADR 0022、0030 §3.8）：用户看过成果提了修改意见。
// - 意见指得到由 AI 做的成果：不用规划员，做它的 AI 接着原会话按意见改，用到它的下游跟着更新（directRevision）。
// - 跨几样成果、指到生产线或定不下来：规划员看上一版决定——沿用、接着原会话改、重新做、加减成果；规划门检查后等用户确认。
import type { CatalogEntry } from '@oasis/contracts/agent';
import type { ExecutionEnvironment } from '@oasis/contracts/harness';
import type { ToolEntry } from '@oasis/contracts/model-gateway';
import {
  AgentOutcome,
  ForeachPlanNode,
  LineOutcome,
  NodeKey,
  ToolPlanNode,
  type PlanNode,
  type RevisionChange,
  type TaskSheet,
} from '@oasis/contracts/task';
import { z } from 'zod';
import type { RevisionPlanNode, RevisionState } from '../repo/schema.ts';
import type { Edge, Node } from '../repo/task-store.ts';
import { hasVariants } from './groups.ts';
import { kindOf } from './kinds/index.ts';
import { patternRegExp } from './output-files.ts';
import { withInputExpects } from './plan.ts';
import {
  exampleOutcome,
  issuesOf,
  OUTCOME_FORMAT_RULES,
  PLAN_FILE,
  readPlanJson,
  resourceSections,
  workflowProblems,
  type PlannerPlan,
  type PlannerResources,
} from './planner.ts';
import { PREVIOUS_DIR } from './prompt.ts';

const Reuse = z.object({ key: NodeKey, reuse: z.literal(true) });
/** 规划员写的修改方案：按成果排，上一版有的成果（key 一样）写明沿用、接着改还是重新做 */
const RevisionPlanFile = z.object({
  summary: z.string().trim().min(1).max(500),
  outcomes: z
    .array(
      z.union([
        Reuse,
        AgentOutcome.extend({ mode: z.enum(['continue', 'fresh']).optional() }),
        LineOutcome.extend({
          nodes: z.array(z.union([Reuse, ToolPlanNode, ForeachPlanNode])).min(1),
        }),
      ]),
    )
    .min(1),
  deliverables: z.record(z.string(), NodeKey),
});
export type RevisionPlan = NonNullable<RevisionState['plan']>;
type Changes = { key: string; title: string; change: RevisionChange }[];

const isReuse = (n: RevisionPlanNode): n is { key: string; reuse: string } => 'reuse' in n;

/** 上一版的节点 → 方案里的完整节点（沿用的节点照搬，规划门用） */
export function asPlanNode(node: Node): PlanNode {
  const c = node.config;
  return kindOf(node).plan(node, {
    key: node.key,
    title: node.title,
    role: node.role,
    goal: node.goal,
    model: node.model,
    expects: c.expects ?? [],
    ...(c.requires ? { requires: c.requires } : {}),
    ...(c.deliver ? { deliver: c.deliver } : {}),
    ...(c.line ? { line: c.line } : {}),
  });
}

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
const minutesOf = (n: Node) =>
  n.startedAt && n.finishedAt
    ? Math.max(1, Math.round((n.finishedAt.getTime() - n.startedAt.getTime()) / 60_000))
    : null;

/** 连线两端的节点名（两端都在的） */
const keyEdges = (nodes: Node[], edges: Edge[]) => {
  const keyOf = new Map(nodes.map((n) => [n.id, n.key]));
  return edges.flatMap((e) => {
    const from = keyOf.get(e.fromNodeId ?? '');
    const to = keyOf.get(e.toNodeId ?? '');
    return from && to ? [{ from, to }] : [];
  });
};

/** 上一版工作流：给规划员看的事实（每样成果做什么、交了什么、花了多少） */
function previousWorkflow(nodes: Node[], edges: Edge[], deliverables: Record<string, string>) {
  const facts = (n: Node) => ({
    key: n.key,
    title: n.title,
    ...(n.config.line ? { kind: n.kind } : { how: n.kind === 'work' ? 'agent' : n.kind }),
    ...(n.model ? { model: n.model } : {}),
    status: n.status,
    goal: n.goal.length > 800 ? `${n.goal.slice(0, 800)}…` : n.goal,
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
  });
  const lines = new Map<string, { key: string; title: string; how: 'line'; nodes: unknown[] }>();
  const outcomes: unknown[] = [];
  for (const node of nodes) {
    const line = node.config.line;
    if (!line) {
      outcomes.push(facts(node));
      continue;
    }
    let entry = lines.get(line.key);
    if (!entry) {
      entry = { ...line, how: 'line', nodes: [] };
      lines.set(line.key, entry);
      outcomes.push(entry);
    }
    entry.nodes.push(facts(node));
  }
  return JSON.stringify(
    {
      outcomes,
      edges: keyEdges(nodes, edges).map((e) => `${e.from} → ${e.to}`),
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
  const first = input.nodes.find((n) => !n.config.line);
  const example = {
    summary: '只改网页的灯光，模型和预览图沿用上一版。',
    outcomes: [
      ...(first ? [{ key: first.key, reuse: true }] : []),
      {
        ...exampleOutcome('web', '网页', '把灯光调亮……', 'site/index.html', input.defaultModel),
        deliver: ['site/**'],
        needs: first ? [first.key] : [],
        mode: 'continue',
      },
    ],
    deliverables: input.deliverables,
  };
  return [
    '你是 Oasis 的规划员。用户看了上一版成果，提出了修改意见。你来决定这次怎么改：哪些成果沿用、哪些接着原会话改、哪些重新做、要不要加减成果。你只排方案，不要动手做。',
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
      '- 沿用一样成果：{"key":"上一版的 key","reuse":true}，不重跑，上一版的产出原样交给下游。它用到的上游也必须是沿用（上游重做了，它拿不到新产出）。',
      '- 接着原会话改（只有 agent 成果）：写完整的成果，key 和上一版一样，加 "mode":"continue"，必须用原来的模型，goal 写这次要改什么。会话里有上一版的全部过程，接得上原来的思路；会话越长每次调用越贵（参考上一版的花费和用时）。',
      `- 重新做：写完整的成果，key 和上一版一样；agent 成果加 "mode":"fresh"，新会话，上一版它交出的文件放在 in/${PREVIOUS_DIR}/，goal 写清基于哪些文件改什么。生产线的 key 不变，里面的节点逐个写：沿用（{"key":"节点 key","reuse":true}）或重新做（完整节点）；展开节点重新做时内容没变的条目自动沿用。`,
      '- 新成果：key 用上一版没有的。上一版的成果、节点没出现在方案里就删掉。',
      '- 只动和意见有关的，其余沿用。',
      ...OUTCOME_FORMAT_RULES,
    ].join('\n'),
    '写完用一两句话说明你的安排。',
  ].join('\n\n');
}

/** 规划员按成果写的修改方案 → 引擎按节点记的修改方案；沿用整样成果时，它的节点和进来的连线照搬上一版 */
function flatten(
  file: z.infer<typeof RevisionPlanFile>,
  old: Node[],
  oldEdges: { from: string; to: string }[],
): { plan: RevisionPlan; problems: string[] } {
  const problems: string[] = [];
  const byKey = new Map(old.map((n) => [n.key, n]));
  const nodes: RevisionPlanNode[] = [];
  const edges: { from: string; to: string }[] = [];
  for (const outcome of file.outcomes) {
    if ('reuse' in outcome) {
      const single = byKey.get(outcome.key);
      const members =
        single && !single.config.line
          ? [single]
          : old.filter((n) => n.config.line?.key === outcome.key);
      if (!members.length) problems.push(`沿用的「${outcome.key}」不是上一版的成果`);
      for (const member of members) {
        nodes.push({ key: member.key, reuse: member.key });
        edges.push(...oldEdges.filter((e) => e.to === member.key));
      }
      continue;
    }
    if (outcome.how === 'agent') {
      const { how: _how, needs, mode, ...rest } = outcome;
      const source = byKey.get(outcome.key);
      nodes.push({
        ...rest,
        kind: 'work',
        role: '',
        ...(source ? { from: outcome.key, mode: mode ?? 'continue' } : { mode: 'fresh' }),
      });
      edges.push(...needs.map((from) => ({ from, to: outcome.key })));
      continue;
    }
    const line = { key: outcome.key, title: outcome.title };
    for (const node of outcome.nodes) {
      const source = byKey.get(node.key);
      if ('reuse' in node) {
        if (source && source.config.line?.key !== outcome.key)
          problems.push(
            `沿用的「${node.key}」上一版不在生产线「${outcome.key}」里：生产线的 key 要和上一版一样`,
          );
        nodes.push({ key: node.key, reuse: node.key });
      } else nodes.push({ ...node, line, ...(source ? { from: node.key } : {}), mode: 'fresh' });
    }
    edges.push(...outcome.edges);
  }
  return {
    plan: { summary: file.summary, nodes, edges, deliverables: file.deliverables },
    problems,
  };
}

/** 方案里每个节点怎么处理，加上上一版有、方案里没有的（删掉） */
function changesOf(plan: RevisionPlan, old: Node[]): Changes {
  const byKey = new Map(old.map((n) => [n.key, n]));
  const kept = new Set(plan.nodes.map((n) => (isReuse(n) ? n.reuse : n.from)));
  return [
    ...plan.nodes.map((n) => ({
      key: n.key,
      title: isReuse(n) ? (byKey.get(n.reuse)?.title ?? n.key) : n.title,
      change: (isReuse(n) ? 'reuse' : n.from ? n.mode : 'new') as RevisionChange,
    })),
    ...old
      .filter((n) => !kept.has(n.key))
      .map((n) => ({ key: n.key, title: n.title, change: 'remove' as const })),
  ];
}

/**
 * 修改的规划门：方案格式、引用的上一版成果、沿用和接着改的条件，再按普通方案检查一遍（沿用的节点照搬，不重查）。
 * 通过时给出方案和每个节点的处理。
 */
export function checkRevisionPlan(
  text: string | undefined,
  input: {
    sheet: TaskSheet;
    catalog: CatalogEntry[];
    tools: ToolEntry[];
    environment?: ExecutionEnvironment;
    nodes: Node[];
    edges: Edge[];
  },
): { plan: RevisionPlan; changes: Changes } | { problems: string[] } {
  const read = readPlanJson(text);
  if ('problems' in read) return read;
  const parsed = RevisionPlanFile.safeParse(read.raw);
  if (!parsed.success) return { problems: issuesOf(parsed.error) };
  const { plan, problems } = flatten(parsed.data, input.nodes, keyEdges(input.nodes, input.edges));
  const old = new Map(input.nodes.map((n) => [n.key, n]));
  const reused = new Set<string>();
  const nodes: PlanNode[] = [];
  for (const entry of plan.nodes) {
    if (isReuse(entry)) {
      const source = old.get(entry.reuse);
      if (!source) {
        problems.push(`沿用的「${entry.reuse}」不是上一版的节点`);
        continue;
      }
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
    if (source && source.kind !== entry.kind)
      problems.push(`「${entry.key}」和上一版同名的节点类型不同：换一个 key，当新的排`);
    if (mode === 'continue' && source) {
      if (!kindOf(source).continuable || !source.currentRunId)
        problems.push(`只有上一版跑过的 agent 成果能接着原会话改（「${entry.key}」）`);
      else if (entry.model !== source.model)
        problems.push(`「${entry.key}」接着原会话改要用原来的模型 ${source.model}`);
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
      // 引用的可以是一个文件、一个目录或带 * 的一批文件：和关卡用同一套匹配
      if (source && !source.outputs.some((o) => patternRegExp(file.path).test(o.path)))
        problems.push(
          `沿用的「${file.from}」上一版没有交出 ${file.path}，节点「${node.key}」要用它`,
        );
    }
  if (problems.length) return { problems };
  const expected = new Map(withInputExpects(workflow).nodes.map((n) => [n.key, n.expects]));
  const withExpects: RevisionPlan = {
    ...plan,
    nodes: plan.nodes.map((n) =>
      isReuse(n) ? n : { ...n, expects: expected.get(n.key) ?? n.expects },
    ),
  };
  return { plan: withExpects, changes: changesOf(withExpects, input.nodes) };
}

/**
 * 意见指得到由 AI 做的成果时不经过规划员（ADR 0030 §3.8）：这些成果的 AI 接着原会话按意见改；用到它们的下游
 * 跟着更新（AI 做的接着原会话，其余重新跑；展开节点内容没变的条目沿用）；别的沿用。
 * targets 是意见针对的节点；没给时只有一样成果就是它。指不到、指到的不是能接着改的 AI 成果时返回 undefined。
 */
export function directRevision(input: {
  /** 工作流图里的节点 */
  nodes: Node[];
  edges: Edge[];
  deliverables: Record<string, string>;
  targets: string[];
}): { plan: RevisionPlan; changes: Changes } | undefined {
  const { nodes } = input;
  const targets = input.targets.length
    ? nodes.filter((n) => input.targets.includes(n.id))
    : nodes.length === 1
      ? nodes
      : [];
  const continuable = (n: Node) =>
    kindOf(n).continuable && !hasVariants(n) && Boolean(n.currentRunId);
  if (!targets.length || !targets.every((n) => n.kind === 'work' && continuable(n))) return;
  const edges = keyEdges(nodes, input.edges);
  const affected = new Set(targets.map((n) => n.key));
  for (let size = 0; size !== affected.size;) {
    size = affected.size;
    for (const edge of edges) if (affected.has(edge.from)) affected.add(edge.to);
  }
  const plan: RevisionPlan = {
    summary: `按意见修改「${targets.map((n) => n.title).join('」「')}」${
      affected.size > targets.length
        ? `，用到它的 ${affected.size - targets.length} 样成果跟着更新`
        : ''
    }`,
    nodes: nodes.map((n): RevisionPlanNode =>
      affected.has(n.key)
        ? { ...asPlanNode(n), from: n.key, mode: continuable(n) ? 'continue' : 'fresh' }
        : { key: n.key, reuse: n.key },
    ),
    edges,
    deliverables: input.deliverables,
  };
  return { plan, changes: changesOf(plan, nodes) };
}
