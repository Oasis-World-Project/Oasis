import { createServiceClient } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOpenRouterClient } from '../src/adapters/openrouter.ts';
import type { CallOutcome, CallsRepo } from '../src/repo/calls-repo.ts';
import { createDecisionService } from '../src/service/decision-service.ts';
import { createMeter } from '../src/service/metering.ts';

const PAYER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const HOLD = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const billingCalls: { path: string; body: Record<string, unknown> }[] = [];
const billing = Fastify();
billing.post('/internal/holds', async (request, reply) => {
  billingCalls.push({ path: 'hold', body: request.body as Record<string, unknown> });
  return reply.code(201).send({ holdId: HOLD, heldMicro: 1 });
});
billing.post('/internal/holds/:id/settle', async (request) => {
  billingCalls.push({ path: 'settle', body: request.body as Record<string, unknown> });
  return { chargedMicro: (request.body as { costMicro: number }).costMicro };
});
billing.post('/internal/holds/:id/release', async (_request, reply) => {
  billingCalls.push({ path: 'release', body: {} });
  return reply.code(204).send();
});

/** 假的 OpenRouter Decisions API */
let upstreamStatus = 200;
const upstreamBodies: Record<string, unknown>[] = [];
const openrouter = Fastify();
openrouter.post('/api/alpha/decisions', async (request, reply) => {
  upstreamBodies.push(request.body as Record<string, unknown>);
  if (upstreamStatus !== 200) return reply.code(upstreamStatus).send({ error: { message: 'bad' } });
  // 与 OpenRouter Decisions API 的响应格式一致
  return {
    id: 'd1',
    model: 'typesafe/jev-1.14',
    answers: { is_task: { type: 'noul', noul: 0.93 } },
    usage: { input_tokens: 120, output_tokens: 1, cost: 0.000005 },
  };
});

const started: Parameters<CallsRepo['start']>[0][] = [];
const finished: CallOutcome[] = [];
const repo: CallsRepo = {
  start: async (call) => void started.push(call),
  finish: async (_id, outcome) => void finished.push(outcome),
};

let service: ReturnType<typeof createDecisionService>;
beforeAll(async () => {
  const billingUrl = await billing.listen({ port: 0, host: '127.0.0.1' });
  const openrouterUrl = await openrouter.listen({ port: 0, host: '127.0.0.1' });
  const logger = pino({ level: 'silent' });
  service = createDecisionService({
    provider: createOpenRouterClient({
      baseUrl: `${openrouterUrl}/api/v1`,
      decisionsUrl: `${openrouterUrl}/api/alpha/decisions`,
      apiKey: 'test-key',
    }),
    meter: createMeter({ billing: createServiceClient('billing', billingUrl), repo, logger }),
    prices: () => new Map([['typesafe/jev-1.14', { prompt: 0.000000042, completion: 0 }]]),
    fallbackHoldMicro: 200_000,
  });
});
afterAll(async () => {
  await billing.close();
  await openrouter.close();
});
beforeEach(() => {
  billingCalls.length = 0;
  upstreamBodies.length = 0;
  started.length = 0;
  finished.length = 0;
  upstreamStatus = 200;
});

const body = {
  model: 'typesafe/jev-1.14',
  state: ['用户在私聊里说：帮我做一个温馨小屋的 3D 模型'],
  questions: {
    is_task: {
      type: 'noul',
      instructions: '判断用户这句话是不是在交代一个要交付成果的任务',
      criteria: { true: '是任务', false: '只是闲聊或提问' },
    },
  },
};

describe('Jev 决策', () => {
  it('冻结 → 原样转发 → 按 usage.cost 结算，记为决策调用', async () => {
    const result = await service.decide({
      caller: { payerId: PAYER },
      requestId: 'r1',
      body,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ answers: { is_task: { noul: 0.93 } } });
    expect(upstreamBodies[0]).toEqual(body);
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'settle']);
    expect(billingCalls[1]?.body).toMatchObject({ costMicro: 5 });
    expect(started[0]).toMatchObject({ kind: 'decision', model: 'typesafe/jev-1.14' });
    expect(finished[0]).toMatchObject({
      status: 'succeeded',
      costSource: 'provider',
      promptTokens: 120,
    });
  });

  it('上游拒绝时退回冻结，不扣钱', async () => {
    upstreamStatus = 400;
    await expect(
      service.decide({
        caller: { payerId: PAYER },
        requestId: 'r2',
        body,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'provider_error' });
    expect(billingCalls.map((c) => c.path)).toEqual(['hold', 'release']);
    expect(finished[0]).toMatchObject({ status: 'failed', chargedMicro: 0 });
  });
});
