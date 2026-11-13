import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '../src/repo/task-store.ts';
import {
  checkRevisionPlan,
  directRevision,
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
  parentId: null,
  slot: null,
  spentMicro: 2_500_000,
  createdAt: new Date(0),
  startedAt: new Date(0),
  finishedAt: new Date(12 * 60_000),
  retiredVersion: null,
  ...extra,
});
// 上一版：网页要用模型交出的文件
const nodes = [old('model', 'model.glb'), old('web', 'site/**')];
const edges: Edge[] = [{ id: 'e', taskId: 't', fromNodeId: 'id-model', toNodeId: 'id-web' }];
const deliverables = { 模型: 'model', 网页: 'web' };
/** 一样由一个 AI 做的成果 */
const agent = (key: string, deliver: string, extra: Record<string, unknown> = {}) => ({
  key,
  title: key,
  how: 'agent',
  goal: 'g',
  model: 'deepseek/x',
  deliver: [deliver],
  ...extra,
});
const web = (extra: Record<string, unknown> = {}) =>
  agent('web', 'site/**', { needs: ['model'], ...extra });
const check = (outcomes: unknown[], input = nodes) =>
  checkRevisionPlan(JSON.stringify({ summary: '只调网页灯光', outcomes, deliverables }), {
    sheet,
    catalog,
    tools: [],
    nodes: input,
    edges,
  });
const problems = (outcomes: unknown[], input = nodes) => {
  const result = check(outcomes, input);
  return 'problems' in result ? result.problems.join('\n') : '';
};

describe('修改的规划门', () => {
  it('规划员看到修改意见、针对的成果和上一版每样成果的产出、花费、用时', () => {
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
      edges,
      deliverables,
    });
    expect(prompt).toContain('【修改意见】\n加点光');
    expect(prompt).toContain('是这些节点交出的：web');
    expect(prompt).toContain('"how": "agent"');
    expect(prompt).toContain('"site/index.html"');
    expect(prompt).toContain('"spent": "$2.50"');
    expect(prompt).toContain('"minutes": 12');
    expect(prompt).toContain('"model → web"');
    expect(prompt).toContain('in/_previous/');
    expect(prompt).toContain('{"key":"上一版的 key","reuse":true}');
  });

  it('沿用 + 接着改 / 重新做：沿用的成果照搬上一版的节点和进来的连线', () => {
    const result = check([{ key: 'model', reuse: true }, web({ mode: 'fresh' })]);
    if ('problems' in result) throw new Error(result.problems.join('\n'));
    expect(result.changes).toEqual([
      { key: 'model', title: '旧model', change: 'reuse' },
      { key: 'web', title: 'web', change: 'fresh' },
    ]);
    expect(result.plan.nodes).toMatchObject([
      { key: 'model', reuse: 'model' },
      { key: 'web', kind: 'work', from: 'web', mode: 'fresh' },
    ]);
    expect(result.plan.edges).toEqual([{ from: 'model', to: 'web' }]);
    // 没写 mode：上一版有的 agent 成果接着原会话改；上一版没有的是新成果，上一版有、方案里没有的删掉
    const mixed = check([
      { key: 'model', reuse: true },
      agent('web', 'site/**'),
      agent('note', 'note.md'),
    ]);
    if ('problems' in mixed) throw new Error(mixed.problems.join('\n'));
    expect(mixed.changes.map((c) => `${c.key}=${c.change}`)).toEqual([
      'model=reuse',
      'web=continue',
      'note=new',
    ]);
    // 沿用下游：进来的连线照搬上一版
    const keep = check([agent('model', 'model.glb', { mode: 'continue' })]);
    expect('problems' in keep && keep.problems.join('\n')).toContain(
      '交付物「网页」指定的节点「web」不存在',
    );
  });

  it('挡住引用不对的方案：沿用的不是上一版的成果、沿用没有产出、沿用的上游要重做、接着改换模型、接着改没跑过的', () => {
    expect(problems([{ key: 'mesh', reuse: true }, web()])).toContain(
      '沿用的「mesh」不是上一版的成果',
    );
    expect(
      problems(
        [{ key: 'model', reuse: true }, web({ mode: 'fresh' })],
        [old('model', 'model.glb', { outputs: [] }), nodes[1]!],
      ),
    ).toContain('「model」上一版没有可沿用的产出');
    expect(
      problems([agent('model', 'model.glb', { mode: 'fresh' }), { key: 'web', reuse: true }]),
    ).toContain('沿用的「web」的上游「model」要重新做');
    expect(
      problems([{ key: 'model', reuse: true }, web({ model: 'deepseek/y', mode: 'continue' })]),
    ).toContain('接着原会话改要用原来的模型 deepseek/x');
    expect(
      problems(
        [{ key: 'model', reuse: true }, web({ mode: 'continue' })],
        [nodes[0]!, old('web', 'site/**', { currentRunId: null })],
      ),
    ).toContain('只有上一版跑过的 agent 成果能接着原会话改');
  });
});

describe('意见直接交给做成果的 AI', () => {
  const direct = (targets: string[], input = nodes) =>
    directRevision({ nodes: input, edges, deliverables, targets });

  it('指到上游的成果：它接着原会话改，用到它的下游跟着更新；指到下游的：上游沿用', () => {
    expect(direct(['id-model'])).toMatchObject({
      plan: {
        summary: '按意见修改「旧model」，用到它的 1 样成果跟着更新',
        nodes: [
          { key: 'model', from: 'model', mode: 'continue', goal: '做 model' },
          { key: 'web', from: 'web', mode: 'continue' },
        ],
        edges: [{ from: 'model', to: 'web' }],
        deliverables,
      },
      changes: [
        { key: 'model', change: 'continue' },
        { key: 'web', change: 'continue' },
      ],
    });
    expect(direct(['id-web'])).toMatchObject({
      plan: {
        summary: '按意见修改「旧web」',
        nodes: [
          { key: 'model', reuse: 'model' },
          { key: 'web', from: 'web', mode: 'continue' },
        ],
      },
    });
  });

  it('下游不是能接着改的 AI（工具节点、没跑过）：重新跑', () => {
    const tool = old('web', 'site/**', { kind: 'tool', config: { steps: [] } } as Partial<Node>);
    expect(direct(['id-model'], [nodes[0]!, tool])?.plan.nodes[1]).toMatchObject({
      key: 'web',
      kind: 'tool',
      mode: 'fresh',
    });
  });

  it('指不到就交给规划员：没给又不止一样成果、指到生产线的节点、会话接不上', () => {
    expect(direct([])).toBeUndefined();
    expect(direct([], [nodes[1]!])).toMatchObject({
      changes: [{ key: 'web', change: 'continue' }],
    });
    const tool = old('web', 'site/**', { kind: 'tool', config: { steps: [] } } as Partial<Node>);
    expect(direct(['id-web'], [nodes[0]!, tool])).toBeUndefined();
    expect(
      direct(['id-web'], [nodes[0]!, old('web', 'site/**', { currentRunId: null })]),
    ).toBeUndefined();
  });
});
