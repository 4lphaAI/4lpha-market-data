/** Read-through exact-pool OHLCV query backed by GeckoTerminal. */

import { fetchGeckoPoolOhlcv, type GeckoTokenRef } from "../adapters/geckoTerminal.js";
import { isEvmAddress } from "../adapters/http.js";
import type { Candle } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { Staleness } from "../core/types.js";
import { klineFreshForMs, type KlineInterval } from "./klines.js";

interface ProviderInterval {
  timeframe: "minute" | "hour" | "day";
  aggregate: number;
}

const INTERVALS: Record<KlineInterval, ProviderInterval> = {
  "1m": { timeframe: "minute", aggregate: 1 },
  "5m": { timeframe: "minute", aggregate: 5 },
  "15m": { timeframe: "minute", aggregate: 15 },
  "1h": { timeframe: "hour", aggregate: 1 },
  "4h": { timeframe: "hour", aggregate: 4 },
  "1d": { timeframe: "day", aggregate: 1 },
};

const DEAD_AFTER_MS = 24 * 60 * 60_000;

interface StoredPoolOhlcv {
  candles: Candle[];
  base: GeckoTokenRef | null;
  quote: GeckoTokenRef | null;
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
  signal?: AbortSignal | undefined;
}

export function poolOhlcvKey(
  poolAddress: string,
  interval: KlineInterval,
  limit: number,
): string {
  return `pool:ohlcv:${poolAddress.toLowerCase()}:${interval}:${limit}`;
}

/** Returns a fresh exact-pool chart, or the last stored chart when upstream fails. */
export async function getPoolOhlcv(
  store: SnapshotStore,
  params: GetPoolOhlcvParams,
): Promise<PoolOhlcvResult | null> {
  const poolAddress = params.poolAddress.toLowerCase();
  if (!isEvmAddress(poolAddress)) return null;

  const limit = Math.max(1, Math.min(Math.trunc(params.limit), 500));
  const key = poolOhlcvKey(poolAddress, params.interval, limit);
  const cached = await store.get<StoredPoolOhlcv>(key);
  if (cached !== null && cached.staleness === "fresh") {
    return resultFromRecord(poolAddress, params.interval, limit, cached);
  }

  const mapping = INTERVALS[params.interval];
  try {
    const fetched = await fetchGeckoPoolOhlcv({
      poolAddress,
      timeframe: mapping.timeframe,
      aggregate: mapping.aggregate,
      limit,
      signal: params.signal,
    });
    if (fetched.candles.length > 0) {
      await store.put(key, fetched, {
        source: "geckoterminal",
        freshForMs: klineFreshForMs(params.interval),
        deadAfterMs: DEAD_AFTER_MS,
      });
      const written = await store.get<StoredPoolOhlcv>(key);
      return {
        poolAddress,
        interval: params.interval,
        limit,
        candles: fetched.candles,
        base: fetched.base,
        quote: fetched.quote,
        source: "geckoterminal",
        asOf: written?.asOf ?? Date.now(),
        staleness: written?.staleness ?? "fresh",
      };
    }
  } catch (error) {
    console.warn(`[pool-ohlcv] source=geckoterminal failed: ${describe(error)}`);
  }

  return cached === null ? null : resultFromRecord(poolAddress, params.interval, limit, cached);
}

function resultFromRecord(
  poolAddress: string,
  interval: KlineInterval,
  limit: number,
  record: Awaited<ReturnType<SnapshotStore["get"]>> & {
    data: StoredPoolOhlcv;
  },
): PoolOhlcvResult {
  return {
    poolAddress,
    interval,
    limit,
    candles: record.data.candles,
    base: record.data.base,
    quote: record.data.quote,
    source: record.source,
    asOf: record.asOf,
    staleness: record.staleness,
  };
}

function describe(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "unknown error";
}
