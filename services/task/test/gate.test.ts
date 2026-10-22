import type { ServiceClient } from '@oasis/service-kit';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { checkRules, createGate } from '../src/service/gate.ts';

describe('关卡的规则检查', () => {
  it('没有产出、缺文件、文件是空的都算没过；通配只匹配一段路径', () => {
    expect(checkRules([], [])).toEqual(['out/ 里没有任何产出文件']);
    const outputs = [
      { path: '报告.md', size: 120 },
      { path: 'img/封面.png', size: 0 },
    ];
    expect(checkRules(outputs, ['*.md'])).toEqual([]);
    expect(checkRules(outputs, ['img/*.png'])).toEqual(['文件 out/img/*.png 是空的']);
    expect(checkRules(outputs, ['*.png', '数据.csv'])).toEqual([
      '缺少文件 out/*.png',
      '缺少文件 out/数据.csv',
    ]);
  });
});

/** 假的服务客户端：按路径返回固定内容，记下请求 */
function fakeClient(answer: (path: string, body: unknown) => unknown) {
  const calls: { path: string; body: unknown; headers?: Record<string, string> }[] = [];
  const client = {
    async json(
      _method: string,
      path: string,
      options?: { body?: unknown; headers?: Record<string, string> },
    ) {
      calls.push({ path, body: options?.body, headers: options?.headers });
      return answer(path, options?.body);
    },
    stream: () => Promise.reject(new Error('不用')),
  } as unknown as ServiceClient;
  return { client, calls };
}

const PAYER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const TASK = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const NODE = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
const input = {
  payerId: PAYER,
  taskId: TASK,
  nodeId: NODE as string | null,
  goal: '写一份介绍',
  runs: [{ runId: 'run-1', summary: '写好了', outputs: [{ path: '介绍.md', size: 50 }] }],
  checks: ['提到了价格', '语气友好'],
  expects: ['*.md'],
};

describe('关卡的验收点检查', () => {
  it('每条验收点问一个是否满足；低于阈值的算没满足；记在付钱的人账上', async () => {
    const harness = fakeClient(() => ({
      files: [{ path: '介绍.md', text: '欢迎光临' }],
      truncated: false,
    }));
    const gateway = fakeClient(() => ({
      answers: { c0: { type: 'noul', noul: 0.2 }, c1: { type: 'noul', noul: 0.9 } },
    }));
    const gate = createGate({
      harness: harness.client,
      modelGateway: gateway.client,
      model: 'typesafe/jev-1.14',
      threshold: 0.5,
      logger: pino({ level: 'silent' }),
    });
    expect(await gate.check(input)).toEqual({ unmet: ['提到了价格'] });
    expect(harness.calls[0]?.path).toBe('/internal/runs/run-1/texts?maxChars=8000');
    expect(harness.calls).toHaveLength(1);
    const call = gateway.calls[0] as {
      body: { state: string[]; questions: object };
      headers: object;
    };
    expect(call.headers).toEqual({
      'x-oasis-payer-id': PAYER,
      'x-oasis-task-id': TASK,
      'x-oasis-node-id': NODE,
    });
    expect(Object.keys(call.body.questions)).toEqual(['c0', 'c1']);
    expect(call.body.state.join('\n')).toContain('欢迎光临');
  });

  it('规则没过就不问 Jev；Jev 出错就放行', async () => {
    const gateway = fakeClient(() => {
      throw new Error('连不上');
    });
    const gate = createGate({
      harness: fakeClient(() => ({ files: [], truncated: false })).client,
      modelGateway: gateway.client,
      model: 'typesafe/jev-1.14',
      threshold: 0.5,
      logger: pino({ level: 'silent' }),
    });
    expect(await gate.check({ ...input, runs: [{ ...input.runs[0]!, outputs: [] }] })).toEqual({
      unmet: ['out/ 里没有任何产出文件'],
    });
    expect(gateway.calls).toHaveLength(0);
    expect(await gate.check(input)).toEqual({ unmet: [] });
  });

  it('整体验收：几个节点的运行一起看（各自标上名字），不带节点归属', async () => {
    const harness = fakeClient((path) => ({
      files: [{ path: 'x.md', text: path.includes('run-2') ? '第二份' : '第一份' }],
      truncated: false,
    }));
    const gateway = fakeClient(() => ({ answers: { c0: { type: 'noul', noul: 0.9 } } }));
    const gate = createGate({
      harness: harness.client,
      modelGateway: gateway.client,
      model: 'typesafe/jev-1.14',
      threshold: 0.5,
      logger: pino({ level: 'silent' }),
    });
    const result = await gate.check({
      ...input,
      nodeId: null,
      checks: ['都写好了'],
      runs: [
        { ...input.runs[0]!, label: '首页文案' },
        { runId: 'run-2', summary: null, outputs: [{ path: 'b.md', size: 1 }], label: '海报' },
      ],
    });
    expect(result).toEqual({ unmet: [] });
    expect(harness.calls.map((c) => c.path)).toEqual([
      '/internal/runs/run-1/texts?maxChars=4000',
      '/internal/runs/run-2/texts?maxChars=4000',
    ]);
    const call = gateway.calls[0] as { body: { state: string[] }; headers: object };
    expect(call.headers).toEqual({ 'x-oasis-payer-id': PAYER, 'x-oasis-task-id': TASK });
    expect(call.body.state.join('\n')).toContain('「海报」产出文件：b.md');
  });
});
