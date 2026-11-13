import { describe, expect, it } from 'vitest';
import { checkPlan, plannerPrompt, revisePrompt } from '../src/service/planner.ts';

const sheet = {
  title: 't',
  deliverables: [{ name: '首页文案', form: 'Markdown' }],
  criteria: ['c'],
  style: [],
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
/** 一样由一个 AI 做的成果 */
const agent = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  title: key,
  how: 'agent',
  goal: 'g',
  model: 'deepseek/x',
  deliver: ['*.md'],
  ...extra,
});
const plan = (outcomes: unknown[], deliverables: Record<string, string> = { 首页文案: 'home' }) =>
  JSON.stringify({ outcomes, deliverables });
const problemsOf = (text: string, s = sheet) => {
  const checked = checkPlan(text, s, catalog, tools);
  return 'problems' in checked ? checked.problems : [];
};

describe('给规划员的说明', () => {
  it('型号带着实测的数：每秒输出、含缓存的实际单价；上游出错多的写出比例，没量过的不写', () => {
    const measured = (failureRate: number) => ({
      calls: 3769,
      tokensPerSecond: 92,
      microPerMTok: 176_185,
      failureRate,
    });
    const prompt = plannerPrompt({
      brief: 'b',
      sheet,
      catalog: [
        { ...catalog[0]!, measured: measured(0.003) },
        { ...catalog[0]!, providerModel: 'deepseek/flaky', measured: measured(0.031) },
        { ...catalog[0]!, providerModel: 'deepseek/new' },
      ],
      tools,
      playbooks: [],
      defaultModel: 'deepseek/x',
    });
    expect(prompt).toContain(
      '- deepseek/x（DeepSeek，v；最近 3769 次调用实测每秒输出约 92 个 token、每百万 token 约 $0.18（含缓存折扣））',
    );
    expect(prompt).toContain('（含缓存折扣）、上游出错 3.1%）');
    expect(prompt).toContain('- deepseek/new（DeepSeek，v）');
  });

  it('首次规划携带完整任务单；修订接着原会话，只列问题', () => {
    const confirmed = {
      ...sheet,
      style: ['澄清后仅日文招牌'],
      criteria: ['1:1画面'],
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

  it('按成果排：讲清两种做法是什么；怎么排由它判断、不带倾向，不动手试跑（ADR 0028、0030）', () => {
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
    expect(prompt).toContain('deepseek/x（DeepSeek，v；旗舰；能直接看图）');
    expect(prompt).toContain('deepseek/fast（DeepSeek，v；快速；只读文字）');
    // 视频、音频做成果的 AI 读不了：说清楚要靠哪个工具，不让规划员以为挑个「多模态」型号就行
    expect(prompt).toContain('视频、音频不管哪个型号都读不了，要用 media.inspect');
    expect(prompt).toContain('"how": "agent"');
    expect(prompt).toContain('一个 AI 在一个沙箱、一次持续会话里把这样成果从头做到交付');
    expect(prompt).toContain('一条生产线，不带 AI');
    expect(prompt).toContain('一样成果不拆给两个 AI 接力');
    expect(prompt).toContain('不要动手做或试跑实现');
    // 没有预算、预估、自查清单；也不把选择往一边推、不写没验证过的话
    for (const gone of [
      '预算',
      'checks',
      'uses',
      '越少越好',
      '写代码的能力弱于',
      '一个节点就够',
      '省钱靠',
      '只在真要',
    ])
      expect(prompt).not.toContain(gone);
  });

  it('型号和工具带着调用记录里的单价；经验手册列出名字', () => {
    const prompt = plannerPrompt({
      brief: 'b',
      sheet,
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
    expect(prompt).toContain('调用记录里干一次活约 $0.02、5 分钟');
    expect(prompt).toContain('img/cheap 每张约 $0.03、一次约 20 秒');
    expect(prompt).toContain('in/playbooks/images.md：图片类（要出图）');
  });
});

describe('规划门', () => {
  it('一个 AI 做的成果变成一个干活节点（补上默认值）；needs 变成连线', () => {
    const checked = checkPlan(
      plan([agent('home', { needs: ['facts'] }), agent('facts', { deliver: ['facts.md'] })], {
        首页文案: 'home',
        资料: 'facts',
      }),
      { ...sheet, deliverables: [...sheet.deliverables, { name: '资料', form: 'Markdown' }] },
      catalog,
      tools,
    );
    expect(checked).toMatchObject({
      plan: {
        nodes: [
          { key: 'home', kind: 'work', role: '', goal: 'g', model: 'deepseek/x', expects: [] },
          { key: 'facts', kind: 'work' },
        ],
        edges: [{ from: 'facts', to: 'home' }],
        deliverables: { 首页文案: 'home', 资料: 'facts' },
      },
    });
    if ('plan' in checked) expect(checked.plan.nodes[0]).not.toHaveProperty('line');
  });

  it('生产线的节点记下属于哪条线；线里的连线可以从别的成果接过来', () => {
    const checked = checkPlan(
      plan(
        [
          agent('board', { deliver: undefined, expects: ['shots.json'] }),
          {
            key: 'film',
            title: '短片',
            how: 'line',
            nodes: [
              {
                key: 'cut',
                title: '拼成片',
                kind: 'tool',
                goal: '拼',
                steps: [{ tool: 'image.generate' }],
                deliver: ['成片.mp4'],
              },
            ],
            edges: [{ from: 'board', to: 'cut' }],
          },
        ],
        { 首页文案: 'cut' },
      ),
      sheet,
      catalog,
      tools,
    );
    expect(checked).toMatchObject({
      plan: {
        nodes: [
          { key: 'board', kind: 'work' },
          { key: 'cut', kind: 'tool', line: { key: 'film', title: '短片' } },
        ],
        edges: [{ from: 'board', to: 'cut' }],
      },
    });
  });

  it('一样成果不拆给两个 AI 接力：不是交付物、又只给一个 AI 用的成果退回；共用的、给生产线用的可以', () => {
    // 写初稿 → 定稿：初稿不是交付物，只有定稿用它
    expect(
      problemsOf(
        plan([agent('draft', { deliver: undefined }), agent('home', { needs: ['draft'] })]),
      ),
    ).toEqual([expect.stringContaining('把它并进「home」')]);
    // 没人用、也不是交付物
    expect(problemsOf(plan([agent('home'), agent('extra', { deliver: undefined })]))).toEqual([
      expect.stringContaining('也没有别的成果用它'),
    ]);
    // 两样交付物共用一份设定：可以
    const two = {
      ...sheet,
      deliverables: [...sheet.deliverables, { name: '海报', form: 'PNG' }],
    };
    expect(
      checkPlan(
        plan(
          [
            agent('setting', { deliver: undefined }),
            agent('home', { needs: ['setting'] }),
            agent('poster', { needs: ['setting'] }),
          ],
          { 首页文案: 'home', 海报: 'poster' },
        ),
        two,
        catalog,
        tools,
      ),
    ).toHaveProperty('plan');
  });

  it('生产线的连线不能接到线外；成果和节点不能重名', () => {
    const line = (edges: unknown[], key = 'film') => ({
      key,
      title: '线',
      how: 'line',
      nodes: [
        {
          key: 'cut',
          title: '拼',
          kind: 'tool',
          goal: '拼',
          steps: [{ tool: 'image.generate' }],
          deliver: ['a.mp4'],
        },
      ],
      edges,
    });
    expect(
      problemsOf(plan([agent('home'), line([{ from: 'cut', to: 'home' }])], { 首页文案: 'home' })),
    ).toContainEqual(expect.stringContaining('终点不在这条线里'));
    expect(problemsOf(plan([line([], 'cut')], { 首页文案: 'cut' }))).toContainEqual(
      expect.stringContaining('key 不能重复：cut'),
    );
  });

  it('成果所需能力必须来自实测环境，不能把包可安装当成浏览器已就绪', () => {
    const environment = {
      image: 'oasis/test:1',
      imageId: 'sha256:test',
      software: { node: '24' },
      capabilities: ['node'],
      notes: [],
    };
    const text = plan([agent('home', { requires: ['browser'] })]);
    expect(checkPlan(text, sheet, catalog, tools, environment)).toMatchObject({
      problems: [expect.stringContaining('browser')],
    });
    expect(
      checkPlan(text.replace('browser', 'node'), sheet, catalog, tools, environment),
    ).toHaveProperty('plan');
  });

  it('成果数量没有上限', () => {
    const names = Array.from({ length: 60 }, (_, index) => `n${index}`);
    expect(
      checkPlan(
        plan(
          names.map((name) => agent(name)),
          Object.fromEntries(names.map((name) => [name, name])),
        ),
        { ...sheet, deliverables: names.map((name) => ({ name, form: 'Markdown' })) },
        catalog,
        tools,
      ),
    ).toHaveProperty('plan');
  });

  it('没有文件、不是 JSON、字段不对、有环、模型不能用、交付物没人负责：一次列出', () => {
    expect(checkPlan(undefined, sheet, catalog, tools)).toEqual({
      problems: ['没有找到 out/plan.json'],
    });
    expect(checkPlan('{', sheet, catalog, tools)).toEqual({
      problems: ['out/plan.json 不是合法的 JSON'],
    });
    expect(checkPlan('{"outcomes":[]}', sheet, catalog, tools)).toHaveProperty('problems');
    // 旧格式（节点和连线）不收
    expect(checkPlan('{"nodes":[],"edges":[]}', sheet, catalog, tools)).toHaveProperty('problems');
    expect(
      problemsOf(
        plan(
          [
            agent('a', { needs: ['b'] }),
            agent('b', { needs: ['a'] }),
            agent('c', { model: 'x/unknown' }),
          ],
          { 首页文案: 'zzz' },
        ),
      ),
    ).toEqual([
      '成果「a」不是任务单上的交付物，又只有「b」用它：一样成果不拆给两个 AI 接力，把它并进「b」，由那个 AI 自己做',
      '成果「b」不是任务单上的交付物，又只有「a」用它：一样成果不拆给两个 AI 接力，把它并进「a」，由那个 AI 自己做',
      '成果「c」不是任务单上的交付物，也没有别的成果用它',
      '工作流里有环（经过「a」）',
      '模型 x/unknown 不在可以用的模型里',
      '交付物「首页文案」指定的节点「zzz」不存在',
    ]);
  });
});
