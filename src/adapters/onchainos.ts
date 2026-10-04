/**
 * OnchainOS (OKX Web3 DEX) adapter — the preferred kline and price source.
 *
 * Requests are HMAC-signed. The prehash string is
 * `timestamp + METHOD + requestPath + body`, where `requestPath` includes the
 * query string exactly as sent, so the query is built once and reused for both
 * the signature and the URL.
 *
 * Credentials come from `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE` and
 * the optional `OKX_PROJECT_ID`. When any required one is missing the adapter
 * throws {@link MissingCredentialsError}, which callers read as "source
 * unavailable" rather than as a failure.
 */

import { createHmac } from "node:crypto";
import type { Candle, RiskLevel, TokenSecuritySummary, TokenSnapshot } from "../core/models.js";
import {
  AdapterError,
  MissingCredentialsError,
  asArray,
  isRecord,
  normalizeAddress,
  parseNum,
  parseStr,
  requestSignal,
  sanitizeMessage,
  sortCandles,
  toEpochMs,
  type FetchFn,
} from "./http.js";

const SOURCE = "onchainos";
const BASE_URL = "https://web3.okx.com";
const BSC_CHAIN_INDEX = "56";
const MAX_KLINE_LIMIT = 299;

interface Credentials {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  projectId: string | null;
}

/** True when every required OKX credential is present in the environment. */
export function hasOnchainosCredentials(): boolean {
  return readCredentials() !== null;
}

function readCredentials(): Credentials | null {
  const apiKey = process.env["OKX_API_KEY"]?.trim();
  const secretKey = process.env["OKX_SECRET_KEY"]?.trim();
  const passphrase = process.env["OKX_PASSPHRASE"]?.trim();
  const projectId = process.env["OKX_PROJECT_ID"]?.trim();
  if (!apiKey || !secretKey || !passphrase) return null;
  return {
    apiKey,
    secretKey,
    passphrase,
    projectId: projectId !== undefined && projectId !== "" ? projectId : null,
  };
}

/** Exported for tests: the base64 HMAC-SHA256 signature of one request. */
export function createSignature(input: {
  timestamp: string;
  method: "GET" | "POST";
  requestPath: string;
  body: string;
  secretKey: string;
}): string {
  const prehash = `${input.timestamp}${input.method}${input.requestPath}${input.body}`;
  return createHmac("sha256", input.secretKey).update(prehash).digest("base64");
}

async function signedRequest(input: {
  method: "GET" | "POST";
  path: string;
  query?: Array<[string, string]>;
  body?: unknown;
  fetchFn: FetchFn;
  signal: AbortSignal | undefined;
}): Promise<unknown> {
  const credentials = readCredentials();
  if (credentials === null) throw new MissingCredentialsError(SOURCE);

  const search = new URLSearchParams(input.query ?? []).toString();
  const requestPath = search === "" ? input.path : `${input.path}?${search}`;
  const bodyText = input.method === "POST" && input.body !== undefined ? JSON.stringify(input.body) : "";
  const timestamp = new Date().toISOString();

  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "Mozilla/5.0",
    "OK-ACCESS-KEY": credentials.apiKey,
    "OK-ACCESS-PASSPHRASE": credentials.passphrase,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-SIGN": createSignature({
      timestamp,
      method: input.method,
      requestPath,
      body: bodyText,
      secretKey: credentials.secretKey,
    }),
  };
  if (credentials.projectId !== null) headers["OK-ACCESS-PROJECT"] = credentials.projectId;

  let response: Response;
  try {
    response = await input.fetchFn(`${BASE_URL}${requestPath}`, {
      method: input.method,
      headers,
      signal: requestSignal(input.signal),
      ...(bodyText === "" ? {} : { body: bodyText }),
    });
  } catch (error) {
    throw new AdapterError(SOURCE, sanitizeMessage(error));
  }

  if (response.status === 401 || response.status === 403) {
    throw new AdapterError(SOURCE, "authentication rejected", response.status);
  }
  if (response.status === 429) {
    throw new AdapterError(SOURCE, "rate limited", 429);
  }
  if (!response.ok) {
    throw new AdapterError(SOURCE, `upstream responded ${response.status}`, response.status);
  }

  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    throw new AdapterError(SOURCE, "invalid JSON in response", response.status);
  }

  if (!isRecord(payload)) throw new AdapterError(SOURCE, "unexpected response shape");
  const code = payload["code"];
  if (String(code) !== "0") {
    const message = parseStr(payload["msg"]) ?? `unsuccessful code ${String(code)}`;
    throw new AdapterError(SOURCE, sanitizeMessage(message));
  }
  return payload["data"];
}

export interface OnchainosKlineParams {
  address: string;
  /** Provider-native bar notation, e.g. `1m`, `15m`, `1H`, `1D`. */
  bar: string;
  limit?: number;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn;
}

/** Fetches historical candles for a BSC token. */
export async function fetchOnchainosKlines(params: OnchainosKlineParams): Promise<Candle[]> {
  const address = params.address.toLowerCase();
  const limit = Math.max(1, Math.min(Math.trunc(params.limit ?? 100), MAX_KLINE_LIMIT));
  const data = await signedRequest({
    method: "GET",
    path: "/api/v6/dex/market/historical-candles",
    query: [
      ["bar", params.bar],
      ["chainIndex", BSC_CHAIN_INDEX],
      ["limit", String(limit)],
      ["tokenContractAddress", address],
    ],
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
  });
  return normalizeKlines(data);
}

/**
 * Exported for tests. Candles arrive either as positional arrays
 * `[ts, o, h, l, c, vol, volUsd, confirm]` or as objects with those same keys.
 */
export function normalizeKlines(data: unknown): Candle[] {
  const candles: Candle[] = [];

  for (const raw of asArray(data)) {
    if (Array.isArray(raw)) {
      const timestamp = toEpochMs(raw[0]);
      if (timestamp === null) continue;
      candles.push({
        timestamp,
        open: parseNum(raw[1]) ?? 0,
        high: parseNum(raw[2]) ?? 0,
        low: parseNum(raw[3]) ?? 0,
        close: parseNum(raw[4]) ?? 0,
        volume: parseNum(raw[5]) ?? 0,
      });
      continue;
    }
    if (!isRecord(raw)) continue;
    const timestamp = toEpochMs(raw["ts"]);
    if (timestamp === null) continue;
    candles.push({
      timestamp,
      open: parseNum(raw["o"]) ?? 0,
      high: parseNum(raw["h"]) ?? 0,
      low: parseNum(raw["l"]) ?? 0,
      close: parseNum(raw["c"]) ?? 0,
      volume: parseNum(raw["vol"]) ?? 0,
    });
  }

  return sortCandles(candles);
}

export interface OnchainosPriceParams {
  address: string;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn;
}

/** Fetches price/market state for a BSC token via the batch price-info endpoint. */
export async function fetchOnchainosPrice(params: OnchainosPriceParams): Promise<TokenSnapshot> {
  const address = params.address.toLowerCase();
  const data = await signedRequest({
    method: "POST",
    path: "/api/v6/dex/market/price-info",
    body: [{ chainIndex: BSC_CHAIN_INDEX, tokenContractAddress: address }],
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
  });
  return normalizePriceInfo(address, data);
}

/** Exported for tests: normalizes the single-element price-info array. */
export function normalizePriceInfo(address: string, data: unknown): TokenSnapshot {
  const first = asArray(data)[0];
  const row = isRecord(first) ? first : isRecord(data) ? data : {};
  return { ...snapshotFromPriceRow(row), address: address.toLowerCase() };
}

function snapshotFromPriceRow(row: Record<string, unknown>): TokenSnapshot {
  return {
    address: normalizeAddress(row["tokenContractAddress"]) ?? "",
    priceUsd: parseNum(row["price"]),
    marketCapUsd: parseNum(row["marketCap"]),
    volume24hUsd: parseNum(row["volume24H"]),
    holders: parseNum(row["holders"]),
    priceChange24hPct: parseNum(row["priceChange24H"]),
    updatedFields: [],
  };
}

/** How many tokens one `price-info` call accepts. */
const MAX_PRICE_BATCH = 100;

export interface OnchainosPricesParams {
  addresses: readonly string[];
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn;
}

/**
 * Fetches price state for many tokens at once, keyed by address.
 *
 * The endpoint silently drops tokens it has never indexed — a batch of four
 * addresses came back with two rows — so results are matched by the response's
 * own `tokenContractAddress` and never by position. A token missing from the
 * map is one OKX has no data for, which for a launchpad token usually means it
 * has not graduated to a DEX pool yet.
 */
export async function fetchOnchainosPrices(
  params: OnchainosPricesParams,
): Promise<Map<string, TokenSnapshot>> {
  const addresses = [...new Set(params.addresses.map((value) => value.toLowerCase()))];
  const snapshots = new Map<string, TokenSnapshot>();

  for (let index = 0; index < addresses.length; index += MAX_PRICE_BATCH) {
    const chunk = addresses.slice(index, index + MAX_PRICE_BATCH);
    const data = await signedRequest({
      method: "POST",
      path: "/api/v6/dex/market/price-info",
      body: chunk.map((address) => ({ chainIndex: BSC_CHAIN_INDEX, tokenContractAddress: address })),
      fetchFn: params.fetchFn ?? globalThis.fetch,
      signal: params.signal,
    });
    for (const [address, snapshot] of normalizePriceInfoRows(data)) snapshots.set(address, snapshot);
  }

  return snapshots;
}

/** Exported for tests: indexes a multi-row price-info payload by its own address field. */
export function normalizePriceInfoRows(data: unknown): Map<string, TokenSnapshot> {
  const snapshots = new Map<string, TokenSnapshot>();
  for (const raw of asArray(data)) {
    if (!isRecord(raw)) continue;
    const snapshot = snapshotFromPriceRow(raw);
    if (snapshot.address === "") continue;
    snapshots.set(snapshot.address, snapshot);
  }
  return snapshots;
}

export interface OnchainosTokenScanParams {
  address: string;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn;
}

/**
 * Runs the OKX token-scan risk check, the primary security source.
 *
 * The endpoint takes a batch but is only ever asked about one token here, so the
 * caller's failure model stays per-token rather than per-batch.
 */
export async function fetchOnchainosTokenScan(
  params: OnchainosTokenScanParams,
): Promise<TokenSecuritySummary> {
  const address = params.address.toLowerCase();
  const data = await signedRequest({
    method: "POST",
    path: "/api/v6/security/token-scan",
    body: {
      source: "onchain_os_cli",
      tokenList: [{ chainId: BSC_CHAIN_INDEX, contractAddress: address }],
    },
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
  });
  return normalizeTokenScan(data);
}

/**
 * Each boolean in the scan payload maps to one stable flag name. Kept as a
 * table so a new upstream signal is one line, and so the flag vocabulary the
 * API exposes is visible in one place.
 */
const SCAN_FLAGS: Array<[string, string]> = [
  ["isHoneypot", "honeypot"],
  ["isRubbishAirdrop", "rubbish_airdrop"],
  ["isAirdropScam", "airdrop_scam"],
  ["isLowLiquidity", "low_liquidity"],
  ["isDumping", "dumping"],
  ["isLiquidityRemoval", "liquidity_removal"],
  ["isPump", "pump"],
  ["isWash", "wash_trading"],
  ["isFakeLiquidity", "fake_liquidity"],
  ["isWash2", "wash_trading_vendor"],
  ["isFundLinkage", "fund_linkage"],
  ["isVeryLowLpBurn", "very_low_lp_burn"],
  ["isVeryHighLpHolderProp", "lp_holder_concentration"],
  ["isHasBlockingHis", "blocking_history"],
  ["isOverIssued", "over_issued"],
  ["isCounterfeit", "counterfeit"],
  ["isNotOpenSource", "not_open_source"],
  ["isMintable", "mintable"],
  ["isHasFrozenAuth", "freeze_authority"],
  ["isNotRenounced", "not_renounced"],
  ["isHasAssetEditAuth", "asset_edit_authority"],
];

/**
 * Exported for tests: maps the scan payload onto a {@link TokenSecuritySummary}.
 *
 * An empty batch, an unsupported chain or an unrecognized risk level all yield
 * `unavailable` — the scanner declining to answer is never read as approval.
 */
export function normalizeTokenScan(data: unknown): TokenSecuritySummary {
  const scannedAt = Date.now();
  const first = asArray(data)[0];
  const row = isRecord(first) ? first : isRecord(data) ? data : null;
  if (row === null || row["isChainSupported"] === false) {
    return { riskLevel: "unavailable", flags: [], scannedAt, source: SOURCE };
  }

  const flags = SCAN_FLAGS.filter(([key]) => row[key] === true)
    .map(([, flag]) => flag)
    .sort();

  return { riskLevel: toRiskLevel(row["riskLevel"]), flags, scannedAt, source: SOURCE };
}

function toRiskLevel(value: unknown): RiskLevel {
  switch (parseStr(value)?.toUpperCase()) {
    case "LOW":
      return "ok";
    case "MEDIUM":
      return "warn";
    case "HIGH":
    case "CRITICAL":
      return "danger";
    default:
      return "unavailable";
  }
}

/**
 * Windowed trading activity for one token, from the same `price-info` call the
 * price path already makes. Measured 2026-10-04: OKX answers for Four.Meme and
 * Flap tokens still on their bonding curve too, not only graduated ones — about
 * half of tokens 1–3 minutes old, and every token past that.
 *
 * `tradeNum` is deliberately not read: it measured 777,427,995.88 on one token,
 * a token amount rather than a count. The `txs*` fields are the trade counts.
 */
export interface TokenActivity {
  address: string;
  /** Upstream observation time, epoch ms. */
  observedAt: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  holders: number | null;
  txs5m: number | null;
  txs1h: number | null;
  txs4h: number | null;
  txs24h: number | null;
  volume5mUsd: number | null;
  volume1hUsd: number | null;
  volume4hUsd: number | null;
  volume24hUsd: number | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  priceChange4hPct: number | null;
  priceChange24hPct: number | null;
}

/** Activity for many tokens, keyed by the response's own address (OKX drops what it has not indexed). */
export async function fetchOnchainosActivity(
  params: OnchainosPricesParams,
): Promise<Map<string, TokenActivity>> {
  const addresses = [...new Set(params.addresses.map((value) => value.toLowerCase()))];
  const out = new Map<string, TokenActivity>();
  for (let index = 0; index < addresses.length; index += MAX_PRICE_BATCH) {
    const chunk = addresses.slice(index, index + MAX_PRICE_BATCH);
    const data = await signedRequest({
      method: "POST",
      path: "/api/v6/dex/market/price-info",
      body: chunk.map((address) => ({ chainIndex: BSC_CHAIN_INDEX, tokenContractAddress: address })),
      fetchFn: params.fetchFn ?? globalThis.fetch,
      signal: params.signal,
    });
    for (const [address, activity] of normalizeActivityRows(data)) out.set(address, activity);
  }
  return out;
}

/** Exported for tests. */
export function normalizeActivityRows(data: unknown): Map<string, TokenActivity> {
  const out = new Map<string, TokenActivity>();
  for (const raw of asArray(data)) {
    if (!isRecord(raw)) continue;
    const address = normalizeAddress(raw["tokenContractAddress"]);
    if (address === null) continue;
    out.set(address, {
      address,
      observedAt: parseNum(raw["time"]),
      priceUsd: parseNum(raw["price"]),
      marketCapUsd: parseNum(raw["marketCap"]),
      liquidityUsd: parseNum(raw["liquidity"]),
      holders: parseNum(raw["holders"]),
      txs5m: parseNum(raw["txs5M"]),
      txs1h: parseNum(raw["txs1H"]),
      txs4h: parseNum(raw["txs4H"]),
      txs24h: parseNum(raw["txs24H"]),
      volume5mUsd: parseNum(raw["volume5M"]),
      volume1hUsd: parseNum(raw["volume1H"]),
      volume4hUsd: parseNum(raw["volume4H"]),
      volume24hUsd: parseNum(raw["volume24H"]),
      priceChange5mPct: parseNum(raw["priceChange5M"]),
      priceChange1hPct: parseNum(raw["priceChange1H"]),
      priceChange4hPct: parseNum(raw["priceChange4H"]),
      priceChange24hPct: parseNum(raw["priceChange24H"]),
    });
  }
  return out;
}

/** OKX `walletType` codes on the signal feed. */
export const SIGNAL_WALLET_TYPES = { "1": "smart_money", "2": "kol", "3": "whale" } as const;
export type SignalWalletType = (typeof SIGNAL_WALLET_TYPES)[keyof typeof SIGNAL_WALLET_TYPES];

/**
 * One buy signal: `walletCount` tagged wallets bought the token around `at`.
 * Token-level aggregate, not wallet tracking — the trigger addresses are not
 * kept. `soldRatioPct` is how much of that buy the wallets have since sold
 * (measured 91.37 on one row), so a signal whose wallets already left says so.
 */
export interface SmartSignal {
  id: string;
  address: string;
  symbol: string | null;
  walletType: SignalWalletType;
  walletCount: number;
  amountUsd: number | null;
  soldRatioPct: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  at: number;
}

export interface OnchainosSignalsParams {
  limit?: number;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn;
}

/**
 * The newest signals on BSC across smart money, KOL and whale wallets.
 * Measured 2026-10-04: 100 signals span ~41 h on BSC (~2.4/h), newest 22–35 min old.
 */
export async function fetchOnchainosSignals(params: OnchainosSignalsParams = {}): Promise<SmartSignal[]> {
  const data = await signedRequest({
    method: "POST",
    path: "/api/v6/dex/market/signal/list",
    body: {
      chainIndex: BSC_CHAIN_INDEX,
      walletType: Object.keys(SIGNAL_WALLET_TYPES).join(","),
      limit: String(Math.min(Math.max(1, Math.trunc(params.limit ?? 100)), 100)),
    },
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
  });
  return normalizeSignals(data);
}

/** Exported for tests. */
export function normalizeSignals(data: unknown): SmartSignal[] {
  const out: SmartSignal[] = [];
  for (const raw of asArray(data)) {
    if (!isRecord(raw)) continue;
    const token = isRecord(raw["token"]) ? raw["token"] : {};
    const address = normalizeAddress(token["tokenAddress"]);
    const at = parseNum(raw["timestamp"]);
    const typeCode = parseStr(raw["walletType"]) ?? String(parseNum(raw["walletType"]) ?? "");
    const walletType = (SIGNAL_WALLET_TYPES as Record<string, SignalWalletType>)[typeCode];
    if (address === null || at === null || walletType === undefined) continue;
    out.push({
      id: `${walletType}:${address}:${at}`,
      address,
      symbol: parseStr(token["symbol"]),
      walletType,
      walletCount: parseNum(raw["triggerWalletCount"]) ?? 0,
      amountUsd: parseNum(raw["amountUsd"]),
      soldRatioPct: parseNum(raw["soldRatioPercent"]),
      priceUsd: parseNum(raw["price"]),
      marketCapUsd: parseNum(token["marketCapUsd"]),
      at,
    });
  }
  return out;
}

/**
 * OKX launchpad protocol ids on BSC, from `memepump/supported/chainsProtocol`
 * (measured 2026-10-04).
 */
export const OKX_LAUNCHPAD_PROTOCOLS = { fourmeme: "135086", flap: "129826" } as const;
export type OkxLaunchpad = keyof typeof OKX_LAUNCHPAD_PROTOCOLS;

/** `rankingTimeFrame` codes. */
export const HOT_TIMEFRAMES = { "5m": "1", "1h": "2" } as const;
export type HotTimeframe = keyof typeof HOT_TIMEFRAMES;

/**
 * One row of OKX's hot-token ranking. Trade fields cover the requested
 * timeframe only. Measured 2026-10-04, ranked by trade count over 1h: Four.Meme
 * had 45 tokens with ≥10 trades and ≥$1k in the hour against 4 found through
 * Meme Rush, because the ranking keeps graduated tokens of any age (quq,
 * mubarak) that the lifecycle lists have long dropped.
 */
export interface HotToken {
  address: string;
  symbol: string;
  launchpad: OkxLaunchpad;
  timeframe: HotTimeframe;
  txs: number | null;
  txsBuy: number | null;
  txsSell: number | null;
  uniqueTraders: number | null;
  volumeUsd: number | null;
  changePct: number | null;
  inflowUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  holders: number | null;
  firstTradeAt: number | null;
  top10Pct: number | null;
  devPct: number | null;
  insiderPct: number | null;
  bundlerPct: number | null;
}

export interface OnchainosHotParams {
  launchpad: OkxLaunchpad;
  timeframe: HotTimeframe;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn;
}

/** The 100 most-traded tokens of one launchpad over one timeframe. */
export async function fetchOnchainosHotTokens(params: OnchainosHotParams): Promise<HotToken[]> {
  const data = await signedRequest({
    method: "GET",
    path: "/api/v6/dex/market/token/hot-token",
    query: [
      ["chainIndex", BSC_CHAIN_INDEX],
      ["rankingType", "4"],
      ["rankBy", "3"],
      ["rankingTimeFrame", HOT_TIMEFRAMES[params.timeframe]],
      ["protocolId", OKX_LAUNCHPAD_PROTOCOLS[params.launchpad]],
      ["limit", "100"],
    ],
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
  });
  return normalizeHotTokens(data, params.launchpad, params.timeframe);
}

/** Exported for tests. */
export function normalizeHotTokens(data: unknown, launchpad: OkxLaunchpad, timeframe: HotTimeframe): HotToken[] {
  const out: HotToken[] = [];
  const seen = new Set<string>();
  for (const raw of asArray(data)) {
    if (!isRecord(raw)) continue;
    const address = normalizeAddress(raw["tokenContractAddress"]);
    if (address === null || seen.has(address)) continue;
    seen.add(address);
    out.push({
      address,
      symbol: parseStr(raw["tokenSymbol"]) ?? "",
      launchpad,
      timeframe,
      txs: parseNum(raw["txs"]),
      txsBuy: parseNum(raw["txsBuy"]),
      txsSell: parseNum(raw["txsSell"]),
      uniqueTraders: parseNum(raw["uniqueTraders"]),
      volumeUsd: parseNum(raw["volume"]),
      changePct: parseNum(raw["change"]),
      inflowUsd: parseNum(raw["inflowUsd"]),
      liquidityUsd: parseNum(raw["liquidity"]),
      marketCapUsd: parseNum(raw["marketCap"]),
      holders: parseNum(raw["holders"]),
      firstTradeAt: parseNum(raw["firstTradeTime"]),
      top10Pct: parseNum(raw["top10HoldPercent"]),
      devPct: parseNum(raw["devHoldPercent"]),
      insiderPct: parseNum(raw["insiderHoldPercent"]),
      bundlerPct: parseNum(raw["bundleHoldPercent"]),
    });
  }
  return out;
}
