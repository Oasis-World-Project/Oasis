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

/**
 * 各档挑节点型号的档次：省钱靠少排节点、少做几版，不靠换弱模型（2026-11-07），所以省钱档也按强力型号算
 * （取其中最便宜的）；精细用旗舰
 */
const TIER_MODELS: Record<BudgetTier, ModelTier> = {
  economy: 'strong',
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

/** 按这一步写的参数取单价：单价随参数变（视频的清晰度）且写了、表里有就用表里的，否则用默认单价 */
export function argRate(rate: ToolRate, args?: Record<string, unknown>): number {
  const value = rate.by ? args?.[rate.by.arg] : undefined;
  return (value === undefined ? undefined : rate.by?.costMicro[String(value)]) ?? rate.costMicro;
}

/** 这一档用工具的哪个型号：省钱取最便宜的，精细取目录排第一的（最强），标准取中间价位 */
export function tierToolRate(tool: ToolEntry, tier: BudgetTier): ToolRate {
  if (!tool.rates.length) return toolRate(tool);
  if (tier === 'premium') return tool.rates[0]!;
  const sorted = [...tool.rates].sort((a, b) => a.costMicro - b.costMicro);
  return tier === 'economy' ? sorted[0]! : sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/** 报价草案：只估要调哪些工具（每档大约几个计费单位）；节点数按交付物定，不让模型拆步骤（2026-11-07） */
export const Draft = z.object({
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
});
export type Draft = z.infer<typeof Draft>;

/** 给列草案的模型的说明 */
function draftPrompt(brief: string, sheet: TaskSheet, tools: ToolEntry[]): string {
  const catalog = tools
    .map((t) => `- ${t.key}（${t.name}，计费单位：${t.unit}）：${t.description}`)
    .join('\n');
  return [
    '你在为一项交给 AI 团队的任务估工具用量。只估要调哪些付费工具、各用多少，不排步骤、不写提示词。',
    `【任务】\n${brief}`,
    `【任务单】\n${JSON.stringify({ title: sheet.title, deliverables: sheet.deliverables, criteria: sheet.criteria, style: sheet.style })}`,
    `【可以用的工具】\n${catalog || '（没有）'}`,
    [
      '【要求】',
      '- uses 是计费单位的数量（视频按秒，图片按张），分三档估：economy 只做一次、刚好满足要求；standard 正常质量；premium 允许多做几版挑最好的。用不到付费工具就留空数组。',
      '- 只输出一个 JSON 对象：{"tools":[{"key":"…","uses":{"economy":1,"standard":1,"premium":2}}]}',
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
    // 用时没有记录时按固定值估（开发阶段本来就不看记录），只有连单价都没有才算粗估
    rough: !model?.node,
  };
}

/**
 * 按档定价、估时（2026-11-07）：规划员 + 每样交付物一个节点（并行），加上草案估的工具；
 * 用时 = 规划 + 一个节点 + 最慢的那个工具。
 */
function priceDraft(
  draft: Draft,
  nodes: number,
  tier: BudgetTier,
  models: PricedModel[],
  tools: ToolEntry[],
  fallback: Fallback,
  planner: PricedModel | undefined,
): Priced {
  const node = nodeCost(tierModel(models, tier), fallback);
  const plan = nodeCost(planner, fallback);
  const byKey = new Map(tools.map((t) => [t.key, t]));
  let rough = node.rough || plan.rough;
  let micro = plan.micro + node.micro * nodes;
  let toolSeconds = 0;
  for (const use of draft.tools) {
    const tool = byKey.get(use.key);
    if (!tool || use.uses[tier] === 0) continue;
    const rate = tierToolRate(tool, tier);
    rough ||= rate.basis === 'fallback';
    micro += rate.costMicro * use.uses[tier];
    // 同一工具的多次调用并行发出（ADR 0016 §7），按一次的用时算
    toolSeconds = Math.max(toolSeconds, rate.seconds ?? 0);
  }
  return { micro, seconds: plan.seconds + node.seconds + toolSeconds, rough };
}

/** 草案 → 三档报价 */
export function quoteOf(
  draft: Draft,
  /** 任务单上的交付物：每样一个节点 */
  deliverables: string[],
  models: PricedModel[],
  tools: ToolEntry[],
  fallback: Fallback,
  planner: PricedModel | undefined,
): BudgetQuote {
  const tiers = (['economy', 'standard', 'premium'] as const).map((tier) => ({
    tier,
    ...priceDraft(draft, Math.max(1, deliverables.length), tier, models, tools, fallback, planner),
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
    steps: deliverables.map((name) => `做出「${name}」`),
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
  /** 规划员型号（各档相同） */
  planner: string;
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
        draft.tools = draft.tools.filter((t) => known.has(t.key));
        return quoteOf(
          draft,
          input.sheet.deliverables.map((d) => d.name),
          models,
          tools,
          deps.fallback,
          models.find((m) => m.providerModel === deps.planner),
        );
      } catch (err) {
        deps.logger.warn({ err }, '报价草案用不了，这次不报价');
        return null;
      }
    },
  };
}
export type Quotes = ReturnType<typeof createQuotes>;
