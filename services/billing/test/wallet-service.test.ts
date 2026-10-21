import { describe, expect, it } from 'vitest';
import { applyMultiplier, monthStart } from '../src/service/wallet-service.ts';

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
