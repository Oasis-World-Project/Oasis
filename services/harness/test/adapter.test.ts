import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { sandboxEnv, translateNotification, runtimeFiles } from '../src/adapter/dsh.ts';
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

  it.each(['max-tokens', 'aborted', 'unknown', undefined])(
    '拒绝非 completed 的结束原因：%s',
    (kind) => {
      expect(translateNotification(...event('turn/end', { reason: { kind } }))).toMatchObject({
        kind: 'error',
        data: { reason: kind ?? 'unknown' },
      });
    },
  );

  it('过长的内容截断', () => {
    const translated = translateNotification(
      ...event('tool/call', { callId: 'c', name: 'write', arguments: 'x'.repeat(10_000) }),
    );
    expect(String(translated?.data.arguments).length).toBeLessThan(4_100);
  });

  it('模型能力通过文件保留，环境变量不承载整个目录；没有出口代理不装包', () => {
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
    const files = runtimeFiles({
      models: [
        {
          id: 'deepseek/x',
          name: 'DeepSeek',
          contextWindow: 1000000,
          maxTokens: 131072,
          input: ['text', 'image'],
          reasoning: true,
        },
      ],
      sessionId: 'root',
      objective: 'task',
      goal: true,
      goalRoundWindow: 256,
    });
    expect(JSON.parse(files[0]!.content.toString())).toMatchObject([
      {
        maxTokens: 131072,
        contextWindow: 1000000,
        input: ['text', 'image'],
        reasoningEfforts: { high: 'high' },
      },
    ]);
    expect(env.OASIS_MODELS).toBeUndefined();
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
    await expect(hanging).rejects.toThrow(/closed/i);
  });
});

describe('根目标与代理树', () => {
  it('子代理错误不终结根；中间 idle 不完成持续目标', async () => {
    const { connectAgent } = await import('../src/adapter/dsh.ts');
    const input = new PassThrough();
    const output = new PassThrough();
    const observed: unknown[] = [];
    const send = (method: string, params: unknown) =>
      input.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    output.on('data', (line: Buffer) => {
      const request = JSON.parse(line.toString());
      if (request.method === 'session/prompt') {
        send('session.event', {
          sessionId: 'root',
          event: { type: 'goal/change', data: { goal: { phase: 'active' } } },
        });
        send('session.event', {
          sessionId: 'root',
          event: { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        });
      }
      input.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\n');
    });
    const agent = connectAgent({
      stdin: output,
      stdout: input,
      sessionId: 'root',
      goal: true,
      onEvent: (event) => observed.push(event),
    });
    await agent.prompt('do work');
    let ended = false;
    const done = agent.waitIdle().then((failure) => {
      ended = true;
      return failure;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(ended).toBe(false);
    send('subagent.started', { parentSessionId: 'root', childSessionId: 'child' });
    send('session.event', {
      sessionId: 'child',
      event: {
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { message: 'child failed' } } },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(ended).toBe(false);
    send('session.event', {
      sessionId: 'root',
      event: { type: 'goal/change', data: { goal: { phase: 'complete' } } },
    });
    expect(await done).toBeUndefined();
    expect(observed).toContainEqual({
      kind: 'error',
      data: { message: 'child failed', sessionId: 'child', parentSessionId: 'root' },
    });
    agent.abort(new Error('test closed'));
  });
});
