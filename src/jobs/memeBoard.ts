/**
 * `meme-board` job — the classified meme board behind `GET /memes`.
 *
 * Discovery is Binance's keyless Meme Rush (New / Finalizing / Migrated, Four.Meme
 * and Flap, bonding-curve tokens included): three calls a cycle, each a list the
 * upstream already screens for launch stage. Liveness is OnchainOS `price-info`
 * (windowed trade counts, 100 tokens a call) and the OKX smart-money/KOL/whale
 * signal feed — one more call. GMGN is deliberately not on this path: its per-IP
 * ban is host-wide (decided 2026-10-04).
 *
 * The board outlives the lists. Meme Rush's New list turns over in ~2.6 minutes,
 * so a token that starts running after it scrolled off would be lost if the board
 * were only the current lists. Each token is therefore tracked for 24h after it
 * was last listed and re-classified every cycle, and dropped early once it has
 * been dead for 2h — the board is for finding runners, not for an obituary.
 */

import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import { fetchMemeRush, type MemeRushRow, type MemeRushStage } from "../adapters/binanceWeb3.js";
import { sanitizeMessage } from "../adapters/http.js";
import {
  fetchOnchainosActivity,
  fetchOnchainosSignals,
  type SmartSignal,
  type TokenActivity,
} from "../adapters/onchainos.js";
import { MEME_RULES, classifyMeme, findClones, type MemeBoardRow } from "../query/memeClassify.js";
import { resolveQuoteKinds, type IssuerReader } from "../query/quoteKind.js";

export const MEME_BOARD_JOB = "meme-board";
/** Public board, served by `GET /memes`. */
export const MEME_BOARD_KEY = "memes:board";
/** Internal tracking state: the last Meme Rush row per token, and the signal window. */
export const MEME_STATE_KEY = "memes:state";

export const MEME_BOARD_CAP = 400;
const TRACK_FOR_MS = 24 * 3_600_000;
const DROP_DEAD_AFTER_MS = 2 * 3_600_000;
const MAX_SIGNALS = 1_000;

const BOARD_FRESH_MS = 3 * 60_000;
const BOARD_DEAD_MS = 30 * 60_000;

/** Later lists win when a token is on two at once: migrated is more news than new. */
const STAGE_ORDER: MemeRushStage[] = ["new", "finalizing", "migrated"];

interface TrackedToken {
  rush: MemeRushRow;
  firstSeenAt: number;
  lastListedAt: number;
  deadSince: number | null;
}

interface MemeState {
  tracked: Record<string, TrackedToken>;
  signals: SmartSignal[];
}

export interface MemeBoardResult {
  rows: number;
  listed: number;
  byStatus: Record<string, number>;
  activityCovered: number;
  signals: number;
  failures: string[];
}

export interface RunMemeBoardOptions {
  fetchRush?: ((stage: MemeRushStage, signal: AbortSignal) => Promise<MemeRushRow[]>) | undefined;
  fetchActivity?: ((addresses: string[], signal: AbortSignal) => Promise<Map<string, TokenActivity>>) | undefined;
  fetchSignals?: ((signal: AbortSignal) => Promise<SmartSignal[]>) | undefined;
  readIssuer?: IssuerReader | undefined;
  now?: (() => number) | undefined;
}

export async function runMemeBoard(
  store: SnapshotStore,
  signal: AbortSignal,
  options: RunMemeBoardOptions = {},
): Promise<MemeBoardResult> {
  const now = (options.now ?? Date.now)();
  const fetchRush = options.fetchRush ?? ((stage, s) => fetchMemeRush({ stage, signal: s }));
  const fetchActivity =
    options.fetchActivity ?? ((addresses, s) => fetchOnchainosActivity({ addresses, signal: s }));
  const fetchSignals = options.fetchSignals ?? ((s) => fetchOnchainosSignals({ signal: s }));
  const failures: string[] = [];

  // 1. Discovery. A partial cycle still publishes; only a total failure throws,
  // and then nothing is restamped — the board's own age says it is stale.
  const listed = new Map<string, MemeRushRow>();
  for (const stage of STAGE_ORDER) {
    try {
      for (const row of await fetchRush(stage, signal)) listed.set(row.address, row);
    } catch (error) {
      failures.push(`rush:${stage}: ${sanitizeMessage(error)}`);
    }
  }
  if (listed.size === 0) throw new Error(`no meme rush list available (${failures.join("; ")})`);

  // 2. Merge into what is already tracked, then prune and cap.
  const state = await readState(store);
  const previousBoard = await readBoard(store);
  for (const [address, rush] of listed) {
    const previous = state.tracked[address];
    state.tracked[address] = {
      rush,
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastListedAt: now,
      deadSince: previous?.deadSince ?? null,
    };
  }
  const tracked = Object.values(state.tracked)
    .filter((token) => now - token.lastListedAt <= TRACK_FOR_MS)
    .filter((token) => token.deadSince === null || now - token.deadSince <= DROP_DEAD_AFTER_MS)
    .sort((a, b) => b.lastListedAt - a.lastListedAt || b.rush.createdAt - a.rush.createdAt)
    .slice(0, MEME_BOARD_CAP);
  const addresses = tracked.map((token) => token.rush.address);

  // 3. Liveness. An OKX failure falls back to each row's previous activity
  // rather than turning the whole board `unknown` — `observedAt` still dates it.
  let activity = new Map<string, TokenActivity>();
  try {
    activity = await fetchActivity(addresses, signal);
  } catch (error) {
    failures.push(`activity: ${sanitizeMessage(error)}`);
    for (const row of previousBoard.values()) {
      if (row.activity !== null) activity.set(row.address, { address: row.address, ...row.activity });
    }
  }

  // 4. Signals accumulate across cycles: one call returns ~41h on BSC today,
  // but a busier day would push older ones out of a single page.
  try {
    const fresh = await fetchSignals(signal);
    const byId = new Map(state.signals.map((s) => [s.id, s]));
    for (const s of fresh) byId.set(s.id, s);
    state.signals = [...byId.values()];
  } catch (error) {
    failures.push(`signals: ${sanitizeMessage(error)}`);
  }
  const signalSince = now - MEME_RULES.signalWindowHours * 3_600_000;
  state.signals = state.signals
    .filter((s) => s.at >= signalSince)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_SIGNALS);
  const signalsByToken = new Map<string, SmartSignal[]>();
  for (const s of state.signals) {
    const list = signalsByToken.get(s.address) ?? [];
    list.push(s);
    signalsByToken.set(s.address, list);
  }

  // 5. Quote kinds (cached forever) and clones (relative to what is tracked).
  const quoteKinds = await resolveQuoteKinds(
    store,
    tracked.flatMap((token) => (token.rush.quote === null ? [] : [token.rush.quote])),
    { signal, readIssuer: options.readIssuer },
  );
  const clones = findClones(tracked.map((token) => token.rush));

  // 6. Classify.
  const rows: MemeBoardRow[] = tracked.map((token) =>
    classifyMeme({
      rush: token.rush,
      activity: activity.get(token.rush.address) ?? null,
      signals: signalsByToken.get(token.rush.address) ?? [],
      quoteKind: token.rush.quote === null ? null : (quoteKinds.get(token.rush.quote) ?? null),
      cloneOf: clones.get(token.rush.address) ?? null,
      lastListedAt: token.lastListedAt,
      firstSeenAt: token.firstSeenAt,
      previousDeadSince: token.deadSince,
      now,
    }),
  );

  const nextTracked: Record<string, TrackedToken> = {};
  for (const [index, token] of tracked.entries()) {
    nextTracked[token.rush.address] = { ...token, deadSince: rows[index]?.deadSince ?? null };
  }
  state.tracked = nextTracked;

  await store.put(MEME_STATE_KEY, state, {
    source: MEME_BOARD_JOB,
    freshForMs: BOARD_FRESH_MS,
    deadAfterMs: TRACK_FOR_MS,
  });
  await store.put(MEME_BOARD_KEY, rows, {
    source: "binance-meme-rush+onchainos",
    freshForMs: BOARD_FRESH_MS,
    deadAfterMs: BOARD_DEAD_MS,
  });

  if (failures.length > 0) console.warn(`[${MEME_BOARD_JOB}] partial cycle: ${failures.join("; ")}`);

  const byStatus: Record<string, number> = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  return {
    rows: rows.length,
    listed: listed.size,
    byStatus,
    activityCovered: rows.filter((row) => row.activity !== null).length,
    signals: state.signals.length,
    failures,
  };
}

async function readState(store: SnapshotStore): Promise<MemeState> {
  const record = await store.get<unknown>(MEME_STATE_KEY);
  const data = record?.data;
  if (typeof data !== "object" || data === null) return { tracked: {}, signals: [] };
  const raw = data as { tracked?: unknown; signals?: unknown };
  const tracked: Record<string, TrackedToken> = {};
  if (typeof raw.tracked === "object" && raw.tracked !== null) {
    for (const [address, value] of Object.entries(raw.tracked as Record<string, unknown>)) {
      if (isTracked(value)) tracked[address] = value;
    }
  }
  const signals = Array.isArray(raw.signals) ? (raw.signals as SmartSignal[]).filter(isSignal) : [];
  return { tracked, signals };
}

/** The store outlives code versions: a row written by an older build is re-checked, not trusted. */
function isTracked(value: unknown): value is TrackedToken {
  if (typeof value !== "object" || value === null) return false;
  const token = value as Partial<TrackedToken>;
  return (
    typeof token.firstSeenAt === "number" &&
    typeof token.lastListedAt === "number" &&
    typeof token.rush === "object" &&
    token.rush !== null &&
    typeof token.rush.address === "string" &&
    typeof token.rush.createdAt === "number" &&
    typeof token.rush.symbol === "string"
  );
}

function isSignal(value: unknown): value is SmartSignal {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Partial<SmartSignal>;
  return typeof s.id === "string" && typeof s.address === "string" && typeof s.at === "number";
}

async function readBoard(store: SnapshotStore): Promise<Map<string, MemeBoardRow>> {
  const record = await store.get<unknown>(MEME_BOARD_KEY);
  const out = new Map<string, MemeBoardRow>();
  if (record === null || !Array.isArray(record.data)) return out;
  for (const row of record.data as MemeBoardRow[]) {
    if (typeof row === "object" && row !== null && typeof row.address === "string") out.set(row.address, row);
  }
  return out;
}

/** Job registration for the scheduler. */
export function memeBoardJob(store: SnapshotStore): JobSpec {
  return {
    name: MEME_BOARD_JOB,
    intervalMs: 60_000,
    jitterMs: 5_000,
    // Three Meme Rush lists, four 100-token price-info batches, one signal call,
    // and at most one batched issuer read for quote tokens never seen before.
    timeoutMs: 45_000,
    run: async (signal) => {
      await runMemeBoard(store, signal);
    },
  };
}

