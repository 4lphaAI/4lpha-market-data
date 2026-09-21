/** Deterministic facts over one observed, exact-pool series. No trading decisions. */
import { createHash } from "node:crypto";
import type { SnapshotStore } from "../core/store.js";
import type { PoolCandle, PoolOhlcvResult } from "./poolOhlcv.js";
import type { OhlcvAttempt } from "./poolOhlcv.js";
import { ORB_WINDOW_MS, SESSION_CLOCK, sessionAt, type Session, type SessionState } from "./sessionClock.js";

export const FEATURE_VERSION = "pool-features-v1";
export const FEATURE_VERSION_V2 = "pool-features-v2";
export type FeatureVersion = typeof FEATURE_VERSION | typeof FEATURE_VERSION_V2;
export const FEATURE_INDEX_KEY_V2 = "trading:features:v2:index";
export const FEATURE_STATE_KEY = "trading:features:v1:producer";
export interface FeatureAttempt {
  revision?: number;
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
  | "numeric_overflow" | "observation_after_evaluation" | "invalid_identity"
  // indicatorRevision 2
  | "zero_width" | "zero_range" | "not_us_equity" | "no_rth_close_in_window" | "zero_volume"
  | "interval_too_coarse" | "orb_not_formed" | "not_rth";
export interface Metric {
  value: number | null;
  available: boolean;
  reason: UnavailableReason | null;
  requiredBars: number;
  usableBars: number;
  unit: string;
  /** Bucket close the value was read at; only on metrics anchored to one bar (`lastRthClose`). */
  asOf?: number | null;
}
/**
 * What the RWA snapshot said about the series' base token when it was
 * observed. `null` = not a tokenized US equity; the session-anchored metrics
 * then answer `not_us_equity`. Retained in the input so replay is exact.
 */
export interface ReferenceSession {
  underlyingTicker: string;
  /** bStocks: `null` (24/7). Ondo: `regular` / `overnight` ... */
  marketStatus: string | null;
  openState: boolean | null;
  asOf: number | null;
}
export const REV2_METRICS = ["bbMiddle20", "bbUpper20", "bbLower20", "bbPosition20", "bbWidthPct20", "stochRsi14",
  "lastRthClose", "gapPct", "vwapSession", "vwapDistancePct", "orbHigh", "orbLow", "orbBreakPct"] as const;
export type Rev2Metric = typeof REV2_METRICS[number];
export interface SessionBlock {
  usEquity: boolean;
  reason: "not_us_equity" | null;
  /** At `calculatedAt`; `null` when not a US equity. */
  state: SessionState | null;
  nextBoundaryAt: number | null;
  sessionStart: number | null;
  lastRthCloseAt: number | null;
  evaluatedAt: number;
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
  /** indicatorRevision 2; absent on older snapshots, read as `null`. */
  referenceSession?: ReferenceSession | null;
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
    indicatorRevision?: 2;
    rsiPeriod?: 14; rsiSmoothing?: "wilder"; rsiFlatValue?: 50;
    momentumPeriod?: 10; macdPeriods?: readonly [12, 26, 9]; signalSeed?: "sma";
    indicatorWarmupBars?: { rsi14: 29; macd: 52; signal9: 69; histogram: 69; momentum10: 11;
      bb20: 20; stochRsi14: 42; vwapSession: 1; gap: 1; orb: number };
    bbPeriod?: 20; bbSigma?: 2; bbDeviation?: "population"; stochRsiPeriods?: readonly [14, 14];
    sessionClock?: typeof SESSION_CLOCK;
  };
  metrics: { roc10Pct: Metric; ema12: Metric; ema26: Metric; emaSpreadPct: Metric; atr14: Metric; atrPct: Metric; rvol20: Metric }
    & Partial<Record<"rsi14" | "macd" | "signal9" | "histogram" | "momentum10" | Rev2Metric, Metric>>;
  /** indicatorRevision 2: the NYSE session the snapshot was evaluated in. Absent on v1. */
  session?: SessionBlock;
  volume: { baseline: number | null; latest: number | null; usableBaselineBars: number };
  lineage: { scope: "exact_pool"; transformation: "native"; correctionPolicy: string };
}
export function featureKey(pool: string, interval: FeatureInterval, currency: "usd" | "token" = "usd", tokenAddress?: string, version: FeatureVersion = FEATURE_VERSION): string {
  return `trading:features:${version === FEATURE_VERSION ? "v1" : "v2"}:${pool.toLowerCase()}:${interval}:${currency}${tokenAddress ? `:${tokenAddress.toLowerCase()}` : ""}`;
}
export function isFeatureInterval(value: string): value is FeatureInterval {
  return Object.hasOwn(FEATURE_INTERVALS, value);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0).map(([key,entry])=>[key,canonical(entry)]));
  return value;
}
function hash(value: unknown, stable = false): string {
  return createHash("sha256").update(JSON.stringify(stable ? canonical(value) : value)).digest("hex");
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
  const reasonWithin = (windowStart: number, required: number, contiguity: boolean): UnavailableReason | null => {
    if (globalReason) return globalReason;
    if (version === FEATURE_VERSION ? invalidBars > 0 : invalidUnlocated || [...invalidTimes].some(t => t >= windowStart)) return "invalid_bar";
    if (version === FEATURE_VERSION ? conflicts.size > 0 : [...conflicts].some(t => t >= windowStart)) return "conflicting_revision";
    if (bars.length < required) return "insufficient_history";
    if (contiguity && contiguous < required) return "gap";
    return null;
  };
  const reasonFor = (required: number): UnavailableReason | null =>
    reasonWithin((latest?.timestamp ?? cutoff) - (required - 1) * step, required, true);
  const metric = (required: number, unit: string, calc: () => number, extra: UnavailableReason | null = null): Metric => {
    let reason = reasonFor(required) ?? extra;
    const value = reason ? null : calc();
    if (value !== null && !Number.isFinite(value)) reason = "numeric_overflow";
    return { value: reason ? null : value, available: reason === null, reason, requiredBars: required, usableBars: Math.min(contiguous, required), unit };
  };
  /** Revision 2 shape: the calculation itself may answer with a reason (zero width, no RTH close ...). */
  const metric2 = (required: number, unit: string, calc: () => number | UnavailableReason,
    guard: UnavailableReason | null = reasonFor(required), usable = Math.min(contiguous, required), asOf?: number | null): Metric => {
    let reason = guard;
    const result = reason ? null : calc();
    if (typeof result === "string") reason = result;
    const value = typeof result === "number" ? result : null;
    if (value !== null && !Number.isFinite(value)) reason = "numeric_overflow";
    return { value: reason ? null : value, available: reason === null, reason, requiredBars: required, usableBars: usable, unit,
      ...(asOf === undefined ? {} : { asOf: reason ? null : asOf }) };
  };
  const priceUnit = input.priceCurrency === "usd" ? "usd_per_base_token" : "quote_token_per_base_token";
  const smoothEma = (prices: number[], period: number): number => {
    let result = prices.slice(0, period).reduce((sum, p) => sum + p / period, 0);
    const alpha = 2 / (period + 1);
    for (const price of prices.slice(period)) result = alpha * price + (1 - alpha) * result;
    return result;
  };
  const ema = (period: number, end = bars.length): number => smoothEma(
    bars.slice(Math.max(0, end - (period === 12 ? warmup.ema12 : warmup.ema26)), end).map(b => b.close), period);
  const macd = (end = bars.length): number => ema(12, end) - ema(26, end);
  // Eighteen consecutive bounded MACD observations: SMA9 seed + nine EMA updates.
  // Each observation uses the same 24/52-bar EMA windows as the published v2 line.
  const signal9 = (): number => smoothEma(Array.from({ length: 18 }, (_, i) => macd(bars.length - 17 + i)), 9);
  const rsiAt = (end: number): number => {
    const window = bars.slice(Math.max(0, end - 29), end);
    let gain = 0, loss = 0;
    for (let i = 1; i < window.length; i++) {
      const delta = window[i]!.close - window[i - 1]!.close;
      const up = Math.max(delta, 0), down = Math.max(-delta, 0);
      if (i <= 14) { gain += up / 14; loss += down / 14; }
      else { gain = gain * (13 / 14) + up / 14; loss = loss * (13 / 14) + down / 14; }
    }
    if (gain === 0 && loss === 0) return 50;
    if (loss === 0) return 100;
    return 100 - 100 / (1 + gain / loss);
  };
  const rsi14 = (): number => rsiAt(bars.length);
  // --- indicatorRevision 2 ---------------------------------------------------
  const rev2 = version === FEATURE_VERSION_V2;
  const bb = () => {
    const window = bars.slice(-20).map((b) => b.close);
    const middle = window.reduce((sum, c) => sum + c / 20, 0);
    const sigma = Math.sqrt(window.reduce((sum, c) => sum + (c - middle) ** 2 / 20, 0));
    return { middle, upper: middle + 2 * sigma, lower: middle - 2 * sigma };
  };
  // Fourteen RSI observations, each over its own 29-bar window, bar-for-bar the rev 1 recurrence.
  const stochRsi = (): number | UnavailableReason => {
    const values = Array.from({ length: 14 }, (_, i) => rsiAt(bars.length - 13 + i));
    const min = Math.min(...values), max = Math.max(...values);
    return max === min ? "zero_range" : (values[13]! - min) / (max - min);
  };
  const reference = rev2 ? input.referenceSession ?? null : null;
  const session: Session | null = reference && Number.isFinite(now) ? sessionAt(now) : null;
  const sessionGuard = (windowStart: number, required = 1): UnavailableReason | null =>
    !reference ? "not_us_equity" : !session ? "observation_after_evaluation" : reasonWithin(windowStart, required, false);
  const usableSince = (from: number, to = Number.POSITIVE_INFINITY) => bars.filter((b) => b.timestamp >= from && b.timestamp + step <= to).length;
  const rthCloseBar = () => session ? [...bars].reverse().find((b) => b.timestamp + step <= session.lastRthCloseAt && b.timestamp + step > session.lastRthOpenAt) ?? null : null;
  const lastRthClose = (): number | UnavailableReason => rthCloseBar()?.close ?? "no_rth_close_in_window";
  const gapPct = (): number | UnavailableReason => {
    const close = lastRthClose();
    return typeof close === "string" ? close : (latest!.close - close) / close * 100;
  };
  const validVolume = (b: PoolCandle) => b.volume !== null && Number.isFinite(b.volume) && b.volume >= 0;
  const vwap = (): number | UnavailableReason => {
    if (!volumeKnown) return "unknown_volume_unit";
    const window = bars.filter((b) => b.timestamp >= session!.sessionStart);
    if (window.length === 0) return "insufficient_history";
    if (!window.every(validVolume)) return "invalid_volume";
    const volume = window.reduce((sum, b) => sum + b.volume!, 0);
    if (volume === 0) return "zero_volume";
    return window.reduce((sum, b) => sum + (b.high + b.low + b.close) / 3 * b.volume!, 0) / volume;
  };
  const vwapDistancePct = (): number | UnavailableReason => {
    const value = vwap();
    return typeof value === "string" ? value : (latest!.close - value) / value * 100;
  };
  const orbBars = ORB_WINDOW_MS / step;
  const orb = (): { high: number; low: number } | UnavailableReason => {
    if (!Number.isInteger(orbBars)) return "interval_too_coarse";
    if (session!.state !== "rth") return "not_rth";
    if (cutoff < session!.orbEnd) return "orb_not_formed";
    const window = bars.filter((b) => b.timestamp >= session!.orbStart && b.timestamp + step <= session!.orbEnd);
    if (window.length !== orbBars) return "gap";
    return { high: Math.max(...window.map((b) => b.high)), low: Math.min(...window.map((b) => b.low)) };
  };
  const orbSide = (side: "high" | "low") => (): number | UnavailableReason => { const r = orb(); return typeof r === "string" ? r : r[side]; };
  const orbBreakPct = (): number | UnavailableReason => {
    const r = orb();
    if (typeof r === "string") return r;
    return latest!.close > r.high ? (latest!.close - r.high) / r.high * 100 : latest!.close < r.low ? (latest!.close - r.low) / r.low * 100 : 0;
  };
  const sessionMetrics = (): Partial<Record<Rev2Metric, Metric>> => {
    const s = session;
    const rthBar = rthCloseBar();
    const rthUsable = rthBar ? 1 : 0, rthAsOf = rthBar ? rthBar.timestamp + step : null;
    const sessionUsable = s ? usableSince(s.sessionStart) : 0;
    const orbUsable = s ? Math.min(usableSince(s.orbStart, s.orbEnd), Number.isInteger(orbBars) ? orbBars : 0) : 0;
    const orbRequired = Number.isInteger(orbBars) ? orbBars : 0;
    return {
      lastRthClose: metric2(1, priceUnit, lastRthClose, sessionGuard(s?.lastRthOpenAt ?? 0), rthUsable, rthAsOf),
      gapPct: metric2(1, "percent", gapPct, sessionGuard(s?.lastRthOpenAt ?? 0), rthUsable),
      vwapSession: metric2(1, priceUnit, vwap, sessionGuard(s?.sessionStart ?? 0), sessionUsable),
      vwapDistancePct: metric2(1, "percent", vwapDistancePct, sessionGuard(s?.sessionStart ?? 0), sessionUsable),
      orbHigh: metric2(orbRequired, priceUnit, orbSide("high"), sessionGuard(s?.orbStart ?? 0), orbUsable),
      orbLow: metric2(orbRequired, priceUnit, orbSide("low"), sessionGuard(s?.orbStart ?? 0), orbUsable),
      orbBreakPct: metric2(orbRequired, "percent", orbBreakPct, sessionGuard(s?.orbStart ?? 0), orbUsable),
    };
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
  // v1 never learns about the reference session, so its IDs and payload stay what they were.
  const { referenceSession: _omitted, ...bareInput } = input;
  const retainedInput: FeatureInput = { ...bareInput, candles: input.candles.map((bar) => ({ ...bar })),
    ...(rev2 ? { referenceSession: reference ? { ...reference } : null } : {}) };
  return {
    version, seriesId, snapshotId: hash({ version, input: retainedInput, cutoff,
      ...(rev2 ? { indicatorRevision: 2 } : {}) }, rev2), input: retainedInput,
    calculatedAt: now, evaluationClose: closeTime,
    refreshAfter: closeTime === null ? now + 60_000 : closeTime + step + PUBLICATION_LAG_MS,
    expiresAt: closeTime === null ? now : closeTime + step + PUBLICATION_LAG_MS + SCHEDULING_GRACE_MS,
    coverage: { availableBars: bars.length, contiguousBars: contiguous, requiredHistory: FEATURE_HISTORY,
      firstOpen: bars[0]?.timestamp ?? null, latestClose: closeTime,
      missingBuckets: bars.length ? (latest!.timestamp - bars[0]!.timestamp) / step + 1 - bars.length : 0,
      invalidBars, excludedUnclosedBars, identicalDuplicates, conflictingDuplicates: conflicts.size },
    parameters: { historyBars: 120, rocPeriod: 10, rvolBaseline: 20, emaPeriods: [12, 26], atrPeriod: 14,
      emaSeed: "sma", atrSmoothing: "wilder", publicationLagMs: PUBLICATION_LAG_MS,
      schedulingGraceMs: SCHEDULING_GRACE_MS, bucketConvention: "UTC-open-ms", warmupBars: warmup,
      ...(rev2 ? { indicatorRevision: 2 as const, rsiPeriod: 14 as const,
        rsiSmoothing: "wilder" as const, rsiFlatValue: 50 as const, momentumPeriod: 10 as const,
        macdPeriods: [12, 26, 9] as const, signalSeed: "sma" as const,
        indicatorWarmupBars: { rsi14: 29, macd: 52, signal9: 69, histogram: 69, momentum10: 11,
          bb20: 20, stochRsi14: 42, vwapSession: 1, gap: 1, orb: Number.isInteger(orbBars) ? orbBars : 0 } as const,
        bbPeriod: 20 as const, bbSigma: 2 as const, bbDeviation: "population" as const, stochRsiPeriods: [14, 14] as const,
        sessionClock: SESSION_CLOCK } : {}) },
    metrics: {
      ...(rev2 ? {
        momentum10: metric(11, priceUnit, () => latest!.close - bars.at(-11)!.close),
        rsi14: metric(29, "index", rsi14),
        macd: metric(52, priceUnit, macd),
        signal9: metric(69, priceUnit, signal9),
        histogram: metric(69, priceUnit, () => macd() - signal9()),
        bbMiddle20: metric2(20, priceUnit, () => bb().middle),
        bbUpper20: metric2(20, priceUnit, () => bb().upper),
        bbLower20: metric2(20, priceUnit, () => bb().lower),
        bbPosition20: metric2(20, "ratio", () => { const b = bb(); return b.upper === b.lower ? "zero_width" : (latest!.close - b.lower) / (b.upper - b.lower); }),
        bbWidthPct20: metric2(20, "percent", () => { const b = bb(); return (b.upper - b.lower) / b.middle * 100; }),
        stochRsi14: metric2(42, "ratio", stochRsi),
        ...sessionMetrics(),
      } : {}),
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
    ...(rev2 ? { session: {
      usEquity: reference !== null, reason: reference ? null : "not_us_equity" as const,
      state: session?.state ?? null, nextBoundaryAt: session?.nextBoundaryAt ?? null,
      sessionStart: session?.sessionStart ?? null, lastRthCloseAt: session?.lastRthCloseAt ?? null, evaluatedAt: now } } : {}),
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
    source: input.source, observedAt: input.observedAt, volumeUnavailableReason: input.volumeUnavailableReason,
    ...(version === FEATURE_VERSION_V2 ? { referenceSession: input.referenceSession ?? null } : {}) },
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
