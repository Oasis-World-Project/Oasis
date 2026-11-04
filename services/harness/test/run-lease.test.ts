import type { ServiceClient } from '@oasis/service-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRunLease } from '../src/service/run-lease.ts';

afterEach(() => vi.useRealTimers());
describe('运行租约', () => {
  it.each([true, false])('有停止证据=%s 时区分真实运行时长与网络恢复等待', async (confirmed) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const paid: number[] = [];
    const client = {
      json: vi.fn(async (_method, path, options) => {
        if (path.endsWith('/settle')) paid.push(options.body.elapsedMs);
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
      onFailure: vi.fn(),
    });
    vi.setSystemTime(10000);
    await lease.close(100, confirmed);
    expect(paid).toEqual(confirmed ? [100] : []);
    const count = vi.mocked(client.json).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(client.json).toHaveBeenCalledTimes(count);
  });

  it('收尾时正在冻结的新窗口也不能把停止后的等待算为运行', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let serial = 0;
    let release!: () => void;
    const paid: number[] = [];
    const client = {
      json: vi.fn(async (_method, path, options) => {
        if (path.endsWith('/compute')) {
          serial++;
          if (serial === 2)
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          return { callId: String(serial) };
        }
        if (path.endsWith('/settle')) paid.push(options.body.elapsedMs);
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
      onFailure: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(500);
    const closing = lease.close(500);
    vi.setSystemTime(5000);
    release();
    await closing;
    expect(paid).toEqual([500, 0]);
  });
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
