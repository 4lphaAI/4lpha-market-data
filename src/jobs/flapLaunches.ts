/**
 * `flap-launches` job — keeps the Flap half of the meme lane warm.
 *
 * Flap has no ranking API, so this is the closest equivalent to Four.Meme's
 * NEW + HOT pull: launches come from `TokenCreated`, and "hot" is derived from
 * the Portal lens's own `progress` field, which is how far along the bonding
 * curve a token is. A token nobody is buying sits near zero forever, so progress
 * separates the handful worth showing from the rest of the ~40k daily launches.
 *
 * The scan window is a short trailing one rather than a cursor. A cursor would
 * turn any downtime into an unbounded catch-up over an `eth_getLogs` path that
 * public endpoints already refuse at 50-block ranges; a trailing window simply
 * resumes. What keeps the lane from being only one window wide is that each
 * cycle merges into the previously stored set rather than replacing it.
 */

import type { TokenSnapshot } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import {
  FLAP_STATUS_DEX,
  fetchFlapLaunches,
  isFlapTradable,
  readFlapMarketStates,
  type FlapLaunch,
  type FlapLaunchScan,
  type FlapMarketState,
} from "../adapters/flap.js";
import { sanitizeMessage } from "../adapters/http.js";
import { fetchOnchainosPrices } from "../adapters/onchainos.js";
import { FLAP_UNIVERSE_KEY } from "../universe.js";
import { TOKEN_DEAD_AFTER_MS, TOKEN_FRESH_FOR_MS, mergeTokenIntoStore } from "./tokenStore.js";

export const FLAP_LAUNCHES_JOB = "flap-launches";

const SOURCE = "flap";

/**
 * Provenance for the enriched snapshot. Named after where the numbers came from,
 * not the job that asked, so `updatedFields` provenance stays truthful.
 */
const SOURCE_ENRICH = "onchainos";

/**
 * Blocks scanned per cycle. At the ~0.45s block time measured on BSC this is a
 * little over one interval's worth, so consecutive cycles overlap rather than
 * leaving a gap. Three `eth_getLogs` chunks.
 */
const SCAN_BLOCKS = 150;

/** Hard cap on the stored lane, so a launchpad this busy cannot grow it without bound. */
const MAX_LANE_ENTRIES = 100;

/** How many of the cap each ranking contributes. They overlap, so the union is usually smaller. */
const NEWEST_SLICE = 50;
const HOTTEST_SLICE = 50;

/**
 * One stored lane row. Richer than `UniverseEntry` on purpose: `launchedAt` and
 * `progress` are what the next cycle ranks by, and `universe.ts` narrows the row
 * back down to the public shape when it reads it.
 */
export interface FlapLaneRow {
  address: string;
  symbol: string;
  name?: string;
  source: string;
  /** Epoch milliseconds of the launch. */
  launchedAt: number;
  /** Progress toward graduation, 0 to 1e18, as a decimal string. */
  progress: string;
  /** `TokenStatus` as last read from the lens. */
  status: number;
}

export interface FlapLaunchesResult {
  /** Rows published to the lane. */
  entries: number;
  /** Launches decoded from this cycle's window. */
  discovered: number;
  /** Rows dropped because the Portal no longer reports them as tradable. */
  pruned: number;
  /** True when the lens could not be read, so nothing was pruned this cycle. */
  prunedSkipped: boolean;
  /** Graduated rows that OnchainOS had price data for, merged into the token store. */
  enriched: number;
  /** Log chunks no endpoint served. */
  missedChunks: number;
}

export interface RunFlapLaunchesOptions {
  /**
   * Overrides the chain reads. Injected the same way {@link isEligible} takes
   * `readState`, so the merge, prune and ranking logic — where the real risk
   * lives — is testable without a chain.
   */
  scan?: ((signal: AbortSignal) => Promise<FlapLaunchScan>) | undefined;
  readStates?:
    | ((addresses: string[], signal: AbortSignal) => Promise<Map<string, FlapMarketState>>)
    | undefined;
  readPrices?:
    | ((addresses: string[], signal: AbortSignal) => Promise<Map<string, TokenSnapshot>>)
    | undefined;
}

/** Runs one cycle. Exported so tests and the smoke script can drive it directly. */
export async function runFlapLaunches(
  store: SnapshotStore,
  signal: AbortSignal,
  options: RunFlapLaunchesOptions = {},
): Promise<FlapLaunchesResult> {
  const scanFn = options.scan ?? ((s: AbortSignal) => fetchFlapLaunches({ blocks: SCAN_BLOCKS, signal: s }));
  const readStatesFn = options.readStates ?? readFlapMarketStates;
  const scan = await scanFn(signal);

  // A partial scan is normal enough not to fail the run, but silent enough to
  // hide a lane that has quietly stopped growing, so it is said out loud.
  if (scan.missedChunks > 0) {
    console.warn(`[${SOURCE}] ${scan.missedChunks} log chunk(s) unserved; window is partial`);
  }

  const rows = new Map<string, FlapLaneRow>();
  for (const row of await readStoredRows(store)) rows.set(row.address, row);
  for (const launch of scan.launches) rows.set(launch.address, rowFromLaunch(launch, rows));

  // Refresh progress for everything in play, and use the same read to drop what
  // the Portal will no longer trade.
  let pruned = 0;
  let prunedSkipped = false;
  try {
    const states = await readStatesFn([...rows.keys()], signal);
    for (const [address, row] of rows) {
      const state = states.get(address);
      // Absent means the lens reverted `TokenNotFound` for it — a real answer.
      if (state === undefined || !isFlapTradable(state.status)) {
        rows.delete(address);
        pruned += 1;
        continue;
      }
      row.progress = state.progress;
      row.status = state.status;
    }
  } catch (error) {
    // The lane is not the eligibility gate: an unreadable lens must not empty
    // it. Publish what we have, unpruned, and let the record's own age say how
    // trustworthy it is.
    prunedSkipped = true;
    console.warn(`[${SOURCE}] lens read failed, publishing unpruned: ${sanitizeMessage(error)}`);
  }

  const entries = selectLane([...rows.values()]);
  await store.put(FLAP_UNIVERSE_KEY, entries, {
    source: SOURCE,
    freshForMs: TOKEN_FRESH_FOR_MS,
    deadAfterMs: TOKEN_DEAD_AFTER_MS,
  });

  const enriched = await enrichGraduated(store, entries, signal, options.readPrices);

  return {
    entries: entries.length,
    discovered: scan.launches.length,
    pruned,
    prunedSkipped,
    enriched,
    missedChunks: scan.missedChunks,
  };
}

/**
 * Fills in price, market cap, volume, holders and 24h change for the graduated
 * part of the lane, from OnchainOS.
 *
 * Only the graduated rows are asked about, and that is measured rather than an
 * optimisation guess: OKX indexes a token once it has a DEX pool and not before.
 * A Flap token minutes old on its bonding curve comes back as an empty result,
 * so asking about the whole lane would spend most of the batch on tokens that
 * cannot answer. The lens is no help here either — after graduation it stops
 * pricing, reporting `price` and `reserve` as 0 and handing back only the pool.
 *
 * Never throws. Enrichment is a bonus on top of a lane that is already
 * published; missing credentials or an OKX outage must not fail a cycle whose
 * actual job — discovery — already succeeded.
 */
async function enrichGraduated(
  store: SnapshotStore,
  entries: FlapLaneRow[],
  signal: AbortSignal,
  readPrices: RunFlapLaunchesOptions["readPrices"],
): Promise<number> {
  const graduated = entries.filter((entry) => entry.status === FLAP_STATUS_DEX);
  if (graduated.length === 0) return 0;

  try {
    const fetchPrices =
      readPrices ??
      ((addresses: string[], s: AbortSignal) => fetchOnchainosPrices({ addresses, signal: s }));
    const snapshots = await fetchPrices(
      graduated.map((entry) => entry.address),
      signal,
    );

    let merged = 0;
    for (const snapshot of snapshots.values()) {
      await mergeTokenIntoStore(store, SOURCE_ENRICH, snapshot);
      merged += 1;
    }
    return merged;
  } catch (error) {
    // MissingCredentialsError included: an unconfigured OKX key means "source
    // unavailable", which is the same non-event as the source being down.
    console.warn(`[${SOURCE}] price enrichment skipped: ${sanitizeMessage(error)}`);
    return 0;
  }
}

/**
 * Newest ∪ hottest, capped.
 *
 * Both rankings are kept because they answer different questions: newest is the
 * launch feed, hottest is what is actually being bought. Taking only one would
 * either bury every token with traction under a minute of fresh noise, or hide
 * new launches behind a stable leaderboard.
 */
export function selectLane(rows: FlapLaneRow[]): FlapLaneRow[] {
  const newest = [...rows].sort((a, b) => b.launchedAt - a.launchedAt).slice(0, NEWEST_SLICE);
  const hottest = [...rows]
    .sort((a, b) => compareProgress(b.progress, a.progress))
    .slice(0, HOTTEST_SLICE);

  const selected = new Map<string, FlapLaneRow>();
  for (const row of [...newest, ...hottest]) selected.set(row.address, row);

  return [...selected.values()]
    .sort((a, b) => b.launchedAt - a.launchedAt)
    .slice(0, MAX_LANE_ENTRIES);
}

/** Progress is a uint256 scaled to 1e18, so it is compared as a bigint, not a float. */
function compareProgress(a: string, b: string): number {
  const left = toBigInt(a);
  const right = toBigInt(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function toBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/** A newly seen launch keeps whatever progress an earlier cycle already recorded. */
function rowFromLaunch(launch: FlapLaunch, existing: Map<string, FlapLaneRow>): FlapLaneRow {
  const previous = existing.get(launch.address);
  return {
    address: launch.address,
    symbol: launch.symbol,
    ...(launch.name === "" ? {} : { name: launch.name }),
    source: SOURCE,
    launchedAt: launch.launchedAt,
    progress: previous?.progress ?? "0",
    status: previous?.status ?? 0,
  };
}

/**
 * Stored rows are re-validated on read: the store outlives code versions, and a
 * row written by an older build must not reach the ranking as `undefined`.
 */
async function readStoredRows(store: SnapshotStore): Promise<FlapLaneRow[]> {
  const record = await store.get<unknown>(FLAP_UNIVERSE_KEY);
  if (record === null || !Array.isArray(record.data)) return [];

  const rows: FlapLaneRow[] = [];
  for (const raw of record.data) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const address = typeof row["address"] === "string" ? row["address"].toLowerCase() : null;
    if (address === null) continue;
    const name = typeof row["name"] === "string" && row["name"] !== "" ? row["name"] : undefined;
    rows.push({
      address,
      symbol: typeof row["symbol"] === "string" ? row["symbol"] : "",
      ...(name === undefined ? {} : { name }),
      source: SOURCE,
      launchedAt: typeof row["launchedAt"] === "number" ? row["launchedAt"] : 0,
      progress: typeof row["progress"] === "string" ? row["progress"] : "0",
      status: typeof row["status"] === "number" ? row["status"] : 0,
    });
  }
  return rows;
}

/** Job registration for the scheduler. */
export function flapLaunchesJob(store: SnapshotStore): JobSpec {
  return {
    name: FLAP_LAUNCHES_JOB,
    intervalMs: 60_000,
    jitterMs: 7_000,
    // Three log chunks plus one batched lens read, each of which may rotate
    // through several endpoints before one answers.
    timeoutMs: 30_000,
    run: async (signal) => {
      await runFlapLaunches(store, signal);
    },
  };
}
