import type { RenderAuditOptions } from '../src/adapters/runpod-audit.ts';

export const auditPolicy: RenderAuditOptions = {
  enabled: true,
  dedicatedEndpoint: true,
  quietMs: 60000,
  billingLagMs: 900000,
  stableMs: 300000,
  maxWaitMs: 86400000,
  watchMs: 86400000,
};
export function runpodFixture() {
  const fixture = {
    instant: Date.parse('2026-10-28T09:05:00Z'),
    jobStatus: 'COMPLETED',
    jobs: { completed: 0, failed: 0, inProgress: 0, inQueue: 0, retried: 0 },
    healthWorkers: { running: 0, idle: 0 },
    activeWorkers: [] as { id: string; status: string }[],
    totalMicro: 0,
    output: undefined as unknown,
    endpoint: {
      id: 'fixture',
      type: 'QUEUE',
      image: `ghcr.io/example/oasis/harness-render@sha256:${'a'.repeat(64)}`,
      workers: { min: 0, max: 1, idleTimeout: 5 },
      gpu: {
        count: 1,
        pools: ['ADA_24'],
        excludedTypes: [],
        allowedCudaVersions: ['12.8'],
        minCudaVersion: '12.8',
      },
      scaling: { type: 'QUEUE_DELAY', queueDelay: 4 },
      timeout: 600000,
      disk: 10,
      networkVolumes: [],
      mounts: { network: [], global: [] },
      env: { SECRET: 'do-not-save-this-secret' },
    },
    requests: [] as { url: string; method: string }[],
    fault: undefined as undefined | ((url: URL, body: unknown) => Response | unknown),
    now: (): number => fixture.instant,
    advance: (ms: number): void => {
      fixture.instant += ms;
    },
    at: (time: string): void => {
      fixture.instant = Date.parse(time);
    },
    fetcher: (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const url = new URL(String(input));
      fixture.requests.push({ url: url.toString(), method: init?.method ?? 'GET' });
      let body: unknown;
      if (url.pathname.endsWith('/health'))
        body = { jobs: fixture.jobs, workers: fixture.healthWorkers };
      else if (url.pathname.includes('/status/'))
        body = {
          id: 'gpu-one',
          status: fixture.jobStatus,
          ...(fixture.output ? { output: fixture.output } : {}),
        };
      else if (url.pathname.endsWith('/workers')) {
        const summary = {
          running: 0,
          idle: 0,
          initializing: 0,
          throttled: 0,
          unhealthy: 0,
          total: fixture.activeWorkers.length,
        };
        for (const worker of fixture.activeWorkers)
          summary[worker.status.toLowerCase() as keyof typeof summary]++;
        body = { workers: fixture.activeWorkers, summary, endpointVersion: 4 };
      } else if (url.pathname.endsWith('/billing/serverless')) {
        const startTime = url.searchParams.get('startTime')!,
          endTime = url.searchParams.get('endTime')!;
        const amounts = {
          totalAmount: fixture.totalMicro / 1000000,
          gpuAmount: fixture.totalMicro / 1000000,
          cpuAmount: 0,
          diskAmount: 0,
          feeAmount: 0,
        };
        const records = [];
        for (let at = Date.parse(startTime); at < Date.parse(endTime); at += 3600000)
          records.push({
            startTime: new Date(at).toISOString(),
            endTime: new Date(at + 3600000).toISOString(),
            serverlessId: 'fixture',
            ...amounts,
          });
        body = {
          records,
          metadata: {
            query: { startTime, endTime, bucketSize: 'hour', serverlessId: 'fixture' },
            recordCount: records.length,
            uniqueServerlessCount: 1,
            totals: Object.fromEntries(
              Object.entries(amounts).map(([k, n]) => [k, n * records.length]),
            ),
          },
        };
      } else body = fixture.endpoint;
      const changed = fixture.fault?.(url, structuredClone(body));
      return changed instanceof Response ? changed : Response.json(changed ?? body);
    }) as typeof fetch,
  };
  return fixture;
}
