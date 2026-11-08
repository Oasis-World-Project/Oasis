// 一次模型调用：冻结、调用、转发、结算，以及流中断和上游出错时怎么收场。
import { createServiceClient, HttpError } from '@oasis/service-kit';
import { describe, expect, it } from 'vitest';
import { createOpenRouterClient } from '../src/adapters/openrouter.ts';
import { createChatService } from '../src/service/chat-service.ts';
import { createMeter } from '../src/service/metering.ts';
import {
  fake,
  PAYER,
  RUN,
  billingCalls,
  generationCosts,
  generationLookups,
  started,
  finished,
  repo,
  silent,
  chat,
  request,
} from './support/chat-fixture.ts';

describe('一次模型调用', () => {
  it('后台执行的传输中断先结算再交还原生重试，不改写为普通 SSE 模型错误', async () => {
    const call = await chat.prepare({
      caller: { payerId: PAYER, runId: RUN },
      requestId: 'native-disconnect',
      body: request,
    });
    let forwarded = '';
    await expect(
      chat.pump(
        call,
        new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
        (chunk) => {
          forwarded += chunk;
        },
        { transportErrors: 'disconnect' },
      ),
    ).rejects.toMatchObject({ code: 'stream_interrupted' });
    expect(forwarded).toContain('partial');
    expect(forwarded).not.toContain('"error"');
    expect(finished[0]).toMatchObject({ status: 'failed', costSource: 'estimate' });
    expect(billingCalls.map((c) => c.path)).toEqual(['/internal/holds', 'settle']);
  });
  it('非流式响应体中断也结算估算费用并标失败，不遗留运行中调用', async () => {
    const call = await chat.prepare({
      caller: { payerId: PAYER },
      requestId: 'broken-json',
      body: { ...request, stream: false },
    });
    await expect(chat.finishJson(call, new Response('{"choices":'))).rejects.toMatchObject({
      code: 'response_interrupted',
    });
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: 'failed', costSource: 'estimate' });
    expect(billingCalls.map((c) => c.path)).toEqual(['/internal/holds', 'settle']);
  });
  it('正常 EOF 缺少完成标记或供应商流内报错，都不能记为成功', async () => {
    for (const content of [
      'data: {"choices":[{"delta":{"content":"部分"}}]}\n\n',
      'data: {"error":{"message":"upstream failed"}}\n\ndata: [DONE]\n\n',
    ]) {
      const call = await chat.prepare({
        caller: { payerId: PAYER },
        requestId: 'not-completed',
        body: request,
      });
      await chat.pump(call, new Response(content), () => undefined);
      expect(finished.at(-1)?.status).toBe('failed');
    }
  });
  it('收到完成标记即完成读取，先结算再转发 DONE，正常关闭不记成中断', async () => {
    const call = await chat.prepare({
      caller: { payerId: PAYER },
      requestId: 'done-before-close',
      body: request,
    });
    let pulls = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (pulls++ === 0)
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[],"usage":{"cost":0.000042}}\n\ndata: [DONE]\n\n',
                ),
              );
            else controller.error(new DOMException('Client closes after DONE', 'AbortError'));
          },
        },
        { highWaterMark: 0 },
      ),
    );
    let forwarded = '';
    await chat.pump(call, response, (chunk) => {
      if (chunk.includes('[DONE]')) expect(finished).toHaveLength(1);
      forwarded += chunk;
    });
    expect(forwarded).toContain('[DONE]');
    expect(forwarded).not.toContain('stream_interrupted');
    expect(pulls).toBe(1);
    expect(finished[0]).toMatchObject({
      status: 'succeeded',
      upstreamCostMicro: 42,
      costSource: 'provider',
    });
  });
  it('没有完成标记的真实中断仍记失败，不能用部分用量冒充完整成功', async () => {
    const call = await chat.prepare({
      caller: { payerId: PAYER },
      requestId: 'interrupted',
      body: request,
    });
    let pulls = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (pulls++ === 0)
              controller.enqueue(
                new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n'),
              );
            else controller.error(new DOMException('Interrupted', 'AbortError'));
          },
        },
        { highWaterMark: 0 },
      ),
    );
    await chat.pump(call, response, () => undefined);
    expect(finished[0]).toMatchObject({ status: 'failed' });
    expect(finished[0]?.error).toContain('中断');
  });
  it('中断时按生成 ID 向供应商查实际花费结算；查不到才按估算（2026-11-08）', async () => {
    const interrupted = () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"id":"gen-1","choices":[{"delta":{"reasoning":"想"}}]}\n\n',
                ),
              );
            },
            pull(controller) {
              controller.error(new DOMException('This operation was aborted', 'AbortError'));
            },
          },
          { highWaterMark: 0 },
        ),
      );
    generationCosts.set('gen-1', 0.031);
    const first = await chat.prepare({
      caller: { payerId: PAYER },
      requestId: 'r1',
      body: request,
    });
    await chat.pump(first, interrupted(), () => undefined);
    expect(finished[0]).toMatchObject({
      status: 'failed',
      upstreamCostMicro: 31_000,
      costSource: 'provider',
    });
    expect(generationLookups).toEqual(['gen-1']);

    generationCosts.clear();
    const second = await chat.prepare({
      caller: { payerId: PAYER },
      requestId: 'r2',
      body: request,
    });
    await chat.pump(second, interrupted(), () => undefined);
    // 两次都查不到：按估算记
    expect(generationLookups).toEqual(['gen-1', 'gen-1', 'gen-1']);
    expect(finished[1]).toMatchObject({ status: 'failed', costSource: 'estimate' });
  });
  it('批次预算在冻结前校验，不透传供应商；非流式返回计量金额', async () => {
    await expect(
      chat.prepare({
        caller: { payerId: PAYER },
        requestId: 'budget',
        body: { ...request, max_cost_micro: 1 },
      }),
    ).rejects.toMatchObject({ code: 'call_budget_exceeded' });
    expect(billingCalls).toEqual([]);
    const call = await chat.prepare({
      caller: { payerId: PAYER, runId: RUN },
      requestId: 'r',
      body: { ...request, stream: false, max_cost_micro: 1000 },
    });
    expect(call.body).not.toHaveProperty('max_cost_micro');
    const result = await chat.finishJson(
      call,
      Response.json({ choices: [{ message: { content: '完成' } }], usage: { cost: 0.000042 } }),
    );
    expect(result).toMatchObject({ oasis: { costMicro: 42 } });
    expect(started[0]).toMatchObject({ runId: RUN, payerId: PAYER });
  });
  it('先冻结、再调用、原样转发，并按供应商返回的实际花费结算', async () => {
    const call = await chat.prepare({
      caller: { payerId: PAYER },
      requestId: 'req-1',
      body: request,
    });
    const response = await chat.open(call, new AbortController().signal);
    let forwarded = '';
    await chat.pump(call, response, (chunk) => (forwarded += chunk));

    expect(billingCalls[0]).toMatchObject({
      path: '/internal/holds',
      body: { userId: PAYER, reason: 'model_call' },
    });
    expect(fake.upstreamBodies[0]).toMatchObject({
      model: 'vendor/model',
      max_tokens: 1000,
      usage: { include: true },
    });
    expect(forwarded).toContain('你好');
    expect(forwarded).toContain('[DONE]');
    expect(billingCalls[1]).toMatchObject({ path: 'settle', body: { costMicro: 42 } });
    expect(finished[0]).toMatchObject({
      status: 'succeeded',
      promptTokens: 12,
      completionTokens: 3,
      upstreamCostMicro: 42,
      costSource: 'provider',
    });
  });

  it('额度不够时返回 402，不会调用上游', async () => {
    fake.balanceEnough = false;
    await expect(
      chat.prepare({ caller: { payerId: PAYER }, requestId: 'req-2', body: request }),
    ).rejects.toMatchObject({ statusCode: 402, code: 'insufficient_balance' });
    expect(fake.upstreamBodies).toHaveLength(0);
  });

  it('上游出错时退回冻结，不扣钱', async () => {
    fake.upstreamStatus = 500;
    const call = await chat.prepare({
      caller: { payerId: PAYER },
      requestId: 'req-3',
      body: request,
    });
    const err = await chat.open(call, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('provider_error');
    expect(billingCalls.map((c) => c.path)).toEqual(['/internal/holds', 'release']);
    expect(finished[0]).toMatchObject({ status: 'failed', chargedMicro: 0 });
  });

  it('平台在供应商那边额度不够（402）：单独的错误码，说明不是用户余额，退回冻结', async () => {
    fake.upstreamStatus = 402;
    fake.upstreamMessage = 'This request requires more credits, or fewer max_tokens.';
    const call = await chat.prepare({
      caller: { payerId: PAYER },
      requestId: 'r402',
      body: request,
    });
    const err = await chat.open(call, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 402, code: 'provider_credits' });
    expect((err as HttpError).message).toContain('不是你的余额');
    expect(billingCalls.map((c) => c.path)).toEqual(['/internal/holds', 'release']);
    // API Key 的花费上限用完时 OpenRouter 回 403，同样归为平台额度不够
    fake.upstreamStatus = 403;
    fake.upstreamMessage = 'Key limit exceeded (total limit). limit_source: openrouter_key_limit';
    const limited = await chat.prepare({
      caller: { payerId: PAYER },
      requestId: 'r403',
      body: request,
    });
    expect(
      await chat.open(limited, new AbortController().signal).catch((e: unknown) => e),
    ).toMatchObject({ statusCode: 402, code: 'provider_credits' });
  });

  it('输出上限按整个上下文窗口要时压到单次回答的上限，冻结也按压过的算', async () => {
    const call = await chat.prepare({
      caller: { payerId: PAYER },
      requestId: 'r-max',
      body: { ...request, max_tokens: 930_247 },
    });
    expect(call.maxOutputTokens).toBe(100_000);
    const response = await chat.open(call, new AbortController().signal);
    await chat.pump(call, response, () => {});
    expect(fake.upstreamBodies[0]).toMatchObject({ max_tokens: 100_000 });
    // 100000 × 0.5 = 50000 微美元，再加一点输入
    expect(billingCalls[0]?.body.amountMicro).toBeLessThan(51_000);
  });

  it('上游的地区限制和限流给出对应的错误码', async () => {
    fake.upstreamStatus = 403;
    fake.upstreamMessage = 'This model is not available in your region.';
    const blocked = await chat.prepare({
      caller: { payerId: PAYER },
      requestId: 'req-4',
      body: request,
    });
    const regionErr = await chat
      .open(blocked, new AbortController().signal)
      .catch((e: unknown) => e);
    expect((regionErr as HttpError).code).toBe('provider_region_unavailable');

    fake.upstreamStatus = 429;
    fake.upstreamMessage = 'Provider returned error';
    const busy = await chat.prepare({
      caller: { payerId: PAYER },
      requestId: 'req-5',
      body: request,
    });
    const busyErr = await chat.open(busy, new AbortController().signal).catch((e: unknown) => e);
    expect((busyErr as HttpError).code).toBe('provider_busy');
    expect(finished.every((f) => f.chargedMicro === 0)).toBe(true);
  });

  it('没有配置 API Key 时直接 503', async () => {
    const unconfigured = createChatService({
      provider: createOpenRouterClient({
        baseUrl: 'http://127.0.0.1:9',
        decisionsUrl: 'http://127.0.0.1:9/decisions',
        apiKey: undefined,
      }),
      meter: createMeter({
        billing: createServiceClient('billing', 'http://127.0.0.1:9'),
        repo,
        logger: silent,
      }),
      prices: () => new Map(),
      defaultMaxTokens: 1000,
      maxOutputTokens: 100_000,
      fallbackHoldMicro: 1,
    });
    await expect(
      unconfigured.prepare({ caller: { payerId: PAYER }, requestId: 'r', body: request }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'provider_not_configured' });
  });

  it('agent 运行的请求：工具调用原样转发、输出上限沿用 max_completion_tokens、调用记在运行名下', async () => {
    const agentRequest = {
      model: 'vendor/model',
      stream: true,
      max_completion_tokens: 4000,
      tools: [{ type: 'function', function: { name: 'write', parameters: { type: 'object' } } }],
      messages: [
        { role: 'user' as const, content: '写一个 hello.md' },
        {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'write', arguments: '{"file_path":"hello.md"}' },
            },
          ],
        },
        { role: 'tool' as const, content: 'Created file', tool_call_id: 'call_1' },
      ],
    };
    const caller = { payerId: PAYER, runId: RUN, taskId: RUN, nodeId: RUN };
    const call = await chat.prepare({ caller, requestId: 'req-6', body: agentRequest });
    const response = await chat.open(call, new AbortController().signal);
    await chat.pump(call, response, () => {});

    expect(fake.upstreamBodies[0]).toMatchObject({
      max_completion_tokens: 4000,
      tools: agentRequest.tools,
    });
    expect(fake.upstreamBodies[0]).not.toHaveProperty('max_tokens');
    expect((fake.upstreamBodies[0]?.messages as unknown[])[1]).toMatchObject({
      tool_calls: [{ id: 'call_1' }],
    });
    // 冻结按 4000 个输出 token 估算（4000 × 0.5 = 2000 微美元，再加输入）
    expect(billingCalls[0]?.body.amountMicro).toBeGreaterThan(2000);
    expect(started[0]).toMatchObject({ kind: 'chat', runId: RUN, taskId: RUN, nodeId: RUN });
  });
});
