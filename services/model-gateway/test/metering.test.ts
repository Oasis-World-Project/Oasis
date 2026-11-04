// 网络短暂断开（2026-11-05 用户决定）：请求没发出去时等网络恢复后原样重发；被拒绝、长时间连不上才报错并退回冻结。
import type { ServiceClient } from '@oasis/service-kit';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { CallsRepo } from '../src/repo/calls-repo.ts';
import { createMeter, notConnected, type MeteredCall } from '../src/service/metering.ts';

const timeout = () =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('Connect Timeout Error'), {
      name: 'ConnectTimeoutError',
      code: 'UND_ERR_CONNECT_TIMEOUT',
    }),
  });

function setup(reconnectMs: number) {
  const released: string[] = [];
  const finished: unknown[] = [];
  const slept: number[] = [];
  const billing = {
    json: async (_method: string, path: string) => {
      released.push(path);
      return {};
    },
  } as unknown as ServiceClient;
  const repo = {
    finish: async (_id: string, outcome: unknown) => {
      finished.push(outcome);
    },
  } as unknown as CallsRepo;
  let now = 0;
  const meter = createMeter({
    billing,
    repo,
    logger: pino({ level: 'silent' }),
    reconnectMs,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  });
  const realNow = Date.now;
  Date.now = () => realNow() + now;
  const call = {
    id: 'call-1',
    holdId: 'hold-1',
    requestId: 'req-1',
    model: 'vendor/model',
    kind: 'chat',
    caller: { payerId: 'payer' },
  } as unknown as MeteredCall;
  return { meter, call, released, finished, slept, restore: () => (Date.now = realNow) };
}

describe('网络短暂断开', () => {
  it('只把「请求没发出去」算作连不上：连接超时、拒绝连接、解析失败；中途断开和取消不算', () => {
    expect(notConnected(timeout())).toBe(true);
    expect(notConnected(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(
      notConnected(
        new TypeError('fetch failed', {
          cause: new AggregateError([Object.assign(new Error('y'), { code: 'ENETUNREACH' })]),
        }),
      ),
    ).toBe(true);
    expect(notConnected(Object.assign(new Error('z'), { code: 'ECONNRESET' }))).toBe(false);
    expect(notConnected(new DOMException('aborted', 'AbortError'))).toBe(false);
    expect(notConnected(new Error('别的错'))).toBe(false);
  });

  it('连不上时等一会儿重发同一请求，接上后照常返回，不退回冻结', async () => {
    const { meter, call, released, slept, restore } = setup(60_000);
    try {
      let attempts = 0;
      const response = await meter.callUpstream(call, async () => {
        attempts += 1;
        if (attempts < 3) throw timeout();
        return new Response('ok');
      });
      expect(await response.text()).toBe('ok');
      expect(attempts).toBe(3);
      expect(slept).toEqual([2_000, 4_000]);
      expect(released).toEqual([]);
    } finally {
      restore();
    }
  });

  it('长时间连不上才报错并退回冻结；被拒绝等别的错误不等', async () => {
    const { meter, call, released, slept, restore } = setup(10_000);
    try {
      await expect(
        meter.callUpstream(call, async () => {
          throw timeout();
        }),
      ).rejects.toMatchObject({ statusCode: 503, code: 'provider_unavailable' });
      expect(slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(10_000);
      expect(released).toEqual(['/internal/holds/hold-1/release']);
      slept.length = 0;
      await expect(
        meter.callUpstream(call, async () => {
          throw new Error('别的错');
        }),
      ).rejects.toMatchObject({ code: 'provider_unavailable' });
      expect(slept).toEqual([]);
    } finally {
      restore();
    }
  });
});
