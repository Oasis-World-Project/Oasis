import { describe, expect, it } from 'vitest';
import { checkPlan, estimatePlan } from '../src/service/planner.ts';

const sheet = {
  title: 't',
  deliverables: [{ name: '首页文案', form: 'Markdown' }],
  criteria: ['c'],
  style: [],
  budgetMicro: null,
  assumptions: [],
  materials: [],
};
const catalog = [
  {
    key: 'ds',
    name: 'DeepSeek',
    vendor: 'v',
    category: 'llm' as const,
    tags: [],
    providerModel: 'deepseek/x',
  },
];
const limits = { maxNodes: 2, defaultModel: 'deepseek/x' };
const node = (key: string, model = 'deepseek/x') => ({
  key,
  title: key,
  kind: 'work',
  goal: 'g',
  model,
});

describe('规划门', () => {
  it('合格的方案通过（补上默认值）', () => {
    const result = checkPlan(
      JSON.stringify({ nodes: [node('a')], edges: [], deliverables: { 首页文案: 'a' } }),
      sheet,
      catalog,
      limits,
    );
    expect(result).toMatchObject({ plan: { nodes: [{ key: 'a', checks: [], role: '' }] } });
  });

  it('没有文件、不是 JSON、字段不对、有环、节点太多、模型不能用、交付物没人负责：一次列出', () => {
    expect(checkPlan(undefined, sheet, catalog, limits)).toEqual({
      problems: ['没有找到 out/plan.json'],
    });
    expect(checkPlan('{', sheet, catalog, limits)).toEqual({
      problems: ['out/plan.json 不是合法的 JSON'],
    });
    expect(checkPlan('{"nodes":[]}', sheet, catalog, limits)).toHaveProperty('problems');
    const bad = checkPlan(
      JSON.stringify({
        nodes: [node('a'), node('b'), node('c', 'x/unknown')],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
        deliverables: { 首页文案: 'zzz' },
      }),
      sheet,
      catalog,
      limits,
    );
    expect('problems' in bad && bad.problems).toEqual([
      '工作流里有环（经过「a」）',
      '节点太多了（3 个），最多 2 个',
      '模型 x/unknown 不在可以用的模型里',
      '交付物「首页文案」指定的节点「zzz」不存在',
    ]);
  });
});

describe('估算花费', () => {
  it('干活节点一次、讨论按发言次数加汇总，再留两成', () => {
    const plan = {
      nodes: [
        { ...node('a'), kind: 'work' as const, role: '', checks: [], expects: [] },
        {
          ...node('d'),
          kind: 'discussion' as const,
          role: '',
          checks: [],
          expects: [],
          rounds: 2,
          participants: [
            { name: '甲', model: 'deepseek/x', stance: '' },
            { name: '乙', model: 'deepseek/x', stance: '' },
          ],
        },
      ],
      edges: [],
    };
    // (1 + 2×2 + 1) × 1000 × 1.2
    expect(estimatePlan(plan, { workRun: 1_000, speechRun: 1_000 })).toBe(7_200);
  });
});
