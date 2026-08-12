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
 * source IP, so every Binance-host request funnels through here; the Sintral
 * kline host is a different service and is intentionally not gated.
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

/** Fetches OHLCV bars from the Sintral kline service used by Binance Web3. */
export async function fetchSintralKlines(params: SintralKlineParams): Promise<Candle[]> {
  const address = params.address.toLowerCase();
  const limit = Math.max(1, Math.trunc(params.limit));
  const url =
    `${KLINE_URL}?address=${encodeURIComponent(address)}` +
    `&interval=${encodeURIComponent(params.interval)}&limit=${limit}&platform=bsc`;

  const payload = await fetchJson({
    source: SOURCE,
    url,
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
  });
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
