/**
 * Four.Meme launchpad adapter — the meme lane's universe and market source.
 *
 * No credentials. The public search endpoint doubles as a ranking endpoint: the
 * `type` selects the ordering, and the response carries enough market state to
 * seed a {@link TokenSnapshot} alongside each {@link UniverseEntry}.
 */

import type { TokenSnapshot, UniverseEntry } from "../core/models.js";
import {
  AdapterError,
  asArray,
  fetchJson,
  isRecord,
  normalizeAddress,
  parseNum,
  parseStr,
  type FetchFn,
} from "./http.js";

const SOURCE = "fourmeme";
const BASE_URL = "https://four.meme/meme-api/v1";
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

/** Ranking orderings the search endpoint understands. */
export type FourMemeRankingType = "CAP" | "VOL" | "NEW" | "HOT";

export interface FourMemeRankingParams {
  type: FourMemeRankingType;
  page?: number;
  pageSize?: number;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn;
}

export interface FourMemeRankingResult {
  entries: UniverseEntry[];
  snapshots: TokenSnapshot[];
}

/**
 * Fetches one ranking page.
 *
 * The response envelope is `{ code, msg, data }` with `"0"` meaning success, and
 * the token array sits either at `data.list` or directly at `data` depending on
 * the ranking type — both are handled.
 */
export async function fetchFourMemeRanking(
  params: FourMemeRankingParams,
): Promise<FourMemeRankingResult> {
  const pageSize = clampPageSize(params.pageSize);
  const body = JSON.stringify({
    type: params.type,
    listType: "NOR",
    status: "PUBLISH",
    sort: "DESC",
    pageIndex: Math.max(1, Math.trunc(params.page ?? 1)),
    pageSize,
  });

  const payload = await fetchJson({
    source: SOURCE,
    url: `${BASE_URL}/public/token/search`,
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
    method: "POST",
    body,
  });

  return normalizeRankingPayload(payload);
}

function clampPageSize(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_PAGE_SIZE;
  const value = Math.trunc(raw);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(value, MAX_PAGE_SIZE);
}

/** Exported for tests: turns a raw envelope into normalized entries/snapshots. */
export function normalizeRankingPayload(payload: unknown): FourMemeRankingResult {
  const rows = extractRows(payload);
  const entries: UniverseEntry[] = [];
  const snapshots: TokenSnapshot[] = [];

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const address = normalizeAddress(row["tokenAddress"] ?? row["address"]);
    if (address === null) continue;

    const symbol = parseStr(row["shortName"]) ?? parseStr(row["tokenSymbol"]) ?? "";
    const name = parseStr(row["name"]);

    entries.push({
      address,
      symbol,
      ...(name === null ? {} : { name }),
      lane: "meme",
      source: SOURCE,
    });
    snapshots.push(toSnapshot(address, symbol, row));
  }

  return { entries, snapshots };
}

function extractRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];

  const code = payload["code"];
  if (code !== undefined && String(code) !== "0") {
    const message = parseStr(payload["msg"]) ?? `unsuccessful code ${String(code)}`;
    throw new AdapterError(SOURCE, message);
  }

  const data = payload["data"];
  if (Array.isArray(data)) return data;
  if (isRecord(data)) return asArray(data["list"]);
  return asArray(payload["list"]);
}

/**
 * Four.Meme quotes `price` and `cap` in the pool's quote asset (usually BNB),
 * while `day1Vol` is already USD. The USD multiplier is therefore derived from
 * the ratio of the two volume figures, which needs no external BNB price feed.
 * When it cannot be derived, price and market cap stay `null` rather than being
 * published in the wrong currency under a `*Usd` name.
 */
function toSnapshot(address: string, symbol: string, row: Record<string, unknown>): TokenSnapshot {
  const usdVolume = parseNum(row["day1Vol"]);
  const quoteVolume = parseNum(row["volume"]);
  const multiplier = resolveUsdMultiplier(parseStr(row["symbol"]), usdVolume, quoteVolume);

  const quotePrice = parseNum(row["price"]);
  const quoteCap = parseNum(row["cap"]) ?? parseNum(row["marketCap"]);

  return {
    address,
    priceUsd: multiplier === null || quotePrice === null ? null : quotePrice * multiplier,
    marketCapUsd: multiplier === null || quoteCap === null ? null : quoteCap * multiplier,
    volume24hUsd: usdVolume,
    holders: parseNum(row["hold"]) ?? parseNum(row["holders"]),
    priceChange24hPct: parseNum(row["day1Increase"]) ?? parseNum(row["increase"]),
    ...(symbol === "" ? {} : { symbol }),
    updatedFields: [],
  };
}

/**
 * Social links for one token, as declared by its creator on the launchpad.
 * Presence, not signal: a link says the project filled the form in, nothing
 * about activity behind it. Every field nullable — most launches skip some.
 */
export interface TokenSocials {
  address: string;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  description: string | null;
}

export interface FourMemeDetailParams {
  address: string;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn;
}

/**
 * Fetches one token's detail record, for its social links.
 *
 * The path says `private` but the endpoint is keyless — measured 2026-08-12: a
 * plain GET with no cookie or header answers `code 0` with `webUrl`,
 * `telegramUrl` and `twitterUrl`. The ranking rows do *not* carry these fields,
 * which is why the lane job cannot collect them in passing.
 *
 * Returns `null` for a token Four.Meme does not know — a valid answer for the
 * whole rest of the universe, not a failure.
 */
export async function fetchFourMemeSocials(
  params: FourMemeDetailParams,
): Promise<TokenSocials | null> {
  const address = params.address.toLowerCase();
  const payload = await fetchJson({
    source: SOURCE,
    url: `${BASE_URL}/private/token/get/v2?address=${encodeURIComponent(address)}`,
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
  });
  return normalizeSocials(address, payload);
}

/** Exported for tests: normalizes a token-detail payload into socials. */
export function normalizeSocials(address: string, payload: unknown): TokenSocials | null {
  if (!isRecord(payload)) return null;
  const code = payload["code"];
  if (code !== undefined && String(code) !== "0") return null;
  const data = payload["data"];
  if (!isRecord(data)) return null;

  return {
    address,
    website: parseUrl(data["webUrl"]),
    twitter: parseUrl(data["twitterUrl"]),
    telegram: parseUrl(data["telegramUrl"]),
    description: parseStr(data["descr"]) ?? parseStr(data["description"]),
  };
}

/** Accepts only http(s) URLs; creators paste anything into these fields. */
function parseUrl(value: unknown): string | null {
  const raw = parseStr(value);
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const USD_QUOTES = new Set(["USDT", "USDC", "USD", "BUSD", "USD1"]);

function resolveUsdMultiplier(
  quoteSymbol: string | null,
  usdVolume: number | null,
  quoteVolume: number | null,
): number | null {
  const normalized = quoteSymbol?.toUpperCase() ?? "";
  if (normalized !== "" && (USD_QUOTES.has(normalized) || normalized.startsWith("USD"))) {
    return 1;
  }
  if (usdVolume === null || quoteVolume === null || quoteVolume <= 0 || usdVolume <= 0) {
    return null;
  }
  const ratio = usdVolume / quoteVolume;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}
