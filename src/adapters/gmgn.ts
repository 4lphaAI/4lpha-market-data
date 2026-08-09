/**
 * GMGN adapter — secondary security and holder-distribution enrichment.
 *
 * GMGN answers in roughly half a second and returns large payloads, so nothing
 * polls it: it is called on demand by the query layer and cached hard behind the
 * snapshot store.
 *
 * Auth is `X-APIKEY` plus a `timestamp` / `client_id` pair on the query string,
 * both of which the upstream requires even though only the header carries the
 * secret. Credentials come from `GMGN_API_KEY`; without it the adapter throws
 * {@link MissingCredentialsError}, which callers read as "source unavailable".
 *
 * Two upstream behaviours drive the shape of this module:
 * - An unknown token answers `200` with an all-null body and an empty `address`
 *   rather than `404`, so "unknown" is detected from the payload, not the status.
 * - Field names differ between token generations (`is_honeypot` vs `honeypot`,
 *   `is_renounced` vs `renounced`), so every read accepts the known aliases.
 */

import { randomUUID } from "node:crypto";
import {
  emptyHolderStats,
  type HolderStats,
  type RiskLevel,
  type TokenSecuritySummary,
} from "../core/models.js";
import {
  AdapterError,
  MissingCredentialsError,
  asArray,
  isRecord,
  parseNum,
  parseStr,
  requestSignal,
  sanitizeMessage,
  type FetchFn,
} from "./http.js";

const SOURCE = "gmgn";
const BASE_URL = "https://openapi.gmgn.ai";
const CHAIN = "bsc";
const TOP_HOLDER_LIMIT = 10;
const SMART_MONEY_LIMIT = 50;

/** True when `GMGN_API_KEY` is present in the environment. */
export function hasGmgnCredentials(): boolean {
  return readApiKey() !== null;
}

function readApiKey(): string | null {
  const key = process.env["GMGN_API_KEY"]?.trim();
  return key === undefined || key === "" ? null : key;
}

/**
 * GMGN escalates repeated rate-limit violations into a temporary *IP* ban, so
 * retrying through a 429 makes things strictly worse — and the ban lands on the
 * whole host, not just this adapter. After a 429 the adapter therefore refuses
 * to dial at all until the upstream's own reset time has passed.
 */
const COOLDOWN_FALLBACK_MS = 60_000;
let cooldownUntil = 0;

/** Exported for tests, which must not inherit a cooldown from an earlier case. */
export function resetGmgnCooldown(): void {
  cooldownUntil = 0;
}

/** Reads `x-ratelimit-reset` (unix seconds) when the upstream supplies it. */
function enterCooldown(response: Response): void {
  const reset = Number(response.headers.get("x-ratelimit-reset") ?? "");
  const until = Number.isFinite(reset) && reset > 0 ? reset * 1000 : 0;
  cooldownUntil = Math.max(until, Date.now() + COOLDOWN_FALLBACK_MS);
}

/**
 * Performs one signed GET and unwraps the `{ code, data }` envelope.
 *
 * Returns `null` for a `404`, which means "GMGN has no record of this token" —
 * a valid answer, not a failure, so it must not surface as a throw.
 */
async function gmgnGet(input: {
  path: string;
  params: Array<[string, string]>;
  fetchFn: FetchFn;
  signal: AbortSignal | undefined;
}): Promise<unknown> {
  const apiKey = readApiKey();
  if (apiKey === null) throw new MissingCredentialsError(SOURCE);
  if (Date.now() < cooldownUntil) throw new AdapterError(SOURCE, "rate limited (cooling down)", 429);

  const query = new URLSearchParams([
    ["timestamp", String(Math.floor(Date.now() / 1000))],
    ["client_id", randomUUID()],
    ...input.params,
  ]);

  let response: Response;
  try {
    response = await input.fetchFn(`${BASE_URL}${input.path}?${query.toString()}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0",
        "X-APIKEY": apiKey,
      },
      signal: requestSignal(input.signal),
    });
  } catch (error) {
    throw new AdapterError(SOURCE, sanitizeMessage(error));
  }

  // A rejected key is indistinguishable from an absent one for every caller, so
  // both collapse onto the same "source unavailable" signal.
  if (response.status === 401 || response.status === 403) {
    throw new MissingCredentialsError(SOURCE);
  }
  if (response.status === 404) return null;
  if (response.status === 429) {
    enterCooldown(response);
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
  if (code !== undefined && String(code) !== "0") {
    const message = parseStr(payload["message"]) ?? `unsuccessful code ${String(code)}`;
    throw new AdapterError(SOURCE, sanitizeMessage(message));
  }
  return payload["data"];
}

/** Params shared by every GMGN read. */
export interface GmgnTokenParams {
  address: string;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn;
}

/** Fetches and normalizes GMGN's token security scan. */
export async function fetchGmgnTokenSecurity(
  params: GmgnTokenParams,
): Promise<TokenSecuritySummary> {
  const data = await gmgnGet({
    path: "/v1/token/security",
    params: [
      ["chain", CHAIN],
      ["address", params.address.toLowerCase()],
    ],
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
  });
  return normalizeGmgnSecurity(data);
}

/**
 * Fetches holder count and top-10 concentration. The two live on different
 * endpoints, so a failure of one is not allowed to lose the other: each
 * contributes independently and a missing piece stays `null`.
 *
 * The two requests are issued in sequence, not in parallel. GMGN's limit is a
 * burst limit measured per IP, so firing both at once is the single easiest way
 * to trip it — and tripping it costs the whole host a temporary ban, not just
 * this call. One extra round trip, once per cache period, is the cheaper side of
 * that trade.
 */
export async function fetchGmgnTokenHolders(params: GmgnTokenParams): Promise<HolderStats> {
  const address = params.address.toLowerCase();
  const fetchFn = params.fetchFn ?? globalThis.fetch;

  const info = await settle(
    gmgnGet({
      path: "/v1/token/info",
      params: [
        ["chain", CHAIN],
        ["address", address],
      ],
      fetchFn,
      signal: params.signal,
    }),
  );
  const holders = await settle(
    gmgnGet({
      path: "/v1/market/token_top_holders",
      params: [
        ["chain", CHAIN],
        ["address", address],
        ["limit", String(TOP_HOLDER_LIMIT)],
      ],
      fetchFn,
      signal: params.signal,
    }),
  );

  // Both failing means the source is genuinely down; one failing is degradation.
  if (info.status === "rejected" && holders.status === "rejected") throw info.reason;

  return {
    holders: info.status === "fulfilled" ? readHolderCount(info.value) : null,
    top10Pct: holders.status === "fulfilled" ? readTop10Pct(holders.value) : null,
    smartMoneyCount: null,
    asOf: Date.now(),
    source: SOURCE,
  };
}

/**
 * Counts the "smart money" wallets currently holding the token. Only
 * `smartMoneyCount` is populated; the other fields belong to
 * {@link fetchGmgnTokenHolders} and stay `null` so a merge cannot clobber them.
 */
export async function fetchGmgnSmartMoney(params: GmgnTokenParams): Promise<HolderStats> {
  const data = await gmgnGet({
    path: "/v1/market/token_top_holders",
    params: [
      ["chain", CHAIN],
      ["address", params.address.toLowerCase()],
      ["tag", "smart_degen"],
      ["limit", String(SMART_MONEY_LIMIT)],
    ],
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
  });

  const stats = emptyHolderStats(SOURCE, Date.now());
  if (data === null) return stats;
  return { ...stats, smartMoneyCount: readHolderList(data).length };
}

/** `Promise.allSettled` for a single promise, so failures stay inspectable. */
async function settle<T>(
  promise: Promise<T>,
): Promise<{ status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown }> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

/** Unwraps the `{ list: [...] }` holder envelope, tolerating a bare array. */
function readHolderList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (isRecord(data)) return asArray(data["list"]);
  return [];
}

function readHolderCount(data: unknown): number | null {
  if (!isRecord(data)) return null;
  const count = parseNum(data["holder_count"]);
  return count !== null && count > 0 ? count : null;
}

/**
 * Sums the top holders' shares. GMGN reports each share as a 0..1 ratio, so the
 * total is scaled to a percentage here; an empty list means "not known", which
 * is `null` rather than `0`.
 */
function readTop10Pct(data: unknown): number | null {
  const list = readHolderList(data).slice(0, TOP_HOLDER_LIMIT);
  if (list.length === 0) return null;

  let total = 0;
  let seen = 0;
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const share = parseNum(raw["amount_percentage"]);
    if (share === null || share < 0) continue;
    total += share;
    seen += 1;
  }
  if (seen === 0) return null;
  return roundPct(ratioToPct(total));
}

/**
 * Exported for tests. Maps GMGN's security payload onto a
 * {@link TokenSecuritySummary}; an unknown token yields `unavailable`.
 */
export function normalizeGmgnSecurity(data: unknown): TokenSecuritySummary {
  const scannedAt = Date.now();
  if (!isRecord(data) || isUnknownToken(data)) {
    return { riskLevel: "unavailable", flags: [], scannedAt, source: SOURCE };
  }

  const danger: string[] = [];
  const warn: string[] = [];

  if (readBool(data, ["is_honeypot", "honeypot"]) === true) danger.push("honeypot");
  if (readBool(data, ["can_not_sell"]) === true) danger.push("cannot_sell");
  if (readBool(data, ["is_blacklist", "blacklist"]) === true) danger.push("blacklist");
  if (readBool(data, ["is_wash_trading"]) === true) warn.push("wash_trading");

  const openSource = readBool(data, ["is_open_source", "open_source"]);
  if (openSource === false) warn.push("not_open_source");
  const renounced = readBool(data, ["is_renounced", "renounced"]);
  if (renounced === false) warn.push("not_renounced");

  const tax = maxRatio(data, ["buy_tax", "sell_tax"]);
  if (tax !== null && tax > HIGH_TAX_RATIO) danger.push("high_tax");
  else if (tax !== null && tax > WARN_TAX_RATIO) warn.push("tax");

  const rug = readRatio(data, ["rug_ratio"]);
  if (rug !== null && rug > 0) danger.push("rug_history");

  const top10 = readRatio(data, ["top_10_holder_rate"]);
  if (top10 !== null && top10 > TOP10_WARN_RATIO) warn.push("top10_concentration");

  const insider = maxRatio(data, [
    "suspected_insider_hold_rate",
    "rat_trader_amount_rate",
    "bundler_trader_amount_rate",
  ]);
  if (insider !== null && insider > INSIDER_WARN_RATIO) warn.push("insider_concentration");

  // Upstream free-form flags are carried through, normalized, so a new GMGN
  // signal shows up in the API without a code change.
  for (const raw of asArray(data["flags"])) {
    const flag = parseStr(raw);
    if (flag !== null) warn.push(toFlagName(flag));
  }

  const flags = [...new Set([...danger, ...warn])].sort();
  const riskLevel: RiskLevel = danger.length > 0 ? "danger" : warn.length > 0 ? "warn" : "ok";
  return { riskLevel, flags, scannedAt, source: SOURCE };
}

const HIGH_TAX_RATIO = 0.1;
const WARN_TAX_RATIO = 0.05;
const TOP10_WARN_RATIO = 0.8;
const INSIDER_WARN_RATIO = 0.1;

/**
 * An unknown token comes back `200 OK` as a well-formed object whose `address`
 * is empty and whose verdicts are all `null` — which is emphatically not a clean
 * scan, and would otherwise read as "open source: no, renounced: no".
 *
 * The legacy numeric aliases (`honeypot: 0`, `open_source: 0`) are *not*
 * consulted here: they are zero-filled in that same payload, so they cannot tell
 * "no" apart from "no idea". Only the `is_`-prefixed verdicts carry the null.
 */
function isUnknownToken(data: Record<string, unknown>): boolean {
  const address = parseStr(data["address"]);
  if (address !== null) return false;
  return readBool(data, ["is_honeypot"]) === null && readBool(data, ["is_renounced"]) === null;
}

/**
 * Reads the first present alias as a tri-state boolean. `null` means the field
 * carried no opinion, which must not be confused with `false`.
 */
function readBool(data: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = data[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value > 0 : null;
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
    if (normalized === "false" || normalized === "no" || normalized === "0") return false;
  }
  return null;
}

/**
 * Reads a rate as a 0..1 ratio. GMGN mixes ratios and percentages across
 * fields, so anything above 1 (and no more than 100) is read as a percentage.
 */
function readRatio(data: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const parsed = parseNum(data[key]);
    if (parsed === null || parsed < 0) continue;
    if (parsed > 1 && parsed <= 100) return parsed / 100;
    if (parsed > 100) continue;
    return parsed;
  }
  return null;
}

function maxRatio(data: Record<string, unknown>, keys: string[]): number | null {
  let max: number | null = null;
  for (const key of keys) {
    const value = readRatio(data, [key]);
    if (value === null) continue;
    max = max === null ? value : Math.max(max, value);
  }
  return max;
}

function ratioToPct(ratio: number): number {
  return ratio <= 1 ? ratio * 100 : ratio;
}

function roundPct(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Normalizes an upstream flag label into the service's snake_case convention. */
function toFlagName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 40);
}
