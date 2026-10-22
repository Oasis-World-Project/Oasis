// 规划员（ADR 0005 §4）的纯函数部分：给规划员的说明、规划门（检查它写的 out/plan.json）、按方案估算花费。
// 规划员只排方案；方案对不对由代码检查，花费由代码按经验单价算，不让 AI 估。
import type { CatalogEntry } from '@oasis/contracts/agent';
import { NodeKey, WorkflowPlan, type TaskSheet } from '@oasis/contracts/task';
import { HttpError } from '@oasis/service-kit';
import { z } from 'zod';
import { validatePlan } from './plan.ts';

/** 规划员写的方案：工作流 + 每样交付物由哪个节点负责 */
const PlannerPlan = WorkflowPlan.extend({
  deliverables: z.record(z.string(), NodeKey),
});
export type PlannerPlan = z.infer<typeof PlannerPlan>;

export const PLAN_FILE = 'plan.json';

export interface PlannerLimits {
  maxNodes: number;
  defaultModel: string;
}

/** 给规划员的说明 */
export function plannerPrompt(input: {
  brief: string;
  sheet: TaskSheet;
  catalog: CatalogEntry[];
  limits: PlannerLimits;
}): string {
  const models = input.catalog
    .map((m) => `- ${m.providerModel}（${m.name}，${m.vendor}；${m.tags.join('、')}）`)
    .join('\n');
  const deliverables = input.sheet.deliverables.map((d) => `「${d.name}」`).join('、');
  const example = {
    nodes: [
      {
        key: 'draft',
        title: '写初稿',
        kind: 'work',
        role: '资深文案',
        goal: '……写成 out/初稿.md',
        model: input.limits.defaultModel,
        checks: ['从任务单里挑和这个节点相关的验收点'],
        expects: ['初稿.md'],
      },
      {
        key: 'review',
        title: '定稿讨论',
        kind: 'discussion',
        goal: '比较 in/draft/ 里的初稿……定下怎么改',
        model: input.limits.defaultModel,
        rounds: 2,
        participants: [
          { name: '品牌顾问', model: input.limits.defaultModel, stance: '看重氛围' },
          { name: '转化顾问', model: input.limits.defaultModel, stance: '看重转化' },
        ],
        checks: [],
        expects: [],
      },
    ],
    edges: [{ from: 'draft', to: 'review' }],
    deliverables: { [input.sheet.deliverables[0]?.name ?? '交付物']: 'draft' },
  };
  return [
    '你是 Oasis 的规划员。用户已经确认了下面的任务单，你要为它排一条工作流，交给 AI 团队去做。',
    `【任务】\n${input.brief}`,
    `【可以用的模型】（节点里的 model 只能填这些；没有特别理由就用 ${input.limits.defaultModel}）\n${models}`,
    [
      '【节点】',
      '- work（干活）：一个 AI 在独立的容器里完成一件事，能读写文件、运行命令；成果写到 out/。',
      '- discussion（讨论）：2–5 位参与者（各自的模型和立场）来回讨论 1–5 轮，最后由汇总者（model）把结论写到 out/。只在需要权衡取舍时用。',
      '- 连线 from → to：上游的 out/ 会放进下游的 in/<上游节点名>/。没有连线的节点同时开跑。',
    ].join('\n'),
    [
      '【规矩】',
      `- 最多 ${input.limits.maxNodes} 个节点。简单的事 1–3 个节点就够，别为了显得完整而拆。`,
      '- 能同时做的就并行；一个节点只做一件事。',
      `- 任务单上每样交付物（${deliverables}）都要在 deliverables 里指定由哪个节点交出最终版。`,
      '- 每个节点的 checks 从任务单的「怎么算做好」里挑和它相关的（最多 5 条，可以为空）；expects 写它必须交出的文件名（可以用 * 通配）。',
      '- goal 写清楚这个节点要做什么、产出写成什么文件；节点里的 AI 不会再问用户问题。',
      '- key 只用英文字母、数字、下划线、短横线。',
    ].join('\n'),
    `【交付】把方案写成 out/${PLAN_FILE}（只放 JSON），格式照下面的例子：\n${JSON.stringify(example, null, 2)}\n\n写完用一两句话说明你的安排。`,
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
  limits: PlannerLimits,
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
  if (plan.nodes.length > limits.maxNodes) {
    problems.push(`节点太多了（${plan.nodes.length} 个），最多 ${limits.maxNodes} 个`);
  }
  const usable = new Set(catalog.map((m) => m.providerModel));
  const used = plan.nodes.flatMap((n) => [
    n.model,
    ...(n.kind === 'discussion' ? n.participants.map((p) => p.model) : []),
  ]);
  for (const model of new Set(used)) {
    if (!usable.has(model)) problems.push(`模型 ${model} 不在可以用的模型里`);
  }
  const keys = new Set(plan.nodes.map((n) => n.key));
  for (const d of sheet.deliverables) {
    const owner = plan.deliverables[d.name];
    if (!owner) problems.push(`交付物「${d.name}」没有指定由哪个节点交出`);
    else if (!keys.has(owner)) problems.push(`交付物「${d.name}」指定的节点「${owner}」不存在`);
  }
  return problems.length > 0 ? { problems } : { plan };
}

/** 估算用的经验单价（微美元），来自 5.2 的真实记账，以后用记账数据校准 */
export interface EstimateRates {
  /** 干活节点跑一次 */
  workRun: number;
  /** 讨论里一次发言或汇总 */
  speechRun: number;
}

/** 按方案估算花费：每个干活节点一次、讨论按发言次数 + 汇总，再留两成给重做和关卡退回 */
export function estimatePlan(plan: WorkflowPlan, rates: EstimateRates): number {
  const runs = plan.nodes.reduce(
    (sum, n) =>
      sum +
      (n.kind === 'discussion'
        ? (n.participants.length * n.rounds + 1) * rates.speechRun
        : rates.workRun),
    0,
  );
  return Math.ceil(runs * 1.2);
}
