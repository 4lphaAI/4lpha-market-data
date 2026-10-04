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

/**
 * The shortlist: what the execution plane reads before deciding a trade.
 *
 * The board is a census (~500 tokens, a third of them dead or unreadable); an
 * agent should not spend a decision cycle on that. The shortlist keeps only
 * tradable charts, ranks them, splits the slots between launchpads, and
 * flattens each row to the fields a trade decision uses. Every default is in
 * {@link SHORTLIST_DEFAULTS}, echoed in `meta.applied`, and overridable.
 */
export const SHORTLIST_DEFAULTS = {
  size: 20,
  maxSize: 100,
  /**
   * Share of slots for Flap; Four.Meme gets the rest. Operator call 2026-10-04:
   * Flap is where the volume is (7:3). A launchpad short of candidates hands
   * its unused slots to the other rather than leaving them empty.
   */
  flapShare: 0.7,
  statuses: ["runner", "active"] as readonly MemeStatus[],
  /**
   * Volume that is not demand (wash-trading tags; 1h volume at 10x market cap or
   * more), and charts the smart money has already left (`smart_exit`: the
   * newest signal's wallets sold at least 80% of what they bought).
   */
  excludeFlags: ["churn", "wash_trading", "smart_exit"] as readonly MemeFlag[],
  /** At least one trade in the last 5 minutes: a chart, not a memory of one. */
  minTxs5m: 1,
  minLiquidityUsd: 3_000,
} as const;

export const MEME_SEGMENTS = ["all", "memestock"] as const;
export type MemeSegment = (typeof MEME_SEGMENTS)[number];

/**
 * The quality gates, per segment. `all` keeps the original shortlist; the
 * meme-stock segment adds four, because measured 2026-10-04 its 29 live
 * candidates included sell-dominated dumps (CZ 488/512 at -68% in the hour,
 * bBroker -50%), charts with 21 traders an hour, five memes with no hour of
 * flow data at all, and eight of the 29 on one stock (BNCB). With these gates
 * the same board gave about a dozen. A gate on a number the row does not carry
 * excludes it — no flow data is not evidence of demand.
 */
export const SEGMENT_GATES: Record<MemeSegment, SegmentGates> = {
  all: {
    minUniqueTraders1h: undefined,
    minBuySellRatio1h: undefined,
    minPriceChange1hPct: undefined,
    maxPerQuote: undefined,
    requireQuoteOpen: false,
  },
  memestock: {
    minUniqueTraders1h: 30,
    /** Buys at least match sells over the hour: someone is still arriving. */
    minBuySellRatio1h: 1,
    /** Down 30% or more in an hour is a dump in progress, whatever the volume. */
    minPriceChange1hPct: -30,
    /** No stock fills the list on its own; the narrative is spread. */
    maxPerQuote: 3,
    /**
     * The quote bStock must be known to be open: a meme stock is bought through
     * its stock, and a halted or unread stock is not a route.
     */
    requireQuoteOpen: true,
  },
};

export interface SegmentGates {
  minUniqueTraders1h: number | undefined;
  minBuySellRatio1h: number | undefined;
  minPriceChange1hPct: number | undefined;
  /** At most this many memes per quote token; `undefined` = no cap. */
  maxPerQuote: number | undefined;
  requireQuoteOpen: boolean;
}

/** What the shortlist knows about a quote stock (see `loadStockInfo`). */
export interface QuoteStockState {
  priceUsd: number | null;
  openState: boolean | null;
}

export interface ShortlistQuery {
  size: number;
  flapShare: number;
  segment: MemeSegment;
  statuses: readonly MemeStatus[];
  stages: readonly MemeStage[] | undefined;
  excludeFlags: readonly MemeFlag[];
  minTxs5m: number;
  minLiquidityUsd: number;
  /** Floor on {@link smartMoneyCount}; none by default — coverage is too thin to require it. */
  minSmartMoney: number | undefined;
  maxAgeMinutes: number | undefined;
  gates: SegmentGates;
}

export function parseShortlistQuery(get: (name: string) => string | undefined): ShortlistQuery {
  const size = numberParam(get("size"), "size");
  if (size !== undefined && (!Number.isInteger(size) || size < 1)) {
    throw new MemeQueryError("size must be a positive integer");
  }
  const flapShare = numberParam(get("flapShare"), "flapShare");
  if (flapShare !== undefined && (flapShare < 0 || flapShare > 1)) {
    throw new MemeQueryError("flapShare must be between 0 and 1");
  }
  const segment = listParam(get("segment"), "segment", MEME_SEGMENTS);
  if (segment !== undefined && segment.length > 1) throw new MemeQueryError("segment takes one value");
  // `excludeFlags=none` clears the default screen; it is never a flag name.
  const excludeRaw = get("excludeFlags");
  const excludeFlags =
    excludeRaw?.trim() === "none"
      ? []
      : (listParam(excludeRaw, "excludeFlags", MEME_FLAGS) ?? SHORTLIST_DEFAULTS.excludeFlags);
  return {
    size: Math.min(size ?? SHORTLIST_DEFAULTS.size, SHORTLIST_DEFAULTS.maxSize),
    flapShare: flapShare ?? SHORTLIST_DEFAULTS.flapShare,
    segment: segment?.[0] ?? "all",
    statuses: listParam(get("status"), "status", MEME_STATUSES) ?? SHORTLIST_DEFAULTS.statuses,
    stages: listParam(get("stage"), "stage", MEME_STAGES),
    excludeFlags,
    minTxs5m: numberParam(get("minTxs5m"), "minTxs5m") ?? SHORTLIST_DEFAULTS.minTxs5m,
    minLiquidityUsd: numberParam(get("minLiquidityUsd"), "minLiquidityUsd") ?? SHORTLIST_DEFAULTS.minLiquidityUsd,
    minSmartMoney: numberParam(get("minSmartMoney"), "minSmartMoney"),
    maxAgeMinutes: numberParam(get("maxAgeMinutes"), "maxAgeMinutes"),
    gates: parseGates(get, segment?.[0] ?? "all"),
  };
}

/** Segment defaults, each overridable; `none` clears one. */
function parseGates(get: (name: string) => string | undefined, segment: MemeSegment): SegmentGates {
  const base = SEGMENT_GATES[segment];
  const optional = (name: string, fallback: number | undefined) =>
    get(name)?.trim() === "none" ? undefined : (numberParam(get(name), name) ?? fallback);
  const maxPerQuote = optional("maxPerQuote", base.maxPerQuote);
  if (maxPerQuote !== undefined && (!Number.isInteger(maxPerQuote) || maxPerQuote < 1)) {
    throw new MemeQueryError("maxPerQuote must be a positive integer or none");
  }
  const openRaw = get("requireQuoteOpen");
  if (openRaw !== undefined && openRaw !== "" && openRaw !== "true" && openRaw !== "false") {
    throw new MemeQueryError("requireQuoteOpen must be true or false");
  }
  return {
    minUniqueTraders1h: optional("minUniqueTraders1h", base.minUniqueTraders1h),
    minBuySellRatio1h: optional("minBuySellRatio1h", base.minBuySellRatio1h),
    minPriceChange1hPct: optional("minPriceChange1hPct", base.minPriceChange1hPct),
    maxPerQuote,
    requireQuoteOpen: openRaw === "true" ? true : openRaw === "false" ? false : base.requireQuoteOpen,
  };
}

/** One shortlist row: flat, every number a trade decision reads, nothing else. */
export interface MemeShortlistRow {
  address: string;
  symbol: string;
  launchpad: MemeLaunchpad;
  stage: MemeStage;
  status: MemeStatus;
  ageMinutes: number;
  progress: number | null;
  /** For a bStock quote, `stock` carries its price and session state; `null` otherwise or when unknown. */
  quote: MemeBoardRow["quote"] & { stock: QuoteStockState | null };
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  holders: number | null;
  txs5m: number | null;
  txs1h: number | null;
  volume5mUsd: number | null;
  volume1hUsd: number | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  /** Last hour's trade split, from OKX's hot ranking; `null` when the token did not rank there. */
  buys1h: number | null;
  sells1h: number | null;
  uniqueTraders1h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  /** Tagged holders + smart-money and KOL signals in the window. */
  smartMoney: number;
  flags: MemeFlag[];
  /** When OKX observed the activity numbers. */
  observedAt: number | null;
}

export interface Shortlist {
  rows: MemeShortlistRow[];
  candidates: { flap: number; fourmeme: number };
  picked: { flap: number; fourmeme: number };
  /** Slots one launchpad could not fill and the other took. */
  backfilled: number;
}

/**
 * Runners before active charts; inside each, by 5-minute trades — momentum the
 * agent can still act on, ranked by how much of it there is right now.
 *
 * Smart money breaks ties between charts of the same activity, and only those.
 * "Same activity" is the same doubling band of 5-minute trades (1, 2–3, 4–7,
 * 8–15, …): exact ties are too rare to matter, while a band keeps a chart with
 * twice the trades ahead whatever its smart money. Kept this light on purpose —
 * on 2026-10-04 OKX carried ~2.4 signals an hour on BSC and ~87 of ~720 board
 * tokens had a tagged holder, so weighting it harder would rank by coverage
 * rather than by quality.
 */
export function compareShortlist(a: MemeBoardRow, b: MemeBoardRow): number {
  const rank = (row: MemeBoardRow) => (row.status === "runner" ? 0 : 1);
  return (
    rank(a) - rank(b) ||
    activityBand(b) - activityBand(a) ||
    smartMoneyCount(b) - smartMoneyCount(a) ||
    compareMemes(a, b, "txs5m") ||
    compareMemes(a, b, "volume1hUsd") ||
    a.address.localeCompare(b.address)
  );
}

/** Doubling band of 5-minute trades: 0 for none or unknown, 1 for one, 2 for 2–3, 3 for 4–7, … */
export function activityBand(row: MemeBoardRow): number {
  const txs = row.activity?.txs5m ?? 0;
  return txs <= 0 ? 0 : Math.floor(Math.log2(txs)) + 1;
}

export function matchesShortlist(
  row: MemeBoardRow,
  query: ShortlistQuery,
  now: number,
  stocks: ReadonlyMap<string, QuoteStockState> = new Map(),
): boolean {
  if (!query.statuses.includes(row.status)) return false;
  if (query.stages !== undefined && !query.stages.includes(row.stage)) return false;
  if (query.segment === "memestock" && row.quote.kind !== "bstock") return false;
  if (query.excludeFlags.some((flag) => row.flags.includes(flag))) return false;
  if (!atLeast(row.activity?.txs5m ?? null, query.minTxs5m)) return false;
  if (!atLeast(row.market.liquidityUsd, query.minLiquidityUsd)) return false;
  if (query.minSmartMoney !== undefined && smartMoneyCount(row) < query.minSmartMoney) return false;
  if (query.maxAgeMinutes !== undefined && (now - row.createdAt) / 60_000 > query.maxAgeMinutes) return false;
  return passesGates(row, query.gates, stocks);
}

function passesGates(row: MemeBoardRow, gates: SegmentGates, stocks: ReadonlyMap<string, QuoteStockState>): boolean {
  const flow = row.flow1h;
  if (gates.minUniqueTraders1h !== undefined && !atLeast(flow?.uniqueTraders ?? null, gates.minUniqueTraders1h)) {
    return false;
  }
  if (gates.minBuySellRatio1h !== undefined) {
    const buys = flow?.buys ?? null;
    const sells = flow?.sells ?? null;
    if (buys === null || sells === null || buys === 0) return false;
    if (sells > 0 && buys / sells < gates.minBuySellRatio1h) return false;
  }
  if (
    gates.minPriceChange1hPct !== undefined &&
    !atLeast(row.activity?.priceChange1hPct ?? null, gates.minPriceChange1hPct)
  ) {
    return false;
  }
  if (gates.requireQuoteOpen && row.quote.kind === "bstock") {
    const stock = row.quote.address === null ? undefined : stocks.get(row.quote.address);
    if (stock?.openState !== true) return false;
  }
  return true;
}

/** Keeps the first `max` rows per quote token, in the order given. */
function capPerQuote(rows: readonly MemeBoardRow[], max: number | undefined): MemeBoardRow[] {
  if (max === undefined) return [...rows];
  const seen = new Map<string, number>();
  return rows.filter((row) => {
    const key = row.quote.address ?? "unknown";
    const count = seen.get(key) ?? 0;
    if (count >= max) return false;
    seen.set(key, count + 1);
    return true;
  });
}

export function buildShortlist(
  rows: readonly MemeBoardRow[],
  query: ShortlistQuery,
  now: number,
  stocks: ReadonlyMap<string, QuoteStockState> = new Map(),
): Shortlist {
  const candidates = capPerQuote(
    rows.filter((row) => matchesShortlist(row, query, now, stocks)).sort(compareShortlist),
    query.gates.maxPerQuote,
  );
  const flap = candidates.filter((row) => row.launchpad === "flap");
  const fourmeme = candidates.filter((row) => row.launchpad === "fourmeme");

  const flapSlots = Math.round(query.size * query.flapShare);
  const fourSlots = query.size - flapSlots;
  const takeFlap = Math.min(flap.length, flapSlots + Math.max(0, fourSlots - fourmeme.length));
  const takeFour = Math.min(fourmeme.length, fourSlots + Math.max(0, flapSlots - flap.length));
  const picked = [...flap.slice(0, takeFlap), ...fourmeme.slice(0, takeFour)].sort(compareShortlist);
  const backfilled = Math.max(0, takeFlap - flapSlots) + Math.max(0, takeFour - fourSlots);

  return {
    rows: picked.map((row) => toShortlistRow(row, now, stocks)),
    candidates: { flap: flap.length, fourmeme: fourmeme.length },
    picked: { flap: takeFlap, fourmeme: takeFour },
    backfilled,
  };
}

export function toShortlistRow(
  row: MemeBoardRow,
  now: number,
  stocks: ReadonlyMap<string, QuoteStockState> = new Map(),
): MemeShortlistRow {
  const stock = row.quote.kind === "bstock" && row.quote.address !== null ? stocks.get(row.quote.address) : undefined;
  return {
    address: row.address,
    symbol: row.symbol,
    launchpad: row.launchpad,
    stage: row.stage,
    status: row.status,
    ageMinutes: Math.round((now - row.createdAt) / 60_000),
    progress: row.progress,
    quote: { ...row.quote, stock: stock === undefined ? null : { priceUsd: stock.priceUsd, openState: stock.openState } },
    priceUsd: row.market.priceUsd,
    marketCapUsd: row.market.marketCapUsd,
    liquidityUsd: row.market.liquidityUsd,
    holders: row.market.holders,
    txs5m: row.activity?.txs5m ?? null,
    txs1h: row.activity?.txs1h ?? null,
    volume5mUsd: row.activity?.volume5mUsd ?? null,
    volume1hUsd: row.activity?.volume1hUsd ?? null,
    priceChange5mPct: row.activity?.priceChange5mPct ?? null,
    priceChange1hPct: row.activity?.priceChange1hPct ?? null,
    buys1h: row.flow1h?.buys ?? null,
    sells1h: row.flow1h?.sells ?? null,
    uniqueTraders1h: row.flow1h?.uniqueTraders ?? null,
    buys24h: row.trades24h.buys,
    sells24h: row.trades24h.sells,
    smartMoney: smartMoneyCount(row),
    flags: row.flags,
    observedAt: row.activity?.observedAt ?? null,
  };
}
