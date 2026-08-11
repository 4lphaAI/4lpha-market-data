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
