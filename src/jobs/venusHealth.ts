/**
 * `venus-health` and `venus-health-hot` jobs.
 *
 * Two cadences over the same code path. The base job sweeps every tracked owner
 * once a minute; the hot job runs every 15s but only touches owners whose last
 * stored tier was DANGER or worse. That is deliberately simpler than dynamic
 * per-owner scheduling: the priority set is derived from state that is already
 * in the store, so there is no second scheduler to keep in sync.
 *
 * The owner list comes from the `tracked:venus-owners` snapshot, which an
 * operator writes. There is no default list — watching an address the operator
 * did not ask for would be surprising — so an unconfigured deployment simply
 * runs a no-op, which is a success, not a failure.
 */

import type { VenusHealth } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import { normalizeAddress } from "../adapters/http.js";
import { fetchVenusHealth, isHotTier } from "../adapters/venus.js";

export const VENUS_HEALTH_JOB = "venus-health";
export const VENUS_HEALTH_HOT_JOB = "venus-health-hot";

/** Store key holding the operator-controlled owner set. */
export const TRACKED_VENUS_OWNERS_KEY = "tracked:venus-owners";

export const VENUS_FRESH_FOR_MS = 90_000;
export const VENUS_DEAD_AFTER_MS = 15 * 60_000;

/** Store key for one owner's position. */
export function venusKey(owner: string): string {
  return `venus:${owner.toLowerCase()}`;
}

/** Reads the tracked owner set. Empty by default. */
export async function readTrackedVenusOwners(store: SnapshotStore): Promise<string[]> {
  const record = await store.get<unknown>(TRACKED_VENUS_OWNERS_KEY);
  const raw: unknown = record === null ? [] : record.data;
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  return [...new Set(list.map((value) => normalizeAddress(value)))].filter(
    (value): value is string => value !== null,
  );
}

/** Narrows the tracked set to the owners currently at DANGER or worse. */
export async function readHotVenusOwners(store: SnapshotStore): Promise<string[]> {
  const owners = await readTrackedVenusOwners(store);
  const hot: string[] = [];
  for (const owner of owners) {
    const record = await store.get<VenusHealth>(venusKey(owner));
    if (record !== null && isHotTier(record.data.tier)) hot.push(owner);
  }
  return hot;
}

export interface VenusHealthResult {
  attempted: number;
  updated: number;
  failed: number;
  hot: number;
}

/** Reads and stores health for the given owners. Exported for tests and smoke. */
export async function runVenusHealth(
  store: SnapshotStore,
  owners: string[],
  signal: AbortSignal,
): Promise<VenusHealthResult> {
  if (owners.length === 0) return { attempted: 0, updated: 0, failed: 0, hot: 0 };

  const outcomes = await Promise.allSettled(
    owners.map(async (owner) => {
      const health = await fetchVenusHealth({ owner, signal });
      await store.put(venusKey(owner), health, {
        source: "venus",
        freshForMs: VENUS_FRESH_FOR_MS,
        deadAfterMs: VENUS_DEAD_AFTER_MS,
      });
      return health;
    }),
  );

  const result: VenusHealthResult = { attempted: owners.length, updated: 0, failed: 0, hot: 0 };
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      result.failed += 1;
      continue;
    }
    result.updated += 1;
    if (isHotTier(outcome.value.tier)) result.hot += 1;
  }

  if (result.updated === 0) {
    throw new Error(`no venus owners updated (failed=${result.failed})`);
  }
  return result;
}

/** Job registration: full sweep of the tracked owner set. */
export function venusHealthJob(store: SnapshotStore): JobSpec {
  return {
    name: VENUS_HEALTH_JOB,
    intervalMs: 60_000,
    jitterMs: 5_000,
    timeoutMs: 30_000,
    run: async (signal) => {
      await runVenusHealth(store, await readTrackedVenusOwners(store), signal);
    },
  };
}

/** Job registration: fast re-check of owners already at DANGER or worse. */
export function venusHealthHotJob(store: SnapshotStore): JobSpec {
  return {
    name: VENUS_HEALTH_HOT_JOB,
    intervalMs: 15_000,
    timeoutMs: 12_000,
    run: async (signal) => {
      await runVenusHealth(store, await readHotVenusOwners(store), signal);
    },
  };
}
