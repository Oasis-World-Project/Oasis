import type { EventEnvelope } from '@oasis/contracts/events';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createServiceClient } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCallsRepo, type Call, type CallsRepo } from '../src/repo/calls-repo.ts';
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

describe.skipIf(!process.env.TEST_DATABASE_URL)('真实 PostgreSQL 算力接管', () => {
  const schema = 'compute_test_' + randomUUID().replaceAll('-', '');
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  beforeAll(async () => {
    await pool.query(`create schema ${schema}`);
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = await readFile(new URL(file, directory), 'utf8');
      await pool.query(sql.split('-- migrate:up')[1]!.split('-- migrate:down')[0]!);
    }
  });
  afterAll(async () => {
    await pool.query(`drop schema if exists ${schema} cascade`);
    await pool.end();
  });
  it('只结算同一付费人的原运行沙箱窗口，保留浏览器检查与其他付费人，重复接管不重复发计费事件', async () => {
    const actual = createCallsRepo(pool);
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of ids.entries()) {
      await actual.start({
        id,
        kind: 'compute',
        model: index === 2 ? 'application-check' : 'sandbox',
        payerId: index === 3 ? randomUUID() : PAYER,
        runId: RUN,
        taskId: TASK,
        holdId: randomUUID(),
      });
      await pool.query('update calls set created_at=$2 where id=$1', [
        id,
        new Date(Date.parse('2026-11-03T00:00:00Z') + index * 30000),
      ]);
    }
    const compute = createComputeService({
      repo: actual,
      pricePerCoreHourMicro: 3600000,
      meter: createMeter({
        billing: createServiceClient('billing', billingUrl),
        repo: actual,
        logger: pino({ level: 'silent' }),
      }),
    });
    const cutoff = { payerId: PAYER, cores: 2, endedAt: '2026-11-03T00:00:45Z' };
    await compute.recover(RUN, cutoff);
    expect((await actual.get(ids[0]!))?.chargedMicro).toBe(60000);
    expect((await actual.get(ids[1]!))?.chargedMicro).toBe(30000);
    expect((await actual.get(ids[2]!))?.status).toBe('running');
    expect((await actual.get(ids[3]!))?.status).toBe('running');
    await compute.recover(RUN, cutoff);
    expect(billingCalls.filter((c) => c.path === 'settle')).toHaveLength(2);
    expect((await pool.query('select count(*)::int as n from outbox')).rows[0].n).toBe(2);
  });
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
  computeForRun: async (runId, payerId) =>
    [...rows.values()].filter(
      (r) =>
        r.runId === runId && r.payerId === payerId && r.kind === 'compute' && r.model === 'sandbox',
    ),
  regionBlockedModels: async () => [],
  staleRunning: async () => [],
  typicalUsage: async () => ({ tools: new Map(), nodes: new Map(), nodeTokens: null }),
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

  it('接管按相邻冻结窗口截断计量，避免失败结算的旧窗口与新窗口重复收费', async () => {
    const compute = build(3600000);
    const first = (await compute.hold({ ...run, cores: 2, maxMs: 60000 })).callId!;
    const second = (await compute.hold({ ...run, cores: 2, maxMs: 60000 })).callId!;
    const start = new Date('2026-11-03T00:00:00Z');
    rows.get(first)!.createdAt = start;
    rows.get(second)!.createdAt = new Date(start.getTime() + 30000);
    await compute.recover(RUN, {
      payerId: PAYER,
      cores: 2,
      endedAt: new Date(start.getTime() + 45000).toISOString(),
    });
    expect(billingCalls.filter((c) => c.path === 'settle').map((c) => c.body.costMicro)).toEqual([
      60000, 30000,
    ]);
    await compute.recover(RUN, {
      payerId: PAYER,
      cores: 2,
      endedAt: new Date(start.getTime() + 45000).toISOString(),
    });
    expect(billingCalls.filter((c) => c.path === 'settle')).toHaveLength(2);
    expect(settled).toHaveLength(2);
  });

  it('单价为 0：不冻结，也不用结算', async () => {
    expect(await build(0).hold({ ...run, cores: 2, maxMs: 60_000 })).toEqual({
      callId: null,
      heldMicro: 0,
    });
    expect(billingCalls).toHaveLength(0);
  });
  it('节点沙箱与检查用浏览器的调用类型分开标识', async () => {
    const compute = build(15_000);
    const sandbox = await compute.hold({ ...run, requestId: 'run', cores: 2, maxMs: 60_000 });
    expect(rows.get(sandbox.callId!)?.model).toBe('sandbox');
    const check = await compute.hold({
      ...run,
      requestId: 'check',
      cores: 2,
      maxMs: 60_000,
      purpose: 'application-check',
    });
    expect(rows.get(check.callId!)?.model).toBe('application-check');
  });
});
