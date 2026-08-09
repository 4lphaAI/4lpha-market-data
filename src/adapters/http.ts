/**
 * Shared HTTP plumbing for every market-data adapter.
 *
 * Three rules hold across all adapters:
 * 1. `fetch` is injectable, so tests never touch the network.
 * 2. Every request carries a 12s deadline, combined with the caller's signal so
 *    a scheduler timeout actually cancels in-flight work.
 * 3. Upstream failures are re-thrown as {@link AdapterError} with a short,
 *    sanitized message — URLs, query strings and credentials never leak into a
 *    log line or an HTTP response.
 */

/** Injectable fetch, so tests can supply a fake without a network. */
export type FetchFn = typeof globalThis.fetch;

/** Hard deadline applied to every adapter request. */
export const REQUEST_TIMEOUT_MS = 12_000;

const MAX_MESSAGE_CHARS = 200;

/** A sanitized upstream failure. Never carries a URL, key or raw payload. */
export class AdapterError extends Error {
  constructor(
    /** Adapter that produced the failure, e.g. `fourmeme`. */
    readonly source: string,
    message: string,
    /** HTTP status, when the failure came from a response. */
    readonly status?: number,
  ) {
    super(`${source}: ${message}`);
    this.name = "AdapterError";
  }
}

/** Thrown when a keyed adapter is called without its credentials configured. */
export class MissingCredentialsError extends Error {
  constructor(readonly source: string) {
    super(`${source}: credentials not configured`);
    this.name = "MissingCredentialsError";
  }
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/giu;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{24,}\b/gu;

/**
 * Reduces an arbitrary thrown value to a short message safe to log or return.
 * Anything URL-shaped or long-and-opaque (keys, signatures, bearer tokens) is
 * replaced rather than trimmed, so no prefix of a secret survives.
 */
export function sanitizeMessage(value: unknown): string {
  const raw =
    value instanceof Error && value.message !== ""
      ? value.message
      : typeof value === "string" && value !== ""
        ? value
        : "request failed";
  return raw
    .replace(URL_PATTERN, "[url]")
    .replace(LONG_TOKEN_PATTERN, "[redacted]")
    .slice(0, MAX_MESSAGE_CHARS);
}

/**
 * Combines the caller's cancellation with this adapter's own deadline. Either
 * one firing aborts the request.
 */
export function requestSignal(external: AbortSignal | undefined): AbortSignal {
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return external === undefined ? deadline : AbortSignal.any([external, deadline]);
}

/** Options for {@link fetchJson}. */
export interface FetchJsonOptions {
  source: string;
  url: string;
  fetchFn: FetchFn;
  signal?: AbortSignal | undefined;
  method?: "GET" | "POST";
  /** Already-serialized request body; only sent for POST. */
  body?: string | undefined;
  headers?: Record<string, string>;
}

const DEFAULT_HEADERS: Record<string, string> = {
  accept: "application/json",
  "user-agent": "Mozilla/5.0",
};

/**
 * Performs a request and parses the JSON body, returning it as `unknown` so
 * callers are forced to narrow provider data instead of trusting its shape.
 */
export async function fetchJson(options: FetchJsonOptions): Promise<unknown> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { ...DEFAULT_HEADERS, ...options.headers };
  if (method === "POST") headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await options.fetchFn(options.url, {
      method,
      headers,
      signal: requestSignal(options.signal),
      ...(method === "POST" && options.body !== undefined ? { body: options.body } : {}),
    });
  } catch (error) {
    throw new AdapterError(options.source, sanitizeMessage(error));
  }

  if (!response.ok) {
    throw new AdapterError(
      options.source,
      `upstream responded ${response.status}`,
      response.status,
    );
  }

  try {
    return (await response.json()) as unknown;
  } catch {
    throw new AdapterError(options.source, "invalid JSON in response", response.status);
  }
}

/** Narrows to a plain object, excluding arrays and null. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a provider number. Returns `null` — never `NaN` — for anything that is
 * not a finite number, including empty strings, `"null"` and objects.
 */
export function parseNum(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parses a provider string, collapsing blanks and non-strings to `null`. */
export function parseStr(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Returns the value as an array of unknowns, or an empty array. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/u;

/** True for a syntactically valid EVM address. */
export function isEvmAddress(value: string): boolean {
  return ADDRESS_PATTERN.test(value);
}

/** Lowercases an EVM address, returning `null` when the input is not one. */
export function normalizeAddress(value: unknown): string | null {
  const text = parseStr(value);
  if (text === null || !isEvmAddress(text)) return null;
  return text.toLowerCase();
}

/** Sorts candles ascending by timestamp and drops structurally broken bars. */
export function sortCandles<T extends { timestamp: number }>(candles: T[]): T[] {
  return candles
    .filter((candle) => Number.isFinite(candle.timestamp) && candle.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Normalizes a provider timestamp to epoch milliseconds. Values that look like
 * seconds (below ~2001 in ms terms) are scaled up.
 */
export function toEpochMs(value: unknown): number | null {
  const parsed = parseNum(value);
  if (parsed === null || parsed <= 0) return null;
  return parsed < 1e12 ? Math.round(parsed * 1000) : Math.round(parsed);
}
