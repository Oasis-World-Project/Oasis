// 中途调整（ADR 0030 §3.7）：做成果的 AI 发现要动别的成果才做得好时提一次（要什么、为什么），规划员答一次，
// 同意的改动马上生效，不问用户。这里是给规划员的说明、答复的格式和检查（都是纯函数）；
// 开运行、把答复写回去在 planning-service.ts，把改动落到工作流上在 engine/adjust.ts。
// 第一版支持三种改动：加一样成果、给没做完的成果补说明、停掉一样成果；不做合并，不撤销做完的成果。
import type { CatalogEntry } from '@oasis/contracts/agent';
import type { ExecutionEnvironment } from '@oasis/contracts/harness';
import type { ToolEntry } from '@oasis/contracts/model-gateway';
import { NodeKey, Outcome, type TaskSheet } from '@oasis/contracts/task';
import { z } from 'zod';
import type { Node, Snapshot } from '../repo/task-store.ts';
import type { Adjustment } from './effects.ts';
import { isGroup, isRoot } from './groups.ts';
import { isOpen } from './kinds/common.ts';
import { OUTCOME_FORMAT_RULES } from './planner-rules.ts';
import {
  issuesOf,
  resourceSections,
  toWorkflow,
  workflowProblems,
  type PlannerResources,
} from './planner.ts';
import { asPlanNode } from './revision-planner.ts';

/** 不会再变的节点状态（和引擎里的一致） */
const FINAL: Node['status'][] = ['succeeded', 'failed', 'cancelled'];

/** 规划员把答复写在这个文件里 */
export const ADJUST_FILE = 'adjust.json';

const AdjustFile = z.object({
  /** 给提出调整的 AI 的答复：同意了什么、没同意什么、为什么 */
  reply: z.string().trim().min(1).max(2000),
  /** 要加的成果，写法和排方案时一样 */
  add: z.array(Outcome).max(8).default([]),
  /** 任务单上的交付物改由谁交付：交付物名 → 成果（节点）的 key */
  deliverables: z.record(z.string(), NodeKey).default({}),
  /** 给还没做完的成果补说明 */
  instruct: z
    .array(z.object({ key: NodeKey, text: z.string().trim().min(1).max(4000) }))
    .default([]),
  /** 停掉的成果：节点的 key，或生产线的 key（整条线） */
  stop: z.array(NodeKey).default([]),
});

type Edges = Snapshot['edges'];

/** 现在的工作流（只有工作流图里的节点）和任务单上的交付物各由谁交付 */
interface CurrentWorkflow {
  nodes: Node[];
  edges: Edges;
  deliverables: Record<string, string>;
}

/** 从任务现在的样子取出工作流：子节点跟着父节点，不单列 */
export function workflowOf(snapshot: Snapshot): CurrentWorkflow {
  const roots = snapshot.nodes.filter(isRoot);
  const keyOf = new Map(roots.map((n) => [n.id, n.key]));
  return {
    nodes: roots,
    edges: snapshot.edges,
    deliverables: Object.fromEntries(
      snapshot.task.deliverables.flatMap((d) =>
        d.nodeId && keyOf.has(d.nodeId) ? [[d.name, keyOf.get(d.nodeId)!]] : [],
      ),
    ),
  };
}

const STATUS: Record<Node['status'], string> = {
  waiting: '还没开始',
  running: '正在做',
  checking: '做完了，正在检查',
  succeeded: '做完了',
  failed: '失败了',
  stopped: '停下了',
  cancelled: '取消了',
};

const clip = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** 现在的工作流写给规划员看：每个节点一条（生产线的节点注明属于哪条线） */
function outline({ nodes, edges, deliverables }: CurrentWorkflow): string {
  const keyOf = new Map(nodes.map((n) => [n.id, n.key]));
  return nodes
    .map((n) => {
      const needs = edges
        .filter((e) => e.toNodeId === n.id)
        .flatMap((e) => keyOf.get(e.fromNodeId ?? '') ?? []);
      const delivers = Object.entries(deliverables).flatMap(([name, key]) =>
        key === n.key ? [name] : [],
      );
      const how = n.config.line
        ? `生产线 ${n.config.line.key}「${n.config.line.title}」里的${n.kind === 'foreach' ? '展开' : '工具'}节点`
        : n.kind === 'work'
          ? `一个 AI（${n.model}）`
          : n.kind;
      const facts = [
        how,
        STATUS[n.status],
        ...(needs.length ? [`要用：${needs.join('、')}`] : []),
        ...(delivers.length ? [`交付：${delivers.join('、')}`] : []),
      ];
      return `- ${n.key}「${n.title}」：${facts.join('；')}\n  要做的事：${clip(n.goal, 400)}`;
    })
    .join('\n');
}

/** 给规划员的说明：只讲清现在的工作流、提出的调整和答复格式，同意不同意由它判断（ADR 0028） */
export function adjustPrompt(
  input: PlannerResources &
    CurrentWorkflow & { brief: string; sheet: TaskSheet; from: Node; want: string; why: string },
): string {
  const example = {
    reply: '同意……（或：不同意，因为……）',
    add: [],
    deliverables: {},
    instruct: [{ key: '某样成果的 key', text: '补给它的说明' }],
    stop: [],
  };
  return [
    `你是 Oasis 的规划员。这件任务正在按之前排的方案做，做「${input.from.title}」的 AI 提出了一条要动别的成果的调整。你答复一次：同意、改一改再同意、或不同意，都写明理由；它不会再来回商量。它自己那样成果里怎么做由它定，不归你管。你只写答复，不要动手做。`,
    `【任务】\n${input.brief}`,
    `【任务单】\n${JSON.stringify(input.sheet)}`,
    `【现在的工作流】\n${outline(input)}`,
    `【提出的调整】来自 ${input.from.key}「${input.from.title}」\n要什么：${input.want}\n为什么：${input.why}`,
    ...resourceSections(input),
    [
      `【答复格式】写成 out/${ADJUST_FILE}（只放 JSON），例如：`,
      JSON.stringify(example, null, 2),
      '- reply：给提出调整的 AI 的答复，说清同意了什么、没同意什么、为什么。',
      '- add、instruct、stop 都可以是空的；都空就是不改工作流，只答复。写了的改动马上生效，不再问用户。',
      '- add：要加的成果，写法和排方案时一样（见下面几条）；needs 可以写现在已有的节点。已经开跑的成果拿不到新成果的文件（文件在开跑时交进去）。新成果交付任务单上的东西时，在 deliverables 里写「交付物名」→ 新成果的 key。',
      '- instruct：给还没做完的成果补说明，key 写【现在的工作流】里的；正在做的 AI 马上收到，还没开始的开跑时带上。工具节点和展开节点没有 AI，不能补说明。',
      '- stop：停掉还没做完的成果（写生产线的 key 就是整条线）；还有没停的成果要用它交出的文件时不能停。停掉的是任务单上的交付物时，在 deliverables 里写改由哪样成果交付。',
      '- 不能合并成果，不能撤销已经做完的成果。',
      ...OUTCOME_FORMAT_RULES,
    ].join('\n'),
    '写完用一句话说明你的答复。',
  ].join('\n\n');
}

/** 现在能不能提出调整；不能时返回给提出的 AI 的原因 */
export function adjustRefusal(
  snapshot: Snapshot,
  node: Node | undefined,
  runId: string,
): string | undefined {
  const { task } = snapshot;
  if (!task.sheet) return '这个任务没有任务单，不能调整';
  if (task.status !== 'running' || task.revision)
    return '任务现在不在运行（已结束、已停下或正在修改），不能调整';
  if (!node || node.kind !== 'work' || !isRoot(node) || isGroup(node))
    return '只有一个 AI 从头做到交付的成果能提出调整';
  if (node.status !== 'running' || node.currentRunId !== runId)
    return '提出调整的这次运行已经不是这样成果当前的运行';
  if (snapshot.activeRuns.some((r) => isOpen(r) && r.purpose === 'adjust'))
    return '规划员正在答复另一条调整，等它答完再提';
  return undefined;
}

/** 检查规划员写的答复。返回要落到工作流上的改动，或者问题清单（普通话） */
export function checkAdjust(
  text: string | undefined,
  ctx: CurrentWorkflow & {
    sheet: TaskSheet;
    catalog: CatalogEntry[];
    tools: ToolEntry[];
    environment?: ExecutionEnvironment;
  },
): Adjustment | { problems: string[] } {
  if (text === undefined) return { problems: [`规划员没有写 out/${ADJUST_FILE}`] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { problems: [`out/${ADJUST_FILE} 不是合法的 JSON`] };
  }
  const parsed = AdjustFile.safeParse(raw);
  if (!parsed.success) return { problems: issuesOf(parsed.error) };
  const file = parsed.data;
  const problems: string[] = [];
  const byId = new Map(ctx.nodes.map((n) => [n.id, n]));
  const open = (n: Node) => !FINAL.includes(n.status);

  const stopped = [...new Set(file.stop)].flatMap((key) => {
    const hit = ctx.nodes.filter((n) => n.key === key || n.config.line?.key === key);
    if (!hit.length) problems.push(`stop 里的「${key}」不在现在的工作流里`);
    for (const n of hit) if (!open(n)) problems.push(`「${n.key}」已经结束了，不能停`);
    return hit;
  });
  const gone = new Set(stopped.map((n) => n.id));
  for (const edge of ctx.edges) {
    const from = byId.get(edge.fromNodeId ?? '');
    const to = byId.get(edge.toNodeId ?? '');
    if (from && to && gone.has(from.id) && !gone.has(to.id) && open(to))
      problems.push(`「${to.key}」还要用「${from.key}」交出的文件，不能只停「${from.key}」`);
  }

  const instructed = file.instruct.flatMap(({ key, text: note }) => {
    const node = ctx.nodes.find((n) => n.key === key);
    if (!node) problems.push(`instruct 里的「${key}」不在现在的工作流里`);
    else if (node.kind !== 'work' || isGroup(node)) problems.push(`「${key}」没有 AI，不能补说明`);
    else if (!['waiting', 'running', 'stopped'].includes(node.status) || gone.has(node.id))
      problems.push(`「${key}」已经做完或停掉了，不能补说明`);
    return node ? [{ node, text: note }] : [];
  });

  const added = toWorkflow({ outcomes: file.add, deliverables: {} });
  for (const edge of added.edges)
    if (stopped.some((n) => n.key === edge.from))
      problems.push(`新成果「${edge.to}」要用的「${edge.from}」写在 stop 里`);
  for (const [name, key] of Object.entries(file.deliverables)) {
    const before = ctx.deliverables[name];
    if (!ctx.sheet.deliverables.some((d) => d.name === name))
      problems.push(`deliverables 里的「${name}」不是任务单上的交付物`);
    else if (before && before !== key && !stopped.some((n) => n.key === before))
      problems.push(`交付物「${name}」已经由「${before}」交付；要换先在 stop 里停掉它`);
  }
  const deliverables = { ...ctx.deliverables, ...file.deliverables };
  for (const node of stopped)
    for (const [name, key] of Object.entries(deliverables))
      if (key === node.key)
        problems.push(
          `「${node.key}」交付任务单上的「${name}」，停掉它要在 deliverables 里写改由哪样成果交付`,
        );

  // 新成果和现在的工作流拼在一起，按规划门的规则查；现有的节点照旧，不再查模型和工具
  const keyOf = new Map(ctx.nodes.map((n) => [n.id, n.key]));
  problems.push(
    ...workflowProblems(
      {
        nodes: [...ctx.nodes.map(asPlanNode), ...added.nodes],
        edges: [
          ...ctx.edges.flatMap((e) => {
            const from = keyOf.get(e.fromNodeId ?? '');
            const to = keyOf.get(e.toNodeId ?? '');
            return from && to ? [{ from, to }] : [];
          }),
          ...added.edges,
        ],
        deliverables,
      },
      ctx.sheet,
      ctx.catalog,
      ctx.tools,
      ctx.environment,
      new Set(ctx.nodes.map((n) => n.key)),
    ),
  );
  if (problems.length) return { problems };
  return {
    reply: file.reply,
    added: { ...added, titles: file.add.map((o) => o.title) },
    instructed,
    stopped,
    deliverables: file.deliverables,
  };
}

/** 写回给提出调整的 AI 的话：规划员的答复，加上实际生效的改动 */
export function replyOf(a: Adjustment): string {
  const names = (titles: string[]) => [...new Set(titles)].map((t) => `「${t}」`).join('、');
  const done = [
    ...(a.added.titles.length ? [`新加了${names(a.added.titles)}`] : []),
    ...(a.instructed.length ? [`给${names(a.instructed.map((i) => i.node.title))}补了说明`] : []),
    ...(a.stopped.length
      ? [`停掉了${names(a.stopped.map((n) => n.config.line?.title ?? n.title))}`]
      : []),
  ];
  return `${a.reply}\n（${done.length ? `已生效：${done.join('；')}` : '工作流没有改动'}）`;
}

/** 节点上给用户看的一句：这样成果被调整过什么（asking：规划员还在答复） */
export const adjustNote = (text: string, asking = false) => ({ asking, note: clip(text) });
