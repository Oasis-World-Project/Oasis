/** 微美元 → 给人看的金额。小于 1 美分时多显示两位，免得都显示成 $0.00。 */
export function formatUsd(micro: number): string {
  const usd = micro / 1_000_000;
  if (usd === 0 || Math.abs(usd) >= 0.01) {
    // 向下取整到分：花了一点点之后余额显示 $29.99，而不是四舍五入回 $30.00
    // 用整数微美元算，避免 0.29 * 100 = 28.999… 这类浮点误差
    return `$${(Math.floor(micro / 10_000) / 100).toFixed(2)}`;
  }
  // 花了但不到 $0.0001 时也要看得出来不是 0
  if (micro > 0 && micro < 100) return '< $0.0001';
  return `$${(Math.floor(micro / 100) / 10_000).toFixed(4)}`;
}

/** 已用比例（0–100），用于额度条。 */
export function usedPercent(availableMicro: number, grantedMicro: number): number {
  if (grantedMicro <= 0) return 0;
  return Math.min(
    100,
    Math.max(0, Math.round(((grantedMicro - availableMicro) / grantedMicro) * 100)),
  );
}

/** 文件大小 → 给人看的写法（1 KB = 1024 B） */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 任务花费常常只有几美分：不到 $1 时显示到 0.0001 美元，看得出差别 */
export function formatCost(micro: number): string {
  if (micro >= 1_000_000 || micro === 0) return formatUsd(micro);
  if (micro < 100) return '< $0.0001';
  return `$${(Math.floor(micro / 100) / 10_000).toFixed(4)}`;
}
