/**
 * Birdeye adapter — OHLCV only, used as the last kline fallback.
 *
 * Keyed by `BIRDEYE_API_KEY` (header `X-API-KEY`), chain pinned to BSC. The
 * endpoint is window-based rather than count-based, so callers pass an explicit
 * `[from, to]` range in epoch seconds.
 */

import type { Candle } from "../core/models.js";
import {
  AdapterError,
  MissingCredentialsError,
  asArray,
  isRecord,
  parseNum,
  parseStr,
  requestSignal,
  sanitizeMessage,
  sortCandles,
  toEpochMs,
  type FetchFn,
} from "./http.js";

const SOURCE = "birdeye";
const BASE_URL = "https://public-api.birdeye.so";
const CHAIN = "bsc";

/** True when `BIRDEYE_API_KEY` is configured. */
export function hasBirdeyeApiKey(): boolean {
  return readApiKey() !== null;
}

function readApiKey(): string | null {
  const value = process.env["BIRDEYE_API_KEY"]?.trim();
  return value !== undefined && value !== "" ? value : null;
}

export interface BirdeyeKlineParams {
  address: string;
  /** Provider-native bar type, e.g. `1m`, `15m`, `1H`, `1D`. */
  type: string;
  /** Window start, epoch seconds. */
  from: number;
  /** Window end, epoch seconds. */
  to: number;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn;
}

/** Fetches OHLCV bars for a BSC token within the requested window. */
export async function fetchBirdeyeKlines(params: BirdeyeKlineParams): Promise<Candle[]> {
  const apiKey = readApiKey();
  if (apiKey === null) throw new MissingCredentialsError(SOURCE);

  const from = Math.max(0, Math.trunc(params.from));
  const to = Math.max(from, Math.trunc(params.to));
  const url = new URL(`${BASE_URL}/defi/ohlcv`);
  url.searchParams.set("address", params.address.toLowerCase());
  url.searchParams.set("currency", "usd");
  url.searchParams.set("time_from", String(from));
  url.searchParams.set("time_to", String(to));
  url.searchParams.set("type", params.type);

  const fetchFn = params.fetchFn ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0",
        "X-API-KEY": apiKey,
        "x-chain": CHAIN,
      },
      signal: requestSignal(params.signal),
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

  if (isRecord(payload) && payload["success"] === false) {
    throw new AdapterError(SOURCE, sanitizeMessage(parseStr(payload["message"]) ?? "request rejected"));
  }
  return normalizeOhlcv(payload);
}

/** Exported for tests: normalizes the `{ data: { items } }` OHLCV payload. */
export function normalizeOhlcv(payload: unknown): Candle[] {
  const data = isRecord(payload) ? (payload["data"] ?? payload) : payload;
  const items = isRecord(data) ? asArray(data["items"]) : asArray(data);
  const candles: Candle[] = [];

  for (const item of items) {
    if (!isRecord(item)) continue;
    const timestamp = toEpochMs(item["unixTime"] ?? item["time"]);
    if (timestamp === null) continue;
    candles.push({
      timestamp,
      open: parseNum(item["o"]) ?? 0,
      high: parseNum(item["h"]) ?? 0,
      low: parseNum(item["l"]) ?? 0,
      close: parseNum(item["c"]) ?? 0,
      volume: parseNum(item["v"]) ?? 0,
    });
  }

  return sortCandles(candles);
}
