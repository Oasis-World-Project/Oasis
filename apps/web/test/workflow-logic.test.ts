import type { NodeBody, TaskBody } from '@oasis/contracts/task';
import { describe, expect, it } from 'vitest';
import { layout, NODE_W } from '../src/workflow/layout.ts';
import { keyFor } from '../src/workflow/NodeEditor.tsx';
import { nodeActions, runLabel, stepsOf } from '../src/workflow/rules.ts';

describe('工作流自动布局', () => {
  it('按最长上游链分列，同一列里按上游的位置排', () => {
    const p = layout(
      ['a', 'b', 'c', 'd', 'x'],
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

  it('有环也不会卡住', () => {
    const p = layout(
      ['a', 'b'],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    );
    expect(p.size).toBe(2);
  });
});

describe('节点名', () => {
  it('从标题生成，去掉不能用的字符，不重名', () => {
    expect(keyFor('写 首页：文案', new Set())).toBe('写-首页-文案');
    expect(keyFor('写首页', new Set(['写首页', '写首页-2']))).toBe('写首页-3');
    expect(keyFor('!!!', new Set())).toBe('node');
  });
});

const node = (id: string, status: NodeBody['status']) => ({ id, status, title: id }) as NodeBody;
const task = (
  nodes: NodeBody[],
  edges: TaskBody['edges'],
  status: TaskBody['status'] = 'running',
) => ({ status, nodes, edges }) as TaskBody;

describe('节点现在能做什么（和 task 的规则一致）', () => {
  it('还没开始的能改、能删、能往里接线；跑完的都不行', () => {
    const t = task(
      [node('a', 'succeeded'), node('b', 'waiting')],
      [{ id: 'e', from: 'a', to: 'b' }],
    );
    expect(nodeActions(t, t.nodes[1]!)).toMatchObject({
      edit: true,
      remove: true,
      run: true,
      acceptsInput: true,
    });
    expect(nodeActions(t, t.nodes[0]!)).toMatchObject({
      edit: false,
      remove: false,
      run: false,
      message: false,
    });
  });

  it('上游没完成的不能单独运行；停止的可以继续；任务结束后什么都不能动', () => {
    const t = task(
      [node('a', 'running'), node('b', 'waiting'), node('c', 'stopped')],
      [
        { id: 'e', from: 'a', to: 'b' },
        { id: 'f', from: 'a', to: 'c' },
      ],
    );
    expect(nodeActions(t, t.nodes[1]!).run).toBe(false);
    expect(nodeActions(t, t.nodes[2]!).run).toBe(true);
    expect(nodeActions(t, t.nodes[0]!)).toMatchObject({ stop: true, message: true });
    const done = task(t.nodes, t.edges, 'succeeded');
    expect(Object.values(nodeActions(done, t.nodes[1]!)).some(Boolean)).toBe(false);
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
