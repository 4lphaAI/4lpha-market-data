/**
 * Sector labels on bStocks — "Magnificent 7", "AI Chips", ... — from the
 * Binance Web3 RWA list's sector tabs.
 *
 * Two sources, deliberately different in kind:
 *
 * - **Fixed baskets** live in `data/bstock-sectors.json`, written by
 *   `scripts/gen-bstock-sectors.ts`. They are curated lists that do not move
 *   day to day, so they are frozen rather than polled (decision 2026-09-26).
 * - **`trending`** moves, so the `bstock-trending` job reads it once a day into
 *   {@link TRENDING_KEY}. It is a hint, never a trade signal, and carries its
 *   own `asOf` so a consumer can see how old the list is.
 *
 * The tab ids are not documented: the docs say only that the list "supports
 * filtering by sector tab", and the ids below were found by sweeping 0–160
 * (2026-09-26). The names are ours — the API returns no labels — inferred from
 * the tickers in each tab; four of them match the names on the hackathon page
 * (Magnificent 7, AI Chips, ETF, Buffett Portfolio). An unknown id answers with
 * the whole 488-row list instead of an error, which is why every read of a tab
 * is bounded by {@link MAX_SECTOR_ROWS}.
 *
 * A tab answers one row per *ticker*, and when both issuers list a ticker the
 * row is the Ondo token (tab 21 is MSFTon, AAPLon, ...; adding
 * `platformId=bstock` returns nothing). So tabs are read as tickers and matched
 * to bStocks by underlying ticker, never by the addresses in the tab.
 */

import { readFileSync } from "node:fs";
import type { SnapshotStore } from "../core/store.js";
import type { Staleness } from "../core/types.js";
import { normalizeAddress, sanitizeMessage } from "../adapters/http.js";

export interface SectorTab {
  tabId: number;
  /** Our name for the tab; not returned by the API. */
  label: string;
}

/** The fixed baskets, keyed by the label the plane serves. */
export const SECTOR_TABS = {
  mag7: { tabId: 21, label: "Magnificent 7" },
  "ai-chips": { tabId: 19, label: "AI Chips" },
  "big-tech": { tabId: 25, label: "Big Tech" },
  "crypto-stocks": { tabId: 23, label: "Crypto stocks" },
  memory: { tabId: 37, label: "Memory & storage" },
  etf: { tabId: 24, label: "ETF" },
  "sector-etf": { tabId: 66, label: "Sector ETF" },
  "space-defense": { tabId: 42, label: "Space & defense" },
  china: { tabId: 22, label: "China" },
  buffett: { tabId: 26, label: "Buffett Portfolio" },
} as const satisfies Record<string, SectorTab>;

export const TRENDING_SECTOR = "trending";
export const TRENDING_TAB: SectorTab = { tabId: 35, label: "Trending" };

export type Sector = keyof typeof SECTOR_TABS | typeof TRENDING_SECTOR;

export const SECTORS: readonly Sector[] = [...(Object.keys(SECTOR_TABS) as Sector[]), TRENDING_SECTOR];

export function isSector(value: string): value is Sector {
  return (SECTORS as readonly string[]).includes(value);
}

/**
 * Largest row count a real sector tab is believed to return. Measured tabs top
 * out at 92 on BSC; a renumbered id falls back to the full 488-row list, which
 * this refuses rather than labelling every stock.
 */
export const MAX_SECTOR_ROWS = 150;

/** Store key for the daily trending read. */
export const TRENDING_KEY = "rwa:trending";

/** The stored payload under {@link TRENDING_KEY}: uppercased underlying tickers. */
export interface TrendingSnapshot {
  tabId: number;
  tickers: string[];
}

/**
 * Daily read at 14:00 UTC — half an hour after the US regular session opens in
 * summer time (21:00 in Vietnam) — so the list reflects the session under way.
 */
export const TRENDING_SCAN_HOUR_UTC = 14;
/** Fresh until the next day's scan is due, plus slack for a slow cycle. */
export const TRENDING_FRESH_FOR_MS = 26 * 60 * 60_000;
/** A list three days old says nothing about what is trending. */
export const TRENDING_DEAD_AFTER_MS = 72 * 60 * 60_000;

/** The most recent scheduled scan at or before `nowMs`. */
export function lastTrendingMark(nowMs: number): number {
  const d = new Date(nowMs);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), TRENDING_SCAN_HOUR_UTC);
  return today <= nowMs ? today : today - 24 * 60 * 60_000;
}

/**
 * True when no read has happened since the last scheduled mark. Keyed off the
 * stored `asOf` rather than process uptime, so a restart neither skips a day
 * nor spends a second call on one.
 */
export function trendingScanDue(asOf: number | null, nowMs: number): boolean {
  return asOf === null || asOf < lastTrendingMark(nowMs);
}

interface StaticSectors {
  byAddress: Map<string, Sector[]>;
  generatedAt: string | null;
}

let staticCache: StaticSectors | null = null;
let staticError: string | null = null;

/**
 * Loads `data/bstock-sectors.json` once per process. Null on a missing or
 * malformed file — labels are enrichment, so the rows are served without them
 * rather than failing — logged once at load, like the allowlist.
 */
export function loadStaticSectors(): StaticSectors | null {
  if (staticCache !== null) return staticCache;
  if (staticError !== null) return null;
  try {
    const url = new URL("../../data/bstock-sectors.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
    const raw = parsed["byAddress"];
    if (typeof raw !== "object" || raw === null) throw new Error("file has no byAddress object");
    const byAddress = new Map<string, Sector[]>();
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const address = normalizeAddress(key);
      const sectors = (value as { sectors?: unknown } | null)?.sectors;
      if (address === null || !Array.isArray(sectors)) continue;
      const valid = sectors.filter((s): s is Sector => typeof s === "string" && isSector(s) && s !== TRENDING_SECTOR);
      if (valid.length > 0) byAddress.set(address, valid);
    }
    const meta = parsed["meta"] as Record<string, unknown> | undefined;
    staticCache = { byAddress, generatedAt: typeof meta?.["generatedAt"] === "string" ? meta["generatedAt"] : null };
    return staticCache;
  } catch (error) {
    staticError = sanitizeMessage(error instanceof Error ? error.message : String(error));
    console.warn(`[bstock-sectors] static sector file unreadable, serving without fixed labels: ${staticError}`);
    return null;
  }
}

export interface TrendingRead {
  tickers: Set<string>;
  staleness: Staleness | null;
  asOf: number | null;
}

/**
 * The stored trending list. A `dead` record contributes no labels — a list
 * that old would mislabel — but its age is still reported.
 */
export async function readTrending(store: SnapshotStore): Promise<TrendingRead> {
  const record = await store.get<unknown>(TRENDING_KEY);
  if (record === null) return { tickers: new Set(), staleness: null, asOf: null };
  const tickers = new Set<string>();
  const raw = (record.data as { tickers?: unknown } | null)?.tickers;
  if (record.staleness !== "dead" && Array.isArray(raw)) {
    for (const value of raw) if (typeof value === "string" && value !== "") tickers.add(value.toUpperCase());
  }
  return { tickers, staleness: record.staleness, asOf: record.asOf };
}

/**
 * The underlying ticker of a bStock row. RWA rows carry it; a static-floor row
 * has only its symbol, which for bStocks is the ticker plus a trailing `B`.
 */
export function bstockTicker(row: { symbol: string; underlyingTicker?: string | undefined }): string | null {
  if (row.underlyingTicker !== undefined && row.underlyingTicker !== "") return row.underlyingTicker.toUpperCase();
  return row.symbol.length > 1 && row.symbol.endsWith("B") ? row.symbol.slice(0, -1).toUpperCase() : null;
}

/** Labels for one bStock, fixed baskets first; empty when it belongs to none. */
export function sectorsFor(
  row: { address: string; symbol: string; underlyingTicker?: string | undefined },
  fixed: StaticSectors | null,
  trending: TrendingRead,
): Sector[] {
  const out: Sector[] = [...(fixed?.byAddress.get(row.address) ?? [])];
  const ticker = bstockTicker(row);
  if (ticker !== null && trending.tickers.has(ticker)) out.push(TRENDING_SECTOR);
  return out;
}
