/**
 * `meme-bars` job — one-minute bars for the meme stocks the execution plane
 * may hold or buy (MEME-SIGNALS-HANDOFF-2026-10-05 item 1).
 *
 * The tracked set is every live meme stock on the board (quote is a bStock,
 * status runner or active) plus every row of the memestock shortlist; a token
 * leaves 30 minutes after it was last live, and at most {@link MEME_BARS_CAP}
 * are tracked (live first, the shortlist ahead of the rest, then by 5-minute
 * trades — the cap is logged when it binds).
 *
 * One source, Sintral (Binance Web3's kline service), measured against the
 * chain on 2026-10-05: prices and volume are USD (see `SintralMinuteBar`). It
 * lists only minutes that traded, and the minute in progress keeps changing for
 * ~20 s after it closes, so a minute counts as closed {@link SETTLE_MS} after
 * its end and the last {@link REFRESH_TAIL} closed minutes are re-read every
 * cycle (a late trade corrects a bar rather than being lost). Missing minutes
 * are zero-filled explicitly — `trades: 0`, `volume: 0`, OHLC at the previous
 * close — so a flat chart reads as silence, not as a gap. Each token keeps the
 * last {@link MEME_BARS_KEEP} closed minutes, backfilled on entry and extended
 * incrementally after that.
 *
 * Budget: one Sintral call per tracked token per minute, four at a time through
 * the shared Binance-host limiter. A 429 stops the cycle's remaining calls (the
 * skipped tokens age toward stale rather than hammer a throttled host); every
 * cycle logs its call count, failures and whether it was throttled.
 */

import { randomUUID } from "node:crypto";
import { fetchSintralMinuteBars, type SintralMinuteBar } from "../adapters/binanceWeb3.js";
import { AdapterError, sanitizeMessage } from "../adapters/http.js";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import type { MemeBoardRow } from "../query/memeClassify.js";
import { buildShortlist, parseShortlistQuery } from "../query/memeQuery.js";
import { loadStockInfo } from "../query/memeStocks.js";
import { MEME_BOARD_KEY } from "./memeBoard.js";

export const MEME_BARS_JOB = "meme-bars";
export const MEME_BARS_INDEX_KEY = "memes:bars:v1:index";
export const MEME_BARS_LEASE = "memes:bars:v1:producer";
export const MEME_BARS_SOURCE = "sintral";
export const MEME_BARS_UNIT = "usd";
export const MEME_BARS_CAP = 120;
export const MEME_BARS_KEEP = 180;
/** A minute is closed this long after its end (Sintral was seen still updating a bar 21 s past it). */
export const SETTLE_MS = 45_000;
/** Closed minutes re-read every cycle, so a late-published trade corrects its bar. */
export const REFRESH_TAIL = 3;
export const LEAVE_AFTER_MS = 30 * 60_000;
/** Same freshness convention as the board. */
export const BARS_FRESH_MS = 3 * 60_000;
export const BARS_DEAD_MS = 30 * 60_000;
const WORKERS = 4;
const MINUTE = 60_000;

export const memeBarsKey = (address: string): string => `memes:bars:v1:${address.toLowerCase()}`;

/** `[startMs, open, high, low, close, volumeUsd, trades]`; a zero-filled minute has `trades: 0` and volume 0. */
export type StoredBar = [number, number, number, number, number, number, number | null];

export interface BarSeries {
  address: string;
  symbol: string;
  source: typeof MEME_BARS_SOURCE;
  unit: typeof MEME_BARS_UNIT;
  /** Start of the newest closed minute the series covers. */
  lastClosedStartMs: number;
  /** Closed minutes, oldest first, contiguous. */
  bars: StoredBar[];
  /** The newest traded minute before the window, kept to carry its close into a zero-filled window start. */
  seed: StoredBar | null;
}

interface IndexEntry {
  symbol: string;
  enteredAt: number;
  lastLiveAt: number;
}

export interface BarsIndex {
  tokens: Record<string, IndexEntry>;
  lastCycle: {
    at: number;
    tracked: number;
    candidates: number;
    capped: boolean;
    calls: number;
    failures: number;
    throttled: boolean;
    boardFresh: boolean;
  } | null;
}

/** Start of the newest closed minute at `now`. */
export function lastClosedMinute(now: number): number {
  return Math.floor((now - MINUTE - SETTLE_MS) / MINUTE) * MINUTE;
}

const isFilled = (bar: StoredBar): boolean => bar[6] === 0 && bar[5] === 0;

function toStored(bar: SintralMinuteBar): StoredBar {
  return [bar.startMs, bar.open, bar.high, bar.low, bar.close, bar.volumeUsd, bar.trades];
}

/**
 * Exported for tests: rebuilds a contiguous, zero-filled series ending at
 * `lastClosed` from the traded minutes known so far. Zero-fills are always
 * recomputed from traded bars, so a late trade that corrects one minute also
 * corrects the flat minutes after it.
 */
export function rebuildSeries(
  previous: Pick<BarSeries, "bars" | "seed"> | null,
  fetched: readonly SintralMinuteBar[],
  lastClosed: number,
  keep = MEME_BARS_KEEP,
): { bars: StoredBar[]; seed: StoredBar | null } {
  const traded = new Map<number, StoredBar>();
  if (previous?.seed) traded.set(previous.seed[0], previous.seed);
  for (const bar of previous?.bars ?? []) if (!isFilled(bar)) traded.set(bar[0], bar);
  for (const bar of fetched) if (bar.startMs <= lastClosed) traded.set(bar.startMs, toStored(bar));

  const windowStart = lastClosed - (keep - 1) * MINUTE;
  const starts = [...traded.keys()].filter((start) => start <= lastClosed).sort((a, b) => a - b);
  let seed: StoredBar | null = null;
  for (const start of starts) if (start < windowStart) seed = traded.get(start)!;
  const firstInWindow = starts.find((start) => start >= windowStart);
  const first = seed !== null ? windowStart : firstInWindow;
  if (first === undefined) return { bars: [], seed: null };

  const bars: StoredBar[] = [];
  let close = seed?.[4] ?? null;
  for (let minute = first; minute <= lastClosed; minute += MINUTE) {
    const bar = traded.get(minute);
    if (bar !== undefined) {
      bars.push(bar);
      close = bar[4];
    } else if (close !== null) {
      bars.push([minute, close, close, close, close, 0, 0]);
    }
  }
  return { bars, seed };
}

/** How many Sintral rows to ask for: everything on entry, the gap plus the re-read tail after that. */
export function fetchLimit(previous: BarSeries | null, lastClosed: number): number {
  if (previous === null || previous.bars.length === 0) return MEME_BARS_KEEP;
  const gap = Math.max(0, Math.round((lastClosed - previous.lastClosedStartMs) / MINUTE));
  // + 2: the minute in progress and the one still settling are returned too.
  return Math.min(MEME_BARS_KEEP, Math.max(5, gap + REFRESH_TAIL + 2));
}

export interface RunMemeBarsOptions {
  fetchBars?: ((address: string, limit: number, signal: AbortSignal) => Promise<SintralMinuteBar[]>) | undefined;
  now?: (() => number) | undefined;
  holder?: string | undefined;
}

export interface MemeBarsResult {
  skipped?: "lease_held";
  tracked: number;
  candidates: number;
  capped: boolean;
  calls: number;
  failures: number;
  throttled: boolean;
}

interface Candidate {
  address: string;
  symbol: string;
  live: boolean;
  shortlisted: boolean;
  txs5m: number;
  lastLiveAt: number;
}

/** Exported for tests: the tracked set for this cycle, and whether the cap bound. */
export function selectTracked(
  index: BarsIndex,
  board: readonly MemeBoardRow[] | null,
  shortlisted: ReadonlySet<string>,
  now: number,
): { tokens: Record<string, IndexEntry>; candidates: number; capped: boolean } {
  const candidates = new Map<string, Candidate>();
  for (const row of board ?? []) {
    const live = row.quote?.kind === "bstock" && (row.status === "runner" || row.status === "active");
    if (!live && !shortlisted.has(row.address)) continue;
    candidates.set(row.address, {
      address: row.address,
      symbol: row.symbol,
      live: true,
      shortlisted: shortlisted.has(row.address),
      txs5m: row.activity?.txs5m ?? 0,
      lastLiveAt: now,
    });
  }
  for (const [address, entry] of Object.entries(index.tokens)) {
    if (candidates.has(address) || now - entry.lastLiveAt > LEAVE_AFTER_MS) continue;
    candidates.set(address, { address, symbol: entry.symbol, live: false, shortlisted: false, txs5m: -1, lastLiveAt: entry.lastLiveAt });
  }
  const ordered = [...candidates.values()].sort(
    (a, b) =>
      Number(b.live) - Number(a.live) ||
      Number(b.shortlisted) - Number(a.shortlisted) ||
      b.txs5m - a.txs5m ||
      b.lastLiveAt - a.lastLiveAt ||
      a.address.localeCompare(b.address),
  );
  const kept = ordered.slice(0, MEME_BARS_CAP);
  const tokens: Record<string, IndexEntry> = {};
  for (const c of kept) {
    tokens[c.address] = { symbol: c.symbol, enteredAt: index.tokens[c.address]?.enteredAt ?? now, lastLiveAt: c.lastLiveAt };
  }
  return { tokens, candidates: ordered.length, capped: ordered.length > MEME_BARS_CAP };
}

/** Runs one cycle. Exported so tests and scripts can drive it directly. */
export async function runMemeBars(
  store: SnapshotStore,
  signal: AbortSignal,
  options: RunMemeBarsOptions = {},
): Promise<MemeBarsResult> {
  const now = (options.now ?? Date.now)();
  const fetchBars = options.fetchBars ?? ((address, limit, s) => fetchSintralMinuteBars({ address, limit, signal: s }));
  if (!await store.acquireSchedulerLease(MEME_BARS_LEASE, options.holder ?? HOLDER, 90_000)) {
    return { skipped: "lease_held", tracked: 0, candidates: 0, capped: false, calls: 0, failures: 0, throttled: false };
  }

  const index = await readIndex(store);
  const boardRecord = await store.get<unknown>(MEME_BOARD_KEY);
  const boardFresh = boardRecord !== null && boardRecord.staleness === "fresh" && Array.isArray(boardRecord.data);
  const board = boardFresh ? (boardRecord.data as MemeBoardRow[]) : null;
  let shortlisted = new Set<string>();
  if (board !== null) {
    const list = buildShortlist(
      board,
      parseShortlistQuery((name) => (name === "segment" ? "memestock" : undefined)),
      now,
      await loadStockInfo(store),
    );
    shortlisted = new Set(list.rows.map((row) => row.address));
  }
  // A board that is not fresh adds no one and refreshes no one's liveness; the
  // tracked tokens keep their bars until they age out.
  const selection = selectTracked(index, board, shortlisted, now);
  const lastClosed = lastClosedMinute(now);

  let calls = 0;
  let failures = 0;
  let throttled = false;
  const queue = Object.entries(selection.tokens);
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined || throttled || signal.aborted) return;
      const [address, entry] = next;
      try {
        const previous = await readSeries(store, address);
        if (previous !== null && previous.lastClosedStartMs >= lastClosed && previous.bars.length > 0) continue;
        calls += 1;
        const fetched = await fetchBars(address, fetchLimit(previous, lastClosed), signal);
        const rebuilt = rebuildSeries(previous, fetched, lastClosed);
        const series: BarSeries = {
          address,
          symbol: entry.symbol,
          source: MEME_BARS_SOURCE,
          unit: MEME_BARS_UNIT,
          lastClosedStartMs: lastClosed,
          bars: rebuilt.bars,
          seed: rebuilt.seed,
        };
        await store.put(memeBarsKey(address), series, {
          source: MEME_BARS_SOURCE,
          freshForMs: BARS_FRESH_MS,
          deadAfterMs: BARS_DEAD_MS,
        });
      } catch (error) {
        failures += 1;
        if (error instanceof AdapterError && error.status === 429) throttled = true;
        else if (failures <= 3) console.warn(`[${MEME_BARS_JOB}] ${address}: ${sanitizeMessage(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, queue.length) }, worker));

  const result = {
    tracked: Object.keys(selection.tokens).length,
    candidates: selection.candidates,
    capped: selection.capped,
    calls,
    failures,
    throttled,
  };
  const next: BarsIndex = { tokens: selection.tokens, lastCycle: { at: now, ...result, boardFresh } };
  await store.put(MEME_BARS_INDEX_KEY, next, { source: MEME_BARS_JOB, freshForMs: BARS_FRESH_MS, deadAfterMs: BARS_DEAD_MS });
  console.log(
    `[${MEME_BARS_JOB}] tracked=${result.tracked} calls=${calls} failures=${failures}` +
      (throttled ? " throttled=429" : "") +
      (selection.capped ? ` cap=${MEME_BARS_CAP} of ${selection.candidates}` : "") +
      (boardFresh ? "" : " board=not_fresh"),
  );
  if (calls > 0 && failures >= calls) throw new Error(`every bar read failed (${failures})`);
  return result;
}

async function readIndex(store: SnapshotStore): Promise<BarsIndex> {
  const data = (await store.get<unknown>(MEME_BARS_INDEX_KEY))?.data as Partial<BarsIndex> | undefined;
  const tokens: Record<string, IndexEntry> = {};
  if (typeof data?.tokens === "object" && data.tokens !== null) {
    for (const [address, value] of Object.entries(data.tokens)) {
      if (typeof value?.lastLiveAt === "number" && typeof value.enteredAt === "number") {
        tokens[address] = { symbol: typeof value.symbol === "string" ? value.symbol : "", enteredAt: value.enteredAt, lastLiveAt: value.lastLiveAt };
      }
    }
  }
  return { tokens, lastCycle: null };
}

async function readSeries(store: SnapshotStore, address: string): Promise<BarSeries | null> {
  const data = (await store.get<unknown>(memeBarsKey(address)))?.data;
  return isSeries(data) ? data : null;
}

function isSeries(value: unknown): value is BarSeries {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Partial<BarSeries>;
  return typeof s.lastClosedStartMs === "number" && Array.isArray(s.bars) && s.source === MEME_BARS_SOURCE;
}

// ─── Read side ───────────────────────────────────────────────────────────────

export interface MemeBarsView {
  address: string;
  tracked: boolean;
  symbol: string | null;
  source: typeof MEME_BARS_SOURCE | null;
  unit: typeof MEME_BARS_UNIT | null;
  asOf: number | null;
  staleness: "fresh" | "stale" | "dead" | null;
  lastClosedStartMs: number | null;
  bars: Array<{ startMs: number; open: number; high: number; low: number; close: number; volume: number; trades: number | null }>;
}

/**
 * One token's newest `limit` closed bars as objects. A token that was never
 * tracked answers `tracked: false` and no bars; one that left the tracked set
 * keeps serving its last series, its staleness saying how old it is.
 */
export async function readMemeBars(store: SnapshotStore, address: string, limit: number): Promise<MemeBarsView> {
  const record = await store.get<unknown>(memeBarsKey(address));
  if (record === null || !isSeries(record.data)) {
    return { address, tracked: false, symbol: null, source: null, unit: null, asOf: null, staleness: null, lastClosedStartMs: null, bars: [] };
  }
  const series = record.data;
  return {
    address,
    tracked: true,
    symbol: series.symbol,
    source: series.source,
    unit: series.unit,
    asOf: record.asOf,
    staleness: record.staleness,
    lastClosedStartMs: series.lastClosedStartMs,
    bars: series.bars.slice(-limit).map(([startMs, open, high, low, close, volume, trades]) => ({ startMs, open, high, low, close, volume, trades })),
  };
}

const HOLDER = randomUUID();

/** Job registration for the scheduler. */
export function memeBarsJob(store: SnapshotStore): JobSpec {
  return {
    name: MEME_BARS_JOB,
    intervalMs: MINUTE,
    jitterMs: 3_000,
    // Up to 120 Sintral reads, four at a time, ~0.2-0.3 s each.
    timeoutMs: 45_000,
    run: async (signal) => {
      await runMemeBars(store, signal);
    },
  };
}
