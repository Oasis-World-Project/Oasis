import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { sandboxEnv, translateNotification } from '../src/adapter/dsh.ts';
import { createJsonRpcClient, JsonRpcError } from '../src/adapter/jsonrpc.ts';

const event = (type: string, data: unknown) =>
  ['session.event', { event: { type, data } }] as const;

describe('dsh 事件翻译', () => {
  it('只保留用户真正说的话，丢掉 dsh 自己插的运行时上下文', () => {
    expect(
      translateNotification(
        ...event('user/message', {
          source: { kind: 'user' },
          content: [{ type: 'text', text: '写报告' }],
        }),
      ),
    ).toEqual({ kind: 'user_message', data: { text: '写报告' } });
    expect(
      translateNotification(
        ...event('user/message', {
          source: { kind: 'runtime' },
          content: [{ type: 'text', text: 'ctx' }],
        }),
      ),
    ).toBeUndefined();
  });

  it('工具调用、工具结果（含失败原因）、模型错误、轮次结束、忙闲状态', () => {
    expect(
      translateNotification(
        ...event('tool/call', { callId: 'c1', name: 'write', arguments: '{}' }),
      ),
    ).toEqual({
      kind: 'tool_call',
      data: { callId: 'c1', name: 'write', arguments: '{}' },
    });
    expect(
      translateNotification(
        ...event('tool/result', {
          message: {
            toolCallId: 'c1',
            isError: true,
            content: [{ type: 'text', text: 'no such file' }],
          },
          error: { name: 'E', code: 'ENOENT', reason: '文件不存在' },
        }),
      ),
    ).toEqual({
      kind: 'tool_result',
      data: { callId: 'c1', ok: false, text: 'no such file', error: '文件不存在' },
    });
    expect(
      translateNotification(
        ...event('turn/end', { reason: { kind: 'error', error: { message: '402' } } }),
      ),
    ).toEqual({ kind: 'error', data: { message: '402' } });
    expect(translateNotification(...event('turn/end', { reason: { kind: 'completed' } }))).toEqual({
      kind: 'turn_end',
      data: { reason: 'completed' },
    });
    expect(translateNotification('session.status', { status: 'idle' })).toEqual({
      kind: 'status',
      data: { status: 'idle' },
    });
    expect(translateNotification(...event('step/start', {}))).toBeUndefined();
  });

  it('只有空白的 AI 发言不记（模型调工具前常吐一段空白）', () => {
    expect(
      translateNotification(
        ...event('assistant/message', { message: { content: [{ type: 'text', text: '  \n' }] } }),
      ),
    ).toBeUndefined();
  });

  it('过长的内容截断', () => {
    const translated = translateNotification(
      ...event('tool/call', { callId: 'c', name: 'write', arguments: 'x'.repeat(10_000) }),
    );
    expect(String(translated?.data.arguments).length).toBeLessThan(4_100);
  });

  it('沙箱环境变量：模型列表只有这次运行用的型号；没有出口代理就不给装包的通路', () => {
    const packages = {
      egressProxy: undefined,
      npmRegistry: 'https://r/',
      pipIndexUrl: 'https://p/simple',
    };
    const env = sandboxEnv({
      modelBaseUrl: 'http://ingress/v1',
      runKey: 'k',
      model: 'deepseek/x',
      packages,
    });
    expect(JSON.parse(env.OASIS_MODELS ?? '')).toEqual([{ id: 'deepseek/x', name: 'deepseek/x' }]);
    // dsh 运行命令时会去掉 OASIS_RUN_KEY，oasis-tool 用这一份
    expect(env.OASIS_TOOL_AUTH).toBe('k');
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.npm_config_registry).toBeUndefined();
  });
});

describe('JSON-RPC 客户端', () => {
  it('请求按 id 配对响应；通知交给回调；错误响应变成 JsonRpcError；连接断开时未完成的请求失败', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const notes: string[] = [];
    const rpc = createJsonRpcClient({ input, output, onNotification: (m) => notes.push(m) });
    output.setEncoding('utf8');
    const sent: { id: number; method: string }[] = [];
    output.on('data', (line: string) =>
      sent.push(
        ...line
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as { id: number; method: string }),
      ),
    );

    const ok = rpc.request<{ v: number }>('a');
    const bad = rpc.request('b');
    await new Promise((r) => setImmediate(r));
    input.write('not json\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session.status', params: {} })}\n`);
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: sent[1]?.id, error: { code: -32603, message: 'boom' } })}\n`,
    );
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: sent[0]?.id, result: { v: 1 } })}\n`);
    await expect(ok).resolves.toEqual({ v: 1 });
    await expect(bad).rejects.toBeInstanceOf(JsonRpcError);
    expect(notes).toEqual(['session.status']);

    const hanging = rpc.request('c');
    input.end();
    await expect(hanging).rejects.toThrow('连接已关闭');
  });
});
