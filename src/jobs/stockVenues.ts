/**
 * `stock-venues` job — which AMM pools each tokenized stock trades in.
 *
 * Measured 2026-09-17: bStocks hold 83% of their AMM liquidity on PancakeSwap
 * v3 and 16% on Uniswap v3 (QQQB's Uniswap v3/USDC pool is larger than its
 * Pancake pool); Ondo is Pancake v3 almost entirely. Cross-venue spreads on the
 * same token reached 24 bps with >$2M on each side, so an arb agent needs the
 * venues named per token rather than assuming Pancake.
 *
 * Discovery is DexScreener (keyless, one call per token, 300/min). The chain
 * is used only for what DexScreener does not carry: the v3 fee tier, read
 * from the pool itself, which doubles as verification that a pool labelled v3
 * really is one. Pancake v3 and Uniswap v3 share the ABI.
 *
 * The sweep rotates: 75 tokens per cycle, one cycle a minute, so 488 tokens
 * are re-read every ~7 minutes — the cadence liquidity needs; venue existence
 * changes on the order of weeks. Fails open per token: a token whose read
 * failed keeps its previous venues and its previous `sweptAt`, so the age is
 * visible; a cycle that reads nothing throws without republishing.
 */

import type { Abi } from "viem";
import type { RwaToken, Venue } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import { isContractLevelFailure, withBscClient } from "../chain/rpc.js";
import { DEXSCREENER_MAX_PER_MINUTE, fetchDexScreenerTokenPairs, type DexPair } from "../adapters/dexScreener.js";
import type { FetchFn } from "../adapters/http.js";
import { MAJOR_TOKENS } from "./majorsPrices.js";
import { bstocksUniverse, RWA_UNIVERSE_KEY, RWA_VENUES_KEY } from "../universe.js";
import type { RwaUniverseSnapshot } from "./binanceRwa.js";

export const STOCK_VENUES_JOB = "stock-venues";
export const STOCK_VENUES_SOURCE = "dexscreener+chain";

export const VENUES_FRESH_FOR_MS = 15 * 60_000;
export const VENUES_DEAD_AFTER_MS = 24 * 60 * 60_000;

/**
 * Tokens read per cycle. Measured 2026-09-17 from a residential connection:
 * 100 tokens took 31.7 s (DexScreener answers in ~300 ms, not the 210 ms
 * floor, plus one multicall for fee tiers). 75 keeps a cycle near 25 s
 * against the 60 s timeout, and a full 488-token sweep still lands every ~7
 * minutes.
 */
export const VENUES_PER_CYCLE = 75;
/** ≥ 210 ms between DexScreener calls keeps one process under 300/min. */
export const VENUES_MIN_SPACING_MS = Math.ceil(60_000 / DEXSCREENER_MAX_PER_MINUTE) + 10;

/** DEXes that count as venues. Everything else (Topaz, Flap) is dust on stock tokens. */
const VENUE_DEXES = new Set<Venue["dex"]>(["pancakeswap", "uniswap"]);

/**
 * Quotes that make a pair a venue for the stock. CAKE is a major elsewhere in
 * the plane but not a quote anyone prices equities in.
 */
const QUOTE_ADDRESSES = new Set(
  MAJOR_TOKENS.filter((t) => t.symbol !== "CAKE").map((t) => t.address),
);

/** The stored payload under {@link RWA_VENUES_KEY}. */
export interface VenuesSnapshot {
  byAddress: Record<string, Venue[]>;
  /** Epoch ms of each token's last successful read. */
  sweptAt: Record<string, number>;
  /** Last address processed; the next cycle starts after it. */
  cursor: string | null;
  /**
   * Pools DexScreener labelled v3 that the chain said are not v3 contracts,
   * with when that was learned. Remembered so the dud is not re-asked every
   * sweep; a pool cannot become a v3 pool later.
   */
  rejected?: Record<string, number>;
}

export type FeeOutcome = number | "not-a-pool" | null;

export interface RunStockVenuesOptions {
  fetchFn?: FetchFn | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  /** Test hook. Default reads `fee()` on each pool through the BSC RPC rotation. */
  readFees?: ((pools: string[], signal: AbortSignal) => Promise<Map<string, FeeOutcome>>) | undefined;
  perCycle?: number | undefined;
}

export interface StockVenuesCycle {
  /** Tokens attempted this cycle. */
  swept: number;
  /** Tokens whose DexScreener read failed (previous venues kept). */
  failed: number;
  /** Venues in the published snapshot, all tokens. */
  venues: number;
  /** v3 fee tiers read from the chain this cycle. */
  feesRead: number;
  cursor: string | null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const POOL_FEE_ABI = [
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
] as const satisfies Abi;

/**
 * `fee()` on each pool, issued in one tick so viem's multicall folds them. A
 * revert or `0x` means "not a v3 pool" and is an answer; a transport failure
 * is not, and rotates to the next endpoint. Pools left unanswered map to
 * `null`, never to a guessed tier.
 */
export async function readPoolFeesOnChain(
  pools: string[],
  signal: AbortSignal,
): Promise<Map<string, FeeOutcome>> {
  if (pools.length === 0) return new Map();
  try {
    return await withBscClient(
      async (client) => {
        const settled = await Promise.allSettled(
          pools.map((pool) =>
            client.readContract({ address: pool as `0x${string}`, abi: POOL_FEE_ABI, functionName: "fee" }),
          ),
        );
        const out = new Map<string, FeeOutcome>();
        let transportFailure: unknown = null;
        settled.forEach((result, i) => {
          const pool = pools[i]!;
          if (result.status === "fulfilled") out.set(pool, Number(result.value));
          else if (isContractLevelFailure(result.reason)) out.set(pool, "not-a-pool");
          else transportFailure ??= result.reason;
        });
        if (out.size === 0 && transportFailure !== null) throw transportFailure;
        return out;
      },
      { signal },
    );
  } catch {
    return new Map();
  }
}

/** Exported for tests: the venue filter, applied to one token's pairs. */
export function selectVenuePairs(
  token: string,
  pairs: DexPair[],
  rwaAddresses: Set<string>,
): Array<DexPair & { version: "v2" | "v3"; dex: Venue["dex"] }> {
  const out: Array<DexPair & { version: "v2" | "v3"; dex: Venue["dex"] }> = [];
  for (const pair of pairs) {
    if (pair.base.address !== token) continue; // the stock as a memecoin's quote is not a venue
    if (!VENUE_DEXES.has(pair.dex as Venue["dex"])) continue;
    if (!QUOTE_ADDRESSES.has(pair.quote.address) && !rwaAddresses.has(pair.quote.address)) continue;
    // DexScreener labels Pancake pools `v2`/`v3` and Uniswap v2 pools `v2`,
    // but leaves Uniswap v3 pools unlabelled (measured: every unlabelled
    // `uniswap` pair answered `fee()` on chain). The chain read confirms it.
    const version = pair.version ?? (pair.dex === "uniswap" ? "v3" : null);
    if (version !== "v2" && version !== "v3") continue;
    out.push({ ...pair, version, dex: pair.dex as Venue["dex"] });
  }
  return out;
}

async function readAddressUniverse(store: SnapshotStore): Promise<{ addresses: string[]; source: string }> {
  const record = await store.get<RwaUniverseSnapshot>(RWA_UNIVERSE_KEY);
  const rows: RwaToken[] = Array.isArray(record?.data?.rows) ? record.data.rows : [];
  if (rows.length > 0) {
    const addresses = [...new Set(rows.map((r) => r.address))].sort();
    return { addresses, source: "universe:rwa" };
  }
  // Without the Binance list the static bStocks are still worth sweeping.
  return { addresses: bstocksUniverse().map((e) => e.address).sort(), source: "static" };
}

/** Runs one cycle. Exported so tests and scripts can drive it directly. */
export async function runStockVenues(
  store: SnapshotStore,
  signal: AbortSignal,
  options: RunStockVenuesOptions = {},
): Promise<StockVenuesCycle> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const readFees = options.readFees ?? readPoolFeesOnChain;
  const perCycle = options.perCycle ?? VENUES_PER_CYCLE;

  const previous = (await store.get<VenuesSnapshot>(RWA_VENUES_KEY))?.data;
  const byAddress: Record<string, Venue[]> = { ...(previous?.byAddress ?? {}) };
  const sweptAt: Record<string, number> = { ...(previous?.sweptAt ?? {}) };
  const cursor = previous?.cursor ?? null;
  const rejected: Record<string, number> = { ...(previous?.rejected ?? {}) };

  const { addresses } = await readAddressUniverse(store);
  if (addresses.length === 0) return { swept: 0, failed: 0, venues: 0, feesRead: 0, cursor };
  const rwaAddresses = new Set(addresses);

  // Rotate: continue after the cursor, wrap at the end.
  let start = cursor === null ? 0 : addresses.findIndex((a) => a > cursor);
  if (start < 0) start = 0;
  const batch: string[] = [];
  for (let i = 0; i < Math.min(perCycle, addresses.length); i++) batch.push(addresses[(start + i) % addresses.length]!);

  const pairsByToken = new Map<string, DexPair[]>();
  let failed = 0;
  let lastAt = 0;
  // The cursor must follow what was *attempted*, not what was planned: an
  // abort mid-batch otherwise skips the unread tail for a whole rotation.
  let lastAttempted: string | null = null;
  for (const address of batch) {
    if (signal.aborted) break;
    lastAttempted = address;
    const wait = VENUES_MIN_SPACING_MS - (now() - lastAt);
    if (lastAt !== 0 && wait > 0) await sleep(wait);
    lastAt = now();
    try {
      pairsByToken.set(address, await fetchDexScreenerTokenPairs({ address, signal, fetchFn: options.fetchFn }));
    } catch {
      failed++;
    }
  }
  if (pairsByToken.size === 0) {
    throw new Error(`no venue reads succeeded (${failed} of ${batch.length} failed)`);
  }

  // Fee tiers are immutable: only pools not already resolved go to the chain.
  const known = new Map<string, number>();
  for (const venues of Object.values(byAddress)) {
    for (const v of venues) if (v.feeTier !== null) known.set(v.pool, v.feeTier);
  }
  const selected = new Map<string, ReturnType<typeof selectVenuePairs>>();
  const unresolved = new Set<string>();
  for (const [address, pairs] of pairsByToken) {
    const chosen = selectVenuePairs(address, pairs, rwaAddresses);
    selected.set(address, chosen);
    for (const pair of chosen) {
      if (pair.version === "v3" && !known.has(pair.pool) && rejected[pair.pool] === undefined) unresolved.add(pair.pool);
    }
  }
  const fees = unresolved.size === 0 ? new Map<string, FeeOutcome>() : await readFees([...unresolved], signal);

  const readAt = now();
  let feesRead = 0;
  for (const [address, chosen] of selected) {
    const venues: Venue[] = [];
    for (const pair of chosen) {
      let feeTier: number | null = null;
      if (pair.version === "v3") {
        if (rejected[pair.pool] !== undefined) continue;
        const fee = known.get(pair.pool) ?? fees.get(pair.pool) ?? null;
        if (fee === "not-a-pool") {
          rejected[pair.pool] = readAt; // labelled v3, is not one — drop and remember
          continue;
        }
        if (fee !== null && !known.has(pair.pool)) feesRead++;
        feeTier = fee;
      }
      venues.push({
        dex: pair.dex,
        version: pair.version,
        pool: pair.pool,
        feeTier,
        quote: pair.quote,
        priceUsd: pair.priceUsd,
        liquidityUsd: pair.liquidityUsd,
        volume24hUsd: pair.volume24hUsd,
        asOf: readAt,
      });
    }
    venues.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
    byAddress[address] = venues;
    sweptAt[address] = readAt;
  }

  const snapshot: VenuesSnapshot = { byAddress, sweptAt, cursor: lastAttempted ?? cursor, rejected };
  await store.put(RWA_VENUES_KEY, snapshot, {
    source: STOCK_VENUES_SOURCE,
    freshForMs: VENUES_FRESH_FOR_MS,
    deadAfterMs: VENUES_DEAD_AFTER_MS,
  });

  return {
    swept: pairsByToken.size + failed,
    failed,
    venues: Object.values(byAddress).reduce((n, v) => n + v.length, 0),
    feesRead,
    cursor: snapshot.cursor,
  };
}

/** Job registration for the scheduler. */
export function stockVenuesJob(store: SnapshotStore): JobSpec {
  return {
    name: STOCK_VENUES_JOB,
    intervalMs: 60_000,
    jitterMs: 5_000,
    timeoutMs: 60_000,
    run: async (signal) => {
      const result = await runStockVenues(store, signal);
      if (result.failed > 0) {
        console.warn(`[${STOCK_VENUES_JOB}] ${result.failed} of ${result.swept} token reads failed; previous venues kept`);
      }
    },
  };
}
