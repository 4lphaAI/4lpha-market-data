/**
 * Binance Web3 API adapter — the signed `/build/api/v1/...` surface, starting
 * with RWA Data (tokenized stocks). Distinct from `binanceWeb3.ts`, which reads
 * the undocumented public `bapi` endpoints for the Alpha list.
 *
 * Everything measured against the live API on 2026-09-16 (see DEVEX-NOTES.md):
 *
 * - The signed `requestPath` must carry the `/build` prefix and the query
 *   string exactly as sent — omitting the prefix is `40102 Invalid signature`.
 * - Two requests with the same path in the same millisecond share a signature,
 *   and the server keys anti-replay on `X-OC-NONCE` *falling back to the
 *   signature*, so the second is `401 40103 Duplicate request detected`. A
 *   fresh nonce goes on every request.
 * - The rate limit is 5 rps **per key across all endpoints**, not per endpoint
 *   as documented. One module-level bucket paces every caller in the process.
 * - `/price` with 100 addresses (the documented maximum) is a bare `HTTP 414`
 *   from the gateway; 80 fits. Batches are chunked at {@link RWA_PRICE_BATCH_MAX}.
 *
 * Credentials come from `BINANCE_WEB3_API_KEY` / `BINANCE_WEB3_SECRET_KEY`.
 * With either missing every call throws {@link MissingCredentialsError}, which
 * callers read as "source unavailable" rather than as a failure.
 */

import { createHmac, randomUUID } from "node:crypto";
import type { RwaToken } from "../core/models.js";
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
  type FetchFn,
} from "./http.js";
import { createRateLimiter, type RateLimiter } from "./rateLimiter.js";

export const BINANCE_RWA_SOURCE = "binance-rwa";
const SOURCE = BINANCE_RWA_SOURCE;
const BASE_URL = "https://web3.binance.com";
/** Signed path prefix. Part of the prehash string, not just the URL. */
const PATH_PREFIX = "/build";
const RWA_PATH = "/api/v1/dex/market/rwa";
export const BSC_CHAIN_ID = "56";

/** Measured ceiling: 80 addresses → 200, 90 → 414. */
export const RWA_PRICE_BATCH_MAX = 80;
/** Binance's per-key ceiling, shared by every endpoint. */
export const BINANCE_RWA_RPS = 5;
/** Longest a 429 retry will wait, whatever `Retry-After` says. */
export const RETRY_AFTER_CAP_S = 5;

/**
 * One bucket per process. Every future caller of this adapter — candles,
 * underlying-market sweeps — must go through it, because the server counts
 * the key, not the endpoint.
 */
export const BINANCE_RWA_LIMITER: RateLimiter = createRateLimiter({
  capacity: BINANCE_RWA_RPS,
  refillPerSecond: BINANCE_RWA_RPS,
});

interface Credentials {
  apiKey: string;
  secretKey: string;
}

/** True when both Binance Web3 credentials are present in the environment. */
export function hasBinanceRwaCredentials(): boolean {
  return readCredentials() !== null;
}

function readCredentials(): Credentials | null {
  const apiKey = process.env["BINANCE_WEB3_API_KEY"]?.trim();
  const secretKey = process.env["BINANCE_WEB3_SECRET_KEY"]?.trim();
  if (!apiKey || !secretKey) return null;
  return { apiKey, secretKey };
}

/** Exported for tests: `base64(HMAC-SHA256(timestamp + METHOD + requestPath + body))`. */
export function createSignature(input: {
  timestamp: string;
  method: "GET" | "POST";
  /** Must include the `/build` prefix and the query string. */
  requestPath: string;
  body: string;
  secretKey: string;
}): string {
  const prehash = `${input.timestamp}${input.method}${input.requestPath}${input.body}`;
  return createHmac("sha256", input.secretKey).update(prehash).digest("base64");
}

export interface SignedRequestOptions {
  method: "GET" | "POST";
  /** Path without the `/build` prefix, e.g. `/api/v1/dex/market/rwa/tokens`. */
  path: string;
  query?: Array<[string, string]>;
  body?: unknown;
  fetchFn?: FetchFn | undefined;
  signal?: AbortSignal | undefined;
  /** Test hook: how long to wait before the single 429 retry. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Test hook: bypass the process-wide limiter. */
  limiter?: RateLimiter | undefined;
  /** Flash quote/build calls are single-attempt; existing callers keep the retry default. */
  retryOn429?: boolean | undefined;
  /** Optional response cap for bounded proxy calls. */
  maxResponseBytes?: number | undefined;
  /** Optional request deadline override. */
  timeoutMs?: number | undefined;
  /** Refuse redirects for bounded proxy calls. */
  redirect?: RequestInit["redirect"] | undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AdapterError(SOURCE, "response too large", 413);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * One signed request, paced by the shared limiter, with exactly one retry on
 * 429. Returns the `data` member of a `code 0` envelope.
 */
export async function signedRequest(options: SignedRequestOptions): Promise<unknown> {
  const credentials = readCredentials();
  if (credentials === null) throw new MissingCredentialsError(SOURCE);

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const limiter = options.limiter ?? BINANCE_RWA_LIMITER;
  const sleep = options.sleep ?? defaultSleep;
  const operationSignal = requestSignal(options.signal, options.timeoutMs);

  const search = new URLSearchParams(options.query ?? []).toString();
  const requestPath = `${PATH_PREFIX}${options.path}${search === "" ? "" : `?${search}`}`;
  const bodyText = options.method === "POST" && options.body !== undefined ? JSON.stringify(options.body) : "";

  for (let attempt = 0; ; attempt++) {
    await limiter.acquire(operationSignal);

    const timestamp = new Date().toISOString();
    const headers: Record<string, string> = {
      accept: "application/json",
      "X-OC-APIKEY": credentials.apiKey,
      "X-OC-TIMESTAMP": timestamp,
      "X-OC-SIGN": createSignature({
        timestamp,
        method: options.method,
        requestPath,
        body: bodyText,
        secretKey: credentials.secretKey,
      }),
      "X-OC-NONCE": randomUUID(),
    };
    if (bodyText !== "") headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await fetchFn(`${BASE_URL}${requestPath}`, {
        method: options.method,
        headers,
        signal: operationSignal,
        ...(options.redirect === undefined ? {} : { redirect: options.redirect }),
        ...(bodyText === "" ? {} : { body: bodyText }),
      });
    } catch (error) {
      throw new AdapterError(SOURCE, sanitizeMessage(error));
    }

    if (response.status === 429) {
      if (attempt === 0 && options.retryOn429 !== false) {
        // Measured Retry-After is 1; the cap keeps an upstream that says 3600
        // from parking a run long past the job's own timeout.
        const retryAfter = parseNum(response.headers.get("retry-after")) ?? 1;
        await sleep(Math.min(RETRY_AFTER_CAP_S, Math.max(1, retryAfter)) * 1000);
        if (operationSignal.aborted) throw new AdapterError(SOURCE, "aborted while waiting to retry", 429);
        continue;
      }
      throw new AdapterError(SOURCE, "rate limited", 429);
    }
    if (response.status === 401 || response.status === 403) {
      // `x-oc-blocked-by` is the only thing separating a bad key from a
      // replay rejection; the header carries no secret.
      const blockedBy = response.headers.get("x-oc-blocked-by");
      throw new AdapterError(
        SOURCE,
        blockedBy === null ? "authentication rejected" : `authentication rejected (${sanitizeMessage(blockedBy).slice(0, 64)})`,
        response.status,
      );
    }
    if (response.status === 414) {
      throw new AdapterError(SOURCE, "request too long", 414);
    }
    if (!response.ok) {
      throw new AdapterError(SOURCE, `upstream responded ${response.status}`, response.status);
    }

    let payload: unknown;
    try {
      const responseText = options.maxResponseBytes === undefined
        ? await response.text()
        : await boundedResponseText(response, options.maxResponseBytes);
      payload = JSON.parse(responseText) as unknown;
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError(SOURCE, "invalid JSON in response", response.status);
    }
    if (!isRecord(payload)) throw new AdapterError(SOURCE, "unexpected response shape", response.status);
    const code = payload["code"];
    if (String(code) !== "0") {
      const message = parseStr(payload["msg"]) ?? `unsuccessful code ${String(code)}`;
      throw new AdapterError(SOURCE, sanitizeMessage(message));
    }
    return payload["data"];
  }
}

// ---------------------------------------------------------------- tokens ----

export interface RwaTokensParams {
  chainId?: string;
  platformId?: "bstock" | "ondo" | undefined;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn | undefined;
}

export interface RwaTokensResult {
  tokens: RwaToken[];
  /** Rows the normalizer refused (no address or symbol) — a shape change shows here. */
  dropped: number;
}

/** The full RWA token list for one chain. One call, no pagination (488 rows measured). */
export async function fetchRwaTokens(params: RwaTokensParams = {}): Promise<RwaTokensResult> {
  const query: Array<[string, string]> = [["binanceChainId", params.chainId ?? BSC_CHAIN_ID]];
  if (params.platformId !== undefined) query.push(["platformId", params.platformId]);
  const data = await signedRequest({
    method: "GET",
    path: `${RWA_PATH}/tokens`,
    query,
    fetchFn: params.fetchFn,
    signal: params.signal,
  });
  return normalizeRwaTokens(data);
}

/** Exported for tests. */
export function normalizeRwaTokens(data: unknown): RwaTokensResult {
  const tokens: RwaToken[] = [];
  let dropped = 0;
  for (const raw of asArray(data)) {
    const token = normalizeRwaToken(raw);
    if (token === null) dropped++;
    else tokens.push(token);
  }
  return { tokens, dropped };
}

function normalizeRwaToken(raw: unknown): RwaToken | null {
  if (!isRecord(raw)) return null;
  const address = normalizeAddress(raw["tokenContractAddress"]);
  const symbol = parseStr(raw["tokenSymbol"]);
  if (address === null || symbol === null || symbol === "") return null;

  const status = isRecord(raw["statusInfo"]) ? raw["statusInfo"] : {};
  const tokenPriceUsd = parseNum(raw["tokenPrice"]);
  const referencePriceUsd = parseNum(raw["referencePrice"]);

  return {
    address,
    symbol,
    name: parseStr(raw["tokenName"]),
    platform: parseStr(raw["platformId"]) ?? "unknown",
    underlyingTicker: parseStr(raw["underlyingTicker"]),
    underlyingName: parseStr(raw["underlyingName"]),
    decimals: parseNum(raw["decimals"]),
    tokenToShareRatio: parseNum(raw["tokenToShareRatio"]),
    tokenPriceUsd,
    referencePriceUsd,
    navPremiumBps: premiumBps(tokenPriceUsd, referencePriceUsd),
    underlyingMarketCapUsd: parseNum(raw["marketCap"]),
    underlyingVolume24hUsd: parseNum(raw["volume24H"]),
    openState: typeof status["openState"] === "boolean" ? status["openState"] : null,
    marketStatus: parseStr(status["marketStatus"]),
    reasonCode: parseStr(status["reasonCode"]),
    nextOpenMs: parseNum(status["nextOpenTime"]),
    nextCloseMs: parseNum(status["nextCloseTime"]),
  };
}

/** Exported for tests. `null` unless both prices are positive. */
export function premiumBps(tokenPriceUsd: number | null, referencePriceUsd: number | null): number | null {
  if (tokenPriceUsd === null || referencePriceUsd === null) return null;
  if (!(tokenPriceUsd > 0) || !(referencePriceUsd > 0)) return null;
  return Math.round((tokenPriceUsd / referencePriceUsd - 1) * 10_000);
}

// ----------------------------------------------------------------- price ----

export interface RwaPrice {
  address: string;
  platform: string | null;
  tokenPriceUsd: number | null;
  referencePriceUsd: number | null;
  premiumBps: number | null;
  /** Epoch ms of the token price, per Binance. */
  tokenPriceUpdatedAt: number | null;
}

export interface RwaPricesParams {
  chainId?: string;
  addresses: string[];
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn | undefined;
}

/**
 * Prices for many tokens, chunked at {@link RWA_PRICE_BATCH_MAX} and issued
 * sequentially. Keyed by the response's own address: Binance drops tokens it
 * does not know, so request position means nothing.
 */
export async function fetchRwaPrices(params: RwaPricesParams): Promise<Map<string, RwaPrice>> {
  const addresses = [...new Set(params.addresses.map((a) => a.toLowerCase()))];
  const out = new Map<string, RwaPrice>();
  for (let i = 0; i < addresses.length; i += RWA_PRICE_BATCH_MAX) {
    const chunk = addresses.slice(i, i + RWA_PRICE_BATCH_MAX);
    const data = await signedRequest({
      method: "GET",
      path: `${RWA_PATH}/price`,
      query: [
        ["binanceChainId", params.chainId ?? BSC_CHAIN_ID],
        ["tokenContractAddresses", chunk.join(",")],
      ],
      fetchFn: params.fetchFn,
      signal: params.signal,
    });
    for (const row of normalizeRwaPrices(data)) out.set(row.address, row);
  }
  return out;
}

/** Exported for tests. */
export function normalizeRwaPrices(data: unknown): RwaPrice[] {
  const rows: RwaPrice[] = [];
  for (const raw of asArray(data)) {
    if (!isRecord(raw)) continue;
    const address = normalizeAddress(raw["tokenContractAddress"]);
    if (address === null) continue;
    const tokenPriceUsd = parseNum(raw["tokenPrice"]);
    const referencePriceUsd = parseNum(raw["referencePrice"]);
    rows.push({
      address,
      platform: parseStr(raw["platformId"]),
      tokenPriceUsd,
      referencePriceUsd,
      premiumBps: premiumBps(tokenPriceUsd, referencePriceUsd),
      tokenPriceUpdatedAt: parseNum(raw["tokenPriceUpdatedAt"]),
    });
  }
  return rows;
}

// ----------------------------------------------------- underlying market ----

export interface RwaUnderlyingMarket {
  address: string;
  platform: string | null;
  openState: boolean | null;
  marketStatus: string | null;
  reasonCode: string | null;
  nextOpenMs: number | null;
  nextCloseMs: number | null;
  referencePriceUsd: number | null;
  high52wUsd: number | null;
  low52wUsd: number | null;
  volumeShares24h: number | null;
  avgDailyVolume1y: number | null;
  totalShares: number | null;
  marketCapUsd: number | null;
  peRatioTtm: number | null;
  dividendYield: number | null;
}

export interface RwaUnderlyingMarketParams {
  chainId?: string;
  address: string;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn | undefined;
}

/** Session state and equity fundamentals for one token's underlying. */
export async function fetchRwaUnderlyingMarket(
  params: RwaUnderlyingMarketParams,
): Promise<RwaUnderlyingMarket> {
  const address = params.address.toLowerCase();
  const data = await signedRequest({
    method: "GET",
    path: `${RWA_PATH}/underlying-market`,
    query: [
      ["binanceChainId", params.chainId ?? BSC_CHAIN_ID],
      ["tokenContractAddress", address],
    ],
    fetchFn: params.fetchFn,
    signal: params.signal,
  });
  const market = normalizeRwaUnderlyingMarket(data);
  if (market === null) throw new AdapterError(SOURCE, "unexpected underlying-market payload");
  return market;
}

/** Exported for tests. */
export function normalizeRwaUnderlyingMarket(data: unknown): RwaUnderlyingMarket | null {
  if (!isRecord(data)) return null;
  const address = normalizeAddress(data["tokenContractAddress"]);
  if (address === null) return null;
  const status = isRecord(data["statusInfo"]) ? data["statusInfo"] : {};
  const market = isRecord(data["marketData"]) ? data["marketData"] : {};
  return {
    address,
    platform: parseStr(data["platformId"]),
    openState: typeof status["openState"] === "boolean" ? status["openState"] : null,
    marketStatus: parseStr(status["marketStatus"]),
    reasonCode: parseStr(status["reasonCode"]),
    nextOpenMs: parseNum(status["nextOpenTime"]),
    nextCloseMs: parseNum(status["nextCloseTime"]),
    referencePriceUsd: parseNum(market["referencePrice"]),
    high52wUsd: parseNum(market["high52W"]),
    low52wUsd: parseNum(market["low52W"]),
    volumeShares24h: parseNum(market["volumeShares24H"]),
    avgDailyVolume1y: parseNum(market["avgDailyVolume1Y"]),
    totalShares: parseNum(market["totalShares"]),
    marketCapUsd: parseNum(market["marketCap"]),
    peRatioTtm: parseNum(market["peRatioTTM"]),
    dividendYield: parseNum(market["dividendYield"]),
  };
}

// ------------------------------------------------------------- platforms ----

export interface RwaPlatform {
  platformId: string;
  tickerCount: number | null;
  /** Token count per Binance chain id, e.g. `{ "56": 77 }`. */
  chainTokenCounts: Record<string, number>;
  website: string | null;
}

export interface RwaPlatformsParams {
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn | undefined;
}

/** The issuers the API knows (`ondo`, `bstock` as of 2026-09-16 — no xStocks). */
export async function fetchRwaPlatforms(params: RwaPlatformsParams = {}): Promise<RwaPlatform[]> {
  const data = await signedRequest({
    method: "GET",
    path: `${RWA_PATH}/platforms`,
    fetchFn: params.fetchFn,
    signal: params.signal,
  });
  return normalizeRwaPlatforms(data);
}

/** Exported for tests. */
export function normalizeRwaPlatforms(data: unknown): RwaPlatform[] {
  const rows: RwaPlatform[] = [];
  for (const raw of asArray(data)) {
    if (!isRecord(raw)) continue;
    const platformId = parseStr(raw["platformId"]);
    if (platformId === null) continue;
    const chainTokenCounts: Record<string, number> = {};
    for (const entry of asArray(raw["chainDistribution"])) {
      if (!isRecord(entry)) continue;
      const chain = parseStr(entry["binanceChainId"]);
      const count = parseNum(entry["tokenCount"]);
      if (chain !== null && count !== null) chainTokenCounts[chain] = count;
    }
    rows.push({
      platformId,
      tickerCount: parseNum(raw["tickerCount"]),
      chainTokenCounts,
      website: parseStr(raw["website"]),
    });
  }
  return rows;
}
