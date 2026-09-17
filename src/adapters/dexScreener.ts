/**
 * DexScreener adapter — keyless pair discovery for one token on BSC.
 *
 * `GET https://api.dexscreener.com/token-pairs/v1/bsc/{address}` returns every
 * pool DexScreener indexes for the token across DEXes, with USD liquidity and
 * 24h volume. Documented public API, 300 requests per minute, no key. Used for
 * the one question the plane's other sources cannot answer: which pools —
 * PancakeSwap *and* Uniswap — a tokenized stock trades in. (Uniswap has no
 * explorer API on BSC; the chain can enumerate pools but not price them in
 * USD without a tick walk.)
 *
 * What this adapter deliberately does not do: filter. It hands back every
 * pair, the stock token as base or as quote; the venues job decides what is a
 * venue for the stock and what is a memecoin quoted in it.
 */

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

export const DEXSCREENER_SOURCE = "dexscreener";
const SOURCE = DEXSCREENER_SOURCE;
const BASE_URL = "https://api.dexscreener.com";
const CHAIN = "bsc";

/** Documented ceiling for `token-pairs`; callers space requests accordingly. */
export const DEXSCREENER_MAX_PER_MINUTE = 300;

export interface DexPairToken {
  address: string;
  symbol: string;
}

export interface DexPair {
  /** DexScreener's `dexId`, e.g. `pancakeswap`, `uniswap`, `topaz`. */
  dex: string;
  /** First label DexScreener attaches, e.g. `v2` / `v3`; `null` when unlabelled. */
  version: string | null;
  /** Pool/pair contract address, lowercased. */
  pool: string;
  base: DexPairToken;
  quote: DexPairToken;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  txns24h: number | null;
}

export interface DexScreenerTokenPairsParams {
  address: string;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn | undefined;
}

/** Every indexed pair for one token. */
export async function fetchDexScreenerTokenPairs(
  params: DexScreenerTokenPairsParams,
): Promise<DexPair[]> {
  const address = params.address.toLowerCase();
  const data = await fetchJson({
    source: SOURCE,
    url: `${BASE_URL}/token-pairs/v1/${CHAIN}/${address}`,
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
  });
  if (!Array.isArray(data)) throw new AdapterError(SOURCE, "unexpected token-pairs payload");
  return normalizeDexPairs(data);
}

/** Exported for tests. Rows missing either token address or the pair address are dropped. */
export function normalizeDexPairs(data: unknown): DexPair[] {
  const pairs: DexPair[] = [];
  for (const raw of asArray(data)) {
    if (!isRecord(raw)) continue;
    const pool = normalizeAddress(raw["pairAddress"]);
    const base = normalizeToken(raw["baseToken"]);
    const quote = normalizeToken(raw["quoteToken"]);
    const dex = parseStr(raw["dexId"]);
    if (pool === null || base === null || quote === null || dex === null) continue;

    const labels = asArray(raw["labels"]).map(parseStr).filter((l): l is string => l !== null);
    const liquidity = isRecord(raw["liquidity"]) ? raw["liquidity"] : {};
    const volume = isRecord(raw["volume"]) ? raw["volume"] : {};
    const txns = isRecord(raw["txns"]) && isRecord(raw["txns"]["h24"]) ? raw["txns"]["h24"] : {};
    const buys = parseNum(txns["buys"]);
    const sells = parseNum(txns["sells"]);

    pairs.push({
      dex,
      version: labels[0] ?? null,
      pool,
      base,
      quote,
      priceUsd: parseNum(raw["priceUsd"]),
      liquidityUsd: parseNum(liquidity["usd"]),
      volume24hUsd: parseNum(volume["h24"]),
      txns24h: buys === null && sells === null ? null : (buys ?? 0) + (sells ?? 0),
    });
  }
  return pairs;
}

function normalizeToken(raw: unknown): DexPairToken | null {
  if (!isRecord(raw)) return null;
  const address = normalizeAddress(raw["address"]);
  if (address === null) return null;
  return { address, symbol: parseStr(raw["symbol"]) ?? "" };
}
