/**
 * Cross-issuer stock compare: the stored row, the pure maths and the verdicts.
 *
 * The `stock-compare` job quotes the same US stock in its two tokenized
 * versions (bStock and Ondo) at fixed USDT sizes and stores shares of the
 * underlying, cost against the reference share price, the cost of selling
 * straight back and the route type. `GET /trading/stock-compare` serves the
 * stored row plus verdicts computed here at read time. Both import this file
 * so the row shape has one definition.
 *
 * Nothing here reads Binance's `priceImpactPercent`: it is a fraction
 * (0.85 means 85 percent, DEVEX PITFALL-35) and an agent that reads it as a
 * percent swaps into a loss.
 */

/** Fixed quote sizes, in USDT. */
export const STOCK_COMPARE_SIZES_USDT: readonly number[] = [100, 1_000, 5_000];

/** Store key: one key, one row per ticker, merged each cycle. */
export const STOCK_COMPARE_KEY = "stocks:compare";
export const STOCK_COMPARE_SOURCE = "stock-compare";

/** Row age limits for `meta.staleness`; a row older than the stale limit is dropped by the job. */
export const STOCK_COMPARE_FRESH_MS = 30 * 60_000;
export const STOCK_COMPARE_STALE_MS = 2 * 60 * 60_000;

/** A verdict says `about_same` when the better version leads by less than this many bps of shares. */
export const STOCK_COMPARE_ABOUT_SAME_BPS = 20;
/** A version whose buy costs more than this many bps over the reference price is listed under `avoid`. */
export const STOCK_COMPARE_AVOID_COST_BPS = 200;

/** Upper bound on stored tickers; far above the ~75 tickers measured with both issuers. */
export const STOCK_COMPARE_MAX_TICKERS = 200;
export const STOCK_COMPARE_MAX_VENUES = 4;
const VENUE_NAME_MAX_CHARS = 32;
const VENUE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/u;

/** Matches the route's `?ticker=` and bounds what the job may store. */
export const STOCK_COMPARE_TICKER_PATTERN = /^[A-Z]{1,6}$/u;

export type StockCompareIssuer = "bstock" | "ondo";
export type StockCompareRoute = "rfq" | "amm" | "mixed";
export type StockCompareStaleness = "fresh" | "stale" | "dead";

/**
 * Closed failure codes:
 * - `no_route`: the aggregator answered "Path not found" (40465) for the buy;
 * - `quote_failed`: any other buy failure (transport, other envelope code, bad answer);
 * - `sell_no_route` / `sell_failed`: the buy answered but selling the quoted amount back did not
 *   (`ok` stays true, `roundTripBps` is null).
 */
export const STOCK_COMPARE_CODES = ["no_route", "quote_failed", "sell_no_route", "sell_failed"] as const;
export type StockCompareCode = (typeof STOCK_COMPARE_CODES)[number];

export interface StockCompareSize {
  usdt: number;
  /** True when the buy quote answered. */
  ok: boolean;
  code?: StockCompareCode;
  /** Tokens received for the buy (token units, not shares). Null when the buy did not answer. */
  tokensOut: number | null;
  /** Shares of the underlying: tokensOut x ratio. */
  shares: number | null;
  /** ((usdt / shares) / referencePriceUsd - 1) x 10 000, rounded to an integer. */
  costBps: number | null;
  /** (1 - usdtBack / usdt) x 10 000, rounded to an integer; null when the sell-back did not answer. */
  roundTripBps: number | null;
  route: StockCompareRoute | null;
  /** Venue names only, deduplicated in order of first appearance, at most four. */
  venues: string[];
}

export interface StockCompareVersion {
  issuer: StockCompareIssuer;
  symbol: string;
  address: string;
  /** The share multiplier from `universe:rwa` (`tokenToShareRatio`). */
  ratio: number;
  openState: boolean | null;
  marketStatus: string | null;
  sizes: StockCompareSize[];
}

export interface StockCompareRow {
  ticker: string;
  /** Epoch ms when this ticker's quotes finished. */
  quotedAt: number;
  referencePriceUsd: number;
  versions: StockCompareVersion[];
}

/** The stored payload under {@link STOCK_COMPARE_KEY}. */
export interface StockCompareSnapshot {
  rows: Record<string, StockCompareRow>;
}

export interface StockCompareSizeVerdict {
  usdt: number;
  /** Issuer with the most shares among the versions whose buy answered; null when none answered. */
  best: StockCompareIssuer | null;
  /** (sharesBest / sharesOther - 1) x 10 000 rounded to 0.1; null unless two versions answered. */
  edgeBps: number | null;
  /** True when two versions answered and edgeBps is under {@link STOCK_COMPARE_ABOUT_SAME_BPS}. */
  about_same: boolean;
  /** Issuers whose answered buy costs more than {@link STOCK_COMPARE_AVOID_COST_BPS} bps over the reference price. */
  avoid: StockCompareIssuer[];
  /** The issuer when exactly one version has a route at this size. */
  only: StockCompareIssuer | null;
}

// ------------------------------------------------------------------ maths ----

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Integer bps, with -0 folded to 0. */
function roundBps(value: number): number {
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

/** 8 decimal places: enough for a 0.0001-share quote and keeps the stored row small. */
function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/** Atomic amount to a plain number at `decimals`. Not used for anything that is sent back. */
export function atomicToNumber(atomic: string, decimals: number): number {
  return Number(BigInt(atomic)) / 10 ** decimals;
}

export function sharesFor(tokensOut: number, ratio: number): number {
  return tokensOut * ratio;
}

export function costBpsFor(usdt: number, shares: number, referencePriceUsd: number): number {
  return roundBps(((usdt / shares) / referencePriceUsd - 1) * 10_000);
}

export function roundTripBpsFor(usdt: number, usdtBack: number): number {
  return roundBps((1 - usdtBack / usdt) * 10_000);
}

/** The shape stored for a buy that answered. `usdtBack` is null when the sell-back did not. */
export function buildAnsweredSize(input: {
  usdt: number;
  tokensOut: number;
  ratio: number;
  referencePriceUsd: number;
  usdtBack: number | null;
  sellCode: StockCompareCode | null;
  legs: readonly string[];
}): StockCompareSize {
  const shares = sharesFor(input.tokensOut, input.ratio);
  const size: StockCompareSize = {
    usdt: input.usdt,
    ok: true,
    tokensOut: round8(input.tokensOut),
    shares: round8(shares),
    costBps: shares > 0 ? costBpsFor(input.usdt, shares, input.referencePriceUsd) : null,
    roundTripBps: input.usdtBack === null ? null : roundTripBpsFor(input.usdt, input.usdtBack),
    route: classifyRoute(input.legs),
    venues: venueNames(input.legs),
  };
  if (input.sellCode !== null) size.code = input.sellCode;
  return size;
}

export function buildFailedSize(usdt: number, code: "no_route" | "quote_failed"): StockCompareSize {
  return { usdt, ok: false, code, tokensOut: null, shares: null, costBps: null, roundTripBps: null, route: null, venues: [] };
}

/**
 * `rfq` when every leg is a maker leg (the aggregator names them `Rfq <maker>`), `amm` when none is,
 * `mixed` otherwise. Null when the answer carried no legs at all.
 */
export function classifyRoute(legs: readonly string[]): StockCompareRoute | null {
  if (legs.length === 0) return null;
  const rfqLegs = legs.filter((leg) => /^rfq(?:\s|$)/iu.test(leg)).length;
  if (rfqLegs === legs.length) return "rfq";
  return rfqLegs === 0 ? "amm" : "mixed";
}

/** Names only (no percentages), deduplicated, a tight charset, at most four. */
export function venueNames(legs: readonly string[]): string[] {
  const names: string[] = [];
  for (const raw of legs) {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (name === "" || name.length > VENUE_NAME_MAX_CHARS || !VENUE_NAME_PATTERN.test(name)) continue;
    if (!names.includes(name)) names.push(name);
    if (names.length === STOCK_COMPARE_MAX_VENUES) break;
  }
  return names;
}

// --------------------------------------------------------------- verdicts ----

/** Pure: the verdict for each size present in the row, ascending. */
export function computeVerdicts(row: StockCompareRow): StockCompareSizeVerdict[] {
  const sizes = [...new Set(row.versions.flatMap((v) => v.sizes.map((s) => s.usdt)))].sort((a, b) => a - b);
  return sizes.map((usdt) => {
    const answered = row.versions
      .map((version) => ({ issuer: version.issuer, size: version.sizes.find((s) => s.usdt === usdt) }))
      .filter((x): x is { issuer: StockCompareIssuer; size: StockCompareSize } =>
        x.size !== undefined && x.size.ok && finite(x.size.shares) && x.size.shares > 0);

    const avoid = answered
      .filter((x) => finite(x.size.costBps) && x.size.costBps > STOCK_COMPARE_AVOID_COST_BPS)
      .map((x) => x.issuer);

    if (answered.length === 0) return { usdt, best: null, edgeBps: null, about_same: false, avoid, only: null };
    if (answered.length === 1) {
      return { usdt, best: answered[0]!.issuer, edgeBps: null, about_same: false, avoid, only: answered[0]!.issuer };
    }
    // More shares wins; an exact tie goes to the first listed version.
    const ordered = [...answered].sort((a, b) => (b.size.shares as number) - (a.size.shares as number));
    const leader = ordered[0]!;
    const runnerUp = ordered[1]!;
    const edgeBps = Math.round(((leader.size.shares as number) / (runnerUp.size.shares as number) - 1) * 10_000 * 10) / 10;
    return { usdt, best: leader.issuer, edgeBps, about_same: edgeBps < STOCK_COMPARE_ABOUT_SAME_BPS, avoid, only: null };
  });
}

/** fresh <= 30 min, stale <= 2 h, dead beyond. A row stamped in the future counts as fresh. */
export function stockCompareStaleness(quotedAt: number, nowMs: number): StockCompareStaleness {
  const age = nowMs - quotedAt;
  if (age <= STOCK_COMPARE_FRESH_MS) return "fresh";
  return age <= STOCK_COMPARE_STALE_MS ? "stale" : "dead";
}

// ------------------------------------------------------------ store merge ----

/**
 * Merge fresh rows into the stored ones: a refreshed ticker replaces its row, an untouched ticker keeps
 * its row, rows older than 2 h are dropped, and the result is bounded to the newest
 * {@link STOCK_COMPARE_MAX_TICKERS}.
 */
export function mergeStockCompareRows(
  previous: Readonly<Record<string, StockCompareRow>>,
  fresh: readonly StockCompareRow[],
  nowMs: number,
): Record<string, StockCompareRow> {
  const merged: Record<string, StockCompareRow> = { ...previous };
  for (const row of fresh) merged[row.ticker] = row;
  const kept = Object.values(merged)
    .filter((row) => nowMs - row.quotedAt <= STOCK_COMPARE_STALE_MS)
    .sort((a, b) => b.quotedAt - a.quotedAt || (a.ticker < b.ticker ? -1 : 1))
    .slice(0, STOCK_COMPARE_MAX_TICKERS);
  const out: Record<string, StockCompareRow> = {};
  for (const row of kept.sort((a, b) => (a.ticker < b.ticker ? -1 : 1))) out[row.ticker] = row;
  return out;
}

// ------------------------------------------------------------- normalizer ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSize(value: unknown): StockCompareSize | null {
  if (!isRecord(value) || !finite(value["usdt"]) || value["usdt"] <= 0 || typeof value["ok"] !== "boolean") return null;
  const ok = value["ok"];
  const code = value["code"];
  if (code !== undefined && !(STOCK_COMPARE_CODES as readonly unknown[]).includes(code)) return null;
  const nullableNum = (v: unknown): number | null | undefined => (v === null ? null : finite(v) ? v : undefined);
  const tokensOut = nullableNum(value["tokensOut"]);
  const shares = nullableNum(value["shares"]);
  const costBps = nullableNum(value["costBps"]);
  const roundTripBps = nullableNum(value["roundTripBps"]);
  if (tokensOut === undefined || shares === undefined || costBps === undefined || roundTripBps === undefined) return null;
  const route = value["route"];
  if (route !== null && route !== "rfq" && route !== "amm" && route !== "mixed") return null;
  const rawVenues = value["venues"];
  if (!Array.isArray(rawVenues)) return null;
  const size: StockCompareSize = {
    usdt: value["usdt"],
    ok,
    tokensOut,
    shares,
    costBps,
    roundTripBps,
    route,
    venues: venueNames(rawVenues.filter((v): v is string => typeof v === "string")),
  };
  if (code !== undefined) size.code = code as StockCompareCode;
  return size;
}

function normalizeVersion(value: unknown): StockCompareVersion | null {
  if (!isRecord(value)) return null;
  const issuer = value["issuer"];
  if (issuer !== "bstock" && issuer !== "ondo") return null;
  const symbol = value["symbol"];
  const address = value["address"];
  if (typeof symbol !== "string" || !/^[A-Za-z0-9._-]{1,24}$/u.test(symbol)) return null;
  if (typeof address !== "string" || !/^0x[0-9a-f]{40}$/u.test(address)) return null;
  if (!finite(value["ratio"]) || value["ratio"] <= 0) return null;
  const openState = value["openState"];
  if (openState !== null && typeof openState !== "boolean") return null;
  const marketStatus = value["marketStatus"];
  if (marketStatus !== null && (typeof marketStatus !== "string" || !/^[A-Za-z0-9._ -]{1,32}$/u.test(marketStatus))) return null;
  if (!Array.isArray(value["sizes"])) return null;
  const sizes = value["sizes"].slice(0, 8).map(normalizeSize);
  if (sizes.some((s) => s === null)) return null;
  return { issuer, symbol, address, ratio: value["ratio"], openState, marketStatus, sizes: sizes as StockCompareSize[] };
}

/** Defensive read of the stored payload: malformed rows are dropped, never thrown on. */
export function normalizeStockCompare(data: unknown): StockCompareSnapshot {
  const rows: Record<string, StockCompareRow> = {};
  const source = isRecord(data) && isRecord(data["rows"]) ? data["rows"] : {};
  for (const [key, value] of Object.entries(source)) {
    if (!isRecord(value) || value["ticker"] !== key || !STOCK_COMPARE_TICKER_PATTERN.test(key)) continue;
    if (!finite(value["quotedAt"]) || !finite(value["referencePriceUsd"]) || value["referencePriceUsd"] <= 0) continue;
    if (!Array.isArray(value["versions"]) || value["versions"].length > 2) continue;
    const versions = value["versions"].map(normalizeVersion);
    if (versions.some((v) => v === null)) continue;
    rows[key] = {
      ticker: key,
      quotedAt: value["quotedAt"],
      referencePriceUsd: value["referencePriceUsd"],
      versions: versions as StockCompareVersion[],
    };
    if (Object.keys(rows).length >= STOCK_COMPARE_MAX_TICKERS) break;
  }
  return { rows };
}
