// 报价与估价（ADR 0016 §4）：单价全部来自模型网关给出的调用记录中位数和供应商价格，不写死。
// 报价：任务单定稿时由便宜的模型列草案，代码按三档配型号、定价、估时；规划后的估价用同一套单价。
import type { CatalogEntry, ModelTier } from '@oasis/contracts/agent';
import { OASIS_HEADERS } from '@oasis/contracts/common';
import type { ModelCapabilities, ToolEntry, ToolRate } from '@oasis/contracts/model-gateway';
import type { BudgetQuote, BudgetTier, TaskSheet } from '@oasis/contracts/task';
import type { Logger, ServiceClient } from '@oasis/service-kit';
import { z } from 'zod';

/** 规划员能挑的型号，加上它负责一个干活节点的典型花费和用时 */
export type PricedModel = CatalogEntry & { node?: ModelCapabilities['node'] };

/**
 * 什么记录都没有时的兜底（只在全新的环境里会用到，结果标成「粗估」）：
 * 一个干活节点、一次讨论发言、一次沙箱运行的算力，以及一个节点大约要多久。
 */
export interface Fallback {
  workRun: number;
  speechRun: number;
  computeRun: number;
  nodeSeconds: number;
}

/** 各档挑节点型号的档次：省钱多用快速型号，标准用性价比强模型，精细用旗舰 */
const TIER_MODELS: Record<BudgetTier, ModelTier> = {
  economy: 'fast',
  standard: 'strong',
  premium: 'flagship',
};

const byCost = (a: PricedModel, b: PricedModel) =>
  (a.node?.costMicro ?? Infinity) - (b.node?.costMicro ?? Infinity);

/** 这一档负责节点的代表型号：同档次里有单价的取中间那个，省钱档取最便宜的 */
export function tierModel(models: PricedModel[], tier: BudgetTier): PricedModel | undefined {
  const priced = models.filter((m) => m.node).sort(byCost);
  const same = priced.filter((m) => m.tier === TIER_MODELS[tier]);
  const pool = same.length ? same : priced;
  if (!pool.length) return undefined;
  if (tier === 'economy') return pool[0];
  if (tier === 'premium' && !same.length) return pool.at(-1);
  return pool[Math.floor((pool.length - 1) / 2)];
}

/** 工具某个型号的单价；没指定型号按目录默认型号，没有单价用目录的兜底值 */
export function toolRate(tool: ToolEntry, model?: string): ToolRate {
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

/** 这一档用工具的哪个型号：省钱取最便宜的，精细取目录排第一的（最强），标准取中间价位 */
export function tierToolRate(tool: ToolEntry, tier: BudgetTier): ToolRate {
  if (!tool.rates.length) return toolRate(tool);
  if (tier === 'premium') return tool.rates[0]!;
  const sorted = [...tool.rates].sort((a, b) => a.costMicro - b.costMicro);
  return tier === 'economy' ? sorted[0]! : sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/** 报价草案：大概几步、每步干什么、在哪几步之后、要调哪些工具（每档大约几个计费单位） */
export const Draft = z.object({
  steps: z
    .array(
      z.object({
        key: z.string().min(1).max(40),
        title: z.string().min(1).max(300),
        after: z.array(z.string()).default([]),
        tools: z
          .array(
            z.object({
              key: z.string(),
              uses: z.object({
                economy: z.number().int().min(0),
                standard: z.number().int().min(0),
                premium: z.number().int().min(0),
              }),
            }),
          )
          .default([]),
      }),
    )
    .min(1)
    .max(12),
});
export type Draft = z.infer<typeof Draft>;

/** 给列草案的模型的说明 */
function draftPrompt(brief: string, sheet: TaskSheet, tools: ToolEntry[]): string {
  const catalog = tools
    .map((t) => `- ${t.key}（${t.name}，计费单位：${t.unit}）：${t.description}`)
    .join('\n');
  return [
    '你在为一项交给 AI 团队的任务做报价草案。只列大概的步骤，不排具体型号，不写提示词。',
    `【任务】\n${brief}`,
    `【任务单】\n${JSON.stringify({ title: sheet.title, deliverables: sheet.deliverables, criteria: sheet.criteria, style: sheet.style })}`,
    `【可以用的工具】\n${catalog || '（没有）'}`,
    [
      '【要求】',
      '- steps：完成这项任务需要的几步（越少越好，能并行的不要串起来）。key 用英文短名，title 一句话说清这步做什么，after 填它要等的前几步的 key。',
      '- 每步要调用的工具写进 tools：uses 是计费单位的数量（视频按秒，图片按张），分三档估：economy 只做一次、刚好满足要求；standard 正常质量；premium 允许多做几版挑最好的。不用工具的步骤 tools 留空。',
      '- 只输出一个 JSON 对象：{"steps":[{"key":"…","title":"…","after":[],"tools":[{"key":"…","uses":{"economy":1,"standard":1,"premium":2}}]}]}',
    ].join('\n'),
  ].join('\n\n');
}

interface Priced {
  micro: number;
  seconds: number;
  rough: boolean;
}

/** 一个节点在这一档的花费和用时（型号单价 + 算力） */
function nodeCost(model: PricedModel | undefined, fallback: Fallback) {
  return {
    micro: (model?.node?.costMicro ?? fallback.workRun) + fallback.computeRun,
    seconds: model?.node?.seconds ?? fallback.nodeSeconds,
    rough: !model?.node || model.node.seconds === null,
  };
}

/** 按档给草案定价、估时：用时取依赖链上最长的一条（并行的步骤同时做），加上规划这一步 */
function priceDraft(
  draft: Draft,
  tier: BudgetTier,
  models: PricedModel[],
  tools: ToolEntry[],
  fallback: Fallback,
  planner: PricedModel | undefined,
): Priced {
  const model = tierModel(models, tier);
  const byKey = new Map(tools.map((t) => [t.key, t]));
  let rough = false;
  const steps = new Map(
    draft.steps.map((step) => {
      const node = nodeCost(model, fallback);
      rough ||= node.rough;
      let micro = node.micro;
      let seconds = node.seconds;
      for (const use of step.tools) {
        const tool = byKey.get(use.key);
        if (!tool || use.uses[tier] === 0) continue;
        const rate = tierToolRate(tool, tier);
        rough ||= rate.basis === 'fallback';
        micro += rate.costMicro * use.uses[tier];
        // 同一工具的多次调用并行发出（ADR 0016 §7），按一次的用时算
        seconds += rate.seconds ?? 0;
      }
      return [step.key, { micro, seconds, after: step.after }];
    }),
  );
  const finish = new Map<string, number>();
  const finishOf = (key: string, seen: Set<string>): number => {
    const known = finish.get(key);
    if (known !== undefined) return known;
    const step = steps.get(key);
    if (!step || seen.has(key)) return 0;
    seen.add(key);
    const start = Math.max(0, ...step.after.map((k) => finishOf(k, seen)));
    finish.set(key, start + step.seconds);
    return start + step.seconds;
  };
  const longest = Math.max(...draft.steps.map((s) => finishOf(s.key, new Set())));
  const plan = nodeCost(planner, fallback);
  return {
    micro: plan.micro + [...steps.values()].reduce((sum, s) => sum + s.micro, 0),
    seconds: plan.seconds + longest,
    rough: rough || plan.rough,
  };
}

/** 草案 → 三档报价 */
export function quoteOf(
  draft: Draft,
  models: PricedModel[],
  tools: ToolEntry[],
  fallback: Fallback,
  planners: Record<BudgetTier, PricedModel | undefined>,
): BudgetQuote {
  const tiers = (['economy', 'standard', 'premium'] as const).map((tier) => ({
    tier,
    ...priceDraft(draft, tier, models, tools, fallback, planners[tier]),
  }));
  // 档位之间不倒挂：更高档至少和低一档一样多
  for (let i = 1; i < tiers.length; i++)
    tiers[i]!.micro = Math.max(tiers[i]!.micro, tiers[i - 1]!.micro);
  return {
    tiers: tiers.map((t) => ({
      tier: t.tier,
      micro: Math.max(1, Math.ceil(t.micro)),
      minutes: Math.max(1, Math.ceil(t.seconds / 60)),
    })),
    minimumMicro: Math.max(1, Math.ceil(tiers[0]!.micro)),
    steps: draft.steps.map((s) => s.title),
    rough: tiers.some((t) => t.rough),
  };
}

const Completion = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({ content: z.string().nullish() }),
      }),
    )
    .min(1),
});

/** 报价服务：列草案的那一次模型调用由付费人付；草案用不了时返回 null（照样能确认任务） */
export function createQuotes(deps: {
  modelGateway: ServiceClient;
  pricing: () => Promise<{ models: PricedModel[]; tools: ToolEntry[] }>;
  /** 列草案用的便宜模型 */
  model: string;
  /** 三档的规划员型号 */
  planners: Record<BudgetTier, string>;
  fallback: Fallback;
  logger: Logger;
}) {
  return {
    async quote(input: {
      ownerId: string;
      brief: string;
      sheet: TaskSheet;
      requestId: string;
    }): Promise<BudgetQuote | null> {
      const { models, tools } = await deps.pricing();
      try {
        const result = await deps.modelGateway.json('POST', '/internal/v1/chat/completions', {
          body: {
            model: deps.model,
            stream: false,
            messages: [{ role: 'user', content: draftPrompt(input.brief, input.sheet, tools) }],
            response_format: { type: 'json_object' },
            // 列草案不需要深度思考：开着时一次要二十多秒，用户要多等这么久才看到任务单
            reasoning: { enabled: false },
          },
          headers: { [OASIS_HEADERS.payerId]: input.ownerId },
          requestId: input.requestId,
          schema: Completion,
        });
        const choice = result.choices[0]!;
        if (choice.finish_reason && choice.finish_reason !== 'stop')
          throw new Error(`草案没写完：${choice.finish_reason}`);
        const draft = Draft.parse(JSON.parse(choice.message.content ?? ''));
        const known = new Set(tools.map((t) => t.key));
        for (const step of draft.steps) step.tools = step.tools.filter((t) => known.has(t.key));
        const planner = (tier: BudgetTier) =>
          models.find((m) => m.providerModel === deps.planners[tier]);
        return quoteOf(draft, models, tools, deps.fallback, {
          economy: planner('economy'),
          standard: planner('standard'),
          premium: planner('premium'),
        });
      } catch (err) {
        deps.logger.warn({ err }, '报价草案用不了，这次不报价');
        return null;
      }
    },
  };
}
export type Quotes = ReturnType<typeof createQuotes>;
