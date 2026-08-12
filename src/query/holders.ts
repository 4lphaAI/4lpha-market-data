/**
 * Read-through holder / smart-money query layer.
 *
 * GMGN is the only upstream here, and it is the one source this service must
 * treat as fragile: ~500ms answers, large payloads, and a per-IP burst limit
 * that escalates into a temporary IP ban. So nothing polls it — this layer is
 * called on demand, the two reads it needs are issued strictly in sequence, and
 * the result is cached hard. On upstream failure a previously stored record is
 * served stale rather than dropped: holder counts drift slowly, so an old
 * number beats none, and `staleness` tells the caller how much to trust it.
 * Fail-open like klines and security — this is telemetry, not a gate.
 */

import { mergeHolderStats, type HolderStats } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { Staleness } from "../core/types.js";
import { MissingCredentialsError, isEvmAddress } from "../adapters/http.js";
import { fetchGmgnSmartMoney, fetchGmgnTokenHolders } from "../adapters/gmgn.js";

const SOURCE = "holders";

/**
 * Cache windows, deliberately wider than every other read path: klines refresh
 * in 5 minutes, this in 15. Holder distribution moves on the hour, and every
 * cache miss costs up to three sequential GMGN round trips (~1.5s) against a
 * rate limit whose penalty is host-wide. A day-old record is still served —
 * stale, and labelled as such — because the alternative is nothing.
 */
export const HOLDERS_FRESH_FOR_MS = 15 * 60_000;
export const HOLDERS_DEAD_AFTER_MS = 24 * 60 * 60_000;

/** Store key for one token's holder stats. */
export function holdersKey(address: string): string {
  return `holders:${address.toLowerCase()}`;
}

export interface HolderResult {
  address: string;
  stats: HolderStats;
  asOf: number;
  staleness: Staleness;
}

/** Both GMGN reads, injectable so the fail-open paths are testable offline. */
export interface HolderFetchers {
  holders: (address: string, signal: AbortSignal | undefined) => Promise<HolderStats>;
  smartMoney: (address: string, signal: AbortSignal | undefined) => Promise<HolderStats>;
}

const liveFetchers: HolderFetchers = {
  holders: (address, signal) => fetchGmgnTokenHolders({ address, signal }),
  smartMoney: (address, signal) => fetchGmgnSmartMoney({ address, signal }),
};

export interface GetHoldersParams {
  address: string;
  signal?: AbortSignal | undefined;
  fetchers?: HolderFetchers | undefined;
}

/**
 * Serves holder stats for one token. Returns `null` only when the address is
 * malformed, or nothing is cached and the upstream contributed nothing.
 */
export async function getHolders(
  store: SnapshotStore,
  params: GetHoldersParams,
): Promise<HolderResult | null> {
  const address = params.address.toLowerCase();
  if (!isEvmAddress(address)) return null;

  const key = holdersKey(address);
  const cached = await store.get<HolderStats>(key);
  if (cached !== null && cached.staleness === "fresh") {
    return { address, stats: cached.data, asOf: cached.asOf, staleness: cached.staleness };
  }

  const fetchers = params.fetchers ?? liveFetchers;

  // Strictly sequential, never `Promise.all`: both reads land on the same GMGN
  // host, and a parallel pair is the single easiest way to trip its burst
  // limit — whose penalty is an IP ban on the whole host, not a failed call.
  // After a 429 the adapter's cooldown makes the second call fail instantly,
  // so the sequencing costs nothing in the failure case either.
  const holders = await attempt("holders", () => fetchers.holders(address, params.signal));
  const smart = await attempt("smart-money", () => fetchers.smartMoney(address, params.signal));

  // Partial answers still count: each read contributes only its own fields
  // (the adapter nulls the rest), so a merge cannot clobber one with the other.
  let stats: HolderStats | null = null;
  if (holders !== null) stats = holders;
  if (smart !== null) stats = stats === null ? smart : mergeHolderStats(stats, smart);

  if (stats !== null) {
    await store.put(key, stats, {
      source: stats.source,
      freshForMs: HOLDERS_FRESH_FOR_MS,
      deadAfterMs: HOLDERS_DEAD_AFTER_MS,
    });
    const written = await store.get<HolderStats>(key);
    return {
      address,
      stats,
      asOf: written?.asOf ?? Date.now(),
      staleness: written?.staleness ?? "fresh",
    };
  }

  // Upstream contributed nothing this round; a stale record beats no record.
  if (cached === null) return null;
  return { address, stats: cached.data, asOf: cached.asOf, staleness: cached.staleness };
}

async function attempt(
  label: string,
  fetch: () => Promise<HolderStats>,
): Promise<HolderStats | null> {
  try {
    return await fetch();
  } catch (error) {
    // A missing key is "source not configured", not an outage; either way this
    // read simply contributes nothing. Messages are sanitized by the adapter.
    if (!(error instanceof MissingCredentialsError)) {
      console.warn(`[${SOURCE}] read=${label} failed: ${describe(error)}`);
    }
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "unknown error";
}
