import type { EventEnvelope } from '@oasis/contracts/events';
import { createServiceClient } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Call, CallsRepo } from '../src/repo/calls-repo.ts';
import { createComputeService } from '../src/service/compute-service.ts';
import { createMeter } from '../src/service/metering.ts';

const PAYER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const TASK = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const RUN = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
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

/** 内存里的调用记录 */
const rows = new Map<string, Call>();
const settled: EventEnvelope[] = [];
const repo: CallsRepo = {
  async start(call) {
    rows.set(call.id, {
      ...call,
      runId: call.runId ?? null,
      taskId: call.taskId ?? null,
      nodeId: call.nodeId ?? null,
      requestId: call.requestId ?? null,
      holdId: call.holdId ?? null,
      status: 'running',
      promptTokens: null,
      completionTokens: null,
      upstreamCostMicro: null,
      chargedMicro: null,
      costSource: null,
      error: null,
      createdAt: new Date(),
      finishedAt: null,
    });
  },
  get: async (id) => rows.get(id),
  async finish(id, outcome, event) {
    const row = rows.get(id)!;
    rows.set(id, { ...row, ...outcome, status: outcome.status ?? row.status } as Call);
    if (event) settled.push(event);
  },
  regionBlockedModels: async () => [],
};

let billingUrl = '';
const build = (pricePerCoreHourMicro: number) =>
  createComputeService({
    meter: createMeter({
      billing: createServiceClient('billing', billingUrl),
      repo,
      logger: pino({ level: 'silent' }),
    }),
    repo,
    pricePerCoreHourMicro,
  });
const run = { runId: RUN, payerId: PAYER, taskId: TASK, nodeId: null, requestId: 'r' };

beforeAll(async () => {
  billingUrl = await billing.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => billing.close());
beforeEach(() => {
  billingCalls.length = 0;
  settled.length = 0;
  rows.clear();
});

describe('算力计费', () => {
  it('按最长运行时间冻结（留够时间），按实际时长 × 核数 × 单价结算，计入任务；只结算一次', async () => {
    const compute = build(15_000);
    const { callId } = await compute.hold({ ...run, cores: 2, maxMs: 30 * 60_000 });
    // 2 核 × 0.5 小时 × $0.015
    expect(billingCalls[0]?.body).toMatchObject({ amountMicro: 15_000, ttlMs: 40 * 60_000 });

    await compute.settle(callId!, { cores: 2, elapsedMs: 6 * 60_000 });
    expect(billingCalls[1]).toMatchObject({ path: 'settle', body: { costMicro: 3_000 } });
    expect(settled[0]).toMatchObject({
      data: { kind: 'compute', taskId: TASK, runId: RUN, chargedMicro: 3_000 },
    });

    await compute.settle(callId!, { cores: 2, elapsedMs: 6 * 60_000 });
    expect(billingCalls).toHaveLength(2);
  });

  it('单价为 0：不冻结，也不用结算', async () => {
    expect(await build(0).hold({ ...run, cores: 2, maxMs: 60_000 })).toEqual({ callId: null });
    expect(billingCalls).toHaveLength(0);
  });
});
