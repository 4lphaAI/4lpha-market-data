/**
 * `spread-history` job — a 48-hour, minute-by-minute record of the two arb
 * spreads on tokenized stocks, read from the chain.
 *
 * Two point measurements (research §6–§7, 2026-09-17) showed pool-vs-pool
 * spreads of 3–24 bps against a 30 bps fee round trip, and Ondo pool-vs-NAV
 * discounts of 70–158 bps. Neither number says how often the spread clears
 * cost or for how long; this series does. Nothing here trades, gates or
 * alerts — it is telemetry for the operator's decision and, later, an agent's
 * signal.
 *
 * Pool prices are `slot0` reads through the plane's own price math, not
 * DexScreener's minutes-old figure, because the whole point is to catch
 * minutes. Only stable-quoted (USDT/USDC) v3 venues are watched so USDT≈USDC
 * is the one assumption; a WBNB-quoted pool would import that pool's drift.
 */

import type { RwaToken, Venue } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import { normalizeAddress } from "../adapters/http.js";
import { RWA_UNIVERSE_KEY, RWA_VENUES_KEY } from "../universe.js";
import {
  MAJOR_TOKENS,
  priceFromSqrtPriceX96,
  readPoolSlot0sOnchain,
  scaledToNumber,
  type PoolSlot0,
  type PricePool,
  type ReadPoolSlot0s,
} from "./majorsPrices.js";
import type { RwaUniverseSnapshot } from "./binanceRwa.js";

export const SPREAD_HISTORY_JOB = "spread-history";
export const SPREAD_HISTORY_KEY = "spread:history";
export const SPREAD_HISTORY_SOURCE = "slot0+binance-rwa";

/** History, not a reading: a dead record still serves its points. */
export const SPREAD_FRESH_FOR_MS = 5 * 60_000;
export const SPREAD_DEAD_AFTER_MS = 24 * 60 * 60_000;
/** Points older than this are dropped on write. */
export const SPREAD_RETENTION_MS = 48 * 60 * 60_000;
/** A venue must be this deep to be watched. Reported in `meta`, never applied to a verdict. */
export const SPREAD_MIN_LIQUIDITY_USD = 10_000;

/** USDT/USDC on BSC — the quotes that make a pool price a USD price. */
const STABLE_QUOTES = new Map(
  MAJOR_TOKENS.filter((t) => t.symbol === "USDT" || t.symbol === "USDC").map((t) => [t.address, t.decimals]),
);

export interface WatchedVenue {
  pool: string;
  dex: Venue["dex"];
  version: "v3";
  feeTier: number;
  quote: string;
  liquidityUsd: number;
  /** Resolved once from the chain, then cached here. */
  token0: string | null;
  token1: string | null;
}

/** `[tsMs, navBps, crossBps | null, feeBps | null, liqA, liqB | null]` */
export type SpreadPoint = [number, number, number | null, number | null, number, number | null];

export interface SpreadSeries {
  symbol: string;
  platform: string;
  underlyingTicker: string | null;
  venues: WatchedVenue[];
  points: SpreadPoint[];
}

export interface SpreadHistorySnapshot {
  byAddress: Record<string, SpreadSeries>;
  cursorTs: number;
}

export interface RunSpreadHistoryOptions {
  readSlot0s?: ReadPoolSlot0s | undefined;
  now?: (() => number) | undefined;
}

export interface SpreadHistoryCycle {
  watched: number;
  pointsWritten: number;
  poolsRead: number;
  poolsMissing: number;
}

/** Exported for tests: the ≤ 2 venues a token is watched on. */
export function selectWatchedVenues(venues: Venue[] | undefined): WatchedVenue[] {
  const out: WatchedVenue[] = [];
  for (const v of venues ?? []) {
    if (v.version !== "v3" || v.feeTier === null) continue;
    if (!STABLE_QUOTES.has(v.quote.address)) continue;
    if (v.liquidityUsd === null || v.liquidityUsd < SPREAD_MIN_LIQUIDITY_USD) continue;
    out.push({ pool: v.pool, dex: v.dex, version: "v3", feeTier: v.feeTier, quote: v.quote.address, liquidityUsd: v.liquidityUsd, token0: null, token1: null });
  }
  out.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  return out.slice(0, 2);
}

/**
 * Exported for tests: the stock's USD price from a pool's `slot0`, given which
 * side the stock is on. `null` when the pool does not contain the stock and
 * its stable quote as its two tokens.
 */
export function stockPriceFromSlot0(
  state: PoolSlot0,
  stock: string,
  stockDecimals: number,
  quote: string,
): number | null {
  const quoteDecimals = STABLE_QUOTES.get(quote);
  if (quoteDecimals === undefined) return null;
  const stockIs0 = state.token0 === stock && state.token1 === quote;
  const stockIs1 = state.token1 === stock && state.token0 === quote;
  if (!stockIs0 && !stockIs1) return null;
  if (state.sqrtPriceX96 <= 0n) return null;
  const scaled = priceFromSqrtPriceX96({
    sqrtPriceX96: state.sqrtPriceX96,
    decimals0: stockIs0 ? stockDecimals : quoteDecimals,
    decimals1: stockIs0 ? quoteDecimals : stockDecimals,
    wanted: stockIs0 ? "token0" : "token1",
  });
  return scaledToNumber(scaled);
}

function bps(ratio: number): number {
  return Math.round((ratio - 1) * 10_000) || 0; // `|| 0` turns -0 into 0
}

/** Exported for tests: one token's point from its answered pools. */
export function computePoint(
  ts: number,
  token: RwaToken,
  venues: WatchedVenue[],
  slot0s: Map<string, PoolSlot0>,
): SpreadPoint | null {
  const [a, b] = venues;
  if (a === undefined) return null;
  const ref = token.referencePriceUsd;
  const ratio = token.tokenToShareRatio;
  if (ref === null || !(ref > 0) || ratio === null || !(ratio > 0)) return null;
  const decimals = token.decimals ?? 18;

  const stateA = slot0s.get(a.pool);
  if (stateA === undefined) return null;
  const priceA = stockPriceFromSlot0(stateA, token.address, decimals, a.quote);
  if (priceA === null || !(priceA > 0)) return null;
  const navBps = bps(priceA / (ref * ratio));

  let crossBps: number | null = null;
  let feeBps: number | null = null;
  let liqB: number | null = null;
  if (b !== undefined) {
    const stateB = slot0s.get(b.pool);
    const priceB = stateB === undefined ? null : stockPriceFromSlot0(stateB, token.address, decimals, b.quote);
    if (priceB !== null && priceB > 0) {
      crossBps = Math.abs(bps(priceA / priceB));
      feeBps = Math.round((a.feeTier + b.feeTier) / 100);
      liqB = b.liquidityUsd;
    }
  }
  return [ts, navBps, crossBps, feeBps, a.liquidityUsd, liqB];
}

/** Re-validated on read; a malformed series is dropped rather than trusted. */
export function normalizeSpreadHistory(data: unknown): SpreadHistorySnapshot {
  const out: SpreadHistorySnapshot = { byAddress: {}, cursorTs: 0 };
  if (typeof data !== "object" || data === null) return out;
  const d = data as Record<string, unknown>;
  if (typeof d["cursorTs"] === "number") out.cursorTs = d["cursorTs"];
  const by = d["byAddress"];
  if (typeof by !== "object" || by === null) return out;
  for (const [raw, value] of Object.entries(by as Record<string, unknown>)) {
    const address = normalizeAddress(raw);
    if (address === null || typeof value !== "object" || value === null) continue;
    const s = value as Record<string, unknown>;
    if (typeof s["symbol"] !== "string" || !Array.isArray(s["points"]) || !Array.isArray(s["venues"])) continue;
    const points = (s["points"] as unknown[]).filter(
      (p): p is SpreadPoint => Array.isArray(p) && p.length === 6 && typeof p[0] === "number" && typeof p[1] === "number",
    );
    out.byAddress[address] = {
      symbol: s["symbol"],
      platform: typeof s["platform"] === "string" ? s["platform"] : "unknown",
      underlyingTicker: typeof s["underlyingTicker"] === "string" ? s["underlyingTicker"] : null,
      venues: (s["venues"] as WatchedVenue[]).filter((v) => typeof v === "object" && v !== null && typeof v.pool === "string"),
      points,
    };
  }
  return out;
}

async function readRwaRows(store: SnapshotStore): Promise<RwaToken[]> {
  const record = await store.get<RwaUniverseSnapshot>(RWA_UNIVERSE_KEY);
  if (record === null || record.staleness !== "fresh") return [];
  return Array.isArray(record.data?.rows) ? record.data.rows : [];
}

async function readVenues(store: SnapshotStore): Promise<Map<string, Venue[]>> {
  const out = new Map<string, Venue[]>();
  const record = await store.get<{ byAddress?: Record<string, Venue[]> }>(RWA_VENUES_KEY);
  const by = record?.data?.byAddress;
  if (typeof by !== "object" || by === null) return out;
  for (const [raw, venues] of Object.entries(by)) {
    const address = normalizeAddress(raw);
    if (address !== null && Array.isArray(venues)) out.set(address, venues);
  }
  return out;
}

/** Runs one cycle. Exported so tests and scripts can drive it directly. */
export async function runSpreadHistory(
  store: SnapshotStore,
  signal: AbortSignal,
  options: RunSpreadHistoryOptions = {},
): Promise<SpreadHistoryCycle> {
  const now = options.now ?? (() => Date.now());
  const readSlot0s = options.readSlot0s ?? readPoolSlot0sOnchain;

  const rows = await readRwaRows(store);
  const venuesByAddress = await readVenues(store);
  const previous = normalizeSpreadHistory((await store.get<unknown>(SPREAD_HISTORY_KEY))?.data);

  // Watch set: every fresh RWA row with at least one stable-quoted v3 venue ≥ floor.
  const watched: Array<{ token: RwaToken; venues: WatchedVenue[] }> = [];
  for (const token of rows) {
    const selected = selectWatchedVenues(venuesByAddress.get(token.address));
    if (selected.length === 0) continue;
    // Keep token0/token1 already resolved for the same pool.
    const known = previous.byAddress[token.address]?.venues ?? [];
    for (const v of selected) {
      const k = known.find((x) => x.pool === v.pool);
      if (k !== undefined) { v.token0 = k.token0; v.token1 = k.token1; }
    }
    watched.push({ token, venues: selected });
  }
  if (watched.length === 0) {
    return { watched: 0, pointsWritten: 0, poolsRead: 0, poolsMissing: 0 };
  }

  const pools: PricePool[] = [];
  for (const w of watched) for (const v of w.venues) pools.push({ pool: v.pool, token0: "", token1: "", base: w.token.address, quote: v.quote });
  const answered = await readSlot0s(pools, signal);
  if (answered.length === 0) throw new Error(`no pool answered (${pools.length} asked)`);
  const slot0s = new Map(answered.map((s) => [s.pool.toLowerCase(), s]));

  const ts = now();
  const cutoff = ts - SPREAD_RETENTION_MS;
  const byAddress: Record<string, SpreadSeries> = {};
  let pointsWritten = 0;
  for (const w of watched) {
    for (const v of w.venues) {
      const s = slot0s.get(v.pool);
      if (s !== undefined) { v.token0 = s.token0; v.token1 = s.token1; }
    }
    const point = computePoint(ts, w.token, w.venues, slot0s);
    const old = previous.byAddress[w.token.address]?.points ?? [];
    const points = old.filter((p) => p[0] >= cutoff);
    if (point !== null) { points.push(point); pointsWritten++; }
    byAddress[w.token.address] = {
      symbol: w.token.symbol,
      platform: w.token.platform,
      underlyingTicker: w.token.underlyingTicker,
      venues: w.venues,
      points,
    };
  }
  // Tokens that dropped out of the watch set keep their history until it ages out.
  for (const [address, series] of Object.entries(previous.byAddress)) {
    if (byAddress[address] !== undefined) continue;
    const points = series.points.filter((p) => p[0] >= cutoff);
    if (points.length > 0) byAddress[address] = { ...series, points };
  }

  const snapshot: SpreadHistorySnapshot = { byAddress, cursorTs: ts };
  await store.put(SPREAD_HISTORY_KEY, snapshot, {
    source: SPREAD_HISTORY_SOURCE,
    freshForMs: SPREAD_FRESH_FOR_MS,
    deadAfterMs: SPREAD_DEAD_AFTER_MS,
  });
  return { watched: watched.length, pointsWritten, poolsRead: answered.length, poolsMissing: pools.length - answered.length };
}

// ─── Read side ───────────────────────────────────────────────────────────────

export interface SpreadSummary {
  address: string;
  symbol: string;
  platform: string;
  underlyingTicker: string | null;
  venues: WatchedVenue[];
  samples: number;
  latest: { ts: number; navBps: number; crossBps: number | null; feeBps: number | null } | null;
  navBps: { min: number; p50: number; max: number } | null;
  crossBps: { p50: number; max: number } | null;
  feeBps: number | null;
  /** Minutes in the window where the cross-venue spread exceeded the fee round trip. */
  minutesAboveFee: number;
  /** Minutes in the window where |NAV spread| exceeded the deepest venue's own fee. */
  minutesNavBeyondFee: number;
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

/** Exported for tests and the routes: the window summary for one series. */
export function summarizeSeries(address: string, series: SpreadSeries, sinceTs: number): SpreadSummary {
  const points = series.points.filter((p) => p[0] >= sinceTs);
  const last = points[points.length - 1];
  const navs = points.map((p) => p[1]).sort((a, b) => a - b);
  const crosses = points.map((p) => p[2]).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const feeBps = last?.[3] ?? null;
  const deepestFeeBps = series.venues[0] === undefined ? null : Math.round(series.venues[0].feeTier / 100);
  return {
    address,
    symbol: series.symbol,
    platform: series.platform,
    underlyingTicker: series.underlyingTicker,
    venues: series.venues,
    samples: points.length,
    latest: last === undefined ? null : { ts: last[0], navBps: last[1], crossBps: last[2], feeBps: last[3] },
    navBps: navs.length === 0 ? null : { min: navs[0]!, p50: quantile(navs, 0.5), max: navs[navs.length - 1]! },
    crossBps: crosses.length === 0 ? null : { p50: quantile(crosses, 0.5), max: crosses[crosses.length - 1]! },
    feeBps,
    minutesAboveFee: points.filter((p) => p[2] !== null && p[3] !== null && p[2] > p[3]).length,
    minutesNavBeyondFee: deepestFeeBps === null ? 0 : points.filter((p) => Math.abs(p[1]) > deepestFeeBps).length,
  };
}

/**
 * True when the operator has switched the sweep on. Off by default since
 * 2026-09-19: the operator decided not to pursue arbitrage after the 48 h
 * read (research §8), so the minute-by-minute chain read stopped earning its
 * keep. The job stays registered — `/status` still lists it and `/spreads`
 * still serves whatever history is stored — but a disabled job is a no-op
 * once an hour, not one multicall a minute.
 */
export function isSpreadHistoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["SPREAD_HISTORY_ENABLED"] === "true";
}

/** Job registration for the scheduler. */
export function spreadHistoryJob(store: SnapshotStore): JobSpec {
  const enabled = isSpreadHistoryEnabled();
  return {
    name: SPREAD_HISTORY_JOB,
    intervalMs: enabled ? 60_000 : 60 * 60_000,
    jitterMs: 3_000,
    timeoutMs: 15_000,
    run: async (signal) => {
      if (!enabled) return;
      const result = await runSpreadHistory(store, signal);
      if (result.poolsMissing > 0) {
        console.warn(`[${SPREAD_HISTORY_JOB}] ${result.poolsMissing} of ${result.poolsRead + result.poolsMissing} pools did not answer`);
      }
    },
  };
}
