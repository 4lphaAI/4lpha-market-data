/**
 * `pancake-pools` job — keeps V3 pool state warm for the tracked pool set.
 *
 * The set comes from the `pools:seed` snapshot, which an operator writes; with
 * none present it falls back to the verified seed list, exactly as
 * `binance-prices` does with `tracked:addresses`.
 */

import type { PoolStats } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import { normalizeAddress } from "../adapters/http.js";
import { POOLS_INDEX_KEY, SEED_POOLS_KEY, fetchPoolStats, poolKey, seedPools } from "../adapters/pancake.js";

export const PANCAKE_POOLS_JOB = "pancake-pools";

export const POOL_FRESH_FOR_MS = 5 * 60_000;
export const POOL_DEAD_AFTER_MS = 60 * 60_000;

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
  attempted: number;
  updated: number;
  failed: number;
}

/** Runs one cycle. Exported so tests and the smoke script can drive it directly. */
export async function runPancakePools(
  store: SnapshotStore,
  signal: AbortSignal,
): Promise<PancakePoolsResult> {
  const pools = await readTrackedPools(store);
  if (pools.length === 0) return { attempted: 0, updated: 0, failed: 0 };

  const outcomes = await Promise.allSettled(
    pools.map(async (pool) => {
      const stats = await fetchPoolStats({ address: pool, signal });
      await store.put(poolKey(pool), stats, {
        source: stats.source,
        freshForMs: POOL_FRESH_FOR_MS,
        deadAfterMs: POOL_DEAD_AFTER_MS,
      });
      return pool;
    }),
  );

  const written: string[] = [];
  let failed = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled") written.push(outcome.value);
    else failed += 1;
  }

  // The index only ever lists pools that actually have a snapshot, so `/pools`
  // cannot advertise a key that reads back as missing.
  if (written.length > 0) {
    const index = await mergeIndex(store, written);
    await store.put(POOLS_INDEX_KEY, index, {
      source: "pancake",
      freshForMs: POOL_FRESH_FOR_MS,
      deadAfterMs: POOL_DEAD_AFTER_MS,
    });
  }

  if (written.length === 0) {
    throw new Error(`no pools updated (failed=${failed})`);
  }
  return { attempted: pools.length, updated: written.length, failed };
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
    intervalMs: 120_000,
    jitterMs: 10_000,
    timeoutMs: 25_000,
    run: async (signal) => {
      await runPancakePools(store, signal);
    },
  };
}
