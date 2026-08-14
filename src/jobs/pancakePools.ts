/**
 * `pancake-pools` job — builds and keeps warm the PancakeSwap V3 pool lane.
 *
 * One cycle does three things, in this order:
 *
 * 1. Pages the explorer's pool list by TVL, up to {@link MAX_LANE_POOLS}. TVL is
 *    an *ingest order*, not a verdict: it decides which pools the lane has room
 *    for, never which pools deserve to be in it. Filtering is the caller's job.
 * 2. Reads the operator-tracked seed pools individually, which is the only path
 *    that carries chain state, and merges them in ahead of the cap so they can
 *    never be evicted by a busier pool.
 * 3. Values CAKE emissions for whichever lane pools carry a farm, so every row
 *    ends up with the same `lpFee + cakeFarm = combined` APR the PancakeSwap UI
 *    shows.
 *
 * The lane fails **open**, unlike the eligibility gate. A cycle that manages
 * part of its paging republishes what it has merged with what was already
 * there; only a cycle that reads nothing at all leaves the stored lane
 * untouched to age on its own. A lane that blanks on an upstream blink is worse
 * than one carrying a row from five minutes ago, and each row states its own
 * `asOf` so nothing is passed off as newer than it is.
 */

import type {
  PoolFarm,
  PoolStats,
  PoolTier,
  PoolTokenOrigins,
  TokenOrigin,
} from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import { type FetchFn, normalizeAddress, parseNum, parseStr, sanitizeMessage } from "../adapters/http.js";
import {
  EXPLORER_PAGE_SIZE,
  POOLS_INDEX_KEY,
  SEED_POOLS_KEY,
  fetchCakePriceUsd,
  fetchPancakeFarmedPools,
  fetchPancakePoolList,
  fetchPoolStats,
  poolKey,
  seedPools,
  withCakeFarm,
} from "../adapters/pancake.js";
import {
  type CakeEmissions,
  computeCakeFarmApr,
  fetchCakeEmissions,
} from "../adapters/masterchefV3.js";
import type { LaunchpadOrigin } from "../query/eligibility.js";
import { labelPools, loadOriginIndex } from "../query/poolTier.js";

export const PANCAKE_POOLS_JOB = "pancake-pools";

/** Store key holding the whole lane, one snapshot rather than 500. */
export const POOLS_LANE_KEY = "universe:pools";

/** Hard cap on lane size. Seed pools are merged first, so the cap never cuts them. */
export const MAX_LANE_POOLS = 500;

/** Pages needed to reach the cap, at the endpoint's fixed 50 rows per page. */
const MAX_PAGES = Math.ceil(MAX_LANE_POOLS / EXPLORER_PAGE_SIZE);

export const POOL_FRESH_FOR_MS = 5 * 60_000;
export const POOL_DEAD_AFTER_MS = 60 * 60_000;

const SOURCE = "pancake";

/** Reads the tracked pool set, falling back to the verified seed list. */
export async function readTrackedPools(store: SnapshotStore): Promise<string[]> {
  const record = await store.get<unknown>(SEED_POOLS_KEY);
  const raw: unknown = record === null ? [] : record.data;
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const pools = [...new Set(list.map((value) => normalizeAddress(value)))].filter(
    (value): value is string => value !== null,
  );
  return pools.length > 0 ? pools : seedPools();
}

export interface PancakePoolsResult {
  /** Rows read from the list endpoint this cycle. */
  discovered: number;
  pagesRead: number;
  /** True when paging ran to the cap or to the end without breaking. */
  complete: boolean;
  /** True when the pass was trusted to replace the lane rather than extend it. */
  replaced: boolean;
  /** Seed pools read in full this cycle. */
  seeded: number;
  /** Seed pools whose read failed; their previous row is kept. */
  failed: number;
  /** Lane pools that ended up with a known CAKE farm APR. */
  farmPriced: number;
  /** Lane pools carrying a tier other than `unclassified`. */
  tiered: number;
  lane: number;
}

/** Injection points, so tests never touch the network or the chain. */
export interface RunPancakePoolsOptions {
  fetchFn?: FetchFn | undefined;
  rpcUrls?: string[] | undefined;
  /** Overrides the MasterChefV3 read. */
  readEmissions?:
    | ((pools: string[], signal: AbortSignal) => Promise<CakeEmissions>)
    | undefined;
  /** Overrides the launchpad-origin read. */
  readOrigins?:
    | ((tokens: string[], signal: AbortSignal | undefined) => Promise<Map<string, LaunchpadOrigin>>)
    | undefined;
}

/** Runs one cycle. Exported so tests and the smoke script can drive it directly. */
export async function runPancakePools(
  store: SnapshotStore,
  signal: AbortSignal,
  options: RunPancakePoolsOptions = {},
): Promise<PancakePoolsResult> {
  const [page, seed] = await Promise.all([
    readLanePages(options, signal),
    readSeedPools(store, options, signal),
  ]);

  // Nothing was read at all: republishing would only restamp stale rows with a
  // fresh snapshot age. Leave the stored lane to age honestly and fail the job.
  if (page.rows.length === 0 && seed.stats.length === 0) {
    throw new Error(`no pools read (pages=${page.pagesRead}, seedFailures=${seed.failed})`);
  }

  // A complete pass is authoritative and replaces the lane; a broken one is
  // backfilled from what was already stored so a bad page cannot shrink it.
  //
  // "Complete" is not enough on its own: an upstream answering `{rows: [],
  // hasNextPage: false}` walks to the end without objecting, and replacing on
  // that would swap a 500-pool lane for the seed set. BSC having no V3 pools is
  // not a state worth modelling, so an empty pass is treated as a broken one.
  const authoritative = page.complete && page.rows.length > 0;
  const carried = authoritative ? [] : await readStoredLane(store);
  const lane = mergeLane(seed.stats, page.rows, carried);

  // Everything read this cycle. Enrichment applies to these only, so a carried
  // row stays internally consistent with the `asOf` it still carries.
  const fresh = new Set([...seed.stats, ...page.rows].map((stats) => stats.pool));
  const farmPriced = await priceFarms(lane, fresh, options, signal);
  const labelled = await labelLane(store, lane, options, signal);

  await store.put(POOLS_LANE_KEY, labelled, {
    source: SOURCE,
    freshForMs: POOL_FRESH_FOR_MS,
    deadAfterMs: POOL_DEAD_AFTER_MS,
  });
  // Only pools actually read this cycle. A tracked pool that failed is still in
  // the lane, carried over from before, and rewriting its `pool:<addr>` record
  // would restamp a stale row as freshly read.
  await writeSeedSnapshots(store, labelled, seed.stats.map((stats) => stats.pool));

  return {
    discovered: page.rows.length,
    pagesRead: page.pagesRead,
    complete: page.complete,
    replaced: authoritative,
    seeded: seed.stats.length,
    failed: seed.failed,
    farmPriced,
    tiered: labelled.filter((pool) => pool.tier !== "unclassified").length,
    lane: labelled.length,
  };
}

/**
 * Labels the lane by token provenance.
 *
 * Enrichment, like farm pricing: the lane is already built, and a classification
 * that cannot run leaves every row exactly as it was rather than failing a cycle
 * whose actual job — discovery — succeeded.
 */
async function labelLane(
  store: SnapshotStore,
  lane: PoolStats[],
  options: RunPancakePoolsOptions,
  signal: AbortSignal,
): Promise<PoolStats[]> {
  try {
    const index = await loadOriginIndex(store, {
      signal,
      // Every token in the lane, so one that has never been resolved gets asked
      // about once. Already-known tokens cost nothing.
      tokens: [...new Set(lane.flatMap((pool) => [pool.token0, pool.token1]))],
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      ...(options.rpcUrls === undefined ? {} : { rpcUrls: options.rpcUrls }),
      ...(options.readOrigins === undefined ? {} : { readOrigins: options.readOrigins }),
    });
    return labelPools(index, lane);
  } catch (error) {
    console.warn(`[${PANCAKE_POOLS_JOB}] classification skipped: ${sanitizeMessage(error)}`);
    return lane;
  }
}

interface LanePages {
  rows: PoolStats[];
  pagesRead: number;
  complete: boolean;
}

/**
 * Walks the cursor until the cap is reached or the list runs out.
 *
 * Never throws: a page that fails ends the walk and marks it incomplete, which
 * is what tells the caller to backfill rather than replace. Pages are strictly
 * sequential because each one's cursor comes out of the previous response.
 */
async function readLanePages(
  options: RunPancakePoolsOptions,
  signal: AbortSignal,
): Promise<LanePages> {
  const rows: PoolStats[] = [];
  let after: string | undefined;
  let pagesRead = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    try {
      const result = await fetchPancakePoolList({
        orderBy: "tvlUSD",
        after,
        signal,
        ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      });
      pagesRead += 1;
      rows.push(...result.rows);

      if (!result.hasNextPage || result.endCursor === null) {
        return { rows, pagesRead, complete: true };
      }
      after = result.endCursor;
    } catch (error) {
      console.warn(`[${PANCAKE_POOLS_JOB}] page ${page + 1} failed: ${sanitizeMessage(error)}`);
      return { rows, pagesRead, complete: false };
    }
  }

  return { rows, pagesRead, complete: true };
}

interface SeedRead {
  addresses: string[];
  stats: PoolStats[];
  failed: number;
}

/**
 * Reads the operator-tracked pools one at a time.
 *
 * These are the only rows that carry chain state, because the list endpoint
 * does not return it. A failure here is not fatal: the pool keeps whatever the
 * lane already holds for it.
 */
async function readSeedPools(
  store: SnapshotStore,
  options: RunPancakePoolsOptions,
  signal: AbortSignal,
): Promise<SeedRead> {
  const addresses = await readTrackedPools(store);
  if (addresses.length === 0) return { addresses, stats: [], failed: 0 };

  const outcomes = await Promise.allSettled(
    addresses.map((address) =>
      fetchPoolStats({
        address,
        signal,
        ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
        ...(options.rpcUrls === undefined ? {} : { rpcUrls: options.rpcUrls }),
      }),
    ),
  );

  const stats: PoolStats[] = [];
  let failed = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled") stats.push(outcome.value);
    else failed += 1;
  }
  return { addresses, stats, failed };
}

/**
 * Seed pools first, then this cycle's discoveries, then anything carried over.
 *
 * First writer wins per address, which is why the order matters: a seed row is
 * richer than the same pool's list row, and both are newer than a carried one.
 * Capping the merged order then cannot evict a seed pool, whatever its TVL.
 */
export function mergeLane(
  seeded: PoolStats[],
  discovered: PoolStats[],
  carried: PoolStats[],
): PoolStats[] {
  const listRows = new Map(discovered.map((row) => [row.pool, row]));
  const merged = new Map<string, PoolStats>();

  for (const row of seeded) {
    const listRow = listRows.get(row.pool);
    merged.set(row.pool, listRow === undefined ? row : fillGaps(row, listRow));
  }
  for (const row of [...discovered, ...carried]) {
    if (!merged.has(row.pool)) merged.set(row.pool, row);
  }

  return [...merged.values()]
    .slice(0, MAX_LANE_POOLS)
    .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
}

/**
 * Completes a seed row from the same pool's list row.
 *
 * The two reads have complementary blind spots — only the per-pool read carries
 * chain state, only the list carries USD figures and the fee APR — and a seed
 * read that fell back to the chain has the second half missing entirely. Taking
 * the seed row whole would then discard TVL and APR the lane had in hand.
 *
 * Only ever applied between two rows from the same cycle. Filling a fresh row
 * from a carried one would put old numbers under a new timestamp.
 */
function fillGaps(seedRow: PoolStats, listRow: PoolStats): PoolStats {
  const lpFeeApr24h = seedRow.lpFeeApr24h ?? listRow.lpFeeApr24h;
  return {
    ...seedRow,
    tvlUsd: seedRow.tvlUsd ?? listRow.tvlUsd,
    volume24hUsd: seedRow.volume24hUsd ?? listRow.volume24hUsd,
    lpFeeApr24h,
    lpFeeApr7d: seedRow.lpFeeApr7d ?? listRow.lpFeeApr7d,
    aprSources: lpFeeApr24h === null ? seedRow.aprSources : ["lpFee"],
  };
}

/**
 * Values CAKE emissions across the lane, in place.
 *
 * All of it or none of it: the farming list says which pools have a farm at
 * all, so a pool missing from it earns no CAKE and gets a real `0`. That
 * inference is only safe while the farm reads themselves succeeded — if any
 * step fails the whole lane keeps `cakeFarmApr: null`, because a silent `0`
 * would understate every farmed pool at once.
 */
async function priceFarms(
  lane: PoolStats[],
  fresh: ReadonlySet<string>,
  options: RunPancakePoolsOptions,
  signal: AbortSignal,
): Promise<number> {
  if (lane.length === 0) return 0;

  try {
    const fetchOptions = options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn };
    const [farmed, cakePrice] = await Promise.all([
      fetchPancakeFarmedPools({ signal, ...fetchOptions }),
      fetchCakePriceUsd({ signal, ...fetchOptions }),
    ]);

    const farmedPools = new Set(farmed.map((pool) => pool.pool));
    const candidates = lane
      .filter((pool) => fresh.has(pool.pool) && farmedPools.has(pool.pool))
      .map((pool) => pool.pool);

    const readEmissions =
      options.readEmissions ??
      ((pools: string[], inner: AbortSignal): Promise<CakeEmissions> =>
        fetchCakeEmissions({
          pools,
          signal: inner,
          ...(options.rpcUrls === undefined ? {} : { rpcUrls: options.rpcUrls }),
        }));
    const emissions = await readEmissions(candidates, signal);

    let priced = 0;
    lane.forEach((pool, index) => {
      // Carried rows are left exactly as they were. Their `tvlUsd` is from an
      // earlier cycle, so dividing this minute's emissions by it would produce a
      // number belonging to no moment at all, filed under the older `asOf`.
      if (!fresh.has(pool.pool)) {
        if (pool.cakeFarmApr !== null) priced += 1;
        return;
      }
      const farm: PoolFarm | null = emissions.farms.get(pool.pool) ?? null;
      const apr = computeCakeFarmApr(farm?.cakePerYear ?? 0, cakePrice, pool.tvlUsd);
      lane[index] = withCakeFarm(pool, farm, apr);
      if (apr !== null) priced += 1;
    });
    return priced;
  } catch (error) {
    // The lane is already built; emissions are an enrichment on top of it.
    console.warn(`[${PANCAKE_POOLS_JOB}] farm pricing skipped: ${sanitizeMessage(error)}`);
    return 0;
  }
}

/**
 * Keeps the per-pool snapshots that `/pools` reads, for the tracked set only.
 *
 * The lane lives in one key; writing 500 more would be 500 round trips per
 * cycle for state the lane snapshot already holds. The index only ever lists
 * pools that actually have a snapshot, so `/pools` cannot advertise a key that
 * reads back as missing.
 */
async function writeSeedSnapshots(
  store: SnapshotStore,
  lane: PoolStats[],
  addresses: string[],
): Promise<void> {
  const byPool = new Map(lane.map((pool) => [pool.pool, pool]));
  const written: string[] = [];

  for (const address of addresses) {
    const stats = byPool.get(address);
    if (stats === undefined) continue;
    await store.put(poolKey(address), stats, {
      source: stats.source,
      freshForMs: POOL_FRESH_FOR_MS,
      deadAfterMs: POOL_DEAD_AFTER_MS,
    });
    written.push(address);
  }

  if (written.length === 0) return;
  const index = await mergeIndex(store, written);
  await store.put(POOLS_INDEX_KEY, index, {
    source: SOURCE,
    freshForMs: POOL_FRESH_FOR_MS,
    deadAfterMs: POOL_DEAD_AFTER_MS,
  });
}

/**
 * Keeps previously indexed pools that this cycle failed on: their `pool:<addr>`
 * record is still there, just ageing, and dropping them would hide it.
 */
async function mergeIndex(store: SnapshotStore, written: string[]): Promise<string[]> {
  const record = await store.get<unknown>(POOLS_INDEX_KEY);
  const existing: unknown[] = Array.isArray(record?.data) ? record.data : [];
  const merged = new Set<string>();
  for (const value of existing) {
    const address = normalizeAddress(value);
    if (address !== null) merged.add(address);
  }
  for (const address of written) merged.add(address);
  return [...merged].sort();
}

/** The lane with the age of the snapshot holding it. */
export interface StoredLane {
  pools: PoolStats[];
  asOf: number;
  staleness: string;
  source: string;
}

/**
 * Reads the lane back, re-validating every row.
 *
 * The store outlives code versions: a row written by an older build must not
 * reach a consumer with fields it has never heard of reading as `undefined`.
 */
export async function readPoolsLane(store: SnapshotStore): Promise<StoredLane | null> {
  const record = await store.get<unknown>(POOLS_LANE_KEY);
  if (record === null || !Array.isArray(record.data)) return null;

  const pools: PoolStats[] = [];
  for (const raw of record.data) {
    const parsed = parseStoredPool(raw);
    if (parsed !== null) pools.push(parsed);
  }
  return { pools, asOf: record.asOf, staleness: record.staleness, source: record.source };
}

/** The lane's rows alone, for callers that do not need the snapshot's age. */
async function readStoredLane(store: SnapshotStore): Promise<PoolStats[]> {
  const lane = await readPoolsLane(store);
  return lane === null ? [] : lane.pools;
}

const TIERS: PoolTier[] = ["core", "degen", "unclassified"];

/** Rebuilds one stored row, or `null` if it no longer describes a pool. */
export function parseStoredPool(raw: unknown): PoolStats | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;

  // Only V3 is served. A row stored by some future build that also writes
  // another protocol must not be read back as one, since its pool id would not
  // be an address.
  const protocol = parseStr(row["protocol"]);
  if (protocol !== null && protocol !== "v3") return null;

  const pool = normalizeAddress(row["pool"]);
  const token0 = normalizeAddress(row["token0"]);
  const token1 = normalizeAddress(row["token1"]);
  const fee = parseNum(row["fee"]);
  if (pool === null || token0 === null || token1 === null || fee === null) return null;

  const tier = parseStr(row["tier"]);
  const sources = Array.isArray(row["aprSources"]) ? row["aprSources"] : [];

  return {
    pool,
    protocol: "v3",
    token0,
    token1,
    token0Symbol: parseStr(row["token0Symbol"]),
    token1Symbol: parseStr(row["token1Symbol"]),
    fee: Math.trunc(fee),
    liquidity: parseStr(row["liquidity"]),
    sqrtPriceX96: parseStr(row["sqrtPriceX96"]),
    tick: parseNum(row["tick"]),
    tvlUsd: parseNum(row["tvlUsd"]),
    volume24hUsd: parseNum(row["volume24hUsd"]),
    lpFeeApr24h: parseNum(row["lpFeeApr24h"]),
    lpFeeApr7d: parseNum(row["lpFeeApr7d"]),
    cakeFarmApr: parseNum(row["cakeFarmApr"]),
    combinedApr: parseNum(row["combinedApr"]),
    aprSources: sources.filter(
      (value): value is "lpFee" | "cakeFarm" => value === "lpFee" || value === "cakeFarm",
    ),
    farm: parseStoredFarm(row["farm"]),
    tier: tier !== null && (TIERS as string[]).includes(tier) ? (tier as PoolTier) : "unclassified",
    tokenOrigin: parseStoredOrigins(row["tokenOrigin"]),
    asOf: parseNum(row["asOf"]) ?? 0,
    source: parseStr(row["source"]) ?? SOURCE,
  };
}

const ORIGINS: TokenOrigin[] = [
  "fourmeme",
  "flap",
  "allowlist",
  "alpha",
  "pancake-list",
  "unknown",
];

function parseStoredOrigins(raw: unknown): PoolTokenOrigins {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { token0: "unknown", token1: "unknown" };
  }
  const origins = raw as Record<string, unknown>;
  return { token0: parseOrigin(origins["token0"]), token1: parseOrigin(origins["token1"]) };
}

function parseOrigin(raw: unknown): TokenOrigin {
  const value = parseStr(raw);
  return value !== null && (ORIGINS as string[]).includes(value)
    ? (value as TokenOrigin)
    : "unknown";
}

function parseStoredFarm(raw: unknown): PoolFarm | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const farm = raw as Record<string, unknown>;
  const pid = parseNum(farm["pid"]);
  const allocPoint = parseNum(farm["allocPoint"]);
  const cakePerYear = parseNum(farm["cakePerYear"]);
  if (pid === null || allocPoint === null || cakePerYear === null) return null;
  return { pid, allocPoint, cakePerYear };
}

/** Reads every indexed pool snapshot, newest state with its staleness. */
export async function readStoredPools(
  store: SnapshotStore,
): Promise<Array<{ stats: PoolStats; asOf: number; staleness: string }>> {
  const record = await store.get<unknown>(POOLS_INDEX_KEY);
  const index: unknown[] = Array.isArray(record?.data) ? record.data : [];
  const results: Array<{ stats: PoolStats; asOf: number; staleness: string }> = [];

  for (const value of index) {
    const address = normalizeAddress(value);
    if (address === null) continue;
    const stored = await store.get<PoolStats>(poolKey(address));
    if (stored === null) continue;
    results.push({ stats: stored.data, asOf: stored.asOf, staleness: stored.staleness });
  }

  return results;
}

/** Job registration for the scheduler. */
export function pancakePoolsJob(store: SnapshotStore): JobSpec {
  return {
    name: PANCAKE_POOLS_JOB,
    // The explorer's own cache is `s-maxage=100`, so polling faster than this
    // would re-fetch bytes that cannot have changed.
    intervalMs: 60_000,
    jitterMs: 7_000,
    // Ten sequential pages, the seed reads, and two batched chain rounds. Warm,
    // a cycle measures ~1.5s; the headroom is for an endpoint rotation.
    timeoutMs: 30_000,
    run: async (signal) => {
      await runPancakePools(store, signal);
    },
  };
}
