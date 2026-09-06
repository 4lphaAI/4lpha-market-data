/** Deterministic facts over one observed, exact-pool series. No trading decisions. */
import { createHash } from "node:crypto";
import type { SnapshotStore } from "../core/store.js";
import type { PoolCandle, PoolOhlcvResult } from "./poolOhlcv.js";
import type { OhlcvAttempt } from "./poolOhlcv.js";

export const FEATURE_VERSION = "pool-features-v1";
export const FEATURE_VERSION_V2 = "pool-features-v2";
export type FeatureVersion = typeof FEATURE_VERSION | typeof FEATURE_VERSION_V2;
export const FEATURE_INDEX_KEY_V2 = "trading:features:v2:index";
export const FEATURE_STATE_KEY = "trading:features:v1:producer";
export interface FeatureAttempt {
  attemptedAt: number; nextAttempt: number; completedAt?: number; lastSuccessAt?: number;
  consecutiveFailures?: number; state?: "queued" | "refreshing" | "ready" | "partial" | "unavailable";
  reason?: string; sources?: OhlcvAttempt[];
}
export const FEATURE_INTERVALS = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000 } as const;
export type FeatureInterval = keyof typeof FEATURE_INTERVALS;
export const FEATURE_HISTORY = 120;
export const PUBLICATION_LAG_MS = 15_000;
export const SCHEDULING_GRACE_MS = 75_000;
export const FEATURE_INDEX_KEY = "trading:features:v1:index";
export type UnavailableReason = "insufficient_history" | "gap" | "stale_input" | "invalid_bar"
  | "conflicting_revision" | "unknown_volume_unit" | "zero_baseline" | "invalid_volume"
  | "numeric_overflow" | "observation_after_evaluation" | "invalid_identity";
export interface Metric {
  value: number | null;
  available: boolean;
  reason: UnavailableReason | null;
  requiredBars: number;
  usableBars: number;
  unit: string;
}
export interface FeatureInput {
  chainId: 56;
  poolAddress: string;
  baseAddress: string;
  quoteAddress: string;
  priceCurrency: "usd" | "token";
  volumeCurrency: string;
  volumeUnavailableReason: string | null;
  source: string;
  interval: FeatureInterval;
  observedAt: number;
  candles: PoolCandle[];
  conflictingTimestamps: number[];
}
export interface FeatureSnapshot {
  version: FeatureVersion;
  snapshotId: string;
  seriesId: string;
  input: FeatureInput;
  calculatedAt: number;
  evaluationClose: number | null;
  refreshAfter: number;
  expiresAt: number;
  coverage: {
    availableBars: number; contiguousBars: number; requiredHistory: number;
    firstOpen: number | null; latestClose: number | null;
    missingBuckets: number; invalidBars: number; excludedUnclosedBars: number;
    identicalDuplicates: number; conflictingDuplicates: number;
  };
  parameters: {
    historyBars: 120; rocPeriod: 10; rvolBaseline: 20; emaPeriods: readonly [12, 26];
    atrPeriod: 14; emaSeed: "sma"; atrSmoothing: "wilder";
    publicationLagMs: number; schedulingGraceMs: number; bucketConvention: "UTC-open-ms";
    warmupBars: { ema12: number; ema26: number; atr14: number };
  };
  metrics: { roc10Pct: Metric; ema12: Metric; ema26: Metric; emaSpreadPct: Metric; atr14: Metric; atrPct: Metric; rvol20: Metric };
  volume: { baseline: number | null; latest: number | null; usableBaselineBars: number };
  lineage: { scope: "exact_pool"; transformation: "native"; correctionPolicy: string };
}
export function featureKey(pool: string, interval: FeatureInterval, currency: "usd" | "token" = "usd", tokenAddress?: string, version: FeatureVersion = FEATURE_VERSION): string {
  return `trading:features:${version === FEATURE_VERSION ? "v1" : "v2"}:${pool.toLowerCase()}:${interval}:${currency}${tokenAddress ? `:${tokenAddress.toLowerCase()}` : ""}`;
}
export function isFeatureInterval(value: string): value is FeatureInterval {
  return Object.hasOwn(FEATURE_INTERVALS, value);
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function validPrice(c: PoolCandle): boolean {
  return [c.open, c.high, c.low, c.close].every((n) => Number.isFinite(n) && n > 0)
    && c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close, c.high);
}
function sameBar(a: PoolCandle, b: PoolCandle): boolean {
  return a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;
}
/** Bounded replay: observedAt is when this exact revision was first available to us. */
export function calculateFeatures(input: FeatureInput, now: number, version: FeatureVersion = FEATURE_VERSION): FeatureSnapshot {
  if (input.candles.length > 501 || input.conflictingTimestamps.length > 501) throw new Error("feature history exceeds bounded input");
  const step = FEATURE_INTERVALS[input.interval];
  const cutoff = Math.floor((now - PUBLICATION_LAG_MS) / step) * step;
  const start = cutoff - FEATURE_HISTORY * step;
  const byTime = new Map<number, PoolCandle>();
  const warmup = version === FEATURE_VERSION ? {ema12:120, ema26:120, atr14:120} : {ema12:24, ema26:52, atr14:29};
  const invalidTimes = new Set<number>();
  let invalidUnlocated = false;
  const conflicts = new Set(input.conflictingTimestamps.filter((t) => t >= start && t < cutoff));
  let invalidBars = 0, excludedUnclosedBars = 0, identicalDuplicates = 0;
  for (const bar of input.candles) {
    if (!Number.isSafeInteger(bar.timestamp) || bar.timestamp <= 0 || bar.timestamp % step !== 0) { invalidBars++; invalidUnlocated = true; continue; }
    if (bar.timestamp + step > cutoff || bar.timestamp + step > input.observedAt) { excludedUnclosedBars++; continue; }
    if (bar.timestamp < start) continue;
    if (!validPrice(bar)) { invalidBars++; invalidTimes.add(bar.timestamp); conflicts.add(bar.timestamp); continue; }
    const previous = byTime.get(bar.timestamp);
    if (previous && !sameBar(previous, bar)) conflicts.add(bar.timestamp);
    else if (previous) identicalDuplicates++;
    byTime.set(bar.timestamp, { ...bar });
  }
  for (const time of conflicts) byTime.delete(time);
  const bars = [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
  const latest = bars.at(-1);
  const closeTime = latest ? latest.timestamp + step : null;
  let contiguous = latest ? 1 : 0;
  for (let i = bars.length - 2; i >= 0; i--) {
    if (bars[i + 1]!.timestamp - bars[i]!.timestamp !== step) break;
    contiguous++;
  }
  const address = /^0x[0-9a-f]{40}$/u;
  const identityValid = input.chainId === 56 && [input.poolAddress, input.baseAddress, input.quoteAddress].every((s) => address.test(s))
    && input.baseAddress !== input.quoteAddress && ["geckoterminal", "dexpaprika"].includes(input.source);
  const globalReason: UnavailableReason | null = !identityValid ? "invalid_identity"
    : !Number.isFinite(now) || !Number.isFinite(input.observedAt) || input.observedAt > now ? "observation_after_evaluation"
    : closeTime !== null && now >= closeTime + step + PUBLICATION_LAG_MS + SCHEDULING_GRACE_MS ? "stale_input" : null;
  const reasonFor = (required: number): UnavailableReason | null => {
    if (globalReason) return globalReason;
    const windowStart = (latest?.timestamp ?? cutoff) - (required - 1) * step;
    if (version === FEATURE_VERSION ? invalidBars > 0 : invalidUnlocated || [...invalidTimes].some(t => t >= windowStart)) return "invalid_bar";
    if (version === FEATURE_VERSION ? conflicts.size > 0 : [...conflicts].some(t => t >= windowStart)) return "conflicting_revision";
    if (bars.length < required) return "insufficient_history";
    if (contiguous < required) return "gap";
    return null;
  };
  const metric = (required: number, unit: string, calc: () => number, extra: UnavailableReason | null = null): Metric => {
    let reason = reasonFor(required) ?? extra;
    const value = reason ? null : calc();
    if (value !== null && !Number.isFinite(value)) reason = "numeric_overflow";
    return { value: reason ? null : value, available: reason === null, reason, requiredBars: required, usableBars: Math.min(contiguous, required), unit };
  };
  const priceUnit = input.priceCurrency === "usd" ? "usd_per_base_token" : "quote_token_per_base_token";
  const ema = (period: number): number => {
    const prices = bars.slice(-(period === 12 ? warmup.ema12 : warmup.ema26)).map((b) => b.close);
    let result = prices.slice(0, period).reduce((sum, p) => sum + p / period, 0);
    const alpha = 2 / (period + 1);
    for (const price of prices.slice(period)) result = alpha * price + (1 - alpha) * result;
    return result;
  };
  const atr = (): number => {
    const window = bars.slice(-warmup.atr14);
    const ranges = window.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - window[i]!.close), Math.abs(b.low - window[i]!.close)));
    let value = ranges.slice(0, 14).reduce((sum, n) => sum + n / 14, 0);
    for (const range of ranges.slice(14)) value = value * (13 / 14) + range / 14;
    return value;
  };
  const volumes = bars.slice(-21);
  const volumeKnown = input.volumeUnavailableReason === null && ["usd", "quote_token"].includes(input.volumeCurrency);
  const usableBaselineBars = volumes.slice(0, -1).filter((b) => b.volume !== null && Number.isFinite(b.volume) && b.volume >= 0).length;
  const validVolumes = volumes.length === 21 && usableBaselineBars === 20 && latest?.volume !== null
    && Number.isFinite(latest?.volume) && latest!.volume! >= 0;
  const baseline = volumeKnown && validVolumes && !reasonFor(21)
    ? volumes.slice(0, -1).reduce((sum, b) => sum + b.volume! / 20, 0) : null;
  const volumeReason: UnavailableReason | null = !volumeKnown ? "unknown_volume_unit" : !validVolumes ? "invalid_volume"
    : baseline === 0 ? "zero_baseline" : baseline !== null && !Number.isFinite(baseline) ? "numeric_overflow" : null;
  const series = { chainId: input.chainId, poolAddress: input.poolAddress, baseAddress: input.baseAddress,
    quoteAddress: input.quoteAddress, priceCurrency: input.priceCurrency, volumeCurrency: input.volumeCurrency,
    source: input.source, interval: input.interval };
  const seriesId = hash(series);
  // Retain the exact bounded observation, including rejected rows, for reproducibility.
  const retainedInput = { ...input, candles: input.candles.map((bar) => ({ ...bar })) };
  return {
    version, seriesId, snapshotId: hash({ version, input: retainedInput, cutoff }), input: retainedInput,
    calculatedAt: now, evaluationClose: closeTime,
    refreshAfter: closeTime === null ? now + 60_000 : closeTime + step + PUBLICATION_LAG_MS,
    expiresAt: closeTime === null ? now : closeTime + step + PUBLICATION_LAG_MS + SCHEDULING_GRACE_MS,
    coverage: { availableBars: bars.length, contiguousBars: contiguous, requiredHistory: FEATURE_HISTORY,
      firstOpen: bars[0]?.timestamp ?? null, latestClose: closeTime,
      missingBuckets: bars.length ? (latest!.timestamp - bars[0]!.timestamp) / step + 1 - bars.length : 0,
      invalidBars, excludedUnclosedBars, identicalDuplicates, conflictingDuplicates: conflicts.size },
    parameters: { historyBars: 120, rocPeriod: 10, rvolBaseline: 20, emaPeriods: [12, 26], atrPeriod: 14,
      emaSeed: "sma", atrSmoothing: "wilder", publicationLagMs: PUBLICATION_LAG_MS,
      schedulingGraceMs: SCHEDULING_GRACE_MS, bucketConvention: "UTC-open-ms", warmupBars: warmup },
    metrics: {
      roc10Pct: metric(11, "percent", () => (latest!.close / bars.at(-11)!.close - 1) * 100),
      ema12: metric(warmup.ema12, priceUnit, () => ema(12)), ema26: metric(warmup.ema26, priceUnit, () => ema(26)),
      emaSpreadPct: metric(warmup.ema26, "percent", () => (ema(12) / ema(26) - 1) * 100),
      atr14: metric(warmup.atr14, priceUnit, atr), atrPct: metric(warmup.atr14, "percent", () => atr() / latest!.close * 100),
      rvol20: { ...metric(21, "ratio", () => latest!.volume! / baseline!, volumeReason),
        usableBars: volumeKnown ? Math.min(contiguous, volumes.filter((b) => b.volume !== null && Number.isFinite(b.volume) && b.volume >= 0).length) : 0 },
    },
    volume: { baseline, latest: volumeKnown && latest?.volume !== null && Number.isFinite(latest?.volume) && latest!.volume! >= 0 ? latest!.volume : null,
      usableBaselineBars: volumeKnown ? usableBaselineBars : 0 },
    lineage: { scope: "exact_pool", transformation: "native", correctionPolicy: "whole_provider_observation; never splice; revisions visible on next advancing refresh" },
  };
}
export function poolFeatureInput(chart: PoolOhlcvResult, interval: FeatureInterval): FeatureInput {
  return { chainId: 56, poolAddress: chart.poolAddress, baseAddress: chart.base.address, quoteAddress: chart.quote.address,
    priceCurrency: chart.priceCurrency, volumeCurrency: chart.volumeCurrency, volumeUnavailableReason: chart.volumeUnavailableReason,
    source: chart.source, interval, observedAt: chart.asOf, candles: chart.candles,
    conflictingTimestamps: chart.quality?.conflictingTimestamps ?? [] };
}
/** Reads only the store. Computation time cannot renew market-data freshness. */
export async function readTradingFeatures(store: SnapshotStore, pool: string, interval: FeatureInterval, now = Date.now(), currency: "usd" | "token" = "usd", tokenAddress?: string, version: FeatureVersion = FEATURE_VERSION) {
  const record = await store.get<FeatureSnapshot>(featureKey(pool, interval, currency, tokenAddress, version));
  if (!record || record.data.version !== version) return null;
  const snapshot = record.data;
  if (snapshot.input.poolAddress !== pool.toLowerCase() || snapshot.input.interval !== interval || snapshot.input.priceCurrency !== currency) return null;
  if (tokenAddress && snapshot.input.baseAddress !== tokenAddress.toLowerCase()) return null;
  const future = snapshot.calculatedAt > now || snapshot.input.observedAt > now;
  const stale = now >= snapshot.expiresAt || record.staleness === "dead" || future;
  const { input, ...result } = snapshot;
  return { ...result, identity: { chainId: input.chainId, poolAddress: input.poolAddress, baseAddress: input.baseAddress,
    quoteAddress: input.quoteAddress, interval: input.interval, priceCurrency: input.priceCurrency, volumeCurrency: input.volumeCurrency,
    source: input.source, observedAt: input.observedAt, volumeUnavailableReason: input.volumeUnavailableReason },
    staleness: stale ? "stale" as const : "fresh" as const,
    metrics: Object.fromEntries(Object.entries(snapshot.metrics).map(([name, m]) => [name,
      stale ? { ...m, value: null, available: false, reason: future ? "observation_after_evaluation" : "stale_input" } : m])) };
}

export async function readFeatureAttempt(store: SnapshotStore, pool: string, interval: FeatureInterval, currency: "usd" | "token", tokenAddress?: string, now = Date.now()) {
  const state = await store.get<Record<string, FeatureAttempt>>(FEATURE_STATE_KEY);
  const attempt = state?.data[`${featureKey(pool, interval, currency, tokenAddress)}:${currency}`];
  if (!attempt) return {state: "queued", reason: "not_attempted", nextAttempt: null, sources: []};
  if (attempt.state === "refreshing" && now > attempt.attemptedAt + 30_000) return {...attempt, state: "unavailable", reason: "refresh_interrupted"};
  return attempt;
}
