/**
 * `binance-rwa` job — the tokenized-stock list from the Binance Web3 RWA API.
 *
 * One signed call per cycle (`/tokens?binanceChainId=56`, 488 rows measured)
 * is the whole product's Binance load: consumers read the snapshot, never the
 * API. Every row carries the on-chain price, the underlying's reference price
 * and the issuer's session state, so this one snapshot feeds the `bstocks` and
 * `ondo` lanes, the premium/discount signal, and (later) the halted-token rule
 * in the eligibility gate.
 *
 * Fails open like the other universe lanes: an upstream error keeps the last
 * snapshot, which ages through `stale` to `dead`; the lane read keeps serving
 * the static bStocks regardless. Nothing here ever writes an empty list.
 */

import type { RwaToken, TokenSnapshot } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import { BINANCE_RWA_SOURCE, fetchRwaTokens } from "../adapters/binanceRwa.js";
import type { FetchFn } from "../adapters/http.js";
import { RWA_UNIVERSE_KEY } from "../universe.js";
import { mergeTokenIntoStore } from "./tokenStore.js";

export const BINANCE_RWA_JOB = "binance-rwa";

/** Prices and session state move within minutes; the list itself within days. */
export const RWA_FRESH_FOR_MS = 5 * 60_000;
export const RWA_DEAD_AFTER_MS = 24 * 60 * 60_000;

/** The stored payload under {@link RWA_UNIVERSE_KEY}. */
export interface RwaUniverseSnapshot {
  rows: RwaToken[];
  byPlatform: Record<string, number>;
}

export interface RunBinanceRwaOptions {
  fetchFn?: FetchFn | undefined;
}

export interface BinanceRwaCycle {
  rows: number;
  byPlatform: Record<string, number>;
  /** Upstream rows the normalizer refused — a shape change is visible here. */
  dropped: number;
  /** Token snapshots that received a price. */
  priced: number;
}

/** Runs one cycle. Exported so tests and scripts can drive it directly. */
export async function runBinanceRwa(
  store: SnapshotStore,
  signal: AbortSignal,
  options: RunBinanceRwaOptions = {},
): Promise<BinanceRwaCycle> {
  const { tokens, dropped } = await fetchRwaTokens({ signal, fetchFn: options.fetchFn });
  // An empty list is an outage or a shape change, not a real universe; keeping
  // the previous snapshot is strictly better than publishing nothing.
  if (tokens.length === 0) throw new Error("rwa token list returned no BSC rows");

  const byPlatform: Record<string, number> = {};
  for (const token of tokens) byPlatform[token.platform] = (byPlatform[token.platform] ?? 0) + 1;

  const snapshot: RwaUniverseSnapshot = { rows: tokens, byPlatform };
  await store.put(RWA_UNIVERSE_KEY, snapshot, {
    source: BINANCE_RWA_SOURCE,
    freshForMs: RWA_FRESH_FOR_MS,
    deadAfterMs: RWA_DEAD_AFTER_MS,
  });

  // The token surface gets the documented price. `volume24H` is the
  // underlying equity's exchange volume and is deliberately not written to
  // `volume24hUsd` — SPYB would otherwise report SPY's ~$44B as on-chain volume.
  let priced = 0;
  for (const token of tokens) {
    if (signal.aborted) break;
    if (token.tokenPriceUsd === null) continue;
    const incoming: TokenSnapshot = {
      address: token.address,
      priceUsd: token.tokenPriceUsd,
      marketCapUsd: token.marketCapUsd,
      volume24hUsd: null,
      holders: null,
      priceChange24hPct: null,
      symbol: token.symbol,
      updatedFields: [],
    };
    await mergeTokenIntoStore(store, BINANCE_RWA_SOURCE, incoming);
    priced++;
  }

  return { rows: tokens.length, byPlatform, dropped, priced };
}

/** Job registration for the scheduler. */
export function binanceRwaJob(store: SnapshotStore): JobSpec {
  return {
    name: BINANCE_RWA_JOB,
    intervalMs: 60_000,
    jitterMs: 5_000,
    timeoutMs: 20_000,
    run: async (signal) => {
      const result = await runBinanceRwa(store, signal);
      if (result.dropped > 0) {
        console.warn(`[${BINANCE_RWA_JOB}] dropped ${result.dropped} unparseable rows of ${result.rows + result.dropped}`);
      }
    },
  };
}
