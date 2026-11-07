import type { ServiceClient } from '@oasis/service-kit';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import {
  createQuotes,
  quoteOf,
  tierModel,
  tierToolRate,
  type Draft,
  type PricedModel,
} from '../src/service/quote.ts';

const model = (
  providerModel: string,
  tier: PricedModel['tier'],
  costMicro: number,
  seconds = 300,
) => ({
  key: providerModel,
  name: providerModel,
  vendor: 'v',
  category: 'llm' as const,
  tags: [],
  providerModel,
  tier,
  node: { costMicro, seconds, basis: 'history' as const },
});
const models: PricedModel[] = [
  model('v/flash', 'fast', 10_000, 120),
  model('v/strong', 'strong', 100_000, 300),
  model('v/flagship', 'flagship', 400_000, 600),
];
const image = {
  key: 'image.generate',
  name: '生成图片',
  description: 'd',
  usage: 'u',
  unit: '张',
  estimateMicro: 150_000,
  long: false,
  available: true,
  models: ['img/best', 'img/mid', 'img/cheap'],
  defaultModel: 'img/best',
  rates: [
    { model: 'img/best', costMicro: 90_000, seconds: 60, basis: 'history' as const },
    { model: 'img/mid', costMicro: 40_000, seconds: 40, basis: 'history' as const },
    { model: 'img/cheap', costMicro: 20_000, seconds: 20, basis: 'history' as const },
  ],
};
const fallback = { workRun: 300_000, speechRun: 50_000, computeRun: 0, nodeSeconds: 600 };
const draft: Draft = {
  steps: [
    { key: 'brief', title: '定角色和分镜', after: [], tools: [] },
    {
      key: 'frame',
      title: '出首帧',
      after: ['brief'],
      tools: [{ key: 'image.generate', uses: { economy: 1, standard: 2, premium: 4 } }],
    },
    { key: 'copy', title: '写字幕', after: ['brief'], tools: [] },
  ],
};

describe('报价（ADR 0016 §4）', () => {
  it('各档挑节点型号：省钱取强力档最便宜的（不靠换弱模型省钱），标准取强力档，精细取旗舰', () => {
    expect(tierModel(models, 'economy')?.providerModel).toBe('v/strong');
    expect(tierModel(models, 'standard')?.providerModel).toBe('v/strong');
    expect(tierModel(models, 'premium')?.providerModel).toBe('v/flagship');
    expect(tierModel([], 'standard')).toBeUndefined();
  });

  it('各档挑工具型号：省钱最便宜、标准中间、精细目录第一', () => {
    expect(tierToolRate(image, 'economy').model).toBe('img/cheap');
    expect(tierToolRate(image, 'standard').model).toBe('img/mid');
    expect(tierToolRate(image, 'premium').model).toBe('img/best');
  });

  it('按档定价；用时取依赖链最长的一条加规划；最低预算就是省钱档', () => {
    const planner = models[1];
    const quote = quoteOf(draft, models, [image], fallback, planner);
    // 省钱：规划一律用最强型号 100000 + 三步各 100000（不换弱模型）+ 1 张 × 20000
    expect(quote.tiers[0]).toEqual({ tier: 'economy', micro: 420_000, minutes: 16 });
    // 标准：规划 100000 + 三步各 100000 + 2 张 × 40000；用时 300 + 300 + (300 + 40)
    expect(quote.tiers[1]).toEqual({ tier: 'standard', micro: 480_000, minutes: 16 });
    expect(quote.tiers[2]!.micro).toBe(100_000 + 3 * 400_000 + 4 * 90_000);
    expect(quote.minimumMicro).toBe(420_000);
    expect(quote.steps).toEqual(['定角色和分镜', '出首帧', '写字幕']);
    expect(quote.rough).toBe(false);
  });

  it('没有任何记录时用兜底并标成粗估', () => {
    const quote = quoteOf(draft, [], [{ ...image, rates: [] }], fallback, undefined);
    expect(quote.rough).toBe(true);
    expect(quote.minimumMicro).toBe(4 * 300_000 + 150_000);
  });

  it('列草案调一次快速模型、不开深度思考，按草案给出三档', async () => {
    const sent: Record<string, unknown>[] = [];
    const quotes = createQuotes({
      modelGateway: {
        json: async (_m: string, _p: string, opts: { body: Record<string, unknown> }) => {
          sent.push(opts.body);
          return {
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }],
          };
        },
      } as unknown as ServiceClient,
      pricing: async () => ({ models, tools: [image] }),
      model: 'v/flash',
      planner: 'v/strong',
      fallback,
      logger: pino({ level: 'silent' }),
    });
    const sheet = {
      title: 't',
      deliverables: [{ name: '视频', form: 'MP4' }],
      criteria: ['c'],
      style: [],
      budgetMicro: null,
      assumptions: [],
      materials: [],
    };
    const quote = await quotes.quote({ ownerId: 'o', brief: 'b', sheet, requestId: 'r' });
    expect(quote?.tiers.map((t) => t.tier)).toEqual(['economy', 'standard', 'premium']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ model: 'v/flash', reasoning: { enabled: false } });
  });

  it('草案用不了（不是 JSON）时不报价，不抛错', async () => {
    const quotes = createQuotes({
      modelGateway: {
        json: async () => ({
          choices: [{ finish_reason: 'stop', message: { content: '不是 JSON' } }],
        }),
      } as unknown as ServiceClient,
      pricing: async () => ({ models, tools: [image] }),
      model: 'v/flash',
      planner: 'v/strong',
      fallback,
      logger: pino({ level: 'silent' }),
    });
    const sheet = {
      title: 't',
      deliverables: [{ name: '视频', form: 'MP4' }],
      criteria: ['c'],
      style: [],
      budgetMicro: null,
      assumptions: [],
      materials: [],
    };
    expect(await quotes.quote({ ownerId: 'o', brief: 'b', sheet, requestId: 'r' })).toBeNull();
  });
});
