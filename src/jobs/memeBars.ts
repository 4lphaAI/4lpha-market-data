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
 * lists only minutes that traded, and keeps changing a minute's bar briefly
 * after the minute ends, so a minute counts as closed {@link SETTLE_MS} after
 * its end and the last {@link REFRESH_TAIL} closed minutes are re-read every
 * cycle (a late trade corrects a bar rather than being lost).
 *
 * Latency (MEME-BARS-LATENCY-HANDOFF-2026-10-05): the job is scheduled to run
 * {@link SETTLE_MS} after every minute ends ({@link msUntilNextRun}), so each
 * minute is read once, right after it closes, instead of up to a full 60 s
 * cycle later. There are no idle runs, so `/status` health is the real cycle's.
 * Each cycle counts the closed bars its re-read changed (`corrected`). Measured
 * 2026-10-05 (`scripts/meme-bars-corrections-probe.ts`, 10 cycles, ~75 tokens):
 * 0-3 per cycle, and every one was Sintral narrowing a wick after the fact —
 * high or low pulled back to max/min(open, close), 0.5-6%, 1-4 min after the
 * close — never trades, volume or close, and never a widening. That is the
 * source revising, not the close delay being short: 45 s would see it too. Missing minutes
 * are zero-filled explicitly — `trades: 0`, `volume: 0`, OHLC at the previous
 * close — so a flat chart reads as silence, not as a gap. Each token keeps the
 * last {@link MEME_BARS_KEEP} closed minutes, backfilled on entry and extended
 * incrementally after that.
 *
 * Budget: one Sintral call per tracked token per minute, four at a time through
 * the shared Binance-host limiter. A 429 stops the cycle's remaining calls and
 * backs the job off across cycles — 2, 4, 8, then 10 minutes while the host keeps
 * throttling — so a throttled host is not hit again at full width a minute later
 * (the skipped tokens age toward stale; nothing is invented). A token Sintral
 * does not know is asked again only every 10 minutes. Every cycle logs its call
 * count, failures and whether it was throttled.
 *
 * A token that leaves the tracked set keeps its series for {@link BARS_DEAD_MS}
 * (it reads `tracked: false`, its staleness ageing), then its key is deleted, so
 * per-token keys do not accumulate as meme stocks churn.
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
/**
 * A minute is closed this long after its end. Measured 2026-10-05
 * (`scripts/sintral-settle-probe.ts`, 61 traded bars over three minutes): 57/61
 * final at +6 s, 58/61 at +10 s, 61/61 at +15 s and every later offset; an
 * independent probe of one busy token saw a last change at +15.0 s. 20 s keeps a
 * margin past that, and with runs aligned to the close (no tick phase) the read
 * lag still meets the handoff's p50 60 s / p90 90 s. A later change is corrected
 * by the {@link REFRESH_TAIL} re-read and counted as `corrected`.
 */
export const SETTLE_MS = 20_000;

/** Delay from `now` to the next run: {@link SETTLE_MS} after the next minute end. */
export function msUntilNextRun(now: number): number {
  let target = Math.floor(now / MINUTE) * MINUTE + SETTLE_MS;
  // Half a second of slack so a run that fires a little early does not schedule itself again at once.
  if (target <= now + 500) target += MINUTE;
  return target - now;
}
/** Closed minutes re-read every cycle, so a late-published trade corrects its bar. */
export const REFRESH_TAIL = 3;
export const LEAVE_AFTER_MS = 30 * 60_000;
/** Same freshness convention as the board. */
export const BARS_FRESH_MS = 3 * 60_000;
export const BARS_DEAD_MS = 30 * 60_000;
const WORKERS = 4;
const MINUTE = 60_000;

/** Backoff after a throttled cycle: 2, 4, 8, then 10 minutes while it keeps happening. */
export function backoffMs(streak: number): number {
  return Math.min(10 * MINUTE, 2 * MINUTE * 2 ** Math.max(0, streak - 1));
}
/** A tracked token Sintral answered with no bar at all is asked again after this long. */
export const UNKNOWN_RETRY_MS = 10 * MINUTE;

export const memeBarsKey = (address: string): string => `memes:bars:v1:${address.toLowerCase()}`;

/**
 * `[startMs, open, high, low, close, volumeUsd, trades, filled]`; `filled` is 1
 * for a zero-filled minute (`trades: 0`, volume 0, OHLC at the previous close),
 * 0 for a minute Sintral reported. Marked, not inferred, so a reported bar can
 * never be mistaken for a fill.
 */
export type StoredBar = [number, number, number, number, number, number, number | null, 0 | 1];

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
  /** When Sintral was last asked for this token. */
  checkedAt: number;
}

interface IndexEntry {
  symbol: string;
  enteredAt: number;
  lastLiveAt: number;
}

export interface BarsIndex {
  tokens: Record<string, IndexEntry>;
  /** Tokens that left the tracked set, by when; their series key is deleted {@link BARS_DEAD_MS} later. */
  departed: Record<string, number>;
  /** Set after a throttled cycle: no Sintral call before `until`. */
  backoff: { until: number; streak: number } | null;
  /** The newest closed minute a cycle has already been run for; ticks before the next one do nothing. */
  closedThrough: number | null;
  lastCycle: {
    at: number;
    tracked: number;
    candidates: number;
    capped: boolean;
    calls: number;
    failures: number;
    throttled: boolean;
    corrected: number;
    boardFresh: boolean;
  } | null;
}

/** Start of the newest closed minute at `now`. */
export function lastClosedMinute(now: number): number {
  return Math.floor((now - MINUTE - SETTLE_MS) / MINUTE) * MINUTE;
}

const isFilled = (bar: StoredBar): boolean => bar[7] === 1;

/** Eight significant digits: past Sintral's own precision, about 40% fewer bytes than its 17-20. */
const r8 = (value: number): number => (value === 0 ? 0 : Number(value.toPrecision(8)));

function toStored(bar: SintralMinuteBar): StoredBar {
  return [bar.startMs, r8(bar.open), r8(bar.high), r8(bar.low), r8(bar.close), r8(bar.volumeUsd), bar.trades, 0];
}

/** Reads a seven-element bar written before the `filled` flag existed. */
function upgrade(bar: StoredBar): StoredBar {
  return bar.length >= 8 ? bar : ([...bar.slice(0, 7), bar[6] === 0 && bar[5] === 0 ? 1 : 0] as StoredBar);
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
  if (previous?.seed) traded.set(previous.seed[0], upgrade(previous.seed));
  for (const raw of previous?.bars ?? []) {
    const bar = upgrade(raw);
    if (!isFilled(bar)) traded.set(bar[0], bar);
  }
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
      bars.push([minute, close, close, close, close, 0, 0, 1]);
    }
  }
  return { bars, seed };
}

/**
 * Exported for tests: closed minutes already served whose bar the rebuild
 * changed — a trade Sintral published after the close delay.
 */
export function countCorrections(previous: Pick<BarSeries, "bars" | "lastClosedStartMs"> | null, rebuilt: readonly StoredBar[]): number {
  if (previous === null) return 0;
  const before = new Map(previous.bars.map((bar) => [bar[0], JSON.stringify(bar)]));
  let changed = 0;
  for (const bar of rebuilt) {
    if (bar[0] > previous.lastClosedStartMs) continue;
    const old = before.get(bar[0]);
    if (old !== undefined && old !== JSON.stringify(bar)) changed += 1;
  }
  return changed;
}

/**
 * How many Sintral rows to ask for: everything on entry, the gap plus the
 * re-read tail after that. `+ 2` everywhere: the newest two rows are the minute
 * in progress and the one still settling, so a full window needs 182 rows.
 */
export function fetchLimit(previous: BarSeries | null, lastClosed: number): number {
  const full = MEME_BARS_KEEP + 2;
  if (previous === null || previous.bars.length === 0) return full;
  const gap = Math.max(0, Math.round((lastClosed - previous.lastClosedStartMs) / MINUTE));
  return Math.min(full, Math.max(5, gap + REFRESH_TAIL + 2));
}

export interface RunMemeBarsOptions {
  fetchBars?: ((address: string, limit: number, signal: AbortSignal) => Promise<SintralMinuteBar[]>) | undefined;
  now?: (() => number) | undefined;
  holder?: string | undefined;
}

export interface MemeBarsResult {
  skipped?: "lease_held" | "backoff" | "up_to_date";
  tracked: number;
  candidates: number;
  capped: boolean;
  calls: number;
  failures: number;
  throttled: boolean;
  /** Closed bars already served that this cycle's re-read changed. */
  corrected: number;
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
  const lastClosed = lastClosedMinute(now);
  const index = await readIndex(store);
  const idle = { tracked: Object.keys(index.tokens).length, candidates: 0, capped: false, calls: 0, failures: 0, throttled: false, corrected: 0 };
  // A restart or a second replica inside the same minute: already read.
  if (index.closedThrough !== null && index.closedThrough >= lastClosed) return { skipped: "up_to_date", ...idle };
  // Silent: the throttled cycle already logged when it started backing off.
  if (index.backoff !== null && now < index.backoff.until) return { skipped: "backoff", ...idle };
  if (!await store.acquireSchedulerLease(MEME_BARS_LEASE, options.holder ?? HOLDER, 90_000)) {
    return { skipped: "lease_held", ...idle, tracked: 0 };
  }
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

  let calls = 0;
  let failures = 0;
  let throttled = false;
  let corrected = 0;
  const queue = Object.entries(selection.tokens);
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined || throttled || signal.aborted) return;
      const [address, entry] = next;
      try {
        const previous = await readSeries(store, address);
        if (previous !== null && previous.lastClosedStartMs >= lastClosed && previous.bars.length > 0) continue;
        // Sintral has never had a bar for it: ask again only now and then.
        if (previous !== null && previous.bars.length === 0 && now - (previous.checkedAt ?? 0) < UNKNOWN_RETRY_MS) continue;
        calls += 1;
        const fetched = await fetchBars(address, fetchLimit(previous, lastClosed), signal);
        const rebuilt = rebuildSeries(previous, fetched, lastClosed);
        corrected += countCorrections(previous, rebuilt.bars);
        const series: BarSeries = {
          address,
          symbol: entry.symbol,
          source: MEME_BARS_SOURCE,
          unit: MEME_BARS_UNIT,
          lastClosedStartMs: lastClosed,
          bars: rebuilt.bars,
          seed: rebuilt.seed,
          checkedAt: now,
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
    corrected,
  };
  // Departures: a token that left keeps its series for BARS_DEAD_MS, then its key goes.
  const departed: Record<string, number> = {};
  for (const [address, leftAt] of Object.entries(index.departed)) {
    if (address in selection.tokens) continue;
    if (now - leftAt > BARS_DEAD_MS) await store.delete(memeBarsKey(address));
    else departed[address] = leftAt;
  }
  for (const address of Object.keys(index.tokens)) {
    if (!(address in selection.tokens) && departed[address] === undefined) departed[address] = now;
  }
  const streak = throttled ? (index.backoff?.streak ?? 0) + 1 : 0;
  const backoff = throttled ? { until: now + backoffMs(streak), streak } : null;
  // A minute is read once: a token that failed waits for the next minute (its
  // re-read tail catches it up) rather than retrying at once against a failing host.
  const next: BarsIndex = { tokens: selection.tokens, departed, backoff, closedThrough: lastClosed, lastCycle: { at: now, ...result, boardFresh } };
  if (throttled) console.log(`[${MEME_BARS_JOB}] 429: backing off until ${new Date(backoff!.until).toISOString()}`);
  await store.put(MEME_BARS_INDEX_KEY, next, { source: MEME_BARS_JOB, freshForMs: BARS_FRESH_MS, deadAfterMs: BARS_DEAD_MS });
  console.log(
    `[${MEME_BARS_JOB}] tracked=${result.tracked} calls=${calls} failures=${failures}` +
      (throttled ? " throttled=429" : "") +
      (corrected > 0 ? ` corrected=${corrected}` : "") +
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
  const departed: Record<string, number> = {};
  if (typeof data?.departed === "object" && data.departed !== null) {
    for (const [address, at] of Object.entries(data.departed)) if (typeof at === "number") departed[address] = at;
  }
  const b = data?.backoff;
  const backoff = typeof b?.until === "number" && typeof b.streak === "number" ? { until: b.until, streak: b.streak } : null;
  const closedThrough = typeof data?.closedThrough === "number" ? data.closedThrough : null;
  return { tokens, departed, backoff, closedThrough, lastCycle: null };
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
  bars: Array<{ startMs: number; open: number; high: number; low: number; close: number; volume: number; trades: number | null; filled: boolean }>;
}

/** The tracked set as the job last wrote it, for the read routes. */
export async function readTrackedSet(store: SnapshotStore): Promise<ReadonlySet<string>> {
  return new Set(Object.keys((await readIndex(store)).tokens));
}

/**
 * One token's newest `limit` closed bars as objects. `tracked` says whether the
 * job is keeping the token now; a token that left still serves its last series
 * for 30 minutes with `tracked: false` and its staleness ageing, then has none.
 */
export async function readMemeBars(
  store: SnapshotStore,
  address: string,
  limit: number,
  tracked: ReadonlySet<string>,
): Promise<MemeBarsView> {
  const record = await store.get<unknown>(memeBarsKey(address));
  if (record === null || !isSeries(record.data)) {
    return { address, tracked: tracked.has(address), symbol: null, source: null, unit: null, asOf: null, staleness: null, lastClosedStartMs: null, bars: [] };
  }
  const series = record.data;
  return {
    address,
    tracked: tracked.has(address),
    symbol: series.symbol,
    source: series.source,
    unit: series.unit,
    asOf: record.asOf,
    staleness: record.staleness,
    lastClosedStartMs: series.lastClosedStartMs,
    bars: series.bars.slice(-limit).map((raw) => {
      const [startMs, open, high, low, close, volume, trades, filled] = upgrade(raw);
      return { startMs, open, high, low, close, volume, trades, filled: filled === 1 };
    }),
  };
}

const HOLDER = randomUUID();

/** Job registration for the scheduler. */
export function memeBarsJob(store: SnapshotStore): JobSpec {
  return {
    name: MEME_BARS_JOB,
    // Runs SETTLE_MS after every minute end (see the latency note above).
    intervalMs: MINUTE,
    nextDelayMs: msUntilNextRun,
    // Up to 120 Sintral reads, four at a time, ~0.2-0.3 s each.
    timeoutMs: 45_000,
    run: async (signal) => {
      await runMemeBars(store, signal);
    },
  };
}
