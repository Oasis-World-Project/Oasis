import { describe, expect, it } from 'vitest';
import type { Node } from '../src/repo/task-store.ts';
import {
  checkRevisionPlan,
  estimateRevision,
  revisionPlannerPrompt,
} from '../src/service/revision-planner.ts';

const sheet = {
  title: 't',
  deliverables: [
    { name: '模型', form: 'GLB' },
    { name: '网页', form: 'HTML' },
  ],
  criteria: [],
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
  {
    key: 'ds2',
    name: 'DeepSeek 2',
    vendor: 'v',
    category: 'llm' as const,
    tags: [],
    providerModel: 'deepseek/y',
  },
];
const fallback = { workRun: 1_000, speechRun: 1_000, computeRun: 0, nodeSeconds: 600 };
const old = (key: string, deliver: string, extra: Partial<Node> = {}): Node => ({
  id: `id-${key}`,
  taskId: 't',
  key,
  title: `旧${key}`,
  kind: 'work',
  role: '',
  goal: `做 ${key}`,
  model: 'deepseek/x',
  config: { deliver: [deliver], outputsRunId: `run-${key}` },
  status: 'succeeded',
  attempts: 0,
  reworks: 0,
  userNotes: [],
  warning: null,
  summary: null,
  outputs: [{ path: deliver.replace('**', 'index.html'), size: 9 }],
  currentRunId: `run-${key}`,
  spentMicro: 2_500_000,
  createdAt: new Date(0),
  startedAt: new Date(0),
  finishedAt: new Date(12 * 60_000),
  retiredVersion: null,
  ...extra,
});
const nodes = [old('model', 'model.glb'), old('web', 'site/**')];
const work = (key: string, deliver: string, model = 'deepseek/x') => ({
  key,
  title: key,
  kind: 'work',
  goal: 'g',
  model,
  deliver: [deliver],
});
const check = (plan: unknown, input = nodes) =>
  checkRevisionPlan(JSON.stringify(plan), { sheet, catalog, tools: [], nodes: input });
const base = {
  summary: '只调网页灯光',
  edges: [{ from: 'model', to: 'web' }],
  deliverables: { 模型: 'model', 网页: 'web' },
};

describe('修改的规划门（ADR 0022）', () => {
  it('规划员看到修改意见、针对的节点和上一版每个节点的产出、花费、用时', () => {
    const prompt = revisionPlannerPrompt({
      brief: 'b',
      sheet,
      catalog,
      tools: [],
      playbooks: [],
      defaultModel: 'deepseek/x',
      request: '加点光',
      targets: ['web'],
      nodes,
      edges: [{ id: 'e', taskId: 't', fromNodeId: 'id-model', toNodeId: 'id-web' }],
      deliverables: { 模型: 'model', 网页: 'web' },
    });
    expect(prompt).toContain('【修改意见】\n加点光');
    expect(prompt).toContain('是这些节点交出的：web');
    expect(prompt).toContain('"site/index.html"');
    expect(prompt).toContain('"spent": "$2.50"');
    expect(prompt).toContain('"minutes": 12');
    expect(prompt).toContain('"model → web"');
    expect(prompt).toContain('in/_previous/');
  });

  it('沿用 + 重新做：照搬沿用的节点，只给要跑的节点估价', () => {
    const result = check({
      ...base,
      nodes: [
        { key: 'model', reuse: 'model' },
        { ...work('web', 'site/**'), from: 'web' },
      ],
    });
    if ('problems' in result) throw new Error(result.problems.join('\n'));
    expect(result.changes).toEqual([
      { key: 'model', title: '旧model', change: 'reuse' },
      { key: 'web', title: 'web', change: 'fresh' },
    ]);
    expect(result.workflow.nodes.map((n) => n.key)).toEqual(['model', 'web']);
    expect(estimateRevision(result.plan, result.workflow, [], [], fallback)).toBeGreaterThan(0);
    const all = check({
      ...base,
      nodes: [
        { ...work('model', 'model.glb'), from: 'model' },
        { ...work('web', 'site/**'), from: 'web' },
      ],
    });
    if ('problems' in all) throw new Error(all.problems.join('\n'));
    expect(estimateRevision(all.plan, all.workflow, [], [], fallback)).toBe(
      2 * estimateRevision(result.plan, result.workflow, [], [], fallback),
    );
  });

  it('挡住引用不对的方案：旧节点引用两次、from 不存在、沿用改名、沿用没有产出、接着改换模型', () => {
    const problems = (plan: unknown, input = nodes) => {
      const result = check(plan, input);
      return 'problems' in result ? result.problems.join('\n') : '';
    };
    expect(
      problems({
        ...base,
        nodes: [
          { key: 'model', reuse: 'model' },
          { ...work('web', 'site/**'), from: 'model' },
        ],
      }),
    ).toContain('上一版的节点只能引用一次：model');
    expect(
      problems({
        ...base,
        nodes: [
          { key: 'model', reuse: 'model' },
          { ...work('web', 'site/**'), from: 'page' },
        ],
      }),
    ).toContain('from「page」不是上一版的节点');
    expect(
      problems({
        ...base,
        edges: [{ from: 'mesh', to: 'web' }],
        deliverables: { 模型: 'mesh', 网页: 'web' },
        nodes: [
          { key: 'mesh', reuse: 'model' },
          { ...work('web', 'site/**'), from: 'web' },
        ],
      }),
    ).toContain('沿用的节点 key 要和旧节点一样');
    expect(
      problems(
        {
          ...base,
          nodes: [
            { key: 'model', reuse: 'model' },
            { ...work('web', 'site/**'), from: 'web' },
          ],
        },
        [old('model', 'model.glb', { outputs: [] }), nodes[1]!],
      ),
    ).toContain('「model」上一版没有可沿用的产出');
    expect(
      problems({
        ...base,
        nodes: [
          { key: 'model', reuse: 'model' },
          { ...work('web', 'site/**', 'deepseek/y'), from: 'web', mode: 'continue' },
        ],
      }),
    ).toContain('接着原会话改要用原来的模型 deepseek/x');
    expect(
      problems({
        ...base,
        nodes: [
          { key: 'model', reuse: 'model' },
          { ...work('web', 'site/**'), mode: 'continue' },
        ],
      }),
    ).toContain('接着原会话改要写 from');
  });
});
