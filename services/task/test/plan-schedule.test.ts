import { HttpError } from '@oasis/service-kit';
import { describe, expect, it } from 'vitest';
import type { DiscussionConfig } from '../src/repo/schema.ts';
import type { Edge, Node } from '../src/repo/task-store.ts';
import { findCycle, planToRows, validatePlan } from '../src/service/plan.ts';
import { decide } from '../src/service/schedule.ts';

const work = (key: string) => ({
  key,
  title: key,
  kind: 'work' as const,
  role: '',
  goal: `做 ${key}`,
  model: 'm',
  checks: [] as string[],
  expects: [] as string[],
  tools: [] as { key: string; uses: number }[],
});

describe('方案校验', () => {
  it('合法的菱形图通过，连线变成节点 ID', () => {
    const plan = {
      nodes: ['A', 'B', 'C'].map(work),
      edges: [
        { from: 'A', to: 'C' },
        { from: 'B', to: 'C' },
      ],
    };
    expect(() => validatePlan(plan)).not.toThrow();
    const rows = planToRows(plan);
    const id = (key: string) => rows.nodes.find((n) => n.key === key)?.id;
    expect(rows.edges.map((e) => [e.fromNodeId, e.toNodeId])).toEqual([
      [id('A'), id('C')],
      [id('B'), id('C')],
    ]);
    expect(rows.nodes.every((n) => n.status === 'waiting')).toBe(true);
  });

  it('重名、连到不存在的节点、连向自己、重复连线、环，一次列出', () => {
    const bad = (nodes: string[], edges: [string, string][]) => {
      try {
        validatePlan({ nodes: nodes.map(work), edges: edges.map(([from, to]) => ({ from, to })) });
      } catch (err) {
        return (err as HttpError).message;
      }
      return '';
    };
    expect(bad(['A', 'A'], [])).toContain('节点名重复');
    expect(bad(['A'], [['A', 'X']])).toContain('「X」不存在');
    expect(bad(['A'], [['A', 'A']])).toContain('不能连向自己');
    expect(
      bad(
        ['A', 'B'],
        [
          ['A', 'B'],
          ['A', 'B'],
        ],
      ),
    ).toContain('重复的连线');
    expect(
      bad(
        ['A', 'B', 'C'],
        [
          ['A', 'B'],
          ['B', 'C'],
          ['C', 'A'],
        ],
      ),
    ).toContain('有环');
    expect(findCycle(['A', 'B'], [{ from: 'A', to: 'B' }])).toBeUndefined();
  });

  describe('AI 节点的说明里写到 in/<别的节点>/', () => {
    const says = (key: string, goal: string) => ({ ...work(key), goal });
    const problems = (plan: Parameters<typeof validatePlan>[0]) => {
      try {
        validatePlan(plan);
      } catch (err) {
        return (err as HttpError).message;
      }
      return '';
    };
    const chain = [
      { from: 'build', to: 'check' },
      { from: 'check', to: 'fix' },
    ];

    it('要有直接连线：隔着一个节点的文件拿不到，规划时就退回', () => {
      // 真实任务里出过的方案：fix 只连了 check，说明里却要拷 in/build/site/，开跑后找不到文件、把游戏重做了一遍
      const nodes = [
        work('build'),
        work('check'),
        says('fix', '把 in/build/site/ 完整拷贝到 out/site/，再按 in/check/check-report.json 修'),
      ];
      const message = problems({ nodes, edges: chain });
      expect(message).toContain('没有连线 build → fix');
      expect(message).not.toContain('check → fix');
      expect(problems({ nodes, edges: [...chain, { from: 'build', to: 'fix' }] })).toBe('');
    });

    it('只管方案里的节点名：上一版的 in/_previous/、自己的名字、路径里凑巧的 in/ 都不算', () => {
      const fix = says(
        'fix',
        '在 in/_previous/ 的基础上改；plug-in/build/、src/in/build/ 是项目里的目录；in/fix/、in/别的/ 不用管',
      );
      expect(problems({ nodes: [work('build'), fix], edges: [] })).toBe('');
    });

    it('讨论参与者的立场、展开节点每条的 goal 也查', () => {
      const debate = {
        key: 'debate',
        title: '讨论',
        kind: 'discussion' as const,
        role: '',
        goal: '定方向',
        model: 'm',
        checks: [] as string[],
        expects: [] as string[],
        participants: [
          { name: '甲', model: 'm', stance: '对照 in/build/site/ 挑毛病' },
          { name: '乙', model: 'm', stance: '' },
        ],
        rounds: 1,
      };
      expect(problems({ nodes: [work('build'), debate], edges: [] })).toContain(
        '没有连线 build → debate',
      );
      const pages = {
        key: 'pages',
        title: '逐页做',
        kind: 'foreach' as const,
        role: '',
        goal: '每页一份',
        model: '',
        checks: [] as string[],
        expects: [] as string[],
        over: 'in/list/pages.json',
        count: 2,
        each: {
          kind: 'work' as const,
          role: '',
          goal: '第 {{index}} 页，素材在 in/build/assets/',
          model: 'm',
          checks: [] as string[],
          expects: [] as string[],
          tools: [] as { key: string; uses: number }[],
        },
      };
      const nodes = [work('list'), work('build'), pages];
      const listed = [{ from: 'list', to: 'pages' }];
      expect(problems({ nodes, edges: listed })).toContain('没有连线 build → pages');
      expect(problems({ nodes, edges: [...listed, { from: 'build', to: 'pages' }] })).toBe('');
    });
  });

  it('讨论节点：参与者不能重名；验收点、应有文件、参与者和轮数写进节点配置', () => {
    const discussion = (names: string[]) => ({
      key: 'D',
      title: '讨论',
      kind: 'discussion' as const,
      role: '',
      goal: '定方向',
      model: 'm',
      checks: ['给出明确建议'],
      expects: ['*.md'],
      participants: names.map((name) => ({ name, model: 'm', stance: '' })),
      rounds: 2,
    });
    expect(() => validatePlan({ nodes: [discussion(['甲', '甲'])], edges: [] })).toThrow(
      '重名的参与者',
    );
    const [row] = planToRows({ nodes: [discussion(['甲', '乙'])], edges: [] }).nodes;
    expect(row?.config).toMatchObject({
      checks: ['给出明确建议'],
      expects: ['*.md'],
      rounds: 2,
      round: 0,
      transcript: [],
    });
    expect((row?.config as DiscussionConfig).participants?.map((p) => p.name)).toEqual([
      '甲',
      '乙',
    ]);
  });
});

let seq = 0;
const node = (key: string, status: Node['status'] = 'waiting'): Node => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  taskId: 't',
  key,
  title: key,
  kind: 'work',
  role: '',
  goal: '',
  model: 'm',
  config: {},
  status,
  attempts: 0,
  reworks: 0,
  userNotes: [],
  warning: null,
  summary: null,
  outputs: [],
  currentRunId: null,
  spentMicro: 0,
  createdAt: new Date(),
  startedAt: null,
  finishedAt: null,
  retiredVersion: null,
  parentId: null,
  slot: null,
});
const edge = (from: Node | null, to: Node | null): Edge => ({
  id: `e-${from?.key}-${to?.key}`,
  taskId: 't',
  fromNodeId: from?.id ?? null,
  toNodeId: to?.id ?? null,
});

describe('调度决定', () => {
  it('并行：互不依赖的一起开跑，但不超过并发上限；串行：上游没完成的不跑', () => {
    const [a, b, c, d] = [node('A'), node('B'), node('C'), node('D')];
    const result = decide({
      taskStatus: 'running',
      nodes: [a, b, c, d],
      edges: [edge(a, d)],
      maxParallel: 2,
      maxToolChildren: 6,
    });
    expect(result.start.map((n) => n.key)).toEqual(['A', 'B']);
    expect(result.task).toBeUndefined();
  });

  it('上游都完成才开跑下游；全部完成则任务完成', () => {
    const [a, b] = [node('A', 'succeeded'), node('B')];
    expect(
      decide({
        taskStatus: 'running',
        nodes: [a, b],
        edges: [edge(a, b)],
        maxParallel: 3,
        maxToolChildren: 6,
      }).start,
    ).toEqual([b]);
    const done = decide({
      taskStatus: 'running',
      nodes: [a, node('B', 'succeeded')],
      edges: [],
      maxParallel: 3,
      maxToolChildren: 6,
    });
    expect(done.task?.status).toBe('succeeded');
  });

  it('有空的进线就是断开，永远不自动跑；跑不下去时任务需要用户处理', () => {
    const [a, c] = [node('A', 'succeeded'), node('C')];
    const result = decide({
      taskStatus: 'running',
      nodes: [a, c],
      edges: [edge(a, null), edge(null, c)],
      maxParallel: 3,
      maxToolChildren: 6,
    });
    expect(result.blocked).toEqual([c]);
    expect(result.start).toEqual([]);
    expect(result.task).toMatchObject({
      status: 'needs_attention',
      attention: { reason: 'workflow_broken' },
    });
  });

  it('有节点失败（重做用完）：任务需要用户处理；任务不在运行时不开跑新节点', () => {
    const [a, b] = [node('A', 'failed'), node('B')];
    const stuck = decide({
      taskStatus: 'running',
      nodes: [a, b],
      edges: [edge(a, b)],
      maxParallel: 3,
      maxToolChildren: 6,
    });
    expect(stuck.task).toMatchObject({
      status: 'needs_attention',
      attention: { reason: 'node_failed' },
    });
    expect(
      decide({
        taskStatus: 'needs_attention',
        nodes: [node('X')],
        edges: [],
        maxParallel: 3,
        maxToolChildren: 6,
      }).start,
    ).toEqual([]);
  });
});
