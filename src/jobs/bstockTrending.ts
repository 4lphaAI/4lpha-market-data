/**
 * `bstock-trending` job — the Binance RWA "trending" tab, read once a day.
 *
 * Wakes hourly but calls Binance only when no read has landed since the last
 * 14:00 UTC mark (see `trendingScanDue`), so a normal day costs one signed
 * request on the key the Flash proxy also needs. The fixed sector baskets are
 * a frozen file and cost nothing (see `query/bstockSectors.ts`).
 *
 * Fails open like the other RWA lanes: an error keeps the previous list, which
 * ages to `dead` after three days and then stops labelling.
 */

import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import { BINANCE_RWA_SOURCE, fetchRwaTokens } from "../adapters/binanceRwa.js";
import type { FetchFn } from "../adapters/http.js";
import {
  MAX_SECTOR_ROWS,
  TRENDING_DEAD_AFTER_MS,
  TRENDING_FRESH_FOR_MS,
  TRENDING_KEY,
  TRENDING_TAB,
  trendingScanDue,
  type TrendingSnapshot,
} from "../query/bstockSectors.js";

export const BSTOCK_TRENDING_JOB = "bstock-trending";

export interface RunBstockTrendingOptions {
  fetchFn?: FetchFn | undefined;
  now?: number | undefined;
}

export type BstockTrendingCycle = { scanned: false } | { scanned: true; tickers: number; rows: number };

/** Runs one cycle. Exported so tests and scripts can drive it directly. */
export async function runBstockTrending(
  store: SnapshotStore,
  signal: AbortSignal,
  options: RunBstockTrendingOptions = {},
): Promise<BstockTrendingCycle> {
  const now = options.now ?? Date.now();
  const previous = await store.get<unknown>(TRENDING_KEY);
  if (!trendingScanDue(previous?.asOf ?? null, now)) return { scanned: false };

  const { tokens } = await fetchRwaTokens({ tabId: TRENDING_TAB.tabId, signal, fetchFn: options.fetchFn });
  // Zero rows is an outage; the full list means the tab id stopped being a
  // filter. Either way the previous list is better than a wrong one.
  if (tokens.length === 0) throw new Error(`trending tab ${TRENDING_TAB.tabId} returned no rows`);
  if (tokens.length > MAX_SECTOR_ROWS) {
    throw new Error(`trending tab ${TRENDING_TAB.tabId} returned ${tokens.length} rows — no longer a sector filter?`);
  }

  // Tickers, not addresses: the tab names the Ondo token when both issuers
  // list a stock, and the labels are matched to bStocks by ticker on read.
  const tickers = [...new Set(tokens.flatMap((t) => (t.underlyingTicker === null ? [] : [t.underlyingTicker.toUpperCase()])))];
  const snapshot: TrendingSnapshot = { tabId: TRENDING_TAB.tabId, tickers };
  await store.put(TRENDING_KEY, snapshot, {
    source: BINANCE_RWA_SOURCE,
    freshForMs: TRENDING_FRESH_FOR_MS,
    deadAfterMs: TRENDING_DEAD_AFTER_MS,
  });
  return { scanned: true, tickers: tickers.length, rows: tokens.length };
}

/** Job registration for the scheduler. */
export function bstockTrendingJob(store: SnapshotStore): JobSpec {
  return {
    name: BSTOCK_TRENDING_JOB,
    intervalMs: 60 * 60_000,
    jitterMs: 60_000,
    timeoutMs: 20_000,
    run: async (signal) => {
      const result = await runBstockTrending(store, signal);
      if (result.scanned) console.log(`[${BSTOCK_TRENDING_JOB}] ${result.tickers} tickers trending (${result.rows} rows)`);
    },
  };
}
