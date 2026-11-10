// 规划员（ADR 0005 §4）的纯函数部分：给规划员的说明、规划门（检查它写的 out/plan.json）、按方案估算花费。
// 规划员只排方案；方案对不对由代码检查，花费由代码按调用记录和供应商价格算（ADR 0016 §4），不让 AI 估。
import type { CatalogEntry, Playbook } from '@oasis/contracts/agent';
import type { ToolEntry } from '@oasis/contracts/model-gateway';
import { NodeKey, WorkflowPlan, type TaskSheet } from '@oasis/contracts/task';
import type { ToolArgSpec } from '@oasis/contracts/tool-args';
import { HttpError } from '@oasis/service-kit';
import { z } from 'zod';
import { validatePlan, withInputExpects } from './plan.ts';
import type { ExecutionEnvironment } from '@oasis/contracts/harness';
import { kindOf, type Rates } from './kinds/index.ts';
import { NODE_FORMAT_RULES } from './planner-rules.ts';
import { argRate, toolRate, type Fallback, type PricedModel } from './quote.ts';

export { NODE_FORMAT_RULES };

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(micro < 10_000 ? 4 : 2)}`;

/** 档次的中文名 */
const TIER_NAMES = {
  economy: '省钱',
  standard: '标准',
  premium: '精细',
  custom: '自定义',
} as const;

/** 预算：只讲事实——是参考不是上限，怎么取舍由规划员判断（ADR 0028） */
function budgetPart(sheet: TaskSheet): string {
  const budget = sheet.budget;
  return budget
    ? `【预算】用户选了「${TIER_NAMES[budget.tier]}」档：约 ${usd(budget.micro)}、${budget.minutes} 分钟左右。这是参考不是上限；方案的预估花费会显示给用户。`
    : '【预算】用户没有选预算档。';
}

/** 规划员写的方案：工作流 + 每样交付物由哪个节点负责 */
const PlannerPlan = WorkflowPlan.extend({
  deliverables: z.record(z.string(), NodeKey),
});
export type PlannerPlan = z.infer<typeof PlannerPlan>;

export const PLAN_FILE = 'plan.json';

/** 每个节点最多几条自查（2026-11-05 用户：小任务十几条检查不合理） */
const MAX_NODE_CHECKS = 5;

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
              `一个节点典型约 ${usd(m.node.costMicro)}${m.node.seconds ? `、${Math.max(1, Math.round(m.node.seconds / 60))} 分钟` : ''}`,
            ]
          : []),
        ...(m.tags.length ? [m.tags.join('、')] : []),
        ...(reads ? [reads.length ? `能直接读：${reads.join('、')}` : '只读文字'] : []),
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
                    // 单价随参数变的（视频按清晰度）列出各档，规划员按需要挑
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
    `【可以用的模型】（档次：旗舰是各家最强的型号；强力次一档，各有专长；快速是私聊用的轻量型号，最便宜也最快，复杂推理和写代码的能力弱于前两档）\n${models}`,
    `【可以用的工具】（干活节点里用 oasis-tool 调用，方案里写成 {"key":"image.generate","uses":3,"model":"型号"}；uses 是预计用几个计费单位——看下面单价「每X」的 X（张、秒、次、作业……），是数量不是金额，生成 3 张图就写 3；工具节点的步骤按「参数」写，* 是必填）\n${tools}`,
    ...(input.environment
      ? [
          `【沙箱环境】${JSON.stringify(input.environment)}\n节点依赖的本地能力写进 requires（只能填 capabilities 里有的）。`,
        ]
      : []),
    ...(input.playbooks.length
      ? [
          `【经验手册】（需要时读；节点看不到手册，节点要用的命令和格式写进它的 goal）\n${input.playbooks.map((p) => `- in/playbooks/${p.key}.md：${p.name}（${p.when}）`).join('\n')}`,
        ]
      : []),
  ];
}

/** 方案示例里的一个干活节点 */
export function exampleNode(key: string, title: string, goal: string, file: string, model: string) {
  return {
    key,
    title,
    kind: 'work',
    role: '',
    goal,
    model,
    tools: [],
    checks: [],
    expects: [file],
  };
}

/**
 * 给规划员的说明：只讲清任务、资源和方案格式，怎么排由规划员自己判断（用户 2026-11-07：规则只留最重要的）。
 * 不带倾向（ADR 0028，用户 2026-11-10）：不说节点、版数越少越好或越多越好，也不替它定用哪一档模型。
 */
export function plannerPrompt(
  input: PlannerResources & { brief: string; sheet: TaskSheet },
): string {
  const deliverable = input.sheet.deliverables[0]?.name ?? '交付物';
  const example = {
    nodes: [
      {
        ...exampleNode('draft', '写初稿', '……写成 out/初稿.md', '初稿.md', input.defaultModel),
        role: '资深文案',
        checks: ['开头一句话点明卖点'],
      },
      {
        ...exampleNode(
          'final',
          '定稿',
          '按 in/draft/初稿.md ……改成 out/成稿.md',
          '成稿.md',
          input.defaultModel,
        ),
        role: '主编',
        deliver: ['成稿.md'],
      },
    ],
    edges: [{ from: 'draft', to: 'final' }],
    deliverables: { [deliverable]: 'final' },
  };
  return [
    '你是 Oasis 的规划员。用户确认了下面的任务单，你来安排 AI 团队怎么做。',
    '排几个节点、用哪种节点、哪些同时做、要不要做几版、各用什么模型和工具，都由你按这件任务本身判断：没有越少越好，也没有越多越好。你只排方案，不要动手做或试跑实现，那是节点的事。',
    `【任务】\n${input.brief}`,
    `【任务单】\n${JSON.stringify(input.sheet)}`,
    budgetPart(input.sheet),
    ...resourceSections(input),
    [
      '【方案格式】写成 out/' + PLAN_FILE + '（只放 JSON），例如：',
      JSON.stringify(example, null, 2),
      ...NODE_FORMAT_RULES,
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

/** 规划门：检查规划员写的方案。返回方案，或者问题清单（普通话，会原样交回给规划员） */
export function checkPlan(
  text: string | undefined,
  sheet: TaskSheet,
  catalog: CatalogEntry[],
  tools: ToolEntry[],
  environment?: ExecutionEnvironment,
): { plan: PlannerPlan } | { problems: string[] } {
  const read = readPlanJson(text);
  if ('problems' in read) return read;
  const parsed = PlannerPlan.safeParse(read.raw);
  if (!parsed.success) return { problems: issuesOf(parsed.error) };
  const problems = workflowProblems(parsed.data, sheet, catalog, tools, environment);
  // 工具节点直接用的上游文件成为上游必须交出的文件（ADR 0025）
  return problems.length > 0 ? { problems } : { plan: withInputExpects(parsed.data) };
}

/**
 * 方案本身的问题：结构（重名、环、连线）、模型和工具能不能用、交付物有没有人交。
 * fixed 里的节点照搬上一版（修改时沿用的，ADR 0022），不再查模型、工具和自查条数。
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
        problems.push(`节点「${node.key}」要求的本地能力 ${required} 在当前环境不可用`);
    if (node.checks.length > MAX_NODE_CHECKS)
      problems.push(
        `节点「${node.key}」有 ${node.checks.length} 条 checks，最多 ${MAX_NODE_CHECKS} 条`,
      );
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

/**
 * 按方案估算花费（ADR 0016 §4）：干活节点按所选型号的典型花费，讨论按发言次数 + 汇总，
 * 加上工具（计费单位数 × 所选型号的单价）。不再额外乘系数：预算本身就是参考。
 * 同时给出每个节点的份额，用来按预算给节点分配。
 */
export function estimatePlan(
  plan: WorkflowPlan,
  models: PricedModel[],
  tools: ToolEntry[],
  fallback: Fallback,
): { totalMicro: number; perNode: Map<string, number> } {
  const byKey = new Map(tools.map((t) => [t.key, t]));
  const rates: Rates = {
    node: (model) =>
      models.find((m) => m.providerModel === model)?.node?.costMicro ?? fallback.workRun,
    tool(key, model, args) {
      const tool = byKey.get(key);
      return tool ? argRate(toolRate(tool, model), args) : 0;
    },
    per: (key) => byKey.get(key)?.per,
    speech: fallback.speechRun,
    compute: fallback.computeRun,
  };
  const perNode = new Map(plan.nodes.map((n) => [n.key, kindOf(n).estimate(n, rates)]));
  const totalMicro = Math.ceil([...perNode.values()].reduce((a, b) => a + b, 0));
  return { totalMicro, perNode };
}

/**
 * 方案估价超过任务单预算这么多倍，多半是规划员写错了数量（2026-11-10：$1.27 的 3D 任务估出 $5008——
 * 规划员把金额（微美元）写进了 uses，3d.render 写成 100000 次）。退回去核对。
 */
const OVER_BUDGET_TIMES = 5;
/** 前几次规划才因为估价退回；之后照收（预算只是参考，ADR 0016 §2），不让规划员一直改下去 */
export const BUDGET_CHECK_ATTEMPTS = 2;

/** 估价远超预算时交回给规划员的话：总价、倍数、最贵的几项工具用量；没超返回空 */
export function budgetProblems(
  plan: WorkflowPlan,
  sheet: TaskSheet,
  totalMicro: number,
  tools: ToolEntry[],
): string[] {
  const budget = sheet.budget?.micro;
  if (!budget || totalMicro <= budget * OVER_BUDGET_TIMES) return [];
  const byKey = new Map(tools.map((t) => [t.key, t]));
  const lines = plan.nodes
    .flatMap((n) => {
      if (n.kind === 'work') return n.tools.map((t) => ({ node: n.key, t, times: 1 }));
      if (n.kind === 'foreach' && n.each.kind === 'work')
        return n.each.tools.map((t) => ({ node: n.key, t, times: n.count }));
      return [];
    })
    .flatMap(({ node, t, times }) => {
      const tool = byKey.get(t.key);
      if (!tool) return [];
      const rate = toolRate(tool, t.model).costMicro;
      const micro = rate * t.uses * times;
      return [
        {
          micro,
          text: `节点「${node}」的 ${t.key}${times > 1 ? ' 每条' : ''} 写了 uses ${t.uses}（每${tool.unit}约 ${usd(rate)}，合计约 ${usd(micro)}）`,
        },
      ];
    })
    .sort((a, b) => b.micro - a.micro)
    .slice(0, 3)
    .map((l) => l.text);
  return [
    `方案估价约 ${usd(totalMicro)}，是任务单预算 ${usd(budget)} 的 ${Math.round(totalMicro / budget)} 倍。` +
      (lines.length ? `最贵的：${lines.join('；')}。` : '') +
      'uses 是数量（几张、几秒、几次），不是金额；请核对各项数量，写错了就改。',
  ];
}
