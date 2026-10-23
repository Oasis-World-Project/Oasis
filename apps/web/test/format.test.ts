import { describe, expect, it } from 'vitest';
import { formatBytes, formatCost, formatUsd, usedPercent } from '../src/ui/format.ts';

describe('金额显示', () => {
  it('向下取整，不会显示比实际更多的余额', () => {
    expect(formatUsd(30_000_000)).toBe('$30.00');
    expect(formatUsd(29_999_877)).toBe('$29.99');
    expect(formatUsd(290_000)).toBe('$0.29');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('不到 1 美分时显示 4 位小数', () => {
    expect(formatUsd(123)).toBe('$0.0001');
    expect(formatUsd(9_999)).toBe('$0.0099');
    expect(formatUsd(60)).toBe('< $0.0001');
  });

  it('用量条的比例在 0–100 之间', () => {
    expect(usedPercent(30_000_000, 30_000_000)).toBe(0);
    expect(usedPercent(15_000_000, 30_000_000)).toBe(50);
    expect(usedPercent(0, 0)).toBe(0);
  });
});

describe('任务花费和文件大小', () => {
  it('不到 $1 的花费显示到 4 位小数，向下取整', () => {
    expect(formatCost(18_700)).toBe('$0.0187');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(60)).toBe('< $0.0001');
    expect(formatCost(2_345_678)).toBe('$2.34');
  });

  it('文件大小按 1024 换算', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1_284_000)).toBe('1.2 MB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
  });
});
