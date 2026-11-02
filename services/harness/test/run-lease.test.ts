import type { ServiceClient } from '@oasis/service-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRunLease } from '../src/service/run-lease.ts';

afterEach(() => vi.useRealTimers());
describe('运行租约', () => {
  it('跨多个窗口持续运行，凭证续期、每段只结算一次，关闭后不再续租', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let serial = 0;
    const settlements: { cores: number; elapsedMs: number }[] = [];
    const requests: string[] = [];
    const client = {
      json: vi.fn(async (_method, path, options) => {
        requests.push(path);
        if (path.endsWith('/compute')) return { callId: String(++serial) };
        if (path.endsWith('/settle')) settlements.push(options.body);
        return {};
      }),
    } as unknown as ServiceClient;
    const failure = vi.fn();
    const lease = await startRunLease({
      client,
      runId: 'run',
      payerId: 'payer',
      taskId: null,
      nodeId: null,
      keyId: 'key',
      keyTtlSeconds: 60,
      cores: 2,
      windowMs: 1000,
      onFailure: failure,
    });
    await vi.advanceTimersByTimeAsync(2600);
    await lease.close();
    await lease.close();
    const count = requests.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(serial).toBe(6);
    expect(requests.filter((path) => path.endsWith('/renew'))).toHaveLength(5);
    expect(settlements).toHaveLength(6);
    expect(settlements.reduce((sum, body) => sum + body.elapsedMs, 0)).toBe(2600);
    expect(requests).toHaveLength(count);
    expect(failure).not.toHaveBeenCalled();
  });
  it('续租失败交由生命周期保存和停止，不继续无冻结地派发', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const failure = vi.fn();
    const client = {
      json: vi.fn(async (_method, path) => {
        if (path.endsWith('/renew')) throw new Error('unavailable');
        return { callId: 'one' };
      }),
    } as unknown as ServiceClient;
    const lease = await startRunLease({
      client,
      runId: 'run',
      payerId: 'payer',
      taskId: null,
      nodeId: null,
      keyId: 'key',
      keyTtlSeconds: 60,
      cores: 2,
      windowMs: 1000,
      onFailure: failure,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(failure).toHaveBeenCalledOnce();
    await lease.close();
    expect(client.json).toHaveBeenCalledTimes(3);
  });
  it('结算短暂失败后收尾重试同一段实际时长，不漏收或重复扩大时长', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let serial = 0;
    let failed = false;
    const paid: { path: string; elapsedMs: number }[] = [];
    const failure = vi.fn();
    const client = {
      json: vi.fn(async (_method, path, options) => {
        if (path.endsWith('/compute')) return { callId: String(++serial) };
        if (path.endsWith('/settle')) {
          paid.push({ path, elapsedMs: options.body.elapsedMs });
          if (!failed) {
            failed = true;
            throw new Error('billing temporarily unavailable');
          }
        }
        return {};
      }),
    } as unknown as ServiceClient;
    const lease = await startRunLease({
      client,
      runId: 'run',
      payerId: 'payer',
      taskId: null,
      nodeId: null,
      keyId: 'key',
      keyTtlSeconds: 60,
      cores: 2,
      windowMs: 1000,
      onFailure: failure,
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(failure).toHaveBeenCalledOnce();
    await lease.close();
    expect(paid).toEqual([
      { path: '/internal/v1/compute/1/settle', elapsedMs: 500 },
      { path: '/internal/v1/compute/1/settle', elapsedMs: 500 },
      { path: '/internal/v1/compute/2/settle', elapsedMs: 100 },
    ]);
  });
});
