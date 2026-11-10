import { describe, expect, it } from 'vitest';
import { checkPlan, estimatePlan, plannerPrompt, revisePrompt } from '../src/service/planner.ts';

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
const tools = [
  {
    key: 'image.generate',
    name: '生成图片',
    description: 'd',
    usage: 'u',
    unit: '张',
    estimateMicro: 40_000,
    long: false,
    available: true,
    models: [],
    defaultModel: null,
    rates: [],
    args: [],
    local: false,
  },
];
const fallback = { workRun: 1_000, speechRun: 1_000, computeRun: 0, nodeSeconds: 600 };
const node = (key: string, model = 'deepseek/x') => ({
  key,
  title: key,
  kind: 'work',
  goal: 'g',
  model,
  deliver: ['*.md'],
});

describe('规划门', () => {
  it('首次规划携带完整任务单；修订接着原会话，只列问题', () => {
    const confirmed = {
      ...sheet,
      style: ['澄清后仅日文招牌'],
      criteria: ['1:1画面'],
      budgetMicro: 123456,
      assumptions: ['网页拖拽观看'],
    };
    const prompt = plannerPrompt({
      brief: '原始简述',
      sheet: confirmed,
      catalog,
      tools,
      playbooks: [],
      defaultModel: 'deepseek/x',
    });
    expect(prompt).toContain(JSON.stringify(confirmed));
    expect(revisePrompt(['路径有误'])).toContain('- 路径有误');
  });
  it('checks 是节点自己看的几件事：可以是一句话，也接受旧的对象格式', () => {
    const plan = (checks: unknown[]) =>
      JSON.stringify({
        nodes: [{ ...node('home'), checks }],
        edges: [],
        deliverables: { 首页文案: 'home' },
      });
    expect(checkPlan(plan(['开头点明卖点']), sheet, catalog, tools)).toMatchObject({
      plan: { nodes: [{ checks: ['开头点明卖点'] }] },
    });
    expect(
      checkPlan(
        plan([{ id: 'c1', text: '画面 1:1', requirementIds: [], files: [] }]),
        sheet,
        catalog,
        tools,
      ),
    ).toHaveProperty('plan');
  });
  it('每个节点最多 5 条检查：多了退回规划员合并', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      text: 'x',
      requirementIds: ['criteria:0'],
      files: [],
    }));
    const plan = JSON.stringify({
      nodes: [{ ...node('home'), checks: many }],
      edges: [],
      deliverables: { 首页文案: 'home' },
    });
    expect(checkPlan(plan, sheet, catalog, tools)).toMatchObject({
      problems: [expect.stringContaining('最多 5 条')],
    });
  });
  it('规划员看到各型号的档位和能读什么；怎么排由它判断、不带倾向，不动手试跑（ADR 0028）', () => {
    const prompt = plannerPrompt({
      brief: 'b',
      sheet,
      catalog: [
        { ...catalog[0]!, tier: 'flagship' as const, inputs: ['text', 'image'] },
        { ...catalog[0]!, providerModel: 'deepseek/fast', tier: 'fast' as const, inputs: ['text'] },
      ],
      tools,
      playbooks: [],
      defaultModel: 'deepseek/x',
    });
    expect(prompt).toContain('deepseek/x（DeepSeek，v；旗舰；节点里能直接看图）');
    expect(prompt).toContain('deepseek/fast（DeepSeek，v；快速；只读文字）');
    // 视频、音频节点里的型号读不了：说清楚要靠哪个工具，不让规划员以为挑个「多模态」型号就行
    expect(prompt).toContain('视频、音频不管哪个型号都读不了，要用 media.inspect');
    expect(prompt).toContain('用户没有选预算档');
    expect(prompt).toContain('没有越少越好，也没有越多越好');
    expect(prompt).toContain('快速是私聊用的轻量型号');
    expect(prompt).toContain('不要动手做或试跑实现');
    // 不把选择往一边推：少排、少做、只在…时才用、指定用哪一档
    for (const nudge of [
      '一个节点就够',
      '省钱靠',
      '难活用',
      '只在真要',
      '只给看运气',
      '按常规质量',
    ])
      expect(prompt).not.toContain(nudge);
  });
  it('节点所需能力必须来自实测环境，不能把包可安装当成浏览器已就绪', () => {
    const environment = {
      image: 'oasis/test:1',
      imageId: 'sha256:test',
      software: { node: '24' },
      capabilities: ['node'],
      notes: [],
    };
    const plan = JSON.stringify({
      nodes: [{ ...node('home'), requires: ['browser'] }],
      edges: [],
      deliverables: { 首页文案: 'home' },
    });
    expect(checkPlan(plan, sheet, catalog, tools, environment)).toMatchObject({
      problems: [expect.stringContaining('browser')],
    });
    expect(
      checkPlan(plan.replace('browser', 'node'), sheet, catalog, tools, environment),
    ).toHaveProperty('plan');
  });
  it('有效大工作流不再被旧节点数量上限拒绝', () => {
    const nodes = Array.from({ length: 60 }, (_, index) => node(`n${index}`));
    expect(
      checkPlan(
        JSON.stringify({ nodes, edges: [], deliverables: { 首页文案: 'n0' } }),
        sheet,
        catalog,
        tools,
      ),
    ).toHaveProperty('plan');
  });
  it('合格的方案通过（补上默认值）', () => {
    const result = checkPlan(
      JSON.stringify({
        nodes: [{ ...node('a'), tools: [{ key: 'image.generate' }] }],
        edges: [],
        deliverables: { 首页文案: 'a' },
      }),
      sheet,
      catalog,
      tools,
    );
    expect(result).toMatchObject({
      plan: {
        nodes: [{ key: 'a', checks: [], role: '', tools: [{ key: 'image.generate', uses: 1 }] }],
      },
    });
  });

  it('没有文件、不是 JSON、字段不对、有环、模型不能用、交付物没人负责：一次列出', () => {
    expect(checkPlan(undefined, sheet, catalog, tools)).toEqual({
      problems: ['没有找到 out/plan.json'],
    });
    expect(checkPlan('{', sheet, catalog, tools)).toEqual({
      problems: ['out/plan.json 不是合法的 JSON'],
    });
    expect(checkPlan('{"nodes":[]}', sheet, catalog, tools)).toHaveProperty('problems');
    const bad = checkPlan(
      JSON.stringify({
        nodes: [
          node('a'),
          { ...node('b'), tools: [{ key: 'video.generate', uses: 2 }] },
          node('c', 'x/unknown'),
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
        deliverables: { 首页文案: 'zzz' },
      }),
      sheet,
      catalog,
      tools,
    );
    expect('problems' in bad && bad.problems).toEqual([
      '工作流里有环（经过「a」）',
      '模型 x/unknown 不在可以用的模型里',
      '节点「b」的工具 video.generate 不在可以用的工具里',
      '交付物「首页文案」指定的节点「zzz」不存在',
    ]);
  });
});

describe('估算花费', () => {
  it('批次 uses 按样本行数估价，支持数百行且不把 1000 行当作任务上限', () => {
    const batchTools = [{ ...tools[0]!, key: 'text.batch', unit: '行', estimateMicro: 2_000 }];
    const result = (uses: number) =>
      checkPlan(
        JSON.stringify({
          nodes: [{ ...node('a'), tools: [{ key: 'text.batch', uses }] }],
          edges: [],
          deliverables: { 首页文案: 'a' },
        }),
        sheet,
        catalog,
        batchTools,
      );
    const checked = result(200);
    expect(checked).toHaveProperty('plan');
    if ('plan' in checked)
      expect(estimatePlan(checked.plan, catalog, batchTools, fallback).totalMicro).toBe(401_000);
    expect(result(1001)).toHaveProperty('plan');
  });
  it('按所选型号的典型单价估价，不再乘系数；没有记录的型号用兜底；同时给出每个节点的份额', () => {
    const plan = {
      nodes: [
        {
          ...node('a'),
          kind: 'work' as const,
          role: '',
          checks: [],
          expects: [],
          tools: [{ key: 'image.generate', uses: 2, model: 'img/cheap' }],
        },
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
    const priced = [
      { ...catalog[0]!, node: { costMicro: 20_000, seconds: 300, basis: 'history' as const } },
    ];
    const imageTools = [
      {
        ...tools[0]!,
        models: ['img/best', 'img/cheap'],
        defaultModel: 'img/best',
        rates: [
          { model: 'img/best', costMicro: 90_000, seconds: 60, basis: 'history' as const },
          { model: 'img/cheap', costMicro: 30_000, seconds: 20, basis: 'history' as const },
        ],
      },
    ];
    const estimate = estimatePlan(plan, priced, imageTools, { ...fallback, computeRun: 100 });
    // 干活节点：型号 20000 + 算力 100 + 便宜型号 2 × 30000；讨论：(2×2+1) × (1000 + 100)
    expect(estimate.perNode.get('a')).toBe(80_100);
    expect(estimate.perNode.get('d')).toBe(5_500);
    expect(estimate.totalMicro).toBe(85_600);
    // 没有记录的型号用兜底
    expect(estimatePlan(plan, catalog, imageTools, fallback).perNode.get('a')).toBe(61_000);
  });

  it('工具指定的型号必须是目录里这个工具能用的', () => {
    const checked = checkPlan(
      JSON.stringify({
        nodes: [{ ...node('a'), tools: [{ key: 'image.generate', uses: 1, model: 'img/other' }] }],
        edges: [],
        deliverables: { 首页文案: 'a' },
      }),
      sheet,
      catalog,
      [{ ...tools[0]!, models: ['img/best'], defaultModel: 'img/best' }],
    );
    expect(checked).toEqual({
      problems: ['节点「a」的工具 image.generate 不能用型号 img/other，可选：img/best'],
    });
  });

  it('说明里写清预算档和每个型号的单价；预算是参考不是上限', () => {
    const prompt = plannerPrompt({
      brief: 'b',
      sheet: {
        ...sheet,
        budget: { tier: 'economy', micro: 800_000, minutes: 6, steps: ['写文案'] },
      },
      catalog: [{ ...catalog[0]!, node: { costMicro: 20_000, seconds: 300, basis: 'history' } }],
      tools: [
        {
          ...tools[0]!,
          rates: [{ model: 'img/cheap', costMicro: 30_000, seconds: 20, basis: 'history' }],
        },
      ],
      playbooks: [{ key: 'images', name: '图片类', when: '要出图' }],
      defaultModel: 'deepseek/x',
    });
    expect(prompt).toContain('用户选了「省钱」档：约 $0.80、6 分钟左右');
    expect(prompt).toContain('这是参考不是上限');
    expect(prompt).toContain('一个节点典型约 $0.02、5 分钟');
    expect(prompt).toContain('img/cheap 每张约 $0.03、一次约 20 秒');
    expect(prompt).toContain('in/playbooks/images.md：图片类（要出图）');
    expect(prompt).not.toContain('不替用户省钱');
  });
});
