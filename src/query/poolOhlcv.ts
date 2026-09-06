/** Exact-pool OHLCV: shared cache -> Gecko -> DexPaprika (ratios) -> old cache. */
import { createHash, randomUUID } from "node:crypto";
import { fetchGeckoPoolOhlcv, type GeckoTokenRef } from "../adapters/geckoTerminal.js";
import { fetchDexCandles, fetchDexPair, type DexPair } from "../adapters/dexPaprika.js";
import { OhlcvTransport } from "../adapters/ohlcvTransport.js";
import { isEvmAddress, sanitizeMessage } from "../adapters/http.js";
import type { Candle } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { DataRecord, Staleness } from "../core/types.js";
import type { KlineInterval } from "./klines.js";

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
  /** Optional explicit USD base for trading; old chart keys/contracts stay unchanged. */
  tokenAddress?: string;
  signal?: AbortSignal | undefined;
}

// All limits share one history. Legacy charts have ambiguous denomination and
// are intentionally not imported into this namespace.
export function poolOhlcvKey(pool: string, interval: KlineInterval, _limit?: number, currency: PoolPriceCurrency = "usd", tokenAddress?: string): string {
  return `pool:ohlcv:v2:${pool.toLowerCase()}:${interval}:${currency}${tokenAddress ? `:${tokenAddress.toLowerCase()}` : ""}`;
}
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
  if (token !== undefined && (!isEvmAddress(token) || currency !== "usd")) return null;
  const key = poolOhlcvKey(pool, params.interval, undefined, currency, token);
  const r = runtime(store);
  let record = await store.get<StoredPoolOhlcv>(key);
  if (record && record.data.schemaVersion !== 2) record = null;
  if (record?.staleness === "fresh" && chartStaleness(record, params.interval) === "fresh") {
    r.stats.cacheHits++;
  } else if (!params.signal?.aborted) {
    let flight = r.inFlight.get(key);
    if (flight) r.stats.coalesced++;
    else if (r.inFlight.size < 4) {
      flight = refresh(r, pool, params.interval, currency, key, record, token).finally(() => { r.inFlight.delete(key); });
      r.inFlight.set(key, flight);
    } else r.stats.admissionDenied++;
    if (flight) record = await flight;
  }
  if (!record) { r.stats.unavailable++; return null; }
  const staleness = chartStaleness(record, params.interval);
  if (staleness !== "fresh") r.stats.staleServed++;
  return { ...record.data, candles: record.data.candles.slice(-params.limit), poolAddress: pool,
    interval: params.interval, limit: params.limit, source: record.source, asOf: record.asOf, staleness };
}

async function refresh(r: Runtime, pool: string, interval: KlineInterval, currency: PoolPriceCurrency,
  key: string, cached: DataRecord<StoredPoolOhlcv> | null, token?: string): Promise<DataRecord<StoredPoolOhlcv> | null> {
  // Shared 60s retry floor, including empty responses/failures. A client cannot
  // cause an unbounded retry loop on a cold or stale cache entry.
  // Fixed stripes bound control-table growth under arbitrary public addresses.
  // A rare collision defers a refresh; it can never return another pool's data.
  const stripe = createHash("sha256").update(key).digest().readUInt32BE(0) % 4096;
  if (!await r.store.acquireSchedulerLease(`ohlcv-refresh:${stripe}`, randomUUID(), 60_000)) return cached;
  r.stats.refreshes++;
  // Shared work has its own deadline; one disconnected waiter cannot cancel it.
  const signal = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
  const mapping = INTERVALS[interval];
  const end = Math.floor(Date.now() / 1000 / mapping.seconds) * mapping.seconds;
  const start = end - HISTORY * mapping.seconds;
  const sources = currency === "token" ? ["geckoterminal", "dexpaprika"] as const : ["geckoterminal"] as const;
  for (const source of sources) {
    try {
      signal.throwIfAborted();
      let data: StoredPoolOhlcv;
      if (source === "geckoterminal") {
        const raw = await fetchGeckoPoolOhlcv({ poolAddress: pool, timeframe: mapping.timeframe,
          aggregate: mapping.aggregate, limit: HISTORY + 1, currency, signal,
          ...(token ? { token } : currency === "usd" && cached ? { token: cached.data.base.address } : {}),
          fetchFn: r.transport.fetch(source) });
        if (!raw.base?.address || !raw.quote?.address || raw.base.address === raw.quote.address) throw new Error("missing pair identity");
        let pair: DexPair = { base: { ...raw.base, address: raw.base.address }, quote: { ...raw.quote, address: raw.quote.address } };
        if (token) {
          if (token !== pair.base.address && token !== pair.quote.address) throw new Error("requested token is not in pool");
          // The provider prices the requested token in USD; metadata may retain
          // the native pool orientation. Swap identities only, never reciprocate USD.
          if (token === pair.quote.address) pair = { base: pair.quote, quote: pair.base };
        }
        data = normalizeChart(raw.candles, pair, currency, source, start * 1000, end * 1000, mapping.seconds * 1000);
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
        const all: Candle[] = [];
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
        data = normalizeChart(bars, pair, currency, source, start * 1000, end * 1000, mapping.seconds * 1000);
      }
      if (data.candles.length === 0) continue;
      if (cached && (data.base.address !== cached.data.base.address || data.quote.address !== cached.data.quote.address)) {
        throw new Error("pair identity changed");
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
      console.warn(`[pool-ohlcv] source=${source} failed: ${sanitizeMessage(error)}`);
    }
  }
  return cached;
}

export function normalizeChart(candles: Candle[], pair: DexPair, currency: PoolPriceCurrency,
  source: "geckoterminal" | "dexpaprika", start: number, end: number, intervalMs: number): StoredPoolOhlcv {
  const invert = currency === "token" && pair.base.address > pair.quote.address;
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

export function aggregateCandles(candles: Candle[], intervalMs: number): Candle[] {
  const result = new Map<number, Candle>();
  for (const row of [...candles].sort((a, b) => a.timestamp - b.timestamp)) {
    const time = Math.floor(row.timestamp / intervalMs) * intervalMs;
    const existing = result.get(time);
    if (!existing) result.set(time, { ...row, timestamp: time });
    else { existing.high = Math.max(existing.high, row.high); existing.low = Math.min(existing.low, row.low);
      existing.close = row.close; existing.volume += row.volume; }
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
