/**
 * `binance-prices` job — refreshes quotes for the tracked address set.
 *
 * The set comes from the `tracked:addresses` snapshot, which another process
 * (or an operator) writes; with none present it defaults to the whole eligible
 * allowlist unioned with the bStocks list, so the lane is never dark and every
 * allowlisted token gets a price (ALLOWLIST-PRICE-SPEC §2 items 1-2).
 * Concurrency is bounded inside the Binance adapter, and the fan-out is
 * additionally issued in batches here.
 */

import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import { fetchBinanceTokenQuote, isPlausiblePrice } from "../adapters/binanceWeb3.js";
import { normalizeAddress } from "../adapters/http.js";
import { loadAllowlist } from "../allowlist.js";
import { bstockAddresses } from "../universe.js";
import { mergeTokenIntoStore, readTokenSnapshot } from "./tokenStore.js";

export const BINANCE_PRICES_JOB = "binance-prices";

/** Store key holding the operator-controlled tracking set. */
export const TRACKED_ADDRESSES_KEY = "tracked:addresses";

/**
 * How many addresses one fan-out covers before the next batch is issued.
 *
 * The tracked set went from 25 addresses to the 221-address allowlist, and one
 * `Promise.allSettled` over all of them is a different shape of load on an
 * undocumented upstream (ALLOWLIST-PRICE-SPEC §2 item 2).
 */
export const PRICE_BATCH_SIZE = 25;

/**
 * Reads the tracked set, falling back to the eligible allowlist unioned with
 * the static bStocks list.
 *
 * The allowlist is the set the consumer filters by market cap, so anything left
 * out of it has no snapshot to filter (ALLOWLIST-PRICE-SPEC §2 item 1). An
 * unreadable allowlist falls back to bStocks alone rather than to nothing.
 */
export async function readTrackedAddresses(store: SnapshotStore): Promise<string[]> {
  const record = await store.get<unknown>(TRACKED_ADDRESSES_KEY);
  const raw: unknown = record === null ? [] : record.data;
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const addresses = [...new Set(list.map((value) => normalizeAddress(value)))].filter(
    (value): value is string => value !== null,
  );
  if (addresses.length > 0) return addresses;

  // Both sides are already lowercased — the allowlist loader normalizes, the
  // bStocks list is lowercase literals — so the Set dedupes them directly.
  const allowlist = loadAllowlist();
  const fallback = allowlist === null ? [] : [...allowlist.keys()];
  return [...new Set([...fallback, ...bstockAddresses()])];
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

  // Batched rather than one fan-out over the whole set, and never retried: a
  // miss is left for the next cycle (ALLOWLIST-PRICE-SPEC §2 item 2).
  for (let start = 0; start < addresses.length; start += PRICE_BATCH_SIZE) {
    const batch = addresses.slice(start, start + PRICE_BATCH_SIZE);
    const outcomes = await Promise.allSettled(
      batch.map(async (address) => {
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
  }

  // The throw stays, and it is the job's status line: all four counts ride on
  // it so a dark cycle says how many addresses it even tried
  // (ALLOWLIST-PRICE-SPEC §2 item 3).
  if (result.updated === 0 && result.attempted > 0) {
    throw new Error(
      `no tracked prices updated (attempted=${result.attempted} updated=${result.updated}` +
        ` rejected=${result.rejected} failed=${result.failed})`,
    );
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
