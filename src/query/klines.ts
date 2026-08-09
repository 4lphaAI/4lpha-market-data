/**
 * Read-through kline query layer.
 *
 * A read is served from the store when it is fresh. On a miss it walks the
 * source chain OnchainOS -> Sintral (Binance Web3) -> Birdeye, writes the first
 * success back, and returns it. If every source fails, a previously stored but
 * stale record is returned rather than nothing — a late chart beats no chart —
 * and the caller can see that from `staleness`.
 */

import type { Candle } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { Staleness } from "../core/types.js";
import { MissingCredentialsError, isEvmAddress } from "../adapters/http.js";
import { fetchOnchainosKlines } from "../adapters/onchainos.js";
import { fetchSintralKlines } from "../adapters/binanceWeb3.js";
import { fetchBirdeyeKlines } from "../adapters/birdeye.js";

/** Canonical interval notation used by this service's API. */
export type KlineInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

interface IntervalMapping {
  seconds: number;
  /** OKX/OnchainOS bar notation. */
  onchainos: string;
  /** Sintral kline-service notation. */
  sintral: string;
  /** Birdeye OHLCV `type` notation. */
  birdeye: string;
}

/**
 * The three upstreams each spell intervals differently; this is the single
 * place that translation happens.
 */
const INTERVALS: Record<KlineInterval, IntervalMapping> = {
  "1m": { seconds: 60, onchainos: "1m", sintral: "1min", birdeye: "1m" },
  "5m": { seconds: 300, onchainos: "5m", sintral: "5min", birdeye: "5m" },
  "15m": { seconds: 900, onchainos: "15m", sintral: "15min", birdeye: "15m" },
  "1h": { seconds: 3_600, onchainos: "1H", sintral: "1h", birdeye: "1H" },
  "4h": { seconds: 14_400, onchainos: "4H", sintral: "4h", birdeye: "4H" },
  "1d": { seconds: 86_400, onchainos: "1D", sintral: "1day", birdeye: "1D" },
};

/**
 * Narrows an arbitrary string to a supported interval. `Object.hasOwn` rather
 * than `in`, so inherited names like `toString` are not accepted as intervals.
 */
export function parseInterval(value: string | undefined): KlineInterval | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  return Object.hasOwn(INTERVALS, normalized) ? (normalized as KlineInterval) : null;
}

/** All supported intervals, for docs and validation messages. */
export const SUPPORTED_INTERVALS = Object.keys(INTERVALS) as KlineInterval[];

export const KLINES_FRESH_FOR_MS = 5 * 60_000;
export const KLINES_DEAD_AFTER_MS = 60 * 60_000;
export const MAX_KLINE_LIMIT = 500;

export interface GetKlinesParams {
  address: string;
  interval: KlineInterval;
  limit: number;
  signal?: AbortSignal | undefined;
}

export interface KlineResult {
  address: string;
  interval: KlineInterval;
  limit: number;
  candles: Candle[];
  /** Adapter that produced the candles, e.g. `onchainos`. */
  source: string;
  /** Epoch milliseconds at which the candles were captured. */
  asOf: number;
  staleness: Staleness;
}

/** Builds the store key for one (address, interval, limit) triple. */
export function klinesKey(address: string, interval: KlineInterval, limit: number): string {
  return `klines:${address.toLowerCase()}:${interval}:${limit}`;
}

interface Source {
  name: string;
  fetch: () => Promise<Candle[]>;
}

/**
 * Serves candles, preferring the store and falling back through the upstream
 * chain. Returns `null` only when nothing is cached and every source failed.
 */
export async function getKlines(
  store: SnapshotStore,
  params: GetKlinesParams,
): Promise<KlineResult | null> {
  const address = params.address.toLowerCase();
  if (!isEvmAddress(address)) return null;

  const limit = Math.max(1, Math.min(Math.trunc(params.limit), MAX_KLINE_LIMIT));
  const key = klinesKey(address, params.interval, limit);
  const cached = await store.get<Candle[]>(key);

  if (cached !== null && cached.staleness === "fresh") {
    return {
      address,
      interval: params.interval,
      limit,
      candles: cached.data,
      source: cached.source,
      asOf: cached.asOf,
      staleness: cached.staleness,
    };
  }

  const mapping = INTERVALS[params.interval];
  const toSec = Math.floor(Date.now() / 1000);
  // One extra bar of head-room so the window cannot clip the newest candle.
  const fromSec = Math.max(0, toSec - mapping.seconds * (limit + 1));

  const sources: Source[] = [
    {
      name: "onchainos",
      fetch: () =>
        fetchOnchainosKlines({
          address,
          bar: mapping.onchainos,
          limit,
          signal: params.signal,
        }),
    },
    {
      name: "sintral",
      fetch: () =>
        fetchSintralKlines({
          address,
          interval: mapping.sintral,
          limit,
          signal: params.signal,
        }),
    },
    {
      name: "birdeye",
      fetch: () =>
        fetchBirdeyeKlines({
          address,
          type: mapping.birdeye,
          from: fromSec,
          to: toSec,
          signal: params.signal,
        }),
    },
  ];

  for (const source of sources) {
    let candles: Candle[];
    try {
      candles = await source.fetch();
    } catch (error) {
      // A missing key is "source not configured", not an outage; either way the
      // chain simply moves on. Messages are already sanitized by the adapters.
      if (!(error instanceof MissingCredentialsError)) {
        console.warn(`[klines] source=${source.name} failed: ${describe(error)}`);
      }
      continue;
    }

    if (candles.length === 0) continue;
    const trimmed = candles.slice(-limit);
    await store.put(key, trimmed, {
      source: source.name,
      freshForMs: KLINES_FRESH_FOR_MS,
      deadAfterMs: KLINES_DEAD_AFTER_MS,
    });
    const written = await store.get<Candle[]>(key);
    return {
      address,
      interval: params.interval,
      limit,
      candles: trimmed,
      source: source.name,
      asOf: written?.asOf ?? Date.now(),
      staleness: written?.staleness ?? "fresh",
    };
  }

  if (cached === null) return null;
  return {
    address,
    interval: params.interval,
    limit,
    candles: cached.data,
    source: cached.source,
    asOf: cached.asOf,
    staleness: cached.staleness,
  };
}

function describe(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "unknown error";
}
