import { HttpError } from '@oasis/service-kit';
import { describe, expect, it } from 'vitest';
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
  userNotes: [],
  warning: null,
  summary: null,
  outputs: [],
  currentRunId: null,
  spentMicro: 0,
  createdAt: new Date(),
  startedAt: null,
  finishedAt: null,
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
    });
    expect(result.start.map((n) => n.key)).toEqual(['A', 'B']);
    expect(result.task).toBeUndefined();
  });

  it('上游都完成才开跑下游；全部完成则任务完成', () => {
    const [a, b] = [node('A', 'succeeded'), node('B')];
    expect(
      decide({ taskStatus: 'running', nodes: [a, b], edges: [edge(a, b)], maxParallel: 3 }).start,
    ).toEqual([b]);
    const done = decide({
      taskStatus: 'running',
      nodes: [a, node('B', 'succeeded')],
      edges: [],
      maxParallel: 3,
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
    });
    expect(stuck.task).toMatchObject({
      status: 'needs_attention',
      attention: { reason: 'node_failed' },
    });
    expect(
      decide({ taskStatus: 'needs_attention', nodes: [node('X')], edges: [], maxParallel: 3 })
        .start,
    ).toEqual([]);
  });
});
