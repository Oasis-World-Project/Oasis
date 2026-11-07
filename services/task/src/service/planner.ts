// 规划员（ADR 0005 §4）的纯函数部分：给规划员的说明、规划门（检查它写的 out/plan.json）、按方案估算花费。
// 规划员只排方案；方案对不对由代码检查，花费由代码按调用记录和供应商价格算（ADR 0016 §4），不让 AI 估。
import type { CatalogEntry, Playbook } from '@oasis/contracts/agent';
import type { ToolEntry } from '@oasis/contracts/model-gateway';
import { NodeKey, WorkflowPlan, type TaskSheet } from '@oasis/contracts/task';
import { HttpError } from '@oasis/service-kit';
import { z } from 'zod';
import { validatePlan } from './plan.ts';
import type { ExecutionEnvironment } from '@oasis/contracts/harness';
import { toolRate, type Fallback, type PricedModel } from './quote.ts';

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(micro < 10_000 ? 4 : 2)}`;

/** 档次的中文名 */
const TIER_NAMES = {
  economy: '省钱',
  standard: '标准',
  premium: '精细',
  custom: '自定义',
} as const;

/** 预算：一句话，是参考不是上限 */
function budgetPart(sheet: TaskSheet): string {
  const budget = sheet.budget;
  return budget
    ? `【预算】用户选了「${TIER_NAMES[budget.tier]}」档：约 ${usd(budget.micro)}、${budget.minutes} 分钟左右。这是参考不是上限，按它挑模型和工具。`
    : '【预算】用户没有选预算档，按常规质量安排。';
}

/** 规划员写的方案：工作流 + 每样交付物由哪个节点负责 */
const PlannerPlan = WorkflowPlan.extend({
  deliverables: z.record(z.string(), NodeKey),
});
export type PlannerPlan = z.infer<typeof PlannerPlan>;

export const PLAN_FILE = 'plan.json';

/** 每个节点最多几条自查（2026-11-05 用户：小任务十几条检查不合理） */
const MAX_NODE_CHECKS = 5;

/** 给规划员的说明：只讲清任务、资源和方案格式，怎么排由规划员自己判断（用户 2026-11-07：规则只留最重要的） */
export function plannerPrompt(input: {
  brief: string;
  sheet: TaskSheet;
  catalog: PricedModel[];
  /** 现在能用的外部工具 */
  tools: ToolEntry[];
  /** 场景经验手册的名字和适用范围；全文放在 in/playbooks/<key>.md，由规划员自己挑着读 */
  playbooks: Pick<Playbook, 'key' | 'name' | 'when'>[];
  defaultModel: string;
  environment?: ExecutionEnvironment;
}): string {
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
          const rates = t.rates.length
            ? t.rates
                .map(
                  (r) =>
                    `${r.model} 每${t.unit}约 ${usd(r.costMicro)}${r.seconds ? `、一次约 ${r.seconds} 秒` : ''}`,
                )
                .join('；')
            : `每${t.unit}约 ${usd(toolRate(t).costMicro)}`;
          return `- ${t.key}（${t.name}）：${t.description}\n  型号与单价：${rates}`;
        })
        .join('\n')
    : '（现在没有可用的工具）';
  const deliverable = input.sheet.deliverables[0]?.name ?? '交付物';
  const example = {
    nodes: [
      {
        key: 'draft',
        title: '写初稿',
        kind: 'work',
        role: '资深文案',
        goal: '……写成 out/初稿.md',
        model: input.defaultModel,
        tools: [],
        checks: ['开头一句话点明卖点'],
        expects: ['初稿.md'],
      },
      {
        key: 'final',
        title: '定稿',
        kind: 'work',
        role: '主编',
        goal: '按 in/draft/初稿.md ……改成 out/成稿.md',
        model: input.defaultModel,
        tools: [],
        checks: [],
        expects: ['成稿.md'],
        deliver: ['成稿.md'],
      },
    ],
    edges: [{ from: 'draft', to: 'final' }],
    deliverables: { [deliverable]: 'final' },
  };
  return [
    '你是 Oasis 的规划员。用户确认了下面的任务单，你来安排 AI 团队怎么做。',
    '用最简单、能把交付物做好的方案：简单任务一个节点就够，确实需要分工或并行才拆。你只排方案，不要动手做或试跑实现，那是节点的事。',
    '省钱靠少排节点、少做几版，不靠换弱模型：写代码、做 3D、做网页这类难活用旗舰或强力档模型。',
    `【任务】\n${input.brief}`,
    `【任务单】\n${JSON.stringify(input.sheet)}`,
    budgetPart(input.sheet),
    `【可以用的模型】\n${models}`,
    `【可以用的工具】（节点里用 oasis-tool 调用；方案里写成 {"key":"image.generate","uses":预计计费单位数,"model":"型号"}）\n${tools}`,
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
    [
      '【方案格式】写成 out/' + PLAN_FILE + '（只放 JSON），例如：',
      JSON.stringify(example, null, 2),
      '- kind：work 是一个 AI 在独立容器里做一件事，成果写到 out/；discussion 是几位参与者（各自的模型和立场）讨论几轮、由 model 汇总，只在真要权衡取舍时用。',
      '- 连线 from → to：上游的 out/ 放进下游的 in/<上游 key>/；没有连线的节点同时开跑。',
      `- deliverables：任务单上每样交付物都指定由哪个节点交出；那个节点要写 deliver（最终交付的文件路径，可用 * 通配，* 只匹配一层，** 递归）。`,
      '- expects：节点必须产出的文件（可写 {"pattern":"图/*.png","minCount":4} 这类数量要求），系统会核对。checks：可选，节点交付前自己看一眼的几件事，最多 5 条。',
      '- goal 写清这个节点要做什么、交出什么文件；节点不能再问用户。key 只用英文字母、数字、下划线、短横线。',
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

/** 规划门：检查规划员写的方案。返回方案，或者问题清单（普通话，会原样交回给规划员） */
export function checkPlan(
  text: string | undefined,
  sheet: TaskSheet,
  catalog: CatalogEntry[],
  tools: ToolEntry[],
  environment?: ExecutionEnvironment,
): { plan: PlannerPlan } | { problems: string[] } {
  if (text === undefined) return { problems: [`没有找到 out/${PLAN_FILE}`] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { problems: [`out/${PLAN_FILE} 不是合法的 JSON`] };
  }
  const parsed = PlannerPlan.safeParse(raw);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join('.') || '整体'}：${i.message}`),
    };
  }
  const plan = parsed.data;
  const problems: string[] = [];
  try {
    validatePlan(plan);
  } catch (err) {
    problems.push(err instanceof HttpError ? err.message : String(err));
  }
  const usable = new Set(catalog.map((m) => m.providerModel));
  const used = plan.nodes.flatMap((n) => [
    n.model,
    ...(n.kind === 'discussion' ? n.participants.map((p) => p.model) : []),
  ]);
  for (const model of new Set(used)) {
    if (!usable.has(model)) problems.push(`模型 ${model} 不在可以用的模型里`);
  }
  const usableTools = new Map(tools.map((t) => [t.key, t]));
  for (const node of plan.nodes) {
    for (const required of node.requires ?? [])
      if (environment && !environment.capabilities.includes(required))
        problems.push(`节点「${node.key}」要求的本地能力 ${required} 在当前环境不可用`);
    if (node.checks.length > MAX_NODE_CHECKS)
      problems.push(
        `节点「${node.key}」有 ${node.checks.length} 条 checks，最多 ${MAX_NODE_CHECKS} 条`,
      );
    if (node.kind !== 'work') continue;
    for (const tool of node.tools) {
      const entry = usableTools.get(tool.key);
      if (!entry) {
        problems.push(`节点「${node.key}」的工具 ${tool.key} 不在可以用的工具里`);
      } else if (tool.model && entry.models.length && !entry.models.includes(tool.model)) {
        problems.push(
          `节点「${node.key}」的工具 ${tool.key} 不能用型号 ${tool.model}，可选：${entry.models.join('、')}`,
        );
      }
    }
  }
  const keys = new Set(plan.nodes.map((n) => n.key));
  for (const d of sheet.deliverables) {
    const owner = plan.deliverables[d.name];
    if (!owner) problems.push(`交付物「${d.name}」没有指定由哪个节点交出`);
    else if (!keys.has(owner)) problems.push(`交付物「${d.name}」指定的节点「${owner}」不存在`);
    else if (!plan.nodes.find((n) => n.key === owner)?.deliver?.length)
      problems.push(`交付物「${d.name}」的节点「${owner}」没有指定最终 deliver 文件`);
  }
  return problems.length > 0 ? { problems } : { plan };
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
  const nodeRate = (model: string) =>
    models.find((m) => m.providerModel === model)?.node?.costMicro ?? fallback.workRun;
  const perNode = new Map(
    plan.nodes.map((n) => {
      if (n.kind === 'discussion')
        return [
          n.key,
          (n.participants.length * n.rounds + 1) * (fallback.speechRun + fallback.computeRun),
        ];
      const toolCost = n.tools.reduce((sum, t) => {
        const tool = byKey.get(t.key);
        return sum + t.uses * (tool ? toolRate(tool, t.model).costMicro : 0);
      }, 0);
      return [n.key, nodeRate(n.model) + fallback.computeRun + toolCost];
    }),
  );
  const totalMicro = Math.ceil([...perNode.values()].reduce((a, b) => a + b, 0));
  return { totalMicro, perNode };
}
