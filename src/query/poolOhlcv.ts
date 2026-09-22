/** Exact-pool OHLCV: shared cache -> Gecko -> DexPaprika (ratios) -> old cache. */
import { createHash, randomUUID } from "node:crypto";
import { fetchGeckoPoolOhlcv, type GeckoTokenRef } from "../adapters/geckoTerminal.js";
import { fetchDexCandles, fetchDexPair, type DexPair } from "../adapters/dexPaprika.js";
import { fetchSintralKlines } from "../adapters/binanceWeb3.js";
import { poolKey } from "../adapters/pancake.js";
import { USD_ANCHOR } from "../jobs/majorsPrices.js";
import { OhlcvTransport } from "../adapters/ohlcvTransport.js";
import { isEvmAddress, sanitizeMessage } from "../adapters/http.js";
import type { Candle, PoolStats } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { DataRecord, Staleness } from "../core/types.js";
import type { KlineInterval } from "./klines.js";
import { candleQuality } from "../core/candleQuality.js";
import { AdapterError } from "../adapters/http.js";

export interface OhlcvAttempt { source: string; reason: string; contiguousBars?: number }

export type PoolPriceCurrency = "usd" | "token";
export type PoolCandle = Omit<Candle, "volume"> & { volume: number | null };
const INTERVALS = {
  "1m": { timeframe: "minute", aggregate: 1, seconds: 60, dex: "1m" },
  "5m": { timeframe: "minute", aggregate: 5, seconds: 300, dex: "5m" },
  "15m": { timeframe: "minute", aggregate: 15, seconds: 900, dex: "15m" },
  "1h": { timeframe: "hour", aggregate: 1, seconds: 3600, dex: "1h" },
  "4h": { timeframe: "hour", aggregate: 4, seconds: 14400, dex: "1h" },
  "1d": { timeframe: "day", aggregate: 1, seconds: 86400, dex: "24h" },
} as const;
const HISTORY = 500;
const DEAD_AFTER_MS = 24 * 60 * 60_000;
const REFRESH_TIMEOUT_MS = 25_000;

export interface StoredPoolOhlcv {
  schemaVersion: 2;
  candles: PoolCandle[];
  base: GeckoTokenRef & { address: string };
  quote: GeckoTokenRef & { address: string };
  priceCurrency: PoolPriceCurrency;
  volumeCurrency: "usd" | "quote_token";
  volumeUnavailableReason: string | null;
  /** Optional additive quality evidence; conflicting revisions are never trading inputs. */
  quality?: { conflictingTimestamps: number[] };
}
export interface PoolOhlcvResult extends StoredPoolOhlcv {
  poolAddress: string;
  interval: KlineInterval;
  limit: number;
  source: string;
  asOf: number;
  staleness: Staleness;
}
export interface GetPoolOhlcvParams {
  poolAddress: string;
  interval: KlineInterval;
  limit: number;
  /** USD retains the old denomination; token is sorted-address base/quote. */
  currency?: PoolPriceCurrency;
  /** Explicit base token in either denomination; old chart keys stay unchanged. */
  tokenAddress?: string;
  qualityPolicy?: "trading-v2";
  onAttempt?: (attempt: OhlcvAttempt) => void;
  signal?: AbortSignal | undefined;
  /**
   * Unused since 2026-09-22: Sintral is now tried first for every
   * `currency: "usd"` + `token` request regardless of asset class (see
   * `refresh`'s `sintralInterval`), so this no longer changes source order.
   * Kept accepted (not removed) so `jobs/tradingFeatures.ts`'s call sites
   * don't need an unrelated signature change; safe to delete once nothing
   * sets it.
   */
  usEquity?: boolean;
}

// All limits share one history. Legacy charts have ambiguous denomination and
// are intentionally not imported into this namespace.
export function poolOhlcvKey(pool: string, interval: KlineInterval, _limit?: number, currency: PoolPriceCurrency = "usd", tokenAddress?: string, qualityPolicy?: "trading-v2"): string {
  return `pool:ohlcv:v2:${pool.toLowerCase()}:${interval}:${currency}${tokenAddress ? `:${tokenAddress.toLowerCase()}` : ""}${qualityPolicy ? ":trading-v2" : ""}`;
}
/**
 * Process-local concurrency cap on simultaneous upstream refreshes, separate
 * from and unrelated to the `OhlcvTransport` per-minute budgets below. It
 * exists only so one caller firing many `getPoolOhlcv` calls at once can't
 * pile up unbounded in-flight promises; it does not itself protect any real
 * upstream limit. Handoff §9 (2026-09-22, measured live): at the old value of
 * 4, this was the dominant cause of `admission_limit` denials once the
 * trading-features watchlist grew past ~10 pools — most of a job cycle's own
 * admissions (`DUE_PER_CYCLE`, `jobs/tradingFeatures.ts`) were discarded here
 * before ever reaching the transport budget check. Kept 1:1 with that
 * constant on principle (§10, §12): 22 while `DUE_PER_CYCLE` was 22, back to
 * 40 alongside it in §12 once Sintral (§11) made a faster same-instant 15m
 * rotation both necessary (measured 15-19 min of `stale_input` at 5/cycle)
 * and affordable (Sintral's own real ceiling is a 6-concurrent semaphore, not
 * a per-minute budget). Shared by every caller of `getPoolOhlcv`, not just
 * that one job; headroom here costs nothing on its own — the transport
 * budgets below remain the real ceiling for the Gecko/DexPaprika path.
 */
const MAX_IN_FLIGHT_REFRESHES = 40;
class Runtime {
  readonly transport: OhlcvTransport;
  readonly inFlight = new Map<string, Promise<DataRecord<StoredPoolOhlcv> | null>>();
  readonly stats = { cacheHits: 0, coalesced: 0, refreshes: 0, staleServed: 0, unavailable: 0, admissionDenied: 0 };
  constructor(readonly store: SnapshotStore) { this.transport = new OhlcvTransport(store); }
}
const runtimes = new WeakMap<SnapshotStore, Runtime>();
function runtime(store: SnapshotStore): Runtime {
  let result = runtimes.get(store);
  if (!result) { result = new Runtime(store); runtimes.set(store, result); }
  return result;
}
export function poolOhlcvDiagnostics(store: SnapshotStore) {
  const r = runtime(store);
  return { scope: "process", ...r.stats, inFlight: r.inFlight.size, providers: r.transport.counters };
}

export async function getPoolOhlcv(store: SnapshotStore, params: GetPoolOhlcvParams): Promise<PoolOhlcvResult | null> {
  const pool = params.poolAddress.toLowerCase();
  if (!isEvmAddress(pool) || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > HISTORY
    || !Object.hasOwn(INTERVALS, params.interval)) return null;
  const currency = params.currency ?? "usd";
  if (currency !== "usd" && currency !== "token") return null;
  const token = params.tokenAddress?.toLowerCase();
  if (token !== undefined && !isEvmAddress(token)) return null;
  const key = poolOhlcvKey(pool, params.interval, undefined, currency, token, params.qualityPolicy);
  const r = runtime(store);
  let record = await store.get<StoredPoolOhlcv>(key);
  if (!record && params.qualityPolicy) record = await store.get<StoredPoolOhlcv>(poolOhlcvKey(pool, params.interval, undefined, currency, token));
  if (record && record.data.schemaVersion !== 2) record = null;
  if (record?.staleness === "fresh" && chartStaleness(record, params.interval) === "fresh"
    && (!params.qualityPolicy || quality(record, params.interval).sufficient)) {
    r.stats.cacheHits++;
    params.onAttempt?.({source: record.source, reason: "cache_hit"});
  } else if (!params.signal?.aborted) {
    let flight = r.inFlight.get(key);
    if (flight) r.stats.coalesced++;
    else if (r.inFlight.size < MAX_IN_FLIGHT_REFRESHES) {
      flight = refresh(r, pool, params.interval, currency, key, record, token, params.qualityPolicy, params.onAttempt)
        .finally(() => { r.inFlight.delete(key); });
      r.inFlight.set(key, flight);
    } else { r.stats.admissionDenied++; params.onAttempt?.({source: "cache", reason: "admission_limit"}); }
    if (flight) record = await flight;
  }
  if (!record) { r.stats.unavailable++; return null; }
  const staleness = chartStaleness(record, params.interval);
  if (staleness !== "fresh") r.stats.staleServed++;
  return { ...record.data, candles: record.data.candles.slice(-params.limit), poolAddress: pool,
    interval: params.interval, limit: params.limit, source: record.source, asOf: record.asOf, staleness };
}

async function refresh(r: Runtime, pool: string, interval: KlineInterval, currency: PoolPriceCurrency,
  key: string, cached: DataRecord<StoredPoolOhlcv> | null, token?: string, policy?: "trading-v2",
  onAttempt?: (attempt: OhlcvAttempt) => void): Promise<DataRecord<StoredPoolOhlcv> | null> {
  // Shared 60s retry floor, including empty responses/failures. A client cannot
  // cause an unbounded retry loop on a cold or stale cache entry.
  // Fixed stripes bound control-table growth under arbitrary public addresses.
  // A rare collision defers a refresh; it can never return another pool's data.
  const stripe = createHash("sha256").update(key).digest().readUInt32BE(0) % 4096;
  if (!await r.store.acquireSchedulerLease(`ohlcv-refresh:${stripe}`, randomUUID(), 60_000)) {
    onAttempt?.({source: "cache", reason: "refresh_lease"}); return cached;
  }
  r.stats.refreshes++;
  // Shared work has its own deadline; one disconnected waiter cannot cancel it.
  const signal = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
  const mapping = INTERVALS[interval];
  const end = Math.floor(Date.now() / 1000 / mapping.seconds) * mapping.seconds;
  const start = end - HISTORY * mapping.seconds;
  // Widened 2026-09-22 (was: US-equity 15m/1h only, handoff §11): the
  // `token` HTTP param is now public (any caller can ask `/pools/:addr/ohlcv
  // ?token=`), and GeckoTerminal's plane-wide budget was already ~91% consumed
  // by the trading-features job alone (BUDGETS.geckoterminal=10,
  // ohlcvTransport.ts) before any UI chart competed for it -- live /status
  // measured 28 budgetDenied + 17 rateLimited + 27 cooldownDenied on Gecko in
  // one window, and 29 pool-ohlcv reads that came back `unavailable` because
  // it was the only source in the chain for a usd+token request. Sintral has
  // proven headroom (310 req/s live probe, no 429 anywhere) and, per the
  // `/klines` reorder the same day, is the cleaner series besides -- so any
  // usd+token request now tries it first, on every chart interval, not just
  // 15m/1h. GeckoTerminal/DexPaprika stay in the chain as the fallback either
  // way, so a token Sintral has never heard of (the overwhelming majority of
  // this plane's tokens) fails there fast and falls through exactly as before.
  const sintralInterval = currency === "usd" && token
    ? (interval === "1m" ? "1min" : interval === "5m" ? "5min" : interval === "15m" ? "15min"
      : interval === "1h" ? "1h" : null) : null;
  const sources = [
    ...(sintralInterval ? ["sintral" as const] : []),
    "geckoterminal" as const,
    ...(currency === "token" || sintralInterval ? ["dexpaprika" as const] : []),
  ];
  // Sintral has no on-chain pair to check `token` against, unlike the Gecko
  // branch's own "requested token is not in pool" guard below -- and that
  // guard only fires once a `cached` record already exists to compare against.
  // On a cold key, nothing has verified `token` is actually one of this
  // pool's two legs. Best-effort, no extra network call: if this pool already
  // has a `pool:<addr>` PancakeSwap snapshot (written by the pools lane/seed
  // set, not this path), require `token` to match one of its two sides before
  // ever trusting a Sintral answer for it. No snapshot yet -- proceed; this is
  // a same-origin, `x-dp-token`-gated API, not open to the public internet.
  if (sintralInterval && !cached) {
    const stats = await r.store.get<PoolStats>(poolKey(pool));
    if (stats && token !== stats.data.token0 && token !== stats.data.token1) {
      onAttempt?.({source: "cache", reason: "token_not_in_pool"});
      return cached;
    }
  }
  let best = cached;
  for (const source of sources) {
    try {
      signal.throwIfAborted();
      let data: StoredPoolOhlcv;
      if (source === "sintral") {
        // Sintral is token-level (no on-chain pair), unlike Gecko/DexPaprika:
        // no pool identity to derive base/quote from, so it can only serve a
        // request for this token's price, and only in USD (Binance's own
        // reference, not a ratio against any specific on-chain quote). The
        // quote reported below is a nominal USDT stand-in for provenance
        // display, not a claim that Sintral priced against that pool.
        // `token`/currency are already guaranteed by `sintralInterval` above.
        // 120, not the general HISTORY(500) constant above: the ruling's own
        // measured limit, matching the trading-features 120-bucket window
        // this exists to feed (query/tradingFeatures.ts's FEATURE_HISTORY,
        // not imported here to avoid a cycle -- that module imports types
        // from this one).
        const raw = await fetchSintralKlines({ address: token!, interval: sintralInterval!, limit: 120, signal });
        const candles: PoolCandle[] = raw.filter((c) => c.timestamp >= start * 1000 && c.timestamp < end * 1000 && c.timestamp % (mapping.seconds * 1000) === 0);
        data = { schemaVersion: 2, candles: candles.sort((a, b) => a.timestamp - b.timestamp),
          base: { address: token!, symbol: null, name: null }, quote: { address: USD_ANCHOR.address, symbol: USD_ANCHOR.symbol, name: null },
          priceCurrency: "usd", volumeCurrency: "usd", volumeUnavailableReason: null };
      } else if (source === "geckoterminal") {
        const raw = await fetchGeckoPoolOhlcv({ poolAddress: pool, timeframe: mapping.timeframe,
          aggregate: mapping.aggregate, limit: HISTORY + 1, currency, signal,
          ...(currency === "usd" && (token || cached) ? { token: token ?? cached!.data.base.address } : {}),
          fetchFn: r.transport.fetch(source) });
        if (!raw.base?.address || !raw.quote?.address || raw.base.address === raw.quote.address) throw new Error("missing pair identity");
        let pair: DexPair = { base: { ...raw.base, address: raw.base.address }, quote: { ...raw.quote, address: raw.quote.address } };
        if (token && currency === "usd") {
          if (token !== pair.base.address && token !== pair.quote.address) throw new Error("requested token is not in pool");
          // The provider prices the requested token in USD; metadata may retain
          // the native pool orientation. Swap identities only, never reciprocate USD.
          if (token === pair.quote.address) pair = { base: pair.quote, quote: pair.base };
        }
        data = normalizeChart(raw.candles, pair, currency, source, start * 1000, end * 1000, mapping.seconds * 1000, token);
      } else {
        const pairKey = `pool:ohlcv:dexpair:${pool}`;
        const storedPair = await r.store.get<DexPair>(pairKey);
        const pair = storedPair?.staleness === "fresh" ? storedPair.data : await fetchDexPair({ poolAddress: pool,
          signal, fetchFn: r.transport.fetch(source) });
        if (storedPair?.staleness !== "fresh") await r.store.put(pairKey, pair, {
          source, freshForMs: DEAD_AFTER_MS, deadAfterMs: DEAD_AFTER_MS * 30,
        });
        // Page by fixed time windows (not count of returned bars: inactive
        // periods are sparse). Failures discard the entire paging pass.
        const step = interval === "4h" ? 3600 : mapping.seconds;
        const all: PoolCandle[] = [];
        for (let pageEnd = end; pageEnd > start;) {
          // The API also caps each window at one year; 366 daily bars can
          // cross that bound in a non-leap year. Reserve one response slot
          // for an inclusive end boundary, which the adapter then discards.
          const pageStart = Math.max(start, pageEnd - 365 * step);
          all.push(...await fetchDexCandles({ poolAddress: pool, interval: mapping.dex,
            start: pageStart, end: pageEnd, limit: (pageEnd - pageStart) / step + 1,
            signal, fetchFn: r.transport.fetch(source) }));
          pageEnd = pageStart;
        }
        const bars = interval === "4h" ? aggregateCandles(all, mapping.seconds * 1000) : all;
        data = normalizeChart(bars, pair, currency, source, start * 1000, end * 1000, mapping.seconds * 1000, token);
      }
      if (data.candles.length === 0) { onAttempt?.({source, reason: "empty"}); continue; }
      if (cached && (data.base.address !== cached.data.base.address || data.quote.address !== cached.data.quote.address)) {
        throw new Error("pair identity changed");
      }
      if (policy) {
        const candidate: DataRecord<StoredPoolOhlcv> = {data, source, asOf: Date.now(), staleness: "fresh"};
        const score = quality(candidate, interval);
        onAttempt?.({source, reason: score.reason, contiguousBars: score.contiguous});
        if (score.fresh && (!best || better(candidate, best, interval))) best = candidate;
        if (best && quality(best, interval).sufficient) break;
        continue;
      }
      const latest = data.candles.at(-1)!.timestamp;
      if (cached && latest <= cached.data.candles.at(-1)!.timestamp) continue;
      if (end * 1000 - (latest + mapping.seconds * 1000) > Math.max(120_000, mapping.seconds * 1000)) continue;
      // Closed candles cannot advance before the next bucket closes. Reusing
      // live-kline TTLs would poll a daily chart every minute after 30 minutes.
      const nextClose = latest + mapping.seconds * 2000;
      await r.store.put(key, data, { source, freshForMs: Math.max(60_000, nextClose - Date.now()), deadAfterMs: DEAD_AFTER_MS });
      return await r.store.get<StoredPoolOhlcv>(key);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const reason = error instanceof AdapterError && error.status === 429 ? "rate_limited"
        : error instanceof AdapterError && error.status === 402 ? "quota_exhausted"
        : /cooling down/.test(message) ? "cooldown" : /budget exhausted/.test(message) ? "budget_exhausted"
        : /invalid candle|conflicting candle|invalid normalized/.test(message) ? "invalid_candles"
        : /identity|requested token/.test(message) ? "identity_mismatch" : "provider_error";
      onAttempt?.({source, reason});
      console.warn(`[pool-ohlcv] source=${source} failed: ${sanitizeMessage(error)}`);
    }
  }
  if (policy && best && best !== cached) {
    const latest = best.data.candles.at(-1)!.timestamp;
    await r.store.put(key, best.data, {source: best.source,
      freshForMs: Math.max(60_000, latest + mapping.seconds * 2000 - Date.now()), deadAfterMs: DEAD_AFTER_MS});
    return r.store.get<StoredPoolOhlcv>(key);
  }
  return cached;
}

function quality(record: DataRecord<StoredPoolOhlcv>, interval: KlineInterval) {
  return candleQuality(record.data.candles, record.data.quality?.conflictingTimestamps ?? [], INTERVALS[interval].seconds * 1000, record.asOf, Date.now());
}
function better(candidate: DataRecord<StoredPoolOhlcv>, previous: DataRecord<StoredPoolOhlcv>, interval: KlineInterval): boolean {
  const a = quality(candidate, interval), b = quality(previous, interval);
  if (a.fresh !== b.fresh) return a.fresh;
  if (a.supported !== b.supported) return a.supported > b.supported;
  if (a.close !== b.close) return a.close > b.close;
  return a.contiguous > b.contiguous;
}

export function normalizeChart(candles: PoolCandle[], pair: DexPair, currency: PoolPriceCurrency,
  source: "geckoterminal" | "dexpaprika", start: number, end: number, intervalMs: number, token?: string): StoredPoolOhlcv {
  if (token && token !== pair.base.address && token !== pair.quote.address) throw new Error("requested token is not in pool");
  // Both providers are requested in their native ratio orientation. Normalize
  // locally to the same target, including reciprocal high/low, before caching.
  const invert = currency === "token" && (token ? token !== pair.base.address : pair.base.address > pair.quote.address);
  const [base, quote] = invert ? [pair.quote, pair.base] : [pair.base, pair.quote];
  const unknownVolume = source === "dexpaprika" || invert;
  const byTime = new Map<number, PoolCandle>();
  const conflicts = new Set<number>();
  for (const candle of candles) {
    if (candle.timestamp < start || candle.timestamp >= end || candle.timestamp % intervalMs !== 0) continue;
    const bar: PoolCandle = { ...candle, volume: unknownVolume ? null : candle.volume };
    if (invert) Object.assign(bar, { open: 1 / candle.open, high: 1 / candle.low,
      low: 1 / candle.high, close: 1 / candle.close });
    if (![bar.open, bar.high, bar.low, bar.close].every((v) => Number.isFinite(v) && v > 0)) throw new Error("invalid normalized price");
    const previous = byTime.get(bar.timestamp);
    if (previous && ["open", "high", "low", "close", "volume"].some((field) =>
      previous[field as keyof PoolCandle] !== bar[field as keyof PoolCandle])) conflicts.add(bar.timestamp);
    byTime.set(bar.timestamp, bar);
  }
  return { schemaVersion: 2, candles: [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-HISTORY),
    base, quote, quality: { conflictingTimestamps: [...conflicts].sort((a, b) => a - b) },
    priceCurrency: currency, volumeCurrency: currency === "usd" ? "usd" : "quote_token",
    volumeUnavailableReason: source === "dexpaprika" ? "provider_volume_unit_unverified"
      : invert ? "cannot_exactly_convert_volume_after_price_inversion" : null };
}

export function aggregateCandles(candles: PoolCandle[], intervalMs: number): PoolCandle[] {
  const result = new Map<number, PoolCandle>();
  for (const row of [...candles].sort((a, b) => a.timestamp - b.timestamp)) {
    const time = Math.floor(row.timestamp / intervalMs) * intervalMs;
    const existing = result.get(time);
    if (!existing) result.set(time, { ...row, timestamp: time });
    else { existing.high = Math.max(existing.high, row.high); existing.low = Math.min(existing.low, row.low);
      existing.close = row.close;
      existing.volume = existing.volume === null || row.volume === null ? null : existing.volume + row.volume; }
  }
  return [...result.values()];
}

function chartStaleness(record: DataRecord<StoredPoolOhlcv>, interval: KlineInterval): Staleness {
  const lastEnd = (record.data.candles.at(-1)?.timestamp ?? 0) + INTERVALS[interval].seconds * 1000;
  const age = Date.now() - lastEnd;
  if (record.staleness === "dead" || age >= Math.max(DEAD_AFTER_MS, INTERVALS[interval].seconds * 2000)) return "dead";
  if (record.staleness === "stale" || age > Math.max(120_000, INTERVALS[interval].seconds * 1000)) return "stale";
  return "fresh";
}
