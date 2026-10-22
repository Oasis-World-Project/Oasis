import { createServiceClient, HttpError } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOpenRouterClient } from '../src/adapters/openrouter.ts';
import type { CallOutcome, CallsRepo } from '../src/repo/calls-repo.ts';
import { createChatService } from '../src/service/chat-service.ts';
import { createMeter } from '../src/service/metering.ts';

const PAYER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const HOLD = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const RUN = '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a';

/** 假的 billing：记录冻结、结算、退回。 */
const billingCalls: { path: string; body: Record<string, unknown> }[] = [];
let balanceEnough = true;
const billing = Fastify();
billing.post('/internal/holds', async (request, reply) => {
  billingCalls.push({ path: '/internal/holds', body: request.body as Record<string, unknown> });
  if (!balanceEnough)
    return reply
      .code(402)
      .send({ error: { code: 'insufficient_balance', message: '额度不够了', requestId: 'r' } });
  return reply.code(201).send({ holdId: HOLD, heldMicro: 1000 });
});
billing.post('/internal/holds/:id/settle', async (request) => {
  billingCalls.push({ path: 'settle', body: request.body as Record<string, unknown> });
  return { chargedMicro: (request.body as { costMicro: number }).costMicro };
});
billing.post('/internal/holds/:id/release', async (_request, reply) => {
  billingCalls.push({ path: 'release', body: {} });
  return reply.code(204).send();
});

/** 假的 OpenRouter：流式返回两段内容和最后的用量。 */
let upstreamStatus = 200;
let upstreamMessage = 'boom';
let upstreamBodies: Record<string, unknown>[] = [];
const openrouter = Fastify();
openrouter.post('/chat/completions', async (request, reply) => {
  upstreamBodies.push(request.body as Record<string, unknown>);
  if (upstreamStatus !== 200)
    return reply.code(upstreamStatus).send({ error: { message: upstreamMessage } });
  reply.header('content-type', 'text/event-stream');
  return [
    ': OPENROUTER PROCESSING\n\n',
    `data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: '呀' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.000042 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
});

const started: Parameters<CallsRepo['start']>[0][] = [];
const finished: CallOutcome[] = [];
const repo: CallsRepo = {
  start: async (call) => void started.push(call),
  get: async () => undefined,
  regionBlockedModels: async () => [],
  finish: async (_id, outcome) => void finished.push(outcome),
};
const silent = pino({ level: 'silent' });

let chat: ReturnType<typeof createChatService>;
beforeAll(async () => {
  const billingUrl = await billing.listen({ port: 0, host: '127.0.0.1' });
  const openrouterUrl = await openrouter.listen({ port: 0, host: '127.0.0.1' });
  chat = createChatService({
    provider: createOpenRouterClient({
      baseUrl: openrouterUrl,
      decisionsUrl: `${openrouterUrl}/decisions`,
      apiKey: 'test-key',
    }),
    meter: createMeter({
      billing: createServiceClient('billing', billingUrl),
      repo,
      logger: silent,
    }),
    prices: () => new Map([['vendor/model', { prompt: 0.0000001, completion: 0.0000005 }]]),
    defaultMaxTokens: 1000,
    fallbackHoldMicro: 200_000,
  });
});
afterAll(async () => {
  await billing.close();
  await openrouter.close();
});
beforeEach(() => {
  billingCalls.length = 0;
  started.length = 0;
  finished.length = 0;
  upstreamBodies = [];
  upstreamStatus = 200;
  upstreamMessage = 'boom';
  balanceEnough = true;
});

const request = {
  model: 'vendor/model',
  messages: [{ role: 'user' as const, content: '在吗' }],
  stream: true,
};

describe('一次模型调用', () => {
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
    expect(upstreamBodies[0]).toMatchObject({
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
    balanceEnough = false;
    await expect(
      chat.prepare({ caller: { payerId: PAYER }, requestId: 'req-2', body: request }),
    ).rejects.toMatchObject({ statusCode: 402, code: 'insufficient_balance' });
    expect(upstreamBodies).toHaveLength(0);
  });

  it('上游出错时退回冻结，不扣钱', async () => {
    upstreamStatus = 500;
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

  it('上游的地区限制和限流给出对应的错误码', async () => {
    upstreamStatus = 403;
    upstreamMessage = 'This model is not available in your region.';
    const blocked = await chat.prepare({
      caller: { payerId: PAYER },
      requestId: 'req-4',
      body: request,
    });
    const regionErr = await chat
      .open(blocked, new AbortController().signal)
      .catch((e: unknown) => e);
    expect((regionErr as HttpError).code).toBe('provider_region_unavailable');

    upstreamStatus = 429;
    upstreamMessage = 'Provider returned error';
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

    expect(upstreamBodies[0]).toMatchObject({
      max_completion_tokens: 4000,
      tools: agentRequest.tools,
    });
    expect(upstreamBodies[0]).not.toHaveProperty('max_tokens');
    expect((upstreamBodies[0]?.messages as unknown[])[1]).toMatchObject({
      tool_calls: [{ id: 'call_1' }],
    });
    // 冻结按 4000 个输出 token 估算（4000 × 0.5 = 2000 微美元，再加输入）
    expect(billingCalls[0]?.body.amountMicro).toBeGreaterThan(2000);
    expect(started[0]).toMatchObject({ kind: 'chat', runId: RUN, taskId: RUN, nodeId: RUN });
  });
});
