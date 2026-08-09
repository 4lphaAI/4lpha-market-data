/**
 * `fourmeme-ranking` job — keeps the meme lane and its market snapshots warm.
 *
 * Two rankings are pulled each cycle: `NEW` for freshly launched tokens and
 * `HOT` for whatever is currently moving. Their union becomes the meme lane.
 */

import type { TokenSnapshot, UniverseEntry } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import { fetchFourMemeRanking, type FourMemeRankingType } from "../adapters/fourmeme.js";
import { MEME_UNIVERSE_KEY } from "../universe.js";
import { TOKEN_DEAD_AFTER_MS, TOKEN_FRESH_FOR_MS, mergeTokenIntoStore } from "./tokenStore.js";

export const FOURMEME_RANKING_JOB = "fourmeme-ranking";

const RANKING_TYPES: FourMemeRankingType[] = ["NEW", "HOT"];
const PAGE_SIZE = 50;

/** Runs one cycle. Exported so tests and the smoke script can drive it directly. */
export async function runFourMemeRanking(
  store: SnapshotStore,
  signal: AbortSignal,
): Promise<{ entries: number; snapshots: number }> {
  const entriesByAddress = new Map<string, UniverseEntry>();
  const snapshots: TokenSnapshot[] = [];
  const failures: string[] = [];

  for (const type of RANKING_TYPES) {
    try {
      const result = await fetchFourMemeRanking({ type, pageSize: PAGE_SIZE, signal });
      for (const entry of result.entries) entriesByAddress.set(entry.address, entry);
      snapshots.push(...result.snapshots);
    } catch (error) {
      failures.push(`${type}: ${describe(error)}`);
    }
  }

  // A partial cycle still publishes; only a total failure is an error, so one
  // bad ranking type cannot blank the lane.
  if (entriesByAddress.size === 0) {
    throw new Error(`no rankings available (${failures.join("; ")})`);
  }

  const entries = [...entriesByAddress.values()];
  await store.put(MEME_UNIVERSE_KEY, entries, {
    source: "fourmeme",
    freshForMs: TOKEN_FRESH_FOR_MS,
    deadAfterMs: TOKEN_DEAD_AFTER_MS,
  });

  for (const snapshot of snapshots) {
    await mergeTokenIntoStore(store, "fourmeme", snapshot);
  }

  return { entries: entries.length, snapshots: snapshots.length };
}

/** Job registration for the scheduler. */
export function fourmemeRankingJob(store: SnapshotStore): JobSpec {
  return {
    name: FOURMEME_RANKING_JOB,
    intervalMs: 30_000,
    jitterMs: 5_000,
    timeoutMs: 10_000,
    run: async (signal) => {
      await runFourMemeRanking(store, signal);
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "unknown error";
}
