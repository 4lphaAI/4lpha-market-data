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

import type { RwaToken, TokenSnapshot, Venue } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import { BINANCE_RWA_SOURCE, fetchRwaTokens } from "../adapters/binanceRwa.js";
import type { FetchFn } from "../adapters/http.js";
import { normalizeAddress } from "../adapters/http.js";
import { RWA_MEMBERS_KEY, RWA_UNIVERSE_KEY, RWA_VENUES_KEY } from "../universe.js";
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

/**
 * Membership outlives the snapshot: `rwa:members` remembers every address ever
 * seen in an RWA list so the eligibility gate can still veto a stock when the
 * snapshot is stale or absent. Merged every cycle, never shrunk — a token that
 * Binance delists is still a stock, and the gate answers `rwa_stale` for it
 * rather than letting it regain allowlist eligibility. Same TTLs as the
 * launchpad-origin cache, for the same "this is a fact, not a reading" reason.
 */
export interface RwaMembers {
  [address: string]: { platform: string; lastSeenAt: number };
}
export const RWA_MEMBERS_FRESH_FOR_MS = 30 * 24 * 60 * 60_000;
export const RWA_MEMBERS_DEAD_AFTER_MS = 365 * 24 * 60 * 60_000;

/** Re-validated on read; a malformed entry is dropped rather than trusted. */
export function normalizeRwaMembers(data: unknown): RwaMembers {
  const out: RwaMembers = {};
  if (typeof data !== "object" || data === null) return out;
  for (const [raw, value] of Object.entries(data as Record<string, unknown>)) {
    const address = normalizeAddress(raw);
    if (address === null || typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    if (typeof v["platform"] !== "string" || typeof v["lastSeenAt"] !== "number") continue;
    out[address] = { platform: v["platform"], lastSeenAt: v["lastSeenAt"] };
  }
  return out;
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

  // Membership is merged, never replaced (see RwaMembers).
  const now = Date.now();
  const previousMembers = normalizeRwaMembers((await store.get<unknown>(RWA_MEMBERS_KEY))?.data);
  const members: RwaMembers = { ...previousMembers };
  for (const token of tokens) members[token.address] = { platform: token.platform, lastSeenAt: now };
  await store.put(RWA_MEMBERS_KEY, members, {
    source: BINANCE_RWA_SOURCE,
    freshForMs: RWA_MEMBERS_FRESH_FOR_MS,
    deadAfterMs: RWA_MEMBERS_DEAD_AFTER_MS,
  });

  // The token surface gets the documented price. `volume24H` is the
  // underlying equity's exchange volume and is deliberately not written to
  // `volume24hUsd` — SPYB would otherwise report SPY's ~$44B as on-chain volume.
  // On-chain volume is the deepest venue's, when the sweep has one.
  const venueVolume = await readDeepestVenueVolume(store);
  let priced = 0;
  for (const token of tokens) {
    if (signal.aborted) break;
    if (token.tokenPriceUsd === null) continue;
    const incoming: TokenSnapshot = {
      address: token.address,
      priceUsd: token.tokenPriceUsd,
      marketCapUsd: token.underlyingMarketCapUsd,
      volume24hUsd: venueVolume.get(token.address) ?? null,
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

/** Deepest venue's 24h volume per token, from the `stock-venues` snapshot; empty when unswept. */
async function readDeepestVenueVolume(store: SnapshotStore): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const record = await store.get<unknown>(RWA_VENUES_KEY);
  if (record === null || typeof record.data !== "object" || record.data === null) return out;
  const byAddress = (record.data as Record<string, unknown>)["byAddress"];
  if (typeof byAddress !== "object" || byAddress === null) return out;
  for (const [raw, venues] of Object.entries(byAddress as Record<string, unknown>)) {
    const address = normalizeAddress(raw);
    if (address === null || !Array.isArray(venues)) continue;
    let best: Venue | null = null;
    for (const v of venues as Venue[]) {
      if (typeof v !== "object" || v === null) continue;
      if (best === null || (v.liquidityUsd ?? 0) > (best.liquidityUsd ?? 0)) best = v;
    }
    if (best !== null && typeof best.volume24hUsd === "number" && Number.isFinite(best.volume24hUsd)) {
      out.set(address, best.volume24hUsd);
    }
  }
  return out;
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
