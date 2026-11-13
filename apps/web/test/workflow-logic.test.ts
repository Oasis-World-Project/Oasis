import type { NodeBody, TaskBody } from '@oasis/contracts/task';
import { describe, expect, it } from 'vitest';
import { layout, NODE_H, NODE_W } from '../src/workflow/layout.ts';
import {
  frameRows,
  nodeActions,
  progressOf,
  runLabel,
  stepArgs,
  stepsOf,
} from '../src/workflow/rules.ts';

const box = (id: string, w = NODE_W, h = NODE_H) => ({ id, w, h });

describe('工作流自动布局', () => {
  it('按最长上游链分列，同一列里按上游的位置排', () => {
    const { positions: p } = layout(
      ['a', 'b', 'c', 'd', 'x'].map((id) => box(id)),
      [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'd' },
        { from: 'c', to: 'd' },
        { from: 'a', to: 'd' },
      ],
    );
    const col = (id: string) => p.get(id)!.x / (NODE_W + 72);
    expect(['a', 'b', 'c', 'd', 'x'].map(col)).toEqual([0, 1, 1, 2, 0]);
    expect(p.get('b')!.y).toBeLessThan(p.get('c')!.y);
  });

  it('块的大小不一样：列宽取最宽的，同一列按各自的高往下排，整张图多大算得出来', () => {
    const {
      positions: p,
      width,
      height,
    } = layout([box('a', 264, 200), box('b'), box('c', 300, 150)], [{ from: 'a', to: 'c' }]);
    expect(p.get('c')).toEqual({ x: 264 + 72, y: (200 + 36 + NODE_H - 150) / 2 });
    expect(p.get('b')!.y - p.get('a')!.y).toBe(200 + 36);
    expect([width, height]).toEqual([264 + 72 + 300, 200 + 36 + NODE_H]);
  });

  it('有环也不会卡住', () => {
    const { positions } = layout(
      [box('a'), box('b')],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    );
    expect(positions.size).toBe(2);
  });
});

const node = (id: string, status: NodeBody['status']) => ({ id, status, title: id }) as NodeBody;
const task = (
  nodes: NodeBody[],
  edges: TaskBody['edges'],
  status: TaskBody['status'] = 'running',
) => ({ status, nodes, edges }) as TaskBody;

describe('一样成果现在能做什么（和 task 的规则一致）', () => {
  it('停下的可以继续，失败的等上游做完才能再试；在跑的能停、能追问；做完的都不行', () => {
    const t = task(
      [
        node('a', 'running'),
        node('b', 'waiting'),
        node('c', 'stopped'),
        node('d', 'failed'),
        node('e', 'succeeded'),
      ],
      [
        { id: 'e', from: 'a', to: 'b' },
        { id: 'f', from: 'a', to: 'c' },
        { id: 'g', from: 'a', to: 'd' },
      ],
    );
    const can = (index: number) => nodeActions(t, t.nodes[index]!);
    expect(can(0)).toEqual({ run: false, stop: true, message: true });
    expect(can(1)).toEqual({ run: false, stop: false, message: true });
    expect(can(2)).toEqual({ run: true, stop: false, message: true });
    expect(can(3)).toEqual({ run: false, stop: false, message: false });
    expect(can(4)).toEqual({ run: false, stop: false, message: false });
    // 任务结束后、修改方案等确认时什么都不能动
    const done = task(t.nodes, t.edges, 'succeeded');
    expect(Object.values(nodeActions(done, t.nodes[2]!)).some(Boolean)).toBe(false);
    const revising = { ...t, revision: { stage: 'confirm' } } as TaskBody;
    expect(Object.values(nodeActions(revising, t.nodes[2]!)).some(Boolean)).toBe(false);
  });

  it('工具节点没有 AI：能停，不能追问', () => {
    const tool = { ...node('t', 'running'), kind: 'tool' } as NodeBody;
    expect(nodeActions(task([tool], []), tool)).toMatchObject({ stop: true, message: false });
  });
});

describe('一样成果做到哪了（AI 自己列的任务清单）', () => {
  const at = '2026-11-13T00:00:00.000Z';
  const call = (seq: number, name: string, args: object) => ({
    seq,
    kind: 'tool_call' as const,
    data: { callId: `c${seq}`, name, arguments: JSON.stringify(args) },
    createdAt: at,
  });
  const todos = (seq: number, list: [string, string][]) =>
    call(seq, 'todo_write', { todos: list.map(([content, status]) => ({ content, status })) });
  const toolName = (key: string) => key;

  it('清单取最后一次列的；后来的运行没再列，就沿用之前那次的', () => {
    const first = [
      todos(0, [
        ['写页面', 'in_progress'],
        ['自查', 'pending'],
      ]),
      call(1, 'write', { path: 'out/index.html' }),
      todos(2, [
        ['写页面', 'completed'],
        ['自查', 'in_progress'],
      ]),
    ];
    const progress = progressOf([first, [call(0, 'write', { path: 'out/style.css' })]]);
    expect(progress.todos).toEqual([
      { text: '写页面', state: 'done' },
      { text: '自查', state: 'doing' },
    ]);
    expect(frameRows(progress, toolName)).toEqual([
      { mark: 'done', text: '写页面' },
      { mark: 'doing', text: '自查' },
    ]);
  });

  it('没列清单时显示最近几步；清单太长只显示正在做的那一段，末行写总数', () => {
    const none = progressOf([
      ['a', 'b', 'c', 'd'].map((name, seq) => call(seq, 'write', { path: `out/${name}.md` })),
    ]);
    expect(none.todos).toBeNull();
    expect(frameRows(none, toolName).map((row) => row.text)).toEqual([
      '写文件 out/b.md',
      '写文件 out/c.md',
      '写文件 out/d.md',
    ]);
    expect(frameRows(undefined, toolName)).toEqual([]);

    const long = progressOf([
      [
        todos(
          0,
          Array.from({ length: 14 }, (_, i): [string, string] => [
            `第 ${i + 1} 步`,
            i < 8 ? 'completed' : i === 8 ? 'in_progress' : 'pending',
          ]),
        ),
      ],
    ]);
    const rows = frameRows(long, toolName);
    expect(rows).toHaveLength(11);
    expect(rows[0]).toEqual({ mark: 'done', text: '第 5 步' });
    expect(rows.at(-1)).toEqual({ mark: 'note', text: '共 14 项，完成了 8 项' });
  });
});

describe('运行过程写成普通话', () => {
  const at = '2026-10-24T00:00:00.000Z';
  it('认出外部工具、文件操作、你说的话和失败的调用', () => {
    const steps = stepsOf([
      { seq: 0, kind: 'assistant_text', data: { text: '开始' }, createdAt: at },
      {
        seq: 1,
        kind: 'tool_call',
        data: { callId: 'a', name: 'write', arguments: '{"path":"out/a.md"}' },
        createdAt: at,
      },
      {
        seq: 2,
        kind: 'tool_call',
        data: {
          callId: 'b',
          name: 'bash',
          arguments: '{"command":"oasis-tool image.generate --prompt x"}',
        },
        createdAt: at,
      },
      { seq: 3, kind: 'tool_result', data: { callId: 'b', ok: false }, createdAt: at },
      { seq: 4, kind: 'user_message', data: { text: '加盏灯' }, createdAt: at },
      { seq: 5, kind: 'status', data: { status: 'idle' }, createdAt: at },
    ]);
    expect(steps).toEqual([
      { kind: 'said', text: '开始' },
      { kind: 'did', text: '写文件', detail: 'out/a.md' },
      {
        kind: 'did',
        text: '调用工具',
        tool: 'image.generate',
        detail: 'oasis-tool image.generate --prompt x',
        failed: true,
      },
      { kind: 'you', text: '加盏灯' },
    ]);
  });

  it('工具节点的步骤：本地操作（oasis-op、oasis-tool op.*）记成 op.* 工具；参数写成一行', () => {
    const call = (callId: string, command: string) => ({
      seq: 0,
      kind: 'tool_call' as const,
      data: { callId, name: 'bash', arguments: JSON.stringify({ command }) },
      createdAt: at,
    });
    expect(
      stepsOf([
        call('a', 'oasis-op video.concat --in a.mp4,b.mp4 --out out/c.mp4'),
        call('b', 'oasis-tool op.media.convert --in out/c.mp4 --out out/c.gif'),
      ]).map((s) => (s.kind === 'did' ? s.tool : undefined)),
    ).toEqual(['op.video.concat', 'op.media.convert']);
    expect(
      stepArgs({ args: { prompt: '猫'.repeat(70), in: ['out/1.mp4', 'out/2.mp4'], n: 2 } }),
    ).toBe(`prompt=${'猫'.repeat(60)}…，in=["out/1.mp4","out/2.mp4"]，n=2`);
    expect(stepArgs({ args: {} })).toBe('（没有参数）');
  });

  it('每次运行的名字', () => {
    const run = {
      purpose: 'work',
      attempt: 1,
      continued: false,
      round: null,
      participant: null,
    } as const;
    expect(runLabel({ ...run } as never)).toBe('第 1 次');
    expect(runLabel({ ...run, continued: true } as never)).toBe('停止后继续');
    expect(runLabel({ ...run, purpose: 'rework' } as never)).toBe('关卡没过，接着改');
    expect(runLabel({ ...run, purpose: 'speech', round: 2, participant: '设计' } as never)).toBe(
      '第 2 轮 · 设计',
    );
  });
});
