/**
 * `binance-prices` job — refreshes quotes for the tracked address set.
 *
 * The set comes from the `tracked:addresses` snapshot, which another process
 * (or an operator) writes; with none present it defaults to the bStocks list so
 * the lane is never dark. Concurrency is bounded inside the Binance adapter, so
 * every address can be dispatched at once here.
 */

import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import { fetchBinanceTokenQuote, isPlausiblePrice } from "../adapters/binanceWeb3.js";
import { normalizeAddress } from "../adapters/http.js";
import { bstockAddresses } from "../universe.js";
import { mergeTokenIntoStore, readTokenSnapshot } from "./tokenStore.js";

export const BINANCE_PRICES_JOB = "binance-prices";

/** Store key holding the operator-controlled tracking set. */
export const TRACKED_ADDRESSES_KEY = "tracked:addresses";

/** Reads the tracked set, falling back to the static bStocks list. */
export async function readTrackedAddresses(store: SnapshotStore): Promise<string[]> {
  const record = await store.get<unknown>(TRACKED_ADDRESSES_KEY);
  const raw: unknown = record === null ? [] : record.data;
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const addresses = [...new Set(list.map((value) => normalizeAddress(value)))].filter(
    (value): value is string => value !== null,
  );
  return addresses.length > 0 ? addresses : bstockAddresses();
}

export interface BinancePricesResult {
  attempted: number;
  updated: number;
  rejected: number;
  failed: number;
}

/** Runs one cycle. Exported so tests and the smoke script can drive it directly. */
export async function runBinancePrices(
  store: SnapshotStore,
  signal: AbortSignal,
): Promise<BinancePricesResult> {
  const addresses = await readTrackedAddresses(store);
  const result: BinancePricesResult = {
    attempted: addresses.length,
    updated: 0,
    rejected: 0,
    failed: 0,
  };

  const outcomes = await Promise.allSettled(
    addresses.map(async (address) => {
      const quote = await fetchBinanceTokenQuote({ address, signal });
      const existing = await readTokenSnapshot(store, address);

      // A glitched bapi price would otherwise be merged in and then defended by
      // the conservative merge rule, so it is dropped before the write.
      if (quote.priceUsd !== null && !isPlausiblePrice(existing?.priceUsd ?? null, quote.priceUsd)) {
        return "rejected" as const;
      }

      await mergeTokenIntoStore(store, "binance", quote);
      return "updated" as const;
    }),
  );

  for (const outcome of outcomes) {
    if (outcome.status === "rejected") result.failed += 1;
    else if (outcome.value === "rejected") result.rejected += 1;
    else result.updated += 1;
  }

  if (result.updated === 0 && result.attempted > 0) {
    throw new Error(`no tracked prices updated (failed=${result.failed} rejected=${result.rejected})`);
  }
  return result;
}

/** Job registration for the scheduler. */
export function binancePricesJob(store: SnapshotStore): JobSpec {
  return {
    name: BINANCE_PRICES_JOB,
    intervalMs: 60_000,
    jitterMs: 5_000,
    timeoutMs: 20_000,
    run: async (signal) => {
      await runBinancePrices(store, signal);
    },
  };
}
