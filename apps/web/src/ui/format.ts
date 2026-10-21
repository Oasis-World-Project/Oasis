/** 微美元 → 给人看的金额。小于 1 美分时多显示两位，免得都显示成 $0.00。 */
export function formatUsd(micro: number): string {
  const usd = micro / 1_000_000;
  return `$${usd.toFixed(Math.abs(usd) >= 0.01 || usd === 0 ? 2 : 4)}`;
}

/** 已用比例（0–100），用于额度条。 */
export function usedPercent(availableMicro: number, grantedMicro: number): number {
  if (grantedMicro <= 0) return 0;
  return Math.min(
    100,
    Math.max(0, Math.round(((grantedMicro - availableMicro) / grantedMicro) * 100)),
  );
}
