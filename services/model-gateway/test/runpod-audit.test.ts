import { describe, expect, it } from 'vitest';
import { createRunpodAudit, type RenderAuditState } from '../src/adapters/runpod-audit.ts';
import { auditPolicy, runpodFixture } from './runpod-fixture.ts';

const handle = JSON.stringify({ id: 'gpu-one', jobId: 'not-an-auth-token' });
function setup() {
  const fixture = runpodFixture();
  const create = () =>
    createRunpodAudit({
      endpointId: 'fixture',
      controlBaseUrl: 'https://control.test/v2',
      queueBaseUrl: 'https://queue.test/v2',
      apiKey: 'fake-api-secret',
      policy: auditPolicy,
      fetcher: fixture.fetcher,
      runtime: (path) => fixture.fetcher(`https://queue.test/v2/fixture/${path}`),
      now: fixture.now,
    });
  return { fixture, create, audit: create() };
}
async function stopped() {
  const context = setup(),
    { fixture, audit } = context;
  let state = await audit.prepare(0);
  fixture.jobs.completed = 1;
  state = (await audit.observe(state, handle)).state;
  fixture.advance(60000);
  state = (await audit.observe(state, handle)).state;
  expect(state.stoppedAt).toBeDefined();
  return { ...context, state };
}
async function firstBill() {
  const context = await stopped();
  context.fixture.at('2026-10-28T10:16:00Z');
  context.fixture.totalMicro = 12345;
  const result = await context.audit.observe(context.state, handle);
  expect(result.evidence).toBeUndefined();
  return { ...context, state: result.state };
}
describe('Runpod 自动账单与停止证据', () => {
  it('完整停止证据、关闭窗口和跨重启稳定账单后自动核对；不以 executionTime 计价', async () => {
    const { fixture, create, state } = await firstBill();
    fixture.advance(300000);
    const result = await create().observe(
      JSON.parse(JSON.stringify(state)) as RenderAuditState,
      handle,
    );
    expect(result.evidence).toMatchObject({
      costMicro: 12345,
      stopped: true,
      source: 'runpod-hourly',
      windowEnd: Date.parse('2026-10-28T10:00:00Z'),
    });
    expect(result.state.watchUntil).toBeGreaterThan(fixture.instant);
    expect(result.evidence!.stopProof.first.workerSummary.total).toBe(0);
    expect(
      result.evidence!.stopProof.last.observedAt - result.evidence!.stopProof.first.observedAt,
    ).toBeGreaterThanOrEqual(60000);
    expect(result.evidence!.stopProof.terminalReceipt).toMatchObject({
      id: 'gpu-one',
      status: 'COMPLETED',
    });
    expect(JSON.stringify(result)).not.toContain('do-not-save-this-secret');
    expect(JSON.stringify(result)).not.toContain('fake-api-secret');
    expect(fixture.requests.every((r) => r.method === 'GET')).toBe(true);
    const resumed = await create().observe(result.state, handle);
    fixture.advance(30000);
    expect((await create().observe(resumed.state, handle)).evidence?.billId).toBe(
      result.evidence!.billId,
    );
  });
  it.each(['IDLE', 'INITIALIZING', 'THROTTLED', 'UNHEALTHY', 'RUNNING'])(
    '控制面仍有 %s worker，即使 health 为零也不认停机',
    async (status) => {
      const { fixture, audit } = setup();
      let state = await audit.prepare(0);
      fixture.activeWorkers = [{ id: 'worker-one', status }];
      fixture.jobs.completed = 1;
      state = (await audit.observe(state, handle)).state;
      fixture.advance(120000);
      const result = await audit.observe(state, handle);
      expect(result.state.stoppedAt).toBeUndefined();
      expect(result.evidence).toBeUndefined();
    },
  );
  it('health 与控制面矛盾、队列未空、worker 重新出现均清除停止观察', async () => {
    const { fixture, audit, state } = await stopped();
    fixture.advance(30000);
    fixture.healthWorkers.idle = 1;
    let result = await audit.observe(state, handle);
    expect(result.state.stoppedAt).toBeUndefined();
    fixture.healthWorkers.idle = 0;
    fixture.jobs.inQueue = 1;
    fixture.advance(30000);
    result = await audit.observe(result.state, handle);
    expect(result.state.quietSince).toBeUndefined();
    fixture.jobs.inQueue = 0;
    fixture.advance(30000);
    result = await audit.observe(result.state, handle);
    expect(result.state.stoppedAt).toBeUndefined();
    fixture.advance(60000);
    expect((await audit.observe(result.state, handle)).state.stoppedAt).toBeDefined();
  });
  it.each([401, 403, 429, 503])(
    'HTTP %s 不伪造停机或免费，保留退避状态和脱敏错误',
    async (status) => {
      const { fixture, audit, state } = await stopped();
      fixture.advance(30000);
      fixture.fault = (url) =>
        url.pathname.endsWith('/workers')
          ? new Response('do-not-save-this-secret', { status })
          : undefined;
      const result = await audit.observe(state, handle);
      expect(result.state.lastError).toBe(`Audit read HTTP ${status}`);
      expect(result.state.nextAt).toBeGreaterThan(fixture.instant + 30000);
      expect(result.state.stoppedAt).toBeUndefined();
      expect(result.evidence).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('do-not-save-this-secret');
    },
  );
  it('取消接受或 job 404 不足以取证；已有终态凭据可跨结果过期继续核对', async () => {
    const { fixture, audit } = setup();
    let state = await audit.prepare(0);
    fixture.jobStatus = 'IN_PROGRESS';
    state = (await audit.observe(state, handle)).state;
    fixture.advance(120000);
    fixture.fault = (url) =>
      url.pathname.includes('/status/') ? new Response('', { status: 404 }) : undefined;
    expect((await audit.observe(state, handle)).state.stoppedAt).toBeUndefined();
    fixture.fault = undefined;
    fixture.jobStatus = 'CANCELLED';
    fixture.advance(120000);
    state = (await audit.observe(state, handle)).state;
    fixture.fault = (url) =>
      url.pathname.includes('/status/') ? new Response('', { status: 404 }) : undefined;
    fixture.advance(60000);
    expect((await audit.observe(state, handle)).state.stoppedAt).toBeDefined();
  });
  it.each(['missing', 'duplicate', 'foreign', 'echo', 'count', 'totals', 'component', 'negative'])(
    '账单 %s 不能结算，恢复正确数据后重新等待稳定窗',
    async (fault) => {
      const { fixture, audit, state } = await firstBill();
      fixture.advance(300000);
      fixture.fault = (url, body) => {
        if (!url.pathname.endsWith('/billing/serverless')) return;
        const v = body as {
          records: Record<string, unknown>[];
          metadata: {
            query: Record<string, unknown>;
            recordCount: number;
            totals: Record<string, number>;
          };
        };
        if (fault === 'missing') v.records = [];
        if (fault === 'duplicate') v.records.push(v.records[0]!);
        if (fault === 'foreign') v.records[0]!.serverlessId = 'other';
        if (fault === 'echo') v.metadata.query.startTime = '2026-10-28T08:00:00Z';
        if (fault === 'count') v.metadata.recordCount++;
        if (fault === 'totals') v.metadata.totals.totalAmount = 900;
        if (fault === 'component') v.records[0]!.diskAmount = 200;
        if (fault === 'negative') v.records[0]!.totalAmount = -1;
        return v;
      };
      const rejected = await audit.observe(state, handle);
      expect(rejected.evidence).toBeUndefined();
      expect(rejected.state.sample).toBeUndefined();
      expect(rejected.state.stoppedAt).toBeDefined();
      fixture.fault = undefined;
      fixture.advance(300000);
      const next = await audit.observe(rejected.state, handle);
      expect(next.evidence).toBeUndefined();
      fixture.advance(300000);
      expect((await audit.observe(next.state, handle)).evidence).toBeDefined();
    },
  );
  it('账单晚到或金额变化重置稳定时钟，未关闭的当前桶不结算', async () => {
    const { fixture, audit, state } = await firstBill();
    fixture.advance(300000);
    fixture.totalMicro = 54321;
    const changed = await audit.observe(state, handle);
    expect(changed.evidence).toBeUndefined();
    fixture.advance(300000);
    expect((await audit.observe(changed.state, handle)).evidence?.costMicro).toBe(54321);
  });
  it('专用归属、历史窗口、启动前活动资源、既有费用、非摘要镜像在 POST 前拒绝', async () => {
    const { fixture, audit } = setup();
    await expect(audit.prepare(Date.parse('2026-10-28T10:00:00Z'))).rejects.toThrow('reserved');
    fixture.jobs.inProgress = 1;
    await expect(audit.prepare(0)).rejects.toThrow('not empty');
    fixture.jobs.inProgress = 0;
    fixture.totalMicro = 1;
    await expect(audit.prepare(0)).rejects.toThrow('Existing');
    fixture.totalMicro = 0;
    fixture.endpoint.image = 'repo:latest';
    await expect(audit.prepare(0)).rejects.toThrow();
  });
  it.each(['retry', 'foreign-job', 'counter-reset', 'profile'])(
    '发现 %s 保留人工核对，恢复旧数值也不偷偷清除风险',
    async (mode) => {
      const { fixture, audit } = setup();
      fixture.jobs.completed = 3;
      const state = await audit.prepare(0);
      if (mode === 'retry') fixture.jobs.retried = 1;
      if (mode === 'foreign-job') fixture.jobs.completed += 2;
      if (mode === 'counter-reset') fixture.jobs.completed = 0;
      if (mode === 'profile') fixture.endpoint.disk++;
      const result = await audit.observe(state, handle);
      expect(result.state.reviewReason).toBeDefined();
      fixture.jobs.retried = 0;
      fixture.jobs.completed = 4;
      fixture.endpoint.disk = 10;
      fixture.at('2026-10-28T12:00:00Z');
      expect((await audit.observe(result.state, handle)).evidence).toBeUndefined();
    },
  );
  it('丢失 POST 响应的作业须 TTL+资源+完整账单共同核对；有费用但无终态计数不能归属', async () => {
    const { fixture, audit } = setup();
    const state = await audit.prepare(0);
    fixture.advance(60000);
    expect((await audit.observe(state, undefined)).state.quietSince).toBeUndefined();
    fixture.at('2026-10-28T09:40:00Z');
    let next = (await audit.observe(state, undefined)).state;
    fixture.advance(60000);
    next = (await audit.observe(next, undefined)).state;
    fixture.at('2026-10-28T10:16:00Z');
    fixture.totalMicro = 1000;
    const ambiguous = await audit.observe(next, undefined);
    expect(ambiguous.state.reviewReason).toContain('without attributable');
    expect(ambiguous.evidence).toBeUndefined();
    fixture.jobs.failed = 1;
    const explicit = { ...next, terminal: undefined };
    next = (await audit.observe(explicit, undefined)).state;
    fixture.advance(300000);
    expect((await audit.observe(next, undefined)).evidence?.costMicro).toBe(1000);
  });
  it('结算后补账只返回平台差额和原证据，不产生新的用户账单', async () => {
    const { fixture, audit, state } = await firstBill();
    fixture.advance(300000);
    const initial = await audit.observe(state, handle);
    fixture.totalMicro = 54321;
    fixture.advance(300000);
    const late = await audit.observe(initial.state, handle);
    expect(late.state.lateAdjustmentMicro).toBe(41976);
    expect(late.evidence).toEqual(initial.evidence);
    expect(late.evidence!.costMicro).toBe(12345);
  });
  it('完整稳定证据可在账单接口随后故障时恢复结算；超出观察期后停止补账读取', async () => {
    const { fixture, audit, state } = await firstBill();
    fixture.advance(300000);
    const accepted = await audit.observe(state, handle);
    fixture.advance(300000);
    fixture.fault = (url) =>
      url.pathname.endsWith('/billing/serverless') ? new Response('', { status: 503 }) : undefined;
    const failedWatch = await audit.observe(accepted.state, handle);
    expect(failedWatch.evidence).toEqual(accepted.evidence);
    fixture.instant = accepted.state.watchUntil! + 300000;
    const reads = fixture.requests.length;
    await audit.observe(failedWatch.state, handle);
    expect(fixture.requests).toHaveLength(reads);
  });
  it('基线允许明确零 totals 的空历史，但结束时空账单不当作零费用', async () => {
    const { fixture, audit } = setup();
    fixture.fault = (url, body) => {
      if (!url.pathname.endsWith('/billing/serverless')) return;
      const v = body as {
        records: unknown[];
        metadata: { recordCount: number; uniqueServerlessCount: number };
      };
      v.records = [];
      v.metadata.recordCount = 0;
      v.metadata.uniqueServerlessCount = 0;
      return v;
    };
    let state = await audit.prepare(0);
    fixture.jobs.completed = 1;
    state = (await audit.observe(state, handle)).state;
    fixture.advance(60000);
    state = (await audit.observe(state, handle)).state;
    fixture.at('2026-10-28T10:16:00Z');
    const result = await audit.observe(state, handle);
    expect(result.state.lastError).toBeDefined();
    expect(result.evidence).toBeUndefined();
  });
  it('已完成作业但 health 完成计数滞后时继续等，矛盾的失败计数则保留核对', async () => {
    const { fixture, audit, state } = await firstBill();
    fixture.jobs.completed = 0;
    fixture.advance(300000);
    expect((await audit.observe(state, handle)).evidence).toBeUndefined();
    fixture.jobs.failed = 1;
    expect((await audit.observe(state, handle)).state.reviewReason).toContain('disagree');
  });
  it('不安全配置短暂出现后也保留核对记录，不因恢复原值就忘掉它', async () => {
    const { fixture, audit, state } = await stopped();
    fixture.endpoint.workers.min = 1;
    fixture.advance(30000);
    const changed = await audit.observe(state, handle);
    expect(changed.state.reviewReason).toContain('unsafe');
    fixture.endpoint.workers.min = 0;
    fixture.at('2026-10-28T12:00:00Z');
    expect((await audit.observe(changed.state, handle)).evidence).toBeUndefined();
  });
  it('伪造 job id 和超大响应不成为停止凭据；重启沿用退避时间', async () => {
    const { fixture, audit } = setup();
    const state = await audit.prepare(0);
    fixture.fault = (url) =>
      url.pathname.includes('/status/')
        ? Response.json({ id: 'other-job', status: 'COMPLETED' })
        : undefined;
    const wrong = await audit.observe(state, handle);
    expect(wrong.state.terminal).toBeUndefined();
    const reads = fixture.requests.length;
    await audit.observe(wrong.state, handle);
    expect(fixture.requests).toHaveLength(reads);
    fixture.instant = wrong.state.nextAt;
    fixture.fault = (url) =>
      url.pathname.endsWith('/workers') ? new Response('x'.repeat(2 * 1024 ** 2)) : undefined;
    expect((await audit.observe(wrong.state, handle)).state.stoppedAt).toBeUndefined();
  });
  it('缺少专用 endpoint 确认时不能自动取证；审计超时不自动免费', async () => {
    const { fixture, audit } = setup();
    const disabled = createRunpodAudit({
      endpointId: 'fixture',
      controlBaseUrl: 'https://control.test/v2',
      queueBaseUrl: 'https://queue.test/v2',
      policy: { ...auditPolicy, dedicatedEndpoint: false },
      fetcher: fixture.fetcher,
      runtime: (path) => fixture.fetcher(`https://queue.test/${path}`),
    });
    expect(disabled.enabled).toBe(false);
    await expect(disabled.prepare(0)).rejects.toThrow('dedicated');
    let state = await audit.prepare(0);
    fixture.jobs.completed = 1;
    state = (await audit.observe(state, handle)).state;
    fixture.advance(auditPolicy.maxWaitMs + 1);
    const result = await audit.observe(state, handle);
    expect(result.state.reviewReason).toContain('deadline');
    expect(result.evidence).toBeUndefined();
  });
  it('观察间隔从响应完成计时，慢响应不能缩短停止取证时间', async () => {
    const { fixture, audit } = setup();
    const state = await audit.prepare(0);
    fixture.jobs.completed = 1;
    fixture.fault = (url) => {
      if (url.pathname.includes('/status/')) fixture.advance(15000);
    };
    const observed = await audit.observe(state, handle);
    expect(observed.state.quietSince).toBe(fixture.instant);
    fixture.fault = undefined;
    fixture.advance(45000);
    expect((await audit.observe(observed.state, handle)).state.stoppedAt).toBeUndefined();
    fixture.advance(60000);
    expect((await audit.observe(observed.state, handle)).state.stoppedAt).toBeDefined();
  });
});
