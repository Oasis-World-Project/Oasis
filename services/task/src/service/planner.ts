// 规划员的纯函数部分：给规划员的说明、规划门（检查它写的 out/plan.json）。
// 规划员只定有几样成果、每样怎么做、用什么型号、谁用谁交出的文件；不排步骤、不估价。
// 方案通过后变成引擎里的节点和连线：一个 AI 做的成果是一个干活节点，生产线是它的工具节点和展开节点。
import type { CatalogEntry, Playbook } from '@oasis/contracts/agent';
import type { ExecutionEnvironment } from '@oasis/contracts/harness';
import type { ModelCapabilities, ToolEntry, ToolRate } from '@oasis/contracts/model-gateway';
import {
  OutcomePlan,
  type PlanNode,
  type TaskSheet,
  type WorkflowPlan,
} from '@oasis/contracts/task';
import type { ToolArgSpec } from '@oasis/contracts/tool-args';
import { HttpError } from '@oasis/service-kit';
import type { z } from 'zod';
import { kindOf } from './kinds/index.ts';
import { validatePlan, withInputExpects } from './plan.ts';
import { OUTCOME_FORMAT_RULES } from './planner-rules.ts';

export { OUTCOME_FORMAT_RULES };

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(micro < 10_000 ? 4 : 2)}`;

/** 规划员能挑的型号，加上调用记录里它干一次活的典型花费和用时 */
export type PricedModel = CatalogEntry & {
  node?: ModelCapabilities['node'];
  measured?: ModelCapabilities['measured'];
};

/** 引擎用的方案：节点、连线，以及每样交付物由哪个节点负责 */
export type PlannerPlan = WorkflowPlan & { deliverables: Record<string, string> };

export const PLAN_FILE = 'plan.json';

/** 规划员能用的资源：模型、工具、沙箱环境、经验手册（第一次规划和修改规划共用） */
export interface PlannerResources {
  catalog: PricedModel[];
  /** 现在能用的外部工具 */
  tools: ToolEntry[];
  /** 场景经验手册的名字和适用范围；全文放在 in/playbooks/<key>.md，由规划员自己挑着读 */
  playbooks: Pick<Playbook, 'key' | 'name' | 'when'>[];
  defaultModel: string;
  environment?: ExecutionEnvironment;
}

/** 工具某个型号的单价；没指定型号按目录默认型号，没有单价用目录的兜底值 */
function toolRate(tool: ToolEntry, model?: string): ToolRate {
  const wanted = model ?? tool.defaultModel ?? '';
  return (
    tool.rates.find((r) => r.model === wanted) ??
    tool.rates[0] ?? {
      model: wanted,
      costMicro: tool.estimateMicro,
      seconds: null,
      basis: 'fallback',
    }
  );
}

/** 工具的参数写成一行给规划员看：名字、必填（*）和形状 */
function argsText(args: ToolArgSpec[]): string {
  const range = (a: ToolArgSpec) =>
    a.min !== undefined || a.max !== undefined ? ` ${a.min ?? ''}–${a.max ?? ''}` : '';
  const shape = (a: ToolArgSpec) => {
    switch (a.kind) {
      case 'number':
        return `数字${range(a)}`;
      case 'flag':
        return 'true/false';
      case 'choice':
        return (a.choices ?? []).join('|');
      case 'path':
        return '文件';
      case 'dir':
        return '目录';
      case 'paths':
        return `文件数组${range(a)}`;
      case 'list':
        return `数组${range(a)}`;
      case 'json':
        return 'JSON';
      default:
        return '文字';
    }
  };
  return args
    .map((a) => `${a.name}${a.required ? '*' : ''}（${shape(a)}；${a.description}）`)
    .join('、');
}

export function resourceSections(input: PlannerResources): string[] {
  const TIER = { flagship: '旗舰', strong: '强力', fast: '快速' } as const;
  const models = input.catalog
    .map((m) => {
      const reads = m.inputs?.filter((i) => i !== 'text');
      const notes = [
        ...(m.tier ? [TIER[m.tier]] : []),
        ...(m.node
          ? [
              `调用记录里干一次活约 ${usd(m.node.costMicro)}${m.node.seconds ? `、${Math.max(1, Math.round(m.node.seconds / 60))} 分钟` : ''}`,
            ]
          : []),
        // 实测：只写量出来的数，哪个型号更擅长哪类活没有数据，不写
        ...(m.measured
          ? [
              `最近 ${m.measured.calls} 次调用实测每秒输出约 ${m.measured.tokensPerSecond} 个 token、每百万 token 约 ${usd(m.measured.microPerMTok)}（含缓存折扣）${
                m.measured.failureRate >= 0.005
                  ? `、上游出错 ${(m.measured.failureRate * 100).toFixed(1)}%`
                  : ''
              }`,
            ]
          : []),
        ...(m.tags.length ? [m.tags.join('、')] : []),
        ...(reads ? [reads.length ? '能直接看图' : '只读文字'] : []),
      ];
      return `- ${m.providerModel}（${m.name}，${m.vendor}${notes.length ? `；${notes.join('；')}` : ''}）`;
    })
    .join('\n');
  const tools = input.tools.length
    ? input.tools
        .map((t) => {
          const rates = t.local
            ? '沙箱里的本地操作，不花工具钱'
            : t.rates.length
              ? t.rates
                  .map((r) => {
                    // 单价随参数变的（视频按清晰度）列出各档
                    const tiers = r.by
                      ? `（${r.by.arg} ${Object.entries(r.by.costMicro)
                          .map(([value, micro]) => `${value} ${usd(micro)}`)
                          .join('、')}）`
                      : '';
                    return `${r.model} 每${t.unit}约 ${usd(r.costMicro)}${tiers}${r.seconds ? `、一次约 ${r.seconds} 秒` : ''}`;
                  })
                  .join('；')
              : `每${t.unit}约 ${usd(toolRate(t).costMicro)}`;
          const args = t.args.length ? `\n  参数：${argsText(t.args)}` : '';
          return `- ${t.key}（${t.name}）：${t.description}\n  ${t.local ? '' : '型号与单价：'}${rates}${args}`;
        })
        .join('\n')
    : '（现在没有可用的工具）';
  return [
    `【可以用的模型】（档次是各家自己的产品定位：旗舰、强力、快速。做成果的 AI 最多能直接看图；视频、音频不管哪个型号都读不了，要用 media.inspect 交给能看能听的型号，只读文字的型号看图也要靠它）\n${models}`,
    `【可以用的工具】（做成果的 AI 在沙箱里用 oasis-tool 调用，用哪些、用多少由它自己定；生产线里工具节点的步骤按「参数」写，* 是必填）\n${tools}`,
    ...(input.environment
      ? [
          `【沙箱环境】${JSON.stringify(input.environment)}\n成果依赖的本地能力写进 requires（只能填 capabilities 里有的）。`,
        ]
      : []),
    ...(input.playbooks.length
      ? [
          `【经验手册】（需要时读；做成果的 AI 看不到手册，它要用的命令和格式写进它的 goal）\n${input.playbooks.map((p) => `- in/playbooks/${p.key}.md：${p.name}（${p.when}）`).join('\n')}`,
        ]
      : []),
  ];
}

/** 方案示例里一样由一个 AI 做的成果 */
export function exampleOutcome(
  key: string,
  title: string,
  goal: string,
  file: string,
  model: string,
) {
  return { key, title, how: 'agent', goal, model, expects: [file], deliver: [file] };
}

/**
 * 给规划员的说明：只讲清任务、资源和方案格式，怎么排由规划员自己判断（用户 2026-11-07：规则只留最重要的）。
 * 不带倾向（用户 2026-11-10）：不说成果越少越好或越多越好，也不替它定用哪一档模型。
 */
export function plannerPrompt(
  input: PlannerResources & { brief: string; sheet: TaskSheet },
): string {
  const deliverable = input.sheet.deliverables[0]?.name ?? '交付物';
  const example = {
    outcomes: [
      exampleOutcome('main', deliverable, '……做成 out/成稿.md', '成稿.md', input.defaultModel),
    ],
    deliverables: { [deliverable]: 'main' },
  };
  return [
    '你是 Oasis 的规划员。用户确认了下面的任务单，你来定这件任务分成几样成果、每样怎么做。',
    '分成几样成果、每样由一个 AI 做还是由生产线做、用什么型号、谁要用谁交出的文件，都由你按这件任务本身判断。你只排方案，不要动手做或试跑实现。',
    `【任务】\n${input.brief}`,
    `【任务单】\n${JSON.stringify(input.sheet)}`,
    ...resourceSections(input),
    [
      '【方案格式】写成 out/' + PLAN_FILE + '（只放 JSON），例如：',
      JSON.stringify(example, null, 2),
      ...OUTCOME_FORMAT_RULES,
    ].join('\n'),
    '写完用一两句话说明你的安排。',
  ].join('\n\n');
}

/** 规划门没过：接着原会话让规划员改 */
export function revisePrompt(problems: string[]): string {
  return [
    `你写的 out/${PLAN_FILE} 有问题：`,
    ...problems.map((p) => `- ${p}`),
    '',
    `请改好 out/${PLAN_FILE}，改完用一句话说明改了什么。`,
  ].join('\n');
}

/** 读出规划员写的 JSON；不存在、不是 JSON 时给出问题 */
export function readPlanJson(text: string | undefined): { raw: unknown } | { problems: string[] } {
  if (text === undefined) return { problems: [`没有找到 out/${PLAN_FILE}`] };
  try {
    return { raw: JSON.parse(text) };
  } catch {
    return { problems: [`out/${PLAN_FILE} 不是合法的 JSON`] };
  }
}

/** zod 的问题 → 交回给规划员的话 */
export const issuesOf = (error: z.ZodError) =>
  error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '整体'}：${i.message}`);

/** 按成果排的方案 → 引擎的节点和连线：一个 AI 做的成果是一个干活节点，生产线的节点记下属于哪条线 */
export function toWorkflow(plan: OutcomePlan): PlannerPlan {
  const nodes: PlanNode[] = [];
  const edges: { from: string; to: string }[] = [];
  for (const outcome of plan.outcomes) {
    if (outcome.how === 'agent') {
      const { how: _how, needs, ...rest } = outcome;
      nodes.push({ ...rest, kind: 'work', role: '' });
      edges.push(...needs.map((from) => ({ from, to: outcome.key })));
      continue;
    }
    const line = { key: outcome.key, title: outcome.title };
    nodes.push(...outcome.nodes.map((node) => ({ ...node, line })));
    edges.push(...outcome.edges);
  }
  return { nodes, edges, deliverables: plan.deliverables };
}

/**
 * 成果这一层的问题：成果和节点重名、生产线的连线接到了线外、一样成果拆给两个 AI 接力。
 * fixed 里是修改时沿用的成果，不再查。
 */
function outcomeProblems(plan: OutcomePlan, fixed: ReadonlySet<string> = new Set()): string[] {
  const problems: string[] = [];
  const workflow = toWorkflow(plan);
  const nodeKeys = workflow.nodes.map((n) => n.key);
  const lines = plan.outcomes.filter((o) => o.how === 'line');
  const clash = lines
    .map((o) => o.key)
    .filter((key, i, all) => nodeKeys.includes(key) || all.indexOf(key) !== i);
  if (clash.length) problems.push(`成果和节点的 key 不能重复：${[...new Set(clash)].join('、')}`);
  for (const line of lines) {
    const inside = new Set(line.nodes.map((n) => n.key));
    for (const edge of line.edges)
      if (!inside.has(edge.to))
        problems.push(
          `生产线「${line.key}」的连线 ${edge.from} → ${edge.to} 终点不在这条线里：别的成果要用它交出的文件，在那样成果的 needs 里写`,
        );
  }
  const agents = new Set(plan.outcomes.filter((o) => o.how === 'agent').map((o) => o.key));
  const delivered = new Set(Object.values(plan.deliverables));
  for (const key of agents) {
    if (delivered.has(key) || fixed.has(key)) continue;
    const users = workflow.edges.filter((e) => e.from === key).map((e) => e.to);
    if (users.length === 0) problems.push(`成果「${key}」不是任务单上的交付物，也没有别的成果用它`);
    else if (users.length === 1 && agents.has(users[0]!))
      problems.push(
        `成果「${key}」不是任务单上的交付物，又只有「${users[0]}」用它：一样成果不拆给两个 AI 接力，把它并进「${users[0]}」，由那个 AI 自己做`,
      );
  }
  return problems;
}

/** 规划门：检查规划员写的方案。返回引擎用的方案，或者问题清单（普通话，会原样交回给规划员） */
export function checkPlan(
  text: string | undefined,
  sheet: TaskSheet,
  catalog: CatalogEntry[],
  tools: ToolEntry[],
  environment?: ExecutionEnvironment,
): { plan: PlannerPlan } | { problems: string[] } {
  const read = readPlanJson(text);
  if ('problems' in read) return read;
  const parsed = OutcomePlan.safeParse(read.raw);
  if (!parsed.success) return { problems: issuesOf(parsed.error) };
  const workflow = toWorkflow(parsed.data);
  const problems = [
    ...outcomeProblems(parsed.data),
    ...workflowProblems(workflow, sheet, catalog, tools, environment),
  ];
  // 工具节点直接用的上游文件成为上游必须交出的文件
  return problems.length > 0 ? { problems } : { plan: withInputExpects(workflow) };
}

/**
 * 节点和连线的问题：结构（重名、环、连线）、模型和工具能不能用、交付物有没有人交。
 * fixed 里的节点照搬上一版（修改时沿用的），不再查模型和工具。
 */
export function workflowProblems(
  plan: PlannerPlan,
  sheet: TaskSheet,
  catalog: CatalogEntry[],
  tools: ToolEntry[],
  environment?: ExecutionEnvironment,
  fixed: ReadonlySet<string> = new Set(),
): string[] {
  const problems: string[] = [];
  try {
    validatePlan(plan);
  } catch (err) {
    problems.push(err instanceof HttpError ? err.message : String(err));
  }
  const checked = plan.nodes.filter((n) => !fixed.has(n.key));
  const usable = new Set(catalog.map((m) => m.providerModel));
  const used = checked.flatMap((n) => kindOf(n).models(n));
  for (const model of new Set(used)) {
    if (!usable.has(model)) problems.push(`模型 ${model} 不在可以用的模型里`);
  }
  const usableTools = new Map(tools.map((t) => [t.key, t]));
  for (const node of checked) {
    for (const required of node.requires ?? [])
      if (environment && !environment.capabilities.includes(required))
        problems.push(`「${node.key}」要求的本地能力 ${required} 在当前环境不可用`);
    problems.push(...kindOf(node).toolProblems(node, usableTools));
  }
  const keys = new Set(plan.nodes.map((n) => n.key));
  for (const d of sheet.deliverables) {
    const owner = plan.deliverables[d.name];
    if (!owner) problems.push(`交付物「${d.name}」没有指定由哪个节点交出`);
    else if (!keys.has(owner)) problems.push(`交付物「${d.name}」指定的节点「${owner}」不存在`);
    else if (plan.nodes.find((n) => n.key === owner)?.kind === 'foreach')
      problems.push(
        `交付物「${d.name}」不能由展开节点「${owner}」直接交出：在后面加一个节点把各条汇总（拼接、整理）后交付`,
      );
    else if (!plan.nodes.find((n) => n.key === owner)?.deliver?.length)
      problems.push(`交付物「${d.name}」的节点「${owner}」没有指定最终 deliver 文件`);
  }
  return problems;
}
