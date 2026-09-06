/** Exact-pool price ratios, not token-wide USD candles. Optional free API key. */
import type { Candle } from "../core/models.js";
import { AdapterError, fetchJson, isRecord, normalizeAddress, parseNum, parseStr, type FetchFn } from "./http.js";
import type { GeckoTokenRef } from "./geckoTerminal.js";

const SOURCE = "dexpaprika";
const BASE = "https://api.dexpaprika.com/networks/bsc/pools";
/** The mixed-case alias supports the operator's existing .env without editing it. */
function headers(): Record<string, string> {
  const key = (process.env["DEXPAPRIKA_API_KEY"] ?? process.env["DexPaprika"])?.trim();
  return key ? { Authorization: key } : {};
}
export interface DexPair { base: GeckoTokenRef & { address: string }; quote: GeckoTokenRef & { address: string } }
export interface DexParams {
  poolAddress: string;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn | undefined;
}
export async function fetchDexPair(params: DexParams): Promise<DexPair> {
  const raw = await fetchJson({ source: SOURCE, url: `${BASE}/${params.poolAddress}`,
    signal: params.signal, fetchFn: params.fetchFn ?? globalThis.fetch, headers: headers() });
  if (!isRecord(raw) || raw["id"] !== params.poolAddress || raw["chain"] !== "bsc") {
    throw new AdapterError(SOURCE, "pool identity mismatch");
  }
  const base = normalizeAddress(raw["base_token_id"]);
  const quote = normalizeAddress(raw["quote_token_id"]);
  if (base === null || quote === null || base === quote) throw new AdapterError(SOURCE, "invalid pair");
  const tokens = Array.isArray(raw["tokens"]) ? raw["tokens"] : [];
  const token = (address: string) => {
    const row: unknown = tokens.find((t: unknown) => isRecord(t) && normalizeAddress(t["id"]) === address);
    return { address, symbol: isRecord(row) ? parseStr(row["symbol"]) : null,
      name: isRecord(row) ? parseStr(row["name"]) : null };
  };
  return { base: token(base), quote: token(quote) };
}

/** One bounded request covers <=366 time buckets. Missing bars remain missing. */
export async function fetchDexCandles(params: DexParams & {
  interval: string; start: number; end: number; limit: number;
}): Promise<Candle[]> {
  const query = new URLSearchParams({ interval: params.interval, start: String(params.start),
    end: String(params.end), limit: String(Math.min(366, params.limit)), inversed: "false" });
  const raw = await fetchJson({ source: SOURCE, url: `${BASE}/${params.poolAddress}/ohlcv?${query}`,
    signal: params.signal, fetchFn: params.fetchFn ?? globalThis.fetch, headers: headers() });
  if (!Array.isArray(raw)) throw new AdapterError(SOURCE, "invalid candle response");
  const result = new Map<number, Candle>();
  for (const value of raw) {
    if (!isRecord(value)) throw new AdapterError(SOURCE, "invalid candle");
    const timestamp = Date.parse(String(value["time_open"]));
    const open = parseNum(value["open"]), high = parseNum(value["high"]);
    const low = parseNum(value["low"]), close = parseNum(value["close"]), volume = parseNum(value["volume"]);
    if (!Number.isFinite(timestamp) || open === null || high === null || low === null || close === null || volume === null
      || low <= 0 || volume < 0 || high < Math.max(open, close, low) || low > Math.min(open, close)) {
      throw new AdapterError(SOURCE, "invalid candle values");
    }
    if (timestamp >= params.start * 1000 && timestamp < params.end * 1000) {
      const previous = result.get(timestamp);
      if (previous && (previous.open !== open || previous.high !== high || previous.low !== low
        || previous.close !== close || previous.volume !== volume)) throw new AdapterError(SOURCE, "conflicting candle revision");
      result.set(timestamp, { timestamp, open, high, low, close, volume });
    }
  }
  return [...result.values()].sort((a, b) => a.timestamp - b.timestamp);
}
