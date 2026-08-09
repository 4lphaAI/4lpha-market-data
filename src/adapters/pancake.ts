/**
 * PancakeSwap V3 pool adapter.
 *
 * Two paths, in this order:
 *
 * 1. PancakeSwap's own cached explorer API (`explorer.pancakeswap.com`), which
 *    needs no key and carries the aggregated numbers no node can answer: TVL,
 *    24h volume and 24h fees.
 * 2. A direct read of the pool contract over BSC RPC, used when the explorer is
 *    unavailable and as the verification path for a pool address.
 *
 * The on-chain path deliberately leaves `tvlUsd`, `volume24hUsd` and `aprPct`
 * as `null`. Deriving TVL from `liquidity` alone would require a price oracle
 * and an assumption about the active range; a fabricated number that looks
 * plausible is worse than an honest gap.
 */

import type { PoolStats } from "../core/models.js";
import { type BscClient, withBscClient } from "../chain/rpc.js";
import {
  AdapterError,
  fetchJson,
  isRecord,
  normalizeAddress,
  parseNum,
  parseStr,
  type FetchFn,
} from "./http.js";

const SOURCE = "pancake";
const EXPLORER_BASE = "https://explorer.pancakeswap.com/api/cached/pools/v3/bsc";

/** Store key holding the operator-overridable pool list. */
export const SEED_POOLS_KEY = "pools:seed";
/** Store key holding the addresses that currently have a `pool:<addr>` record. */
export const POOLS_INDEX_KEY = "pools:index";

/** Store key for one pool's snapshot. */
export function poolKey(address: string): string {
  return `pool:${address.toLowerCase()}`;
}

/**
 * Verified PancakeSwap V3 pools for the tokenized-equity pairs, used as the
 * default tracking set. An operator overrides it by writing {@link SEED_POOLS_KEY},
 * exactly as with `tracked:addresses`.
 */
const SEED_POOL_ADDRESSES = [
  // NVDAB/USDT 0.05%
  "0xcc2bffaec373a6004bb6ccc8a62cdd66061f7c6a",
  // NVDAB/USDT 0.25%
  "0x8fb4243b553ac29ba088acf00b9b7da24bd6690c",
  // NVDAB/WBNB 0.25%
  "0xdebed59510885e29ce1d3da0e5412d49d21f0354",
  // TSLAB/USDT 0.25%
  "0xb0f5e5400e8f0f7c242f2b7740c004f020579c41",
  // TSLAB/USDT 1%
  "0x613ebcfcf41749571d659a0bf3e2c0032fd4859e",
  // TSLAB/WBNB 0.25%
  "0x787f3ebb965a7c5484d08b143809d8c4b043cd45",
];

/** The default pool set. A fresh array each call, so callers cannot mutate it. */
export function seedPools(): string[] {
  return [...SEED_POOL_ADDRESSES];
}

export interface PancakePoolParams {
  address: string;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn;
  /** Overrides the environment RPC endpoint list. Tests use this. */
  rpcUrls?: string[] | undefined;
}

/**
 * Reads one pool, preferring the explorer API and falling back to the chain.
 *
 * A fallback result is strictly poorer (no USD fields) but never wrong, so the
 * degradation is visible in the data rather than hidden behind an error.
 */
export async function fetchPoolStats(params: PancakePoolParams): Promise<PoolStats> {
  try {
    return await fetchPancakePoolStats(params);
  } catch (error) {
    try {
      return await fetchPancakePoolOnchain(params);
    } catch {
      // The explorer failure is the more informative of the two: the on-chain
      // path is only ever reached because the explorer already failed.
      throw error;
    }
  }
}

/** Reads one pool from PancakeSwap's cached explorer API. No credentials. */
export async function fetchPancakePoolStats(params: PancakePoolParams): Promise<PoolStats> {
  const address = params.address.toLowerCase();
  const data = await fetchJson({
    source: SOURCE,
    url: `${EXPLORER_BASE}/${address}`,
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
  });

  const stats = normalizeExplorerPool(address, data);
  if (stats === null) throw new AdapterError(SOURCE, "unexpected pool payload");
  return stats;
}

/**
 * Exported for tests. Returns `null` when the payload does not describe a pool,
 * which the caller turns into an error rather than a half-empty record.
 */
export function normalizeExplorerPool(address: string, data: unknown): PoolStats | null {
  if (!isRecord(data)) return null;

  const token0 = readTokenRef(data["token0"]);
  const token1 = readTokenRef(data["token1"]);
  const fee = parseNum(data["feeTier"]);
  const liquidity = parseBigintString(data["liquidity"]);
  const sqrtPriceX96 = parseBigintString(data["sqrtPrice"]);
  const tick = parseNum(data["tick"]);

  if (token0 === null || token1 === null || fee === null || liquidity === null) return null;

  const tvlUsd = positiveOrNull(parseNum(data["tvlUSD"]));
  const fees24hUsd = nonNegativeOrNull(parseNum(data["feeUSD24h"]));

  return {
    pool: address.toLowerCase(),
    token0: token0.address,
    token1: token1.address,
    token0Symbol: token0.symbol,
    token1Symbol: token1.symbol,
    fee: Math.trunc(fee),
    liquidity,
    sqrtPriceX96: sqrtPriceX96 ?? "0",
    tick: tick === null ? 0 : Math.trunc(tick),
    tvlUsd,
    volume24hUsd: nonNegativeOrNull(parseNum(data["volumeUSD24h"])),
    aprPct: computeFeeApr(fees24hUsd, tvlUsd),
    asOf: Date.now(),
    source: SOURCE,
  };
}

/**
 * Fee APR: one day of fees, annualized over the pool's TVL. Reported only when
 * both inputs are real, and clamped away from a division by a dust TVL, which
 * produces meaningless five-figure percentages.
 */
const MIN_APR_TVL_USD = 1;

function computeFeeApr(fees24hUsd: number | null, tvlUsd: number | null): number | null {
  if (fees24hUsd === null || tvlUsd === null || tvlUsd < MIN_APR_TVL_USD) return null;
  return Math.round((fees24hUsd / tvlUsd) * 365 * 100 * 100) / 100;
}

interface TokenRef {
  address: string;
  symbol: string | null;
}

function readTokenRef(value: unknown): TokenRef | null {
  if (!isRecord(value)) return null;
  const address = normalizeAddress(value["id"] ?? value["address"]);
  if (address === null) return null;
  return { address, symbol: parseStr(value["symbol"]) };
}

/** Keeps big integers as digit strings; anything else is not a pool amount. */
function parseBigintString(value: unknown): string | null {
  const text = typeof value === "number" && Number.isInteger(value) ? String(value) : parseStr(value);
  if (text === null || !/^-?\d+$/u.test(text)) return null;
  return text;
}

function positiveOrNull(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}

function nonNegativeOrNull(value: number | null): number | null {
  return value !== null && value >= 0 ? value : null;
}

const POOL_ABI = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint32" },
      { name: "unlocked", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "liquidity",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint128" }],
  },
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const ERC20_SYMBOL_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/**
 * ERC-20 symbols are immutable, so they are cached for the process lifetime.
 * Keyed by lowercased address; a failed read is simply not cached.
 */
const symbolCache = new Map<string, string>();

/** Exported for tests, which must not inherit symbols from an earlier case. */
export function clearSymbolCache(): void {
  symbolCache.clear();
}

/**
 * Reads one pool directly from the chain. USD fields stay `null`: a node knows
 * the pool's state, not what it is worth.
 */
export async function fetchPancakePoolOnchain(params: PancakePoolParams): Promise<PoolStats> {
  const address = normalizeAddress(params.address);
  if (address === null) throw new AdapterError(SOURCE, "invalid pool address");

  return withBscClient(
    async (client) => {
      const pool = { address: address as `0x${string}`, abi: POOL_ABI } as const;
      const [slot0, liquidity, fee, token0, token1] = await Promise.all([
        client.readContract({ ...pool, functionName: "slot0" }),
        client.readContract({ ...pool, functionName: "liquidity" }),
        client.readContract({ ...pool, functionName: "fee" }),
        client.readContract({ ...pool, functionName: "token0" }),
        client.readContract({ ...pool, functionName: "token1" }),
      ]);

      const [token0Symbol, token1Symbol] = await Promise.all([
        readSymbol(client, token0),
        readSymbol(client, token1),
      ]);

      return {
        pool: address,
        token0: token0.toLowerCase(),
        token1: token1.toLowerCase(),
        token0Symbol,
        token1Symbol,
        fee: Number(fee),
        liquidity: liquidity.toString(),
        sqrtPriceX96: slot0[0].toString(),
        tick: Number(slot0[1]),
        tvlUsd: null,
        volume24hUsd: null,
        aprPct: null,
        asOf: Date.now(),
        source: `${SOURCE}-onchain`,
      } satisfies PoolStats;
    },
    { signal: params.signal, rpcUrls: params.rpcUrls },
  );
}

/** Reads and caches one ERC-20 symbol. A token without one is not an error. */
async function readSymbol(client: BscClient, token: `0x${string}`): Promise<string | null> {
  const key = token.toLowerCase();
  const cached = symbolCache.get(key);
  if (cached !== undefined) return cached;

  try {
    const symbol = await client.readContract({
      address: token,
      abi: ERC20_SYMBOL_ABI,
      functionName: "symbol",
    });
    const trimmed = symbol.trim();
    if (trimmed === "") return null;
    symbolCache.set(key, trimmed);
    return trimmed;
  } catch {
    return null;
  }
}
