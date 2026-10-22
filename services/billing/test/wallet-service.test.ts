import type { Logger } from '@oasis/service-kit';
import { describe, expect, it } from 'vitest';
import type { WalletRepo } from '../src/repo/wallet-repo.ts';
import { applyMultiplier, createWalletService, monthStart } from '../src/service/wallet-service.ts';

describe('定价系数', () => {
  it('系数 1.0 按成本价收', () => {
    expect(applyMultiplier(12_345, 1)).toBe(12_345);
  });
  it('有小数时向上取整到 1 微美元', () => {
    expect(applyMultiplier(10, 1.25)).toBe(13);
    expect(applyMultiplier(1, 1.5)).toBe(2);
  });
  it('没有花费就不收钱', () => {
    expect(applyMultiplier(0, 1.5)).toBe(0);
  });
  it('浮点误差不会多收 1', () => {
    expect(applyMultiplier(100, 1.1)).toBe(110);
  });
});

describe('本月起点', () => {
  it('取当月 1 日 0 点（UTC）', () => {
    expect(monthStart(new Date('2026-10-22T05:00:00Z')).toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });
});

describe('冻结的有效期', () => {
  const at = new Date('2026-10-23T00:00:00Z');
  const created: { expiresAt: Date; amountMicro: number }[] = [];
  const service = createWalletService({
    repo: {
      createHold: async (hold: { expiresAt: Date; amountMicro: number }) => {
        created.push(hold);
        return { id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', amountMicro: hold.amountMicro };
      },
    } as unknown as WalletRepo,
    signupGrantMicro: 0,
    priceMultiplier: 1,
    holdTtlMs: 10 * 60_000,
    logger: { info: () => {} } as unknown as Logger,
    now: () => at,
  });

  it('默认 10 分钟；长任务可以指定更久（不会被当成表里的字段写进去）', async () => {
    const base = {
      userId: '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f',
      amountMicro: 5,
      reason: 'r',
      ref: 'x',
    };
    await service.hold(base);
    await service.hold({ ...base, ttlMs: 3600_000 });
    expect(created.map((h) => h.expiresAt.getTime() - at.getTime())).toEqual([600_000, 3_600_000]);
    expect(created[1]).not.toHaveProperty('ttlMs');
  });
});
