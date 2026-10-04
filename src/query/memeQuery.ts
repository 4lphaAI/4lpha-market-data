/**
 * `GET /memes` query: parsing, filtering and ordering over the classified board.
 *
 * Same contract as `/pools/top`: the board carries labels and raw numbers, and
 * every screen is the caller's. The one default is that `dead` is hidden — the
 * board exists to find tokens that are trading — and `status=dead` (or listing
 * every status) brings them back.
 */

import type { MemeLaunchpad } from "../adapters/binanceWeb3.js";
import type { QuoteKind } from "./quoteKind.js";
import {
  MEME_FLAGS,
  MEME_STAGES,
  MEME_STATUSES,
  type MemeBoardRow,
  type MemeFlag,
  type MemeStage,
  type MemeStatus,
} from "./memeClassify.js";

export class MemeQueryError extends Error {}

export const MEME_ORDER_FIELDS = [
  "txs5m",
  "txs1h",
  "volume1hUsd",
  "priceChange1hPct",
  "marketCapUsd",
  "liquidityUsd",
  "smartMoney",
  "progress",
  "createdAt",
] as const;
export type MemeOrderField = (typeof MEME_ORDER_FIELDS)[number];

const LAUNCHPADS: readonly MemeLaunchpad[] = ["fourmeme", "flap"];
const QUOTE_KINDS: readonly QuoteKind[] = ["bnb", "stable", "bstock", "other"];
const DEFAULT_STATUSES: readonly MemeStatus[] = MEME_STATUSES.filter((status) => status !== "dead");
const DEFAULT_LIMIT = 100;

export interface MemeQuery {
  statuses: readonly MemeStatus[];
  stages: readonly MemeStage[] | undefined;
  launchpad: MemeLaunchpad | undefined;
  quotes: readonly QuoteKind[] | undefined;
  /** Every one of these must be present. */
  flags: readonly MemeFlag[];
  /** None of these may be present. */
  excludeFlags: readonly MemeFlag[];
  minLiquidityUsd: number | undefined;
  minMarketCapUsd: number | undefined;
  maxMarketCapUsd: number | undefined;
  minTxs5m: number | undefined;
  minTxs1h: number | undefined;
  minVolume1hUsd: number | undefined;
  minSmartMoney: number | undefined;
  maxAgeMinutes: number | undefined;
  orderBy: MemeOrderField;
  limit: number;
}

export function parseMemeQuery(get: (name: string) => string | undefined, cap: number): MemeQuery {
  const limit = numberParam(get("limit"), "limit");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new MemeQueryError("limit must be a positive integer");
  }
  const launchpad = listParam(get("launchpad"), "launchpad", LAUNCHPADS);
  if (launchpad !== undefined && launchpad.length > 1) {
    throw new MemeQueryError("launchpad takes one value");
  }
  return {
    statuses: listParam(get("status"), "status", MEME_STATUSES) ?? DEFAULT_STATUSES,
    stages: listParam(get("stage"), "stage", MEME_STAGES),
    launchpad: launchpad?.[0],
    quotes: listParam(get("quote"), "quote", QUOTE_KINDS),
    flags: listParam(get("flags"), "flags", MEME_FLAGS) ?? [],
    excludeFlags: listParam(get("excludeFlags"), "excludeFlags", MEME_FLAGS) ?? [],
    minLiquidityUsd: numberParam(get("minLiquidityUsd"), "minLiquidityUsd"),
    minMarketCapUsd: numberParam(get("minMarketCapUsd"), "minMarketCapUsd"),
    maxMarketCapUsd: numberParam(get("maxMarketCapUsd"), "maxMarketCapUsd"),
    minTxs5m: numberParam(get("minTxs5m"), "minTxs5m"),
    minTxs1h: numberParam(get("minTxs1h"), "minTxs1h"),
    minVolume1hUsd: numberParam(get("minVolume1hUsd"), "minVolume1hUsd"),
    minSmartMoney: numberParam(get("minSmartMoney"), "minSmartMoney"),
    maxAgeMinutes: numberParam(get("maxAgeMinutes"), "maxAgeMinutes"),
    orderBy: listParam(get("orderBy"), "orderBy", MEME_ORDER_FIELDS)?.[0] ?? "txs5m",
    limit: Math.min(limit ?? DEFAULT_LIMIT, cap),
  };
}

/**
 * Smart-money weight of a row: tagged holders plus smart-money and KOL signals
 * in the window. A count, not a score — it says how many, not how good.
 */
export function smartMoneyCount(row: MemeBoardRow): number {
  return (
    (row.smartMoney.holders ?? 0) + row.smartMoney.signals.smart_money + row.smartMoney.signals.kol
  );
}

/**
 * A floor on a number the row does not carry excludes it: asking for tokens
 * above 20 trades in 5 minutes is asking for tokens *known* to be.
 */
export function matchesMemeQuery(row: MemeBoardRow, query: MemeQuery, now: number): boolean {
  if (!query.statuses.includes(row.status)) return false;
  if (query.stages !== undefined && !query.stages.includes(row.stage)) return false;
  if (query.launchpad !== undefined && row.launchpad !== query.launchpad) return false;
  if (query.quotes !== undefined && (row.quote.kind === null || !query.quotes.includes(row.quote.kind))) {
    return false;
  }
  if (!query.flags.every((flag) => row.flags.includes(flag))) return false;
  if (query.excludeFlags.some((flag) => row.flags.includes(flag))) return false;
  if (!atLeast(row.market.liquidityUsd, query.minLiquidityUsd)) return false;
  if (!atLeast(row.market.marketCapUsd, query.minMarketCapUsd)) return false;
  if (query.maxMarketCapUsd !== undefined && (row.market.marketCapUsd === null || row.market.marketCapUsd > query.maxMarketCapUsd)) {
    return false;
  }
  if (!atLeast(row.activity?.txs5m ?? null, query.minTxs5m)) return false;
  if (!atLeast(row.activity?.txs1h ?? null, query.minTxs1h)) return false;
  if (!atLeast(row.activity?.volume1hUsd ?? null, query.minVolume1hUsd)) return false;
  if (query.minSmartMoney !== undefined && smartMoneyCount(row) < query.minSmartMoney) return false;
  if (query.maxAgeMinutes !== undefined && (now - row.createdAt) / 60_000 > query.maxAgeMinutes) return false;
  return true;
}

/** Descending, unknown values last — an unknown is not a zero. */
export function compareMemes(a: MemeBoardRow, b: MemeBoardRow, field: MemeOrderField): number {
  const left = orderValue(a, field);
  const right = orderValue(b, field);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

function orderValue(row: MemeBoardRow, field: MemeOrderField): number | null {
  switch (field) {
    case "txs5m":
      return row.activity?.txs5m ?? null;
    case "txs1h":
      return row.activity?.txs1h ?? null;
    case "volume1hUsd":
      return row.activity?.volume1hUsd ?? null;
    case "priceChange1hPct":
      return row.activity?.priceChange1hPct ?? null;
    case "marketCapUsd":
      return row.market.marketCapUsd;
    case "liquidityUsd":
      return row.market.liquidityUsd;
    case "smartMoney":
      return smartMoneyCount(row);
    case "progress":
      return row.progress;
    case "createdAt":
      return row.createdAt;
  }
}

function atLeast(value: number | null, floor: number | undefined): boolean {
  if (floor === undefined) return true;
  return value !== null && value >= floor;
}

function numberParam(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new MemeQueryError(`${name} must be a number`);
  return parsed;
}

function listParam<T extends string>(raw: string | undefined, name: string, allowed: readonly T[]): T[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const values = raw.split(",").map((value) => value.trim()).filter((value) => value !== "");
  for (const value of values) {
    if (!(allowed as readonly string[]).includes(value)) {
      throw new MemeQueryError(`${name} must be one of ${allowed.join(", ")}`);
    }
  }
  return values as T[];
}
