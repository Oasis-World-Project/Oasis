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
  },
];
const node = (key: string, model = 'deepseek/x') => ({
  key,
  title: key,
  kind: 'work',
  goal: 'g',
  model,
  deliver: ['*.md'],
});

describe('规划门', () => {
  it('首次规划和原会话修订都携带完整任务单；没有要求编号时不示范虚构编号', () => {
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
    expect(prompt).toContain('criteria:0');
    expect(prompt).toContain('style:0');
    expect(prompt).not.toContain('"requirementIds":["r1"]');
    expect(revisePrompt(['路径有误'], confirmed)).toContain(JSON.stringify(confirmed));
  });
  it('新 AI 检查只能引用确认任务单，规划员自行加的自测方法不能升级为强制要求', () => {
    const check = {
      id: 'self-check',
      text: '必须用 Node 桩自检并交日志',
      requirementIds: ['criteria:0'],
      files: ['result.md'],
    };
    const plan = (checks: unknown[]) =>
      JSON.stringify({
        nodes: [{ ...node('home'), checks }],
        edges: [],
        deliverables: { 首页文案: 'home' },
      });
    expect(checkPlan(plan([check]), sheet, catalog, tools)).toMatchObject({
      plan: {
        nodes: [{ checks: [{ id: 'self-check', text: 'c', requirementIds: ['criteria:0'] }] }],
      },
    });
    expect(
      checkPlan(plan([{ ...check, requirementIds: [] }]), sheet, catalog, tools),
    ).toMatchObject({ problems: [expect.stringContaining('没有用户要求来源')] });
    expect(
      checkPlan(plan([{ ...check, requirementIds: ['criteria:99'] }]), sheet, catalog, tools),
    ).toMatchObject({ problems: [expect.stringContaining('未知要求')] });
    expect(checkPlan(plan(['必须提交 Node 自检记录']), sheet, catalog, tools)).toMatchObject({
      problems: [expect.stringContaining('引用确认任务单')],
    });
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
  it('规划员看到各型号的档位和能读什么，被要求核心产出用旗舰、拿不准时联网查', () => {
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
    expect(prompt).toContain('deepseek/x（DeepSeek，v；旗舰；能直接读：image）');
    expect(prompt).toContain('deepseek/fast（DeepSeek，v；快速；只读文字）');
    expect(prompt).toContain('不替用户省钱');
    expect(prompt).toContain('web.search');
    expect(prompt).toContain('负责交付物的节点 checks 留空');
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
      expect(
        estimatePlan(checked.plan, { workRun: 1_000, speechRun: 1_000, computeRun: 0 }, batchTools),
      ).toBe(481_200);
    expect(result(1001)).toHaveProperty('plan');
  });
  it('干活节点一次加工具（次数 × 单价）、讨论按发言次数加汇总，再留两成', () => {
    const plan = {
      nodes: [
        {
          ...node('a'),
          kind: 'work' as const,
          role: '',
          checks: [],
          expects: [],
          tools: [{ key: 'image.generate', uses: 2 }],
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
    // (1000 + 2×40000 + (2×2 + 1) × 1000) × 1.2
    expect(estimatePlan(plan, { workRun: 1_000, speechRun: 1_000, computeRun: 0 }, tools)).toBe(
      103_200,
    );
    // 每次运行再加 100 的算力：一共 6 次运行
    expect(estimatePlan(plan, { workRun: 1_000, speechRun: 1_000, computeRun: 100 }, tools)).toBe(
      103_920,
    );
  });
});
