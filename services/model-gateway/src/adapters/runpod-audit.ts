// Provider observations only. Durable state and settlement stay in the existing tool-job service.
import { createHash } from 'node:crypto';
import { z } from 'zod';

const HOUR = 3600000;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Jobs = z.strictObject({
  completed: count,
  failed: count,
  inProgress: count,
  inQueue: count,
  retried: count,
});
const Health = z.object({
  jobs: Jobs,
  workers: z.record(z.string(), count).refine((v) => 'idle' in v && 'running' in v),
});
const Workers = z.object({
  endpointVersion: count,
  workers: z
    .array(
      z.object({
        id: z.string(),
        status: z.enum(['RUNNING', 'IDLE', 'INITIALIZING', 'THROTTLED', 'UNHEALTHY']),
      }),
    )
    .max(1000),
  summary: z.object({
    running: count,
    idle: count,
    initializing: count,
    throttled: count,
    unhealthy: count,
    total: count,
  }),
});
const Endpoint = z.object({
  id: z.string(),
  type: z.literal('QUEUE'),
  image: z.string().regex(/@sha256:[a-f0-9]{64}$/),
  workers: z.object({ min: z.literal(0), max: z.literal(1), idleTimeout: count.optional() }),
  gpu: z.object({
    count: z.literal(1),
    pools: z.array(z.string()),
    excludedTypes: z.array(z.string()).optional(),
    allowedCudaVersions: z.array(z.string()),
    minCudaVersion: z.string().nullable(),
  }),
  scaling: z.record(z.string(), z.unknown()),
  timeout: count,
  disk: count,
  networkVolumes: z.array(z.string()).length(0),
  mounts: z.object({
    network: z.array(z.unknown()).length(0),
    global: z.array(z.unknown()).length(0),
  }),
});
const amount = z
  .number()
  .finite()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER / 1000000);
const Amounts = z.object({
  totalAmount: amount,
  gpuAmount: amount,
  cpuAmount: amount,
  diskAmount: amount,
  feeAmount: amount,
});
const range = {
  startTime: z.iso.datetime({ offset: true }),
  endTime: z.iso.datetime({ offset: true }),
};
const Bills = z.object({
  records: z.array(Amounts.extend({ ...range, serverlessId: z.string() })).max(72),
  metadata: z.object({
    query: z.object({ ...range, bucketSize: z.literal('hour'), serverlessId: z.string() }),
    recordCount: count,
    uniqueServerlessCount: count,
    totals: Amounts,
  }),
});
const Status = z.enum(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);
const terminal = (status: string) =>
  ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(status);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const micro = (usd: number) => {
  const value = Math.round(usd * 1000000);
  if (!Number.isSafeInteger(value)) throw new Error('Invalid billing amount');
  return value;
};
type JobCounts = z.infer<typeof Jobs>;
interface StopObservation {
  observedAt: number;
  endpointVersion: number;
  workerSummary: z.infer<typeof Workers>['summary'];
  healthWorkers: Record<string, number>;
  jobs: JobCounts;
  workerIds: string[];
}
export interface RenderAuditState {
  version: 1;
  identity: string;
  endpointId: string;
  profileHash: string;
  endpointVersion: number;
  startedAt: number;
  dispatchedAt?: number;
  windowStart: number;
  baseline: JobCounts;
  terminal?: string;
  terminalReceipt?: { id: string; status: string; observedAt: number };
  lastResources?: StopObservation;
  firstEmpty?: StopObservation;
  lastEmpty?: StopObservation;
  quietSince?: number;
  stoppedAt?: number;
  windowEnd?: number;
  sample?: {
    hash: string;
    since: number;
    observedAt: number;
    totalMicro: number;
    components: Record<string, number>;
  };
  acceptedMicro?: number;
  watchUntil?: number;
  lateAdjustmentMicro?: number;
  reviewReason?: string;
  lastError?: string;
  failures: number;
  nextAt: number;
  lastObservedAt?: number;
  evidence?: RenderBillEvidence;
}
export interface RenderBillEvidence {
  costMicro: number;
  billId: string;
  stopped: true;
  source: 'runpod-hourly';
  endpointId: string;
  windowStart: number;
  windowEnd: number;
  stoppedAt: number;
  observedAt: number;
  snapshotHash: string;
  components: Record<string, number>;
  sharedStorageCost: 'unallocated-platform-risk';
  stopProof: {
    first: StopObservation;
    last: StopObservation;
    terminalReceipt?: RenderAuditState['terminalReceipt'];
    mode: 'job-receipt' | 'ttl-and-empty-exclusive-endpoint';
  };
}
export interface RenderAuditOptions {
  enabled: boolean;
  dedicatedEndpoint: boolean;
  quietMs: number;
  billingLagMs: number;
  stableMs: number;
  maxWaitMs: number;
  watchMs: number;
}

export function createRunpodAudit(options: {
  endpointId: string;
  controlBaseUrl: string;
  queueBaseUrl: string;
  apiKey?: string;
  policy?: RenderAuditOptions;
  fetcher: typeof fetch;
  runtime: (path: string) => Promise<Response>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const policy = options.policy;
  const enabled = Boolean(policy?.enabled && policy.dedicatedEndpoint);
  const identity = digest([
    options.controlBaseUrl,
    options.queueBaseUrl,
    options.endpointId,
    policy,
  ]);
  const endpointPath = `serverless/${encodeURIComponent(options.endpointId)}`;
  // Do not expose provider bodies (endpoint env, signatures or arbitrary error text) in exceptions.
  async function json(response: Response): Promise<unknown> {
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Audit read HTTP ${response.status}`);
    }
    if (!response.body) throw new Error('Audit response missing');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 1024 ** 2) throw new Error('Audit response exceeds limit');
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString());
    } finally {
      await reader.cancel();
    }
  }
  const control = (path: string) =>
    options
      .fetcher(`${options.controlBaseUrl.replace(/\/$/, '')}/${path}`, {
        headers: { authorization: `Bearer ${options.apiKey ?? ''}` },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      })
      .then(json);
  async function resources() {
    const [endpoint, workers, health] = await Promise.all([
      control(endpointPath).then((v) => {
        const parsed = Endpoint.safeParse(v);
        if (!parsed.success) throw new Error('Audit endpoint profile invalid');
        return parsed.data;
      }),
      control(`${endpointPath}/workers`).then((v) => Workers.parse(v)),
      options
        .runtime('health')
        .then(json)
        .then((v) => Health.parse(v)),
    ]);
    if (endpoint.id !== options.endpointId) throw new Error('Endpoint identity mismatch');
    if (
      workers.summary.total !== workers.workers.length ||
      Object.entries(workers.summary)
        .filter(([key]) => key !== 'total')
        .reduce((s, [, n]) => s + n, 0) !== workers.summary.total
    )
      throw new Error('Worker summary mismatch');
    const empty =
      workers.workers.length === 0 &&
      Object.values(health.workers).every((n) => n === 0) &&
      health.jobs.inProgress === 0 &&
      health.jobs.inQueue === 0;
    return {
      profileHash: digest(endpoint),
      endpointVersion: workers.endpointVersion,
      empty,
      jobs: health.jobs,
      observation: {
        endpointVersion: workers.endpointVersion,
        workerSummary: workers.summary,
        healthWorkers: health.workers,
        jobs: health.jobs,
        workerIds: workers.workers.slice(0, 20).map((w) => w.id),
      },
    };
  }
  async function bill(start: number, end: number, baseline = false) {
    if ((end - start) / HOUR > 72 || start % HOUR || end % HOUR || end <= start)
      throw new Error('Invalid audit window');
    const query = new URLSearchParams({
      serverlessId: options.endpointId,
      bucketSize: 'hour',
      startTime: new Date(start).toISOString(),
      endTime: new Date(end).toISOString(),
    });
    const value = Bills.parse(await control(`billing/serverless?${query}`));
    const meta = value.metadata;
    if (
      meta.query.serverlessId !== options.endpointId ||
      Date.parse(meta.query.startTime) !== start ||
      Date.parse(meta.query.endTime) !== end ||
      meta.recordCount !== value.records.length
    )
      throw new Error('Billing coverage missing or mismatched');
    if (
      baseline &&
      value.records.length === 0 &&
      meta.uniqueServerlessCount === 0 &&
      Object.values(meta.totals).every((v) => v === 0)
    )
      return { totalMicro: 0, components: {}, hash: digest([start, end, 'empty-baseline']) };
    if (meta.uniqueServerlessCount !== 1 || value.records.length !== (end - start) / HOUR)
      throw new Error('Billing coverage missing or mismatched');
    const records = [...value.records].sort(
      (a, b) => Date.parse(a.startTime) - Date.parse(b.startTime),
    );
    const totals = { totalAmount: 0, gpuAmount: 0, cpuAmount: 0, diskAmount: 0, feeAmount: 0 };
    for (const [i, record] of records.entries()) {
      if (
        record.serverlessId !== options.endpointId ||
        Date.parse(record.startTime) !== start + i * HOUR ||
        Date.parse(record.endTime) !== start + (i + 1) * HOUR
      )
        throw new Error('Billing window duplicate, overlap or foreign endpoint');
      const components =
        micro(record.gpuAmount) +
        micro(record.cpuAmount) +
        micro(record.diskAmount) +
        micro(record.feeAmount);
      if (Math.abs(components - micro(record.totalAmount)) > 3)
        throw new Error('Billing components mismatch');
      for (const key of Object.keys(totals) as (keyof typeof totals)[])
        totals[key] += micro(record[key]);
    }
    if (!Object.values(totals).every(Number.isSafeInteger))
      throw new Error('Billing total overflow');
    for (const key of Object.keys(totals) as (keyof typeof totals)[])
      if (Math.abs(totals[key] - micro(meta.totals[key])) > records.length)
        throw new Error('Billing totals mismatch');
    return {
      totalMicro: totals.totalAmount,
      components: totals,
      hash: digest([
        start,
        end,
        totals,
        records.map((r) => [
          r.startTime,
          r.endTime,
          micro(r.totalAmount),
          micro(r.gpuAmount),
          micro(r.cpuAmount),
          micro(r.diskAmount),
          micro(r.feeAmount),
        ]),
      ]),
    };
  }
  const resetStop = (state: RenderAuditState) => {
    delete state.quietSince;
    delete state.stoppedAt;
    delete state.sample;
    delete state.firstEmpty;
    delete state.lastEmpty;
  };
  return {
    enabled,
    endpointId: options.endpointId,
    async prepare(notBefore: number): Promise<RenderAuditState> {
      if (!enabled) throw new Error('Automatic audit requires dedicated endpoint');
      const startedAt = now(),
        windowStart = Math.floor(startedAt / HOUR) * HOUR;
      if (windowStart < notBefore) throw new Error('Prior render billing window still reserved');
      const snapshot = await resources();
      if (!snapshot.empty) throw new Error('Endpoint is not empty before submission');
      if ((await bill(windowStart, windowStart + HOUR, true)).totalMicro !== 0)
        throw new Error('Existing endpoint charges prevent exclusive attribution');
      if (Math.floor(now() / HOUR) * HOUR !== windowStart)
        throw new Error('Audit baseline crossed a bucket boundary; retry before POST');
      return {
        version: 1,
        identity,
        endpointId: options.endpointId,
        profileHash: snapshot.profileHash,
        endpointVersion: snapshot.endpointVersion,
        startedAt,
        windowStart,
        baseline: snapshot.jobs,
        failures: 0,
        nextAt: startedAt,
      };
    },
    async observe(
      prior: RenderAuditState,
      handle: string | undefined,
    ): Promise<{ state: RenderAuditState; evidence?: RenderBillEvidence }> {
      const state = structuredClone(prior);
      let instant = now();
      if (!enabled || instant < state.nextAt) return { state };
      let resourceProof = false;
      try {
        if (
          state.version !== 1 ||
          state.identity !== identity ||
          state.endpointId !== options.endpointId ||
          !Number.isSafeInteger(state.startedAt)
        ) {
          state.reviewReason = 'Audit configuration or identity changed';
          throw new Error('Audit identity mismatch');
        }
        if (state.acceptedMicro !== undefined) {
          if (instant < (state.watchUntil ?? 0)) {
            const snapshot = await bill(state.windowStart, state.windowEnd!);
            state.lateAdjustmentMicro = snapshot.totalMicro - state.acceptedMicro;
            instant = now();
            state.sample = { ...snapshot, since: instant, observedAt: instant };
          }
          state.lastObservedAt = instant;
          state.nextAt = instant + 300000;
          state.failures = 0;
          delete state.lastError;
          return { state, ...(state.evidence ? { evidence: state.evidence } : {}) };
        }
        const snapshot = await resources();
        if (
          snapshot.profileHash !== state.profileHash ||
          snapshot.endpointVersion !== state.endpointVersion
        )
          state.reviewReason = 'Endpoint configuration changed during render';
        if (
          snapshot.jobs.completed < state.baseline.completed ||
          snapshot.jobs.failed < state.baseline.failed ||
          snapshot.jobs.retried !== state.baseline.retried ||
          snapshot.jobs.completed -
            state.baseline.completed +
            snapshot.jobs.failed -
            state.baseline.failed >
            1
        )
          state.reviewReason = 'Queue counters reset, retried or foreign jobs observed';
        if (handle && !state.terminal) {
          const id = z.object({ id: z.string() }).parse(JSON.parse(handle)).id;
          const response = await options.runtime(`status/${encodeURIComponent(id)}`);
          const receipt = z
            .object({ id: z.literal(id), status: Status })
            .parse(await json(response));
          if (terminal(receipt.status)) {
            state.terminal = receipt.status;
            state.terminalReceipt = { ...receipt, observedAt: now() };
          }
        }
        instant = now();
        const observation = { ...snapshot.observation, observedAt: instant };
        state.lastResources = observation;
        if (snapshot.observation.workerSummary.total > 1)
          state.reviewReason = 'Exclusive worker count exceeded';
        if (
          (state.terminal === 'COMPLETED' && snapshot.jobs.failed > state.baseline.failed) ||
          (state.terminal &&
            state.terminal !== 'COMPLETED' &&
            snapshot.jobs.completed > state.baseline.completed)
        )
          state.reviewReason = 'Job receipt and endpoint terminal counters disagree';
        const ttlElapsed = instant >= (state.dispatchedAt ?? state.startedAt) + 1800000 + 120000;
        resourceProof = true;
        const canStop = Boolean(state.terminal || (!handle && ttlElapsed));
        if (!snapshot.empty || !canStop) resetStop(state);
        else {
          if (!state.firstEmpty) {
            state.firstEmpty = observation;
            state.quietSince = instant;
          }
          state.lastEmpty = observation;
          if (instant - state.firstEmpty.observedAt >= policy!.quietMs) {
            // A resource reappearing after a prior observation can extend, never shrink, the window.
            if (state.stoppedAt === undefined) {
              state.stoppedAt = instant;
              state.windowEnd = Math.max(state.windowEnd ?? 0, Math.ceil(instant / HOUR) * HOUR);
            }
          }
        }
        if (instant - state.startedAt > policy!.maxWaitMs)
          state.reviewReason ??= 'Automatic audit deadline exceeded';
        state.lastObservedAt = instant;
        state.nextAt = instant + 30000;
        state.failures = 0;
        delete state.lastError;
        if (
          state.reviewReason ||
          !state.stoppedAt ||
          instant < state.windowEnd! + policy!.billingLagMs
        )
          return { state };
        const statement = await bill(state.windowStart, state.windowEnd!);
        instant = now();
        state.lastObservedAt = instant;
        state.nextAt = instant + 30000;
        if (
          state.terminal === 'COMPLETED' &&
          snapshot.jobs.completed - state.baseline.completed !== 1
        )
          return { state };
        const finished =
          snapshot.jobs.completed -
          state.baseline.completed +
          snapshot.jobs.failed -
          state.baseline.failed;
        if (!handle && finished === 0 && statement.totalMicro > 0) {
          state.reviewReason =
            'Unknown submission has charges without attributable terminal counter';
          return { state };
        }
        if (!state.sample || state.sample.hash !== statement.hash)
          state.sample = { ...statement, since: instant, observedAt: instant };
        else state.sample.observedAt = instant;
        if (instant - state.sample.since < policy!.stableMs) return { state };
        state.acceptedMicro = statement.totalMicro;
        state.watchUntil = instant + policy!.watchMs;
        state.evidence = {
          costMicro: statement.totalMicro,
          billId: `runpod:${digest([options.endpointId, state.windowStart, state.windowEnd])}`,
          stopped: true,
          source: 'runpod-hourly',
          endpointId: options.endpointId,
          windowStart: state.windowStart,
          windowEnd: state.windowEnd!,
          stoppedAt: state.stoppedAt,
          observedAt: instant,
          snapshotHash: statement.hash,
          components: statement.components,
          sharedStorageCost: 'unallocated-platform-risk',
          stopProof: {
            first: state.firstEmpty!,
            last: state.lastEmpty!,
            mode: handle ? 'job-receipt' : 'ttl-and-empty-exclusive-endpoint',
            ...(state.terminalReceipt ? { terminalReceipt: state.terminalReceipt } : {}),
          },
        };
        return { state, evidence: state.evidence };
      } catch (error) {
        if (error instanceof Error && error.message === 'Audit endpoint profile invalid')
          state.reviewReason = 'Endpoint profile became unsafe or unsupported';
        if (state.acceptedMicro === undefined) {
          if (!resourceProof) resetStop(state);
          else delete state.sample;
        }
        state.failures++;
        // Only our fixed HTTP classification is safe to retain; never persist provider/validation text.
        state.lastError =
          error instanceof Error && /^Audit read HTTP \d{3}$/.test(error.message)
            ? error.message
            : 'Audit observation unavailable or invalid';
        state.nextAt = now() + Math.min(300000, 30000 * 2 ** Math.min(state.failures, 4));
        return {
          state,
          ...(state.evidence && state.identity === identity && !state.reviewReason
            ? { evidence: state.evidence }
            : {}),
        };
      }
    },
  };
}
