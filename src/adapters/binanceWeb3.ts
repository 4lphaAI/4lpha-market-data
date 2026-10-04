/**
 * Binance Web3 / Alpha adapter — the coins lane's universe and price source.
 *
 * These are undocumented public `bapi` endpoints, so everything here is written
 * defensively: shapes are probed rather than asserted, unknown chains are
 * filtered out, and prices are range-checked by the caller through
 * {@link isPlausiblePrice} because the feed occasionally emits glitch values.
 */

import type { Candle, TokenSnapshot, UniverseEntry } from "../core/models.js";
import {
  AdapterError,
  asArray,
  fetchJson,
  isRecord,
  normalizeAddress,
  parseNum,
  parseStr,
  sortCandles,
  toEpochMs,
  type FetchFn,
} from "./http.js";

const SOURCE = "binance";
const ALPHA_LIST_URL =
  "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list";
const DYNAMIC_INFO_URL =
  "https://web3.binance.com/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info/ai";
const META_INFO_URL =
  "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/dex/market/token/meta/info/ai";
const KLINE_URL = "https://dquery.sintral.io/u-kline/v1/k-line/candles";

const BSC_CHAIN_ID = "56";
const SUCCESS_CODE = "000000";

/** Ceiling on concurrent requests to Binance hosts, shared process-wide. */
const MAX_CONCURRENT = 6;

let inFlight = 0;
const waiters: Array<() => void> = [];

/**
 * Minimal counting semaphore. The bapi endpoints throttle aggressively per
 * source IP, so every Binance-host request funnels through here — including
 * `fetchSintralKlines` (handoff §11, 2026-09-22): the Sintral kline host is a
 * physically different service, but the operator ruled it through the same
 * shared cap anyway as a precaution, not because it was measured to need it.
 */
async function withBinanceLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  }
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
    const next = waiters.shift();
    if (next !== undefined) next();
  }
}

/** Exported for tests: current number of in-flight Binance-host requests. */
export function binanceInFlight(): number {
  return inFlight;
}

interface BaseParams {
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn;
}

/**
 * `{ code: "000000", data }` is the bapi success envelope. Some endpoints omit
 * `code` entirely, which is treated as success so a shape change does not take
 * the lane offline.
 */
function unwrapEnvelope(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const code = payload["code"];
  if (code !== undefined && String(code) !== SUCCESS_CODE && String(code) !== "0") {
    const message = parseStr(payload["message"]) ?? `unsuccessful code ${String(code)}`;
    throw new AdapterError(SOURCE, message);
  }
  return payload["data"] ?? payload;
}

/** Fetches the Binance Alpha token list, keeping only BSC entries. */
export async function fetchBinanceAlphaUniverse(
  params: BaseParams = {},
): Promise<UniverseEntry[]> {
  const payload = await withBinanceLimit(() =>
    fetchJson({
      source: SOURCE,
      url: ALPHA_LIST_URL,
      fetchFn: params.fetchFn ?? globalThis.fetch,
      signal: params.signal,
    }),
  );
  return normalizeAlphaUniverse(payload);
}

/** Exported for tests: normalizes an Alpha list payload. */
export function normalizeAlphaUniverse(payload: unknown): UniverseEntry[] {
  const data = unwrapEnvelope(payload);
  const rows = Array.isArray(data) ? data : isRecord(data) ? asArray(data["tokens"]) : [];
  const entries: UniverseEntry[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const address = normalizeAddress(row["contractAddress"] ?? row["tokenAddress"]);
    if (address === null || seen.has(address)) continue;
    if (!isBscRow(row)) continue;
    if (!isLiveRow(row)) continue;

    const symbol = parseStr(row["symbol"]) ?? parseStr(row["tokenSymbol"]) ?? "";
    const name = parseStr(row["name"]) ?? parseStr(row["tokenName"]);

    seen.add(address);
    entries.push({
      address,
      symbol,
      ...(name === null ? {} : { name }),
      lane: "coins",
      source: SOURCE,
    });
  }

  return entries;
}

/**
 * The list mixes chains on some responses and omits chain fields on others.
 * A row is kept when it explicitly says BSC, or when it says nothing at all —
 * dropping unlabelled rows would empty the lane the first time the shape moves.
 */
function isBscRow(row: Record<string, unknown>): boolean {
  const chainId = parseStr(row["chainId"]) ?? parseNum(row["chainId"])?.toString() ?? null;
  const chainName = parseStr(row["chainName"]) ?? parseStr(row["network"]);
  if (chainId === null && chainName === null) return true;
  if (chainId === BSC_CHAIN_ID) return true;
  const normalized = chainName?.toUpperCase() ?? "";
  return normalized === "BSC" || normalized === "BNB" || normalized === "BNB CHAIN";
}

/**
 * Drops rows the list itself marks as retired. Measured 2026-08-12: of 486 BSC
 * rows, 82 were `fullyDelisted` and another 90 `offline` — 314 live. Both flags
 * exclude, by decision: this list feeds the coins lane *and* the eligibility
 * gate's Alpha rule, and a retired listing must not read as "eligible".
 * Only an explicit `true` drops a row — a missing or reshaped flag keeps it,
 * consistent with how every other bapi field is read defensively.
 */
function isLiveRow(row: Record<string, unknown>): boolean {
  return row["offline"] !== true && row["fullyDelisted"] !== true;
}

export interface BinanceTokenParams extends BaseParams {
  address: string;
}

/** Fetches the live price/market state for one BSC token. */
export async function fetchBinanceTokenQuote(
  params: BinanceTokenParams,
): Promise<TokenSnapshot> {
  const address = params.address.toLowerCase();
  const url = `${DYNAMIC_INFO_URL}?chainId=${BSC_CHAIN_ID}&contractAddress=${encodeURIComponent(address)}`;
  const payload = await withBinanceLimit(() =>
    fetchJson({
      source: SOURCE,
      url,
      fetchFn: params.fetchFn ?? globalThis.fetch,
      signal: params.signal,
    }),
  );
  return normalizeTokenQuote(address, payload);
}

/** Exported for tests: normalizes a dynamic-info payload. */
export function normalizeTokenQuote(address: string, payload: unknown): TokenSnapshot {
  const data = unwrapEnvelope(payload);
  const row = isRecord(data) ? data : {};
  const symbol = parseStr(row["symbol"]);

  return {
    address: address.toLowerCase(),
    priceUsd: parseNum(row["price"]) ?? parseNum(row["aggPrice"]),
    marketCapUsd: parseNum(row["marketCap"]) ?? parseNum(row["fdv"]),
    volume24hUsd: parseNum(row["volume24h"]) ?? parseNum(row["v24h"]),
    holders: parseNum(row["holders"]),
    priceChange24hPct: parseNum(row["percentChange24h"]) ?? parseNum(row["priceChange24h"]),
    ...(symbol === null ? {} : { symbol }),
    updatedFields: [],
  };
}

export interface BinanceTokenMeta {
  address: string;
  symbol: string | null;
  name: string | null;
}

/** Fetches symbol/name metadata for one BSC token. */
export async function fetchBinanceTokenMeta(
  params: BinanceTokenParams,
): Promise<BinanceTokenMeta> {
  const address = params.address.toLowerCase();
  const url = `${META_INFO_URL}?chainId=${BSC_CHAIN_ID}&contractAddress=${encodeURIComponent(address)}`;
  const payload = await withBinanceLimit(() =>
    fetchJson({
      source: SOURCE,
      url,
      fetchFn: params.fetchFn ?? globalThis.fetch,
      signal: params.signal,
    }),
  );
  return normalizeTokenMeta(address, payload);
}

/** Exported for tests: normalizes a meta-info payload. */
export function normalizeTokenMeta(address: string, payload: unknown): BinanceTokenMeta {
  const data = unwrapEnvelope(payload);
  const row = isRecord(data) ? data : {};
  return {
    address: address.toLowerCase(),
    symbol: parseStr(row["symbol"]) ?? parseStr(row["tokenSymbol"]),
    name: parseStr(row["name"]) ?? parseStr(row["tokenName"]),
  };
}

export interface SintralKlineParams extends BaseParams {
  address: string;
  /** Provider-native interval, e.g. `1min`, `15min`, `1h`. */
  interval: string;
  limit: number;
}

/**
 * Fetches OHLCV bars from the Sintral kline service used by Binance Web3.
 *
 * Handoff §11 (2026-09-22, operator ruling): gated behind the same
 * `withBinanceLimit` semaphore as every other Binance-host call, even though
 * a live probe of 36 back-to-back requests in 3s saw no throttling (`36/36`
 * 200s) — the probe was a burst at 12 req/s, the producer's real steady load
 * is ~5 req/min, so the probe does not clear this host of needing the same
 * caution applied everywhere else in this file. Sends the same
 * `clienttype`/`clientversion` headers Neural Alpha's own integration uses
 * against this same endpoint (its reference implementation is the only
 * evidence this shape works; this adapter previously sent none).
 */
export async function fetchSintralKlines(params: SintralKlineParams): Promise<Candle[]> {
  const address = params.address.toLowerCase();
  const limit = Math.max(1, Math.trunc(params.limit));
  const url =
    `${KLINE_URL}?address=${encodeURIComponent(address)}` +
    `&interval=${encodeURIComponent(params.interval)}&limit=${limit}&platform=bsc`;

  const payload = await withBinanceLimit(() => fetchJson({
    source: SOURCE,
    url,
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
    headers: { clienttype: "web", clientversion: "1.2.0" },
  }));
  return normalizeSintralKlines(payload);
}

/**
 * Exported for tests. Rows arrive as positional arrays in
 * `[open, high, low, close, volume, timestamp]` order — note the timestamp is
 * last, unlike most OHLCV feeds.
 */
export function normalizeSintralKlines(payload: unknown): Candle[] {
  const rows = isRecord(payload) ? asArray(payload["data"]) : asArray(payload);
  const candles: Candle[] = [];

  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const timestamp = toEpochMs(row[5]);
    if (timestamp === null) continue;
    candles.push({
      timestamp,
      open: parseNum(row[0]) ?? 0,
      high: parseNum(row[1]) ?? 0,
      low: parseNum(row[2]) ?? 0,
      close: parseNum(row[3]) ?? 0,
      volume: parseNum(row[4]) ?? 0,
    });
  }

  return sortCandles(candles);
}

const MIN_PLAUSIBLE_RATIO = 0.02;
const MAX_PLAUSIBLE_RATIO = 50;

/**
 * Guards against bapi glitch prices. A live quote is accepted when it sits
 * within 50x of the last known price in either direction; with no reference
 * price yet, any positive number is accepted.
 */
export function isPlausiblePrice(reference: number | null, live: number): boolean {
  if (!Number.isFinite(live) || live <= 0) return false;
  if (reference === null || !Number.isFinite(reference) || reference <= 0) return true;
  const ratio = live / reference;
  return ratio >= MIN_PLAUSIBLE_RATIO && ratio <= MAX_PLAUSIBLE_RATIO;
}

const MEME_RUSH_URL =
  "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/pulse/rank/list/ai";

/** Meme Rush lifecycle lists: freshly created, nearly graduated, just migrated. */
export const MEME_RUSH_STAGES = { new: 10, finalizing: 20, migrated: 30 } as const;
export type MemeRushStage = keyof typeof MEME_RUSH_STAGES;

/** Meme Rush launchpad codes on BSC. Other codes (2006/2007 seen) are not ours to label. */
export const MEME_RUSH_PROTOCOLS = { fourmeme: 2001, flap: 2002 } as const;
export type MemeLaunchpad = keyof typeof MEME_RUSH_PROTOCOLS;

/**
 * The server answers at most 100 rows whatever `limit` says (documented 200,
 * measured 2026-10-04), so asking for more only costs payload.
 */
const MEME_RUSH_LIMIT = 100;

/**
 * One Meme Rush row, narrowed to what the meme board classifies on. Percentages
 * stay as the upstream formats them (`23.57` means 23.57%); trade counts cover
 * 24h, which for a token minutes old is its whole life.
 */
export interface MemeRushRow {
  address: string;
  symbol: string;
  name: string | null;
  launchpad: MemeLaunchpad;
  stage: MemeRushStage;
  createdAt: number;
  /** Bonding-curve progress, 0–100. */
  progress: number | null;
  migrated: boolean;
  migratedAt: number | null;
  /** Quote token of the curve/pair, lowercased; `0xeeee…` means native BNB. */
  quote: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceChange24hPct: number | null;
  holders: number | null;
  count24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  netBuy24hUsd: number | null;
  top10Pct: number | null;
  devPct: number | null;
  sniperPct: number | null;
  insiderPct: number | null;
  bundlerPct: number | null;
  newWalletPct: number | null;
  smartMoneyHolders: number | null;
  kolHolders: number | null;
  devAddress: string | null;
  devSoldAll: boolean;
  devMigrateCount: number | null;
  washTrading: boolean;
  socials: { website: string | null; twitter: string | null; telegram: string | null };
}

export interface MemeRushParams extends BaseParams {
  stage: MemeRushStage;
  /**
   * One launchpad per call. Asked for both at once the 100-row cap is shared,
   * and Flap crowds Four.Meme out (78/100 of New, 2026-10-04); asked
   * separately the six lists returned 517 tokens instead of 300.
   */
  launchpad: MemeLaunchpad;
}

/** Fetches one Meme Rush list for one BSC launchpad. Keyless. */
export async function fetchMemeRush(params: MemeRushParams): Promise<MemeRushRow[]> {
  const payload = await withBinanceLimit(() =>
    fetchJson({
      source: SOURCE,
      url: MEME_RUSH_URL,
      method: "POST",
      body: JSON.stringify({
        chainId: BSC_CHAIN_ID,
        rankType: MEME_RUSH_STAGES[params.stage],
        limit: MEME_RUSH_LIMIT,
        protocol: [MEME_RUSH_PROTOCOLS[params.launchpad]],
      }),
      fetchFn: params.fetchFn ?? globalThis.fetch,
      signal: params.signal,
    }),
  );
  return normalizeMemeRush(payload, params.stage);
}

/** Exported for tests. Rows from a launchpad we do not serve are dropped, not mislabelled. */
export function normalizeMemeRush(payload: unknown, stage: MemeRushStage): MemeRushRow[] {
  const data = unwrapEnvelope(payload);
  const rows: MemeRushRow[] = [];
  const seen = new Set<string>();
  for (const raw of asArray(data)) {
    if (!isRecord(raw)) continue;
    const address = normalizeAddress(raw["contractAddress"]);
    if (address === null || seen.has(address)) continue;
    const launchpad = launchpadOf(parseNum(raw["protocol"]));
    if (launchpad === null) continue;
    const createdAt = toEpochMs(raw["createTime"]);
    if (createdAt === null) continue;
    seen.add(address);

    const socials = isRecord(raw["socials"]) ? raw["socials"] : {};
    const migrateStatus = parseNum(raw["migrateStatus"]);
    rows.push({
      address,
      symbol: parseStr(raw["symbol"]) ?? "",
      name: parseStr(raw["name"]),
      launchpad,
      stage,
      createdAt,
      progress: parseNum(raw["progress"]),
      migrated: migrateStatus === 1,
      migratedAt: positiveOrNull(toEpochMs(raw["migrateTime"])),
      quote: normalizeAddress(raw["pairAnchorAddress"]),
      priceUsd: parseNum(raw["price"]),
      marketCapUsd: parseNum(raw["marketCap"]),
      liquidityUsd: parseNum(raw["liquidity"]),
      volume24hUsd: parseNum(raw["volume"]),
      priceChange24hPct: parseNum(raw["priceChange"]),
      holders: parseNum(raw["holders"]),
      count24h: parseNum(raw["count"]),
      buys24h: parseNum(raw["countBuy"]),
      sells24h: parseNum(raw["countSell"]),
      netBuy24hUsd: parseNum(raw["netBuy"]),
      top10Pct: parseNum(raw["holdersTop10Percent"]),
      devPct: parseNum(raw["holdersDevPercent"]),
      sniperPct: parseNum(raw["holdersSniperPercent"]),
      insiderPct: parseNum(raw["holdersInsiderPercent"]),
      bundlerPct: parseNum(raw["bundlerHoldingPercent"]),
      newWalletPct: parseNum(raw["newWalletHoldingPercent"]),
      smartMoneyHolders: parseNum(raw["smartMoneyHolders"]),
      kolHolders: parseNum(raw["kolHolders"]),
      devAddress: normalizeAddress(raw["devAddress"]),
      // `devPosition: 2` is the documented "dev sold all".
      devSoldAll: parseNum(raw["devPosition"]) === 2,
      devMigrateCount: parseNum(raw["devMigrateCount"]),
      washTrading: isTruthyTag(raw["tagDevWashTrading"]) || isTruthyTag(raw["tagInsiderWashTrading"]),
      socials: {
        website: parseStr(socials["website"]),
        twitter: parseStr(socials["twitter"]),
        telegram: parseStr(socials["telegram"]),
      },
    });
  }
  return rows;
}

function launchpadOf(code: number | null): MemeLaunchpad | null {
  if (code === MEME_RUSH_PROTOCOLS.fourmeme) return "fourmeme";
  if (code === MEME_RUSH_PROTOCOLS.flap) return "flap";
  return null;
}

function positiveOrNull(value: number | null): number | null {
  return value === null || value <= 0 ? null : value;
}

/** Tags arrive as `null` when unset; anything set and not falsy counts. */
function isTruthyTag(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "0") return false;
  return value !== "";
}
