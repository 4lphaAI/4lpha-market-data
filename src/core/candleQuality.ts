import type { PoolCandle } from "../query/poolOhlcv.js";

/** Quality of the latest observed closed segment; never fills or joins bars. */
export function candleQuality(candles: PoolCandle[], conflicts: number[], intervalMs: number, observedAt: number, now: number) {
  const cutoff = Math.floor((now - 15_000) / intervalMs) * intervalMs;
  const byTime = new Map<number, PoolCandle>();
  const rejected = new Set(conflicts);
  let invalidTimestamp = false;
  for (const bar of candles) {
    if (!Number.isSafeInteger(bar.timestamp) || bar.timestamp <= 0 || bar.timestamp % intervalMs !== 0) {invalidTimestamp = true; continue;}
    if (bar.timestamp + intervalMs > cutoff || bar.timestamp + intervalMs > observedAt) continue;
    if (![bar.open, bar.high, bar.low, bar.close].every(n => Number.isFinite(n) && n > 0)
      || bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close, bar.high)) {
      rejected.add(bar.timestamp); continue;
    }
    const previous = byTime.get(bar.timestamp);
    if (previous && (previous.open !== bar.open || previous.high !== bar.high || previous.low !== bar.low || previous.close !== bar.close)) rejected.add(bar.timestamp);
    byTime.set(bar.timestamp, bar);
  }
  for (const time of rejected) byTime.delete(time);
  const times = [...byTime.keys()].sort((a,b) => a-b);
  const latest = times.at(-1);
  const close = latest === undefined ? 0 : latest + intervalMs;
  let contiguous = latest === undefined ? 0 : 1;
  for (let i = times.length-2; i >= 0; i--) {
    if (times[i+1]! - times[i]! !== intervalMs) break;
    contiguous++;
  }
  const fresh = close > 0 && observedAt <= now && now < close + intervalMs + 90_000;
  const badWindow = (n:number) => invalidTimestamp || [...rejected].some(t => t >= (latest ?? cutoff) - (n-1)*intervalMs && t < cutoff);
  const supported = fresh ? [11,24,29,52].filter(n => contiguous >= n && !badWindow(n)).length : 0;
  return { close, contiguous, fresh, supported, sufficient: supported === 4,
    reason: !close ? "empty" : !fresh ? "stale" : badWindow(52) ? "invalid_candles"
      : contiguous < 52 ? (times.length > contiguous ? "gap" : "insufficient_history") : "ready" };
}
