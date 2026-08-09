/**
 * `binance-universe` job — refreshes the coins lane from the Binance Alpha list.
 *
 * The list changes on the order of days, so this runs every six hours and its
 * snapshot stays usable for two days; the lane survives a long upstream outage.
 */

import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import { fetchBinanceAlphaUniverse } from "../adapters/binanceWeb3.js";
import { COINS_UNIVERSE_KEY } from "../universe.js";

export const BINANCE_UNIVERSE_JOB = "binance-universe";

export const COINS_FRESH_FOR_MS = 12 * 60 * 60_000;
export const COINS_DEAD_AFTER_MS = 48 * 60 * 60_000;

/** Runs one cycle. Exported so tests and the smoke script can drive it directly. */
export async function runBinanceUniverse(
  store: SnapshotStore,
  signal: AbortSignal,
): Promise<{ entries: number }> {
  const entries = await fetchBinanceAlphaUniverse({ signal });
  // An empty list is a shape change or an outage, not a real universe; keeping
  // the previous snapshot is strictly better than publishing nothing.
  if (entries.length === 0) {
    throw new Error("alpha token list returned no BSC entries");
  }

  await store.put(COINS_UNIVERSE_KEY, entries, {
    source: "binance",
    freshForMs: COINS_FRESH_FOR_MS,
    deadAfterMs: COINS_DEAD_AFTER_MS,
  });
  return { entries: entries.length };
}

/** Job registration for the scheduler. */
export function binanceUniverseJob(store: SnapshotStore): JobSpec {
  return {
    name: BINANCE_UNIVERSE_JOB,
    intervalMs: 6 * 60 * 60_000,
    jitterMs: 60_000,
    timeoutMs: 20_000,
    run: async (signal) => {
      await runBinanceUniverse(store, signal);
    },
  };
}
