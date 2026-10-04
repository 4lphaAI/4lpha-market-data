/**
 * Meme stocks grouped by their stock — `GET /memes/stocks`.
 *
 * A meme stock is a Four.Meme or Flap token whose curve/pair is quoted in a
 * bStock (`quote.kind == "bstock"`, decided on chain by the issuer's admin
 * role). Measured 2026-10-04 about half of the meme board is quoted that way,
 * spread over a dozen stocks (BNCB, SPCXB, NVDAB, QQQB, AAPLB, SKHYB…). The
 * question this answers is the narrative one — *which stock's memes are
 * running right now* — so each stock gets its meme counts by status, the live
 * memes' summed activity, and its top memes in shortlist shape.
 *
 * Read-time only: a pure fold over the classified board plus the stock's own
 * row from `universe:rwa`. No job, no upstream call.
 */

import type { RwaToken } from "../core/models.js";
import type { MemeLaunchpad } from "../adapters/binanceWeb3.js";
import { MEME_STATUSES, type MemeBoardRow, type MemeFlag, type MemeStatus } from "./memeClassify.js";
import {
  MemeQueryError,
  compareShortlist,
  smartMoneyCount,
  toShortlistRow,
  type MemeShortlistRow,
} from "./memeQuery.js";

/**
 * What makes a meme "live" for the counts: trading for real (runner/active)
 * and not churned or wash-traded — volume that is not demand would make a
 * stock look hot on nothing. Same screen as the shortlist, minus `smart_exit`,
 * which is a reason not to buy a meme, not a reason to stop counting it.
 */
export const MEME_STOCK_RULES = {
  liveStatuses: ["runner", "active"] as readonly MemeStatus[],
  liveExcludeFlags: ["churn", "wash_trading"] as readonly MemeFlag[],
  topPerStock: 3,
  newWindowMinutes: 60,
} as const;

export const MEME_STOCK_ORDER_FIELDS = ["volume1hUsd", "live", "txs5m", "new1h", "smartMoney"] as const;
export type MemeStockOrderField = (typeof MEME_STOCK_ORDER_FIELDS)[number];

export interface MemeStockGroup {
  stock: {
    address: string;
    symbol: string | null;
    underlyingTicker: string | null;
    /** Binance's NAV price for the stock token; `null` when Binance has no row for it. */
    priceUsd: number | null;
    openState: boolean | null;
    /** False for issuer bStocks Binance's RWA snapshot does not carry (e.g. BNCB). */
    inRwaSnapshot: boolean;
  };
  memes: {
    total: number;
    live: number;
    byStatus: Record<MemeStatus, number>;
    /** Live memes per launchpad. */
    liveByLaunchpad: Record<MemeLaunchpad, number>;
    /** Memes created in the last hour, any status. */
    new1h: number;
  };
  /** Summed over live memes only. */
  activity: { txs5m: number; txs1h: number; volume5mUsd: number; volume1hUsd: number; smartMoney: number };
  top: MemeShortlistRow[];
}

export interface MemeStockQuery {
  orderBy: MemeStockOrderField;
  minLive: number;
  limit: number;
}

export function parseMemeStockQuery(get: (name: string) => string | undefined): MemeStockQuery {
  const orderRaw = get("orderBy");
  if (orderRaw !== undefined && orderRaw !== "" && !(MEME_STOCK_ORDER_FIELDS as readonly string[]).includes(orderRaw)) {
    throw new MemeQueryError(`orderBy must be one of ${MEME_STOCK_ORDER_FIELDS.join(", ")}`);
  }
  const minLive = integerParam(get("minLive"), "minLive", 0);
  const limit = integerParam(get("limit"), "limit", 1);
  return {
    orderBy: (orderRaw === undefined || orderRaw === "" ? "volume1hUsd" : orderRaw) as MemeStockOrderField,
    minLive: minLive ?? 0,
    limit: Math.min(limit ?? 50, 100),
  };
}

function integerParam(raw: string | undefined, name: string, min: number): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new MemeQueryError(`${name} must be an integer >= ${min}`);
  return value;
}

export function isLiveMeme(row: MemeBoardRow): boolean {
  return (
    MEME_STOCK_RULES.liveStatuses.includes(row.status) &&
    !MEME_STOCK_RULES.liveExcludeFlags.some((flag) => row.flags.includes(flag))
  );
}

export function groupMemesByStock(
  rows: readonly MemeBoardRow[],
  stocks: ReadonlyMap<string, RwaToken>,
  query: MemeStockQuery,
  now: number,
): MemeStockGroup[] {
  const byStock = new Map<string, MemeBoardRow[]>();
  for (const row of rows) {
    if (row.quote.kind !== "bstock" || row.quote.address === null) continue;
    const list = byStock.get(row.quote.address) ?? [];
    list.push(row);
    byStock.set(row.quote.address, list);
  }

  const groups: MemeStockGroup[] = [];
  for (const [address, memes] of byStock) {
    const live = memes.filter(isLiveMeme);
    const byStatus = Object.fromEntries(MEME_STATUSES.map((status) => [status, 0])) as Record<MemeStatus, number>;
    for (const meme of memes) byStatus[meme.status] += 1;
    const sum = (pick: (row: MemeBoardRow) => number | null | undefined) =>
      live.reduce((total, row) => total + (pick(row) ?? 0), 0);
    const rwa = stocks.get(address);
    groups.push({
      stock: {
        address,
        symbol: rwa?.symbol ?? memes.find((meme) => meme.quote.symbol !== null)?.quote.symbol ?? null,
        underlyingTicker: rwa?.underlyingTicker ?? null,
        priceUsd: rwa?.tokenPriceUsd ?? null,
        openState: rwa?.openState ?? null,
        inRwaSnapshot: rwa !== undefined,
      },
      memes: {
        total: memes.length,
        live: live.length,
        byStatus,
        liveByLaunchpad: {
          flap: live.filter((row) => row.launchpad === "flap").length,
          fourmeme: live.filter((row) => row.launchpad === "fourmeme").length,
        },
        new1h: memes.filter((row) => now - row.createdAt <= MEME_STOCK_RULES.newWindowMinutes * 60_000).length,
      },
      activity: {
        txs5m: sum((row) => row.activity?.txs5m),
        txs1h: sum((row) => row.activity?.txs1h),
        volume5mUsd: sum((row) => row.activity?.volume5mUsd),
        volume1hUsd: sum((row) => row.activity?.volume1hUsd),
        smartMoney: sum(smartMoneyCount),
      },
      top: [...live].sort(compareShortlist).slice(0, MEME_STOCK_RULES.topPerStock).map((row) => toShortlistRow(row, now)),
    });
  }

  return groups
    .filter((group) => group.memes.live >= query.minLive)
    .sort((a, b) => orderValue(b, query.orderBy) - orderValue(a, query.orderBy) || a.stock.address.localeCompare(b.stock.address))
    .slice(0, query.limit);
}

function orderValue(group: MemeStockGroup, field: MemeStockOrderField): number {
  switch (field) {
    case "volume1hUsd":
      return group.activity.volume1hUsd;
    case "live":
      return group.memes.live;
    case "txs5m":
      return group.activity.txs5m;
    case "new1h":
      return group.memes.new1h;
    case "smartMoney":
      return group.activity.smartMoney;
  }
}

/** Stock rows from a `universe:rwa` payload, by address; tolerant of shape drift. */
export function rwaRowsByAddress(data: unknown): Map<string, RwaToken> {
  const out = new Map<string, RwaToken>();
  if (typeof data !== "object" || data === null) return out;
  const rows = (data as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return out;
  for (const row of rows as RwaToken[]) {
    if (typeof row === "object" && row !== null && typeof row.address === "string") out.set(row.address.toLowerCase(), row);
  }
  return out;
}
