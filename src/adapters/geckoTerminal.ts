/**
 * GeckoTerminal public OHLCV adapter.
 *
 * The public endpoint is keyless but shares an IP rate limit, so callers must
 * put the result behind the snapshot store rather than fan browser traffic out
 * to this adapter directly.
 */

import type { Candle } from "../core/models.js";
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

const SOURCE = "geckoterminal";
const BASE_URL = "https://api.geckoterminal.com/api/v2";
const NETWORK = "bsc";

export type GeckoOhlcvTimeframe = "minute" | "hour" | "day";

export interface GeckoTokenRef {
  address: string | null;
  name: string | null;
  symbol: string | null;
}

export interface GeckoPoolOhlcv {
  candles: Candle[];
  base: GeckoTokenRef | null;
  quote: GeckoTokenRef | null;
}

export interface GeckoPoolOhlcvParams {
  poolAddress: string;
  timeframe: GeckoOhlcvTimeframe;
  aggregate: number;
  limit: number;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn;
}

/** Fetches candles for the exact BSC pool and prices its base token in quote. */
export async function fetchGeckoPoolOhlcv(
  params: GeckoPoolOhlcvParams,
): Promise<GeckoPoolOhlcv> {
  const poolAddress = params.poolAddress.toLowerCase();
  const query = new URLSearchParams({
    aggregate: String(params.aggregate),
    limit: String(params.limit),
    token: "base",
  });
  const payload = await fetchJson({
    source: SOURCE,
    url: `${BASE_URL}/networks/${NETWORK}/pools/${encodeURIComponent(poolAddress)}/ohlcv/${params.timeframe}?${query.toString()}`,
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
    headers: { "accept-version": "20230302" },
  });
  return normalizeGeckoPoolOhlcv(payload);
}

/** Normalizes GeckoTerminal's newest-first positional bars and optional pair metadata. */
export function normalizeGeckoPoolOhlcv(payload: unknown): GeckoPoolOhlcv {
  if (!isRecord(payload)) throw new AdapterError(SOURCE, "unexpected response shape");
  const data = payload["data"];
  if (!isRecord(data)) throw new AdapterError(SOURCE, "unexpected response shape");
  const attributes = data["attributes"];
  if (!isRecord(attributes)) throw new AdapterError(SOURCE, "unexpected response shape");

  const candles: Candle[] = [];
  for (const row of asArray(attributes["ohlcv_list"])) {
    if (!Array.isArray(row)) continue;
    const timestamp = toEpochMs(row[0]);
    const open = parseNum(row[1]);
    const high = parseNum(row[2]);
    const low = parseNum(row[3]);
    const close = parseNum(row[4]);
    const volume = parseNum(row[5]);
    if (
      timestamp === null ||
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      volume === null ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0 ||
      volume < 0 ||
      high < Math.max(open, close, low) ||
      low > Math.min(open, close, high)
    ) {
      continue;
    }
    candles.push({ timestamp, open, high, low, close, volume });
  }

  const meta = isRecord(payload["meta"]) ? payload["meta"] : {};
  return {
    candles: sortCandles(candles),
    base: normalizeTokenRef(meta["base"]),
    quote: normalizeTokenRef(meta["quote"]),
  };
}

function normalizeTokenRef(value: unknown): GeckoTokenRef | null {
  if (!isRecord(value)) return null;
  const address = normalizeAddress(value["address"]);
  const name = parseStr(value["name"]);
  const symbol = parseStr(value["symbol"]);
  if (address === null && name === null && symbol === null) return null;
  return { address, name, symbol };
}
