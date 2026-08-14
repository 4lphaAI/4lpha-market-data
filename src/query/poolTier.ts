/**
 * Pool classification — what the two tokens of a pool actually are.
 *
 * A pool on PancakeSwap is permissionless, so TVL, volume and APR are all
 * things anyone can manufacture: the lane's own top row by APR is routinely a
 * pool holding a few dollars, and the top row by volume is routinely a pair of
 * tokens quoting each other into a fabricated price. None of that can be
 * detected from the pool's own numbers, because the numbers are the thing being
 * faked. What cannot be faked is the provenance of the two tokens, and that is
 * what this module reports.
 *
 * Curated origins come from state the plane already holds: the frozen
 * eligible-token allowlist, the Binance Alpha snapshot, and PancakeSwap's own
 * token list. Launchpad origin comes from the chain, asked once per token and
 * then cached forever.
 *
 * That last part is the whole design. Launchpad membership was first taken from
 * the `universe:meme` and `universe:flap` lanes, which was wrong in a way worth
 * recording: those lanes are *leaderboards*. Every Four.Meme graduate with a
 * real V3 pool — TUT, Broccoli, AKE, BR — had long since dropped out of the top
 * 100 and came back labelled `core` off the allowlist instead, and one pool
 * measurably flipped between `degen` and `core` between two runs depending on
 * whether its token happened to be trending. A provenance label that moves with
 * a ranking is not provenance.
 *
 * Reading it from the launchpad contracts fixes that, and is affordable because
 * the answer never changes: a launchpad mints new contracts, it never adopts an
 * existing one, so both `fourmeme` and `none` are permanent. The cost is one
 * resolution per token for the life of the deployment — measured at 377 distinct
 * tokens across a full 500-pool lane — after which a cycle resolves only tokens
 * it has never seen.
 *
 * One deliberate limit remains, so it does not read later as a bug: the tier
 * says nothing about CAKE emissions. `farm.allocPoint` is on the record already
 * and answers a different question — what PancakeSwap funds, rather than what
 * the tokens are. A caller who wants both filters for both.
 */

import type { PoolStats, PoolTier } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import { type FetchFn, normalizeAddress, sanitizeMessage } from "../adapters/http.js";
import { fetchPancakeTokenList } from "../adapters/pancake.js";
import { type LaunchpadOrigin, loadAllowlist, resolveLaunchpadOrigins } from "./eligibility.js";
import { COINS_UNIVERSE_KEY } from "../universe.js";

/** Where a token came from, most specific first. */
export type TokenOrigin = "fourmeme" | "flap" | "allowlist" | "alpha" | "pancake-list" | "unknown";

/** Origins that mean somebody curated this token rather than merely minted it. */
const VETTED: TokenOrigin[] = ["allowlist", "alpha", "pancake-list"];

/** Origins that mean the token came off a bonding curve. */
const LAUNCHPAD: TokenOrigin[] = ["fourmeme", "flap"];

/** Store key holding the cached PancakeSwap Extended addresses. */
export const PANCAKE_TOKEN_LIST_KEY = "pancake:tokenlist";

/** Store key holding the permanent per-token launchpad verdicts. */
export const LAUNCHPAD_ORIGINS_KEY = "origins:launchpad";

/**
 * Provenance does not change, so this never needs refreshing. The window is
 * finite only so a verdict written by a buggy build eventually ages out rather
 * than outliving the bug forever.
 */
const ORIGINS_FRESH_FOR_MS = 30 * 24 * 60 * 60_000;
const ORIGINS_DEAD_AFTER_MS = 365 * 24 * 60 * 60_000;

/**
 * Tokens resolved per cycle, so a cold start converges over a few minutes
 * instead of in one long burst.
 *
 * The whole cache is written once, at the end of a resolution, so a pass the
 * job timeout aborts saves nothing and starts over. Measured cold, a full lane
 * is 376 unseen tokens and 12.5s locally — comfortably inside the 30s timeout
 * here, but this plane runs on a host where chain reads have measured several
 * times slower, and a pass that can never finish would never cache anything.
 * At this rate a cold lane is fully resolved in three cycles.
 */
const ORIGINS_PER_CYCLE = 150;

/** The list changes on PancakeSwap's editorial cadence, not a market's. */
const TOKEN_LIST_FRESH_FOR_MS = 24 * 60 * 60_000;
const TOKEN_LIST_DEAD_AFTER_MS = 7 * 24 * 60 * 60_000;

/**
 * The address sets one classification pass runs against.
 *
 * `allowlist` is `null` when the frozen snapshot could not be read at all, which
 * is the one condition that suppresses classification rather than narrowing it.
 */
export interface OriginIndex {
  fourmeme: ReadonlySet<string>;
  flap: ReadonlySet<string>;
  allowlist: ReadonlySet<string> | null;
  alpha: ReadonlySet<string>;
  pancakeList: ReadonlySet<string>;
}

export interface LoadOriginIndexOptions {
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn | undefined;
  /** Overrides the environment RPC endpoint list. Tests use this. */
  rpcUrls?: string[] | undefined;
  /**
   * Tokens to resolve on the chain if they have never been resolved before.
   * Omit to build the index from what is already cached and read nothing.
   */
  tokens?: string[] | undefined;
  /** Overrides the launchpad read. Tests use this. */
  readOrigins?:
    | ((tokens: string[], signal: AbortSignal | undefined) => Promise<Map<string, LaunchpadOrigin>>)
    | undefined;
}

/** Builds the index for one cycle. Never throws; a missing source narrows it. */
export async function loadOriginIndex(
  store: SnapshotStore,
  options: LoadOriginIndexOptions = {},
): Promise<OriginIndex> {
  const allowlistMap = loadAllowlist();
  const [origins, alpha, pancakeList] = await Promise.all([
    resolveOrigins(store, options),
    readLaneAddresses(store, COINS_UNIVERSE_KEY),
    readTokenList(store, options),
  ]);

  const fourmeme = new Set<string>();
  const flap = new Set<string>();
  for (const [token, origin] of origins) {
    if (origin === "fourmeme") fourmeme.add(token);
    else if (origin === "flap") flap.add(token);
  }

  return {
    fourmeme,
    flap,
    alpha,
    pancakeList,
    allowlist: allowlistMap === null ? null : new Set(allowlistMap.keys()),
  };
}

/**
 * Serves launchpad verdicts from the permanent cache, resolving only tokens it
 * has never seen.
 *
 * A resolution that fails leaves those tokens unresolved rather than recording
 * a negative: the cache is forever, so an outage written into it would be too.
 * They are simply retried next cycle.
 */
async function resolveOrigins(
  store: SnapshotStore,
  options: LoadOriginIndexOptions,
): Promise<Map<string, LaunchpadOrigin>> {
  const cached = await readOriginCache(store);
  const wanted = (options.tokens ?? [])
    .map((token) => normalizeAddress(token))
    .filter((token): token is string => token !== null && !cached.has(token));
  if (wanted.length === 0) return cached;

  const unique = [...new Set(wanted)].slice(0, ORIGINS_PER_CYCLE);
  try {
    const read =
      options.readOrigins ??
      ((tokens: string[], signal: AbortSignal | undefined): Promise<Map<string, LaunchpadOrigin>> =>
        resolveLaunchpadOrigins(tokens, {
          ...(signal === undefined ? {} : { signal }),
          ...(options.rpcUrls === undefined ? {} : { rpcUrls: options.rpcUrls }),
        }));

    const resolved = await read(unique, options.signal);
    if (resolved.size === 0) return cached;

    for (const [token, origin] of resolved) cached.set(token, origin);
    await store.put(LAUNCHPAD_ORIGINS_KEY, Object.fromEntries(cached), {
      source: "pool-tier",
      freshForMs: ORIGINS_FRESH_FOR_MS,
      deadAfterMs: ORIGINS_DEAD_AFTER_MS,
    });
    console.log(`[pool-tier] resolved ${resolved.size} new token origins (${cached.size} known)`);
  } catch (error) {
    console.warn(`[pool-tier] origin resolution skipped: ${sanitizeMessage(error)}`);
  }
  return cached;
}

const ORIGIN_VALUES: LaunchpadOrigin[] = ["fourmeme", "flap", "none"];

/** Re-validated on read: the store outlives the code that wrote it. */
async function readOriginCache(store: SnapshotStore): Promise<Map<string, LaunchpadOrigin>> {
  const record = await store.get<unknown>(LAUNCHPAD_ORIGINS_KEY);
  const cache = new Map<string, LaunchpadOrigin>();
  const data = record?.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return cache;

  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const token = normalizeAddress(key);
    if (token === null) continue;
    if (typeof value !== "string" || !(ORIGIN_VALUES as string[]).includes(value)) continue;
    cache.set(token, value as LaunchpadOrigin);
  }
  return cache;
}

/** Pulls the addresses out of a universe lane. An absent lane is an empty set. */
async function readLaneAddresses(
  store: SnapshotStore,
  key: string,
): Promise<ReadonlySet<string>> {
  const record = await store.get<unknown>(key);
  if (record === null || !Array.isArray(record.data)) return new Set();

  const addresses = new Set<string>();
  for (const raw of record.data) {
    if (typeof raw !== "object" || raw === null) continue;
    const address = normalizeAddress((raw as Record<string, unknown>)["address"]);
    if (address !== null) addresses.add(address);
  }
  return addresses;
}

/**
 * Serves the token list from the store, refreshing it when the copy has aged
 * out. A refresh that fails falls back to the stored copy however old it is:
 * PancakeSwap's editorial decisions from yesterday are still true today, and
 * dropping the list would unlabel every pool that depends on it.
 */
async function readTokenList(
  store: SnapshotStore,
  options: LoadOriginIndexOptions,
): Promise<ReadonlySet<string>> {
  const record = await store.get<unknown>(PANCAKE_TOKEN_LIST_KEY);
  const stored = Array.isArray(record?.data) ? record.data : [];
  if (record !== null && record.staleness === "fresh" && stored.length > 0) {
    return toAddressSet(stored);
  }

  try {
    const addresses = await fetchPancakeTokenList({
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    });
    await store.put(PANCAKE_TOKEN_LIST_KEY, addresses, {
      source: "pancake",
      freshForMs: TOKEN_LIST_FRESH_FOR_MS,
      deadAfterMs: TOKEN_LIST_DEAD_AFTER_MS,
    });
    return new Set(addresses);
  } catch (error) {
    console.warn(`[pool-tier] token list refresh failed: ${sanitizeMessage(error)}`);
    return toAddressSet(stored);
  }
}

function toAddressSet(values: unknown[]): ReadonlySet<string> {
  const addresses = new Set<string>();
  for (const value of values) {
    const address = normalizeAddress(value);
    if (address !== null) addresses.add(address);
  }
  return addresses;
}

/**
 * Resolves one token, launchpad origin first.
 *
 * Order is by how much the answer says: that a token came off Four.Meme is a
 * sharper fact than that it also appears on a curated list, and a token can be
 * both.
 */
export function resolveOrigin(index: OriginIndex, address: string): TokenOrigin {
  const token = address.toLowerCase();
  if (index.fourmeme.has(token)) return "fourmeme";
  if (index.flap.has(token)) return "flap";
  if (index.allowlist?.has(token) === true) return "allowlist";
  if (index.alpha.has(token)) return "alpha";
  if (index.pancakeList.has(token)) return "pancake-list";
  return "unknown";
}

export interface PoolClassification {
  tier: PoolTier;
  tokenOrigin: { token0: TokenOrigin; token1: TokenOrigin };
}

/**
 * Labels one pool from its two token origins.
 *
 * - `core` — both tokens are curated by somebody: the plane's own eligible-token
 *   allowlist, Binance Alpha, or PancakeSwap Extended.
 * - `degen` — both tokens are accounted for and at least one came off Four.Meme
 *   or Flap. Requiring the other side to be known too is what separates a real
 *   launchpad pair from a pool whose quote token nothing recognizes.
 * - `unclassified` — anything else, which includes every pool built out of a
 *   token this plane has simply never heard of.
 */
export function classifyPool(index: OriginIndex, pool: PoolStats): PoolClassification {
  const token0 = resolveOrigin(index, pool.token0);
  const token1 = resolveOrigin(index, pool.token1);
  const tokenOrigin = { token0, token1 };

  const known = token0 !== "unknown" && token1 !== "unknown";
  if (known && (LAUNCHPAD.includes(token0) || LAUNCHPAD.includes(token1))) {
    return { tier: "degen", tokenOrigin };
  }
  if (VETTED.includes(token0) && VETTED.includes(token1)) {
    return { tier: "core", tokenOrigin };
  }
  return { tier: "unclassified", tokenOrigin };
}

/**
 * Labels a whole lane.
 *
 * Labels are **sticky**: a pool that already carries one keeps it rather than
 * falling back to `unclassified`. Token provenance does not change — a Four.Meme
 * token is one forever — so an `unclassified` verdict is nearly always a
 * statement about a source being unavailable rather than about the pool. A
 * different real label still replaces the old one.
 *
 * With the frozen allowlist unreadable the pass is skipped outright, for the
 * same reason the eligibility gate refuses to answer without it: every verdict
 * would be shaped by the absence rather than by the tokens.
 */
export function labelPools(index: OriginIndex, pools: PoolStats[]): PoolStats[] {
  if (index.allowlist === null) {
    console.warn("[pool-tier] allowlist unavailable; leaving tiers untouched");
    return pools;
  }

  return pools.map((pool) => {
    const { tier, tokenOrigin } = classifyPool(index, pool);
    return {
      ...pool,
      tier: tier === "unclassified" ? pool.tier : tier,
      tokenOrigin,
    };
  });
}
