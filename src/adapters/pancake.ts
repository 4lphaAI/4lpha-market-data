/**
 * PancakeSwap V3 pool adapter (BSC).
 *
 * Everything here reads PancakeSwap's own cached explorer API — the same
 * service their web app reads. That is deliberate: matching the APR a user sees
 * on pancakeswap.finance is then a property of the architecture rather than of
 * a formula we keep in sync by hand.
 *
 * Four read paths:
 *
 * 1. {@link fetchPancakePoolList} — the lane: pools ordered by TVL, one page at
 *    a time. Carries the aggregates and `apr24h`, but no chain state.
 * 2. {@link fetchPancakeFarmedPools} — every BSC V3 pool with a live CAKE farm,
 *    in a single unpaginated call. The candidate set for MasterChefV3 reads.
 * 3. {@link fetchPancakePoolStats} — one pool in full, identity plus chain state
 *    plus both fee-APR windows.
 * 4. {@link fetchPancakePoolOnchain} — a direct pool-contract read, used when
 *    the explorer is unavailable and as the verification path for an address.
 *
 * The on-chain path leaves every USD and APR field `null`. Deriving TVL from
 * `liquidity` alone would need a price oracle and an assumption about the active
 * range; a fabricated number that looks plausible is worse than an honest gap.
 *
 * Measured 2026-08-14: median 73ms over 8 sequential reads; 60 parallel requests
 * all answered 200 with no rate-limit headers and no 429. Responses carry
 * `s-maxage=100`, so the data is at most ~100s old however often it is polled.
 */

import type { AprSource, PoolFarm, PoolStats } from "../core/models.js";
import { type BscClient, withBscClient } from "../chain/rpc.js";
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

const SOURCE = "pancake";
const EXPLORER_BASE = "https://explorer.pancakeswap.com/api/cached";
const CHAIN = "bsc";
const CHAIN_ID = 56;
const PROTOCOL = "v3";

/** Provenance is filled in by the classification pass, not by the adapter. */
const UNKNOWN_ORIGINS = { token0: "unknown", token1: "unknown" } as const;

/** CAKE on BSC. Used to price farm emissions. */
export const CAKE_ADDRESS = "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82";

/**
 * The list endpoint caps a page at 50 rows whatever `limit` asks for — measured
 * with 100, 200, 500 and 1000, all of which returned exactly 50. Paging is the
 * only way to a larger set, so the constant is stated rather than hoped for.
 */
export const EXPLORER_PAGE_SIZE = 50;

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

// ─── APR arithmetic ──────────────────────────────────────────────────────────

/** APRs are reported to two decimals, the precision PancakeSwap's UI displays. */
export function roundAprPercent(percent: number): number {
  return Math.round(percent * 100) / 100;
}

/**
 * Converts an upstream APR to a percentage.
 *
 * The explorer reports APR as a fraction (`0.108307…` is 10.83%), and the whole
 * plane reports percentages, so the conversion happens once, here, at the edge.
 * A negative value cannot come from fees and is treated as absent rather than
 * carried through into a subtraction downstream.
 */
export function toAprPercent(value: unknown): number | null {
  const parsed = parseNum(value);
  if (parsed === null || parsed < 0) return null;
  return roundAprPercent(parsed * 100);
}

/**
 * The UI's APR column: trading fees plus CAKE emissions.
 *
 * `null` when either component is unknown. Summing what happens to be present
 * would silently report a partial yield as the whole one — the exact confusion
 * this pair of fields exists to prevent.
 */
export function combinePoolApr(
  lpFeeApr24h: number | null,
  cakeFarmApr: number | null,
): number | null {
  if (lpFeeApr24h === null || cakeFarmApr === null) return null;
  return roundAprPercent(lpFeeApr24h + cakeFarmApr);
}

/**
 * Folds a farm reading into a pool record, keeping `combinedApr` and
 * `aprSources` consistent with the numbers. The single place that writes those
 * two fields together, so they cannot drift apart.
 */
export function withCakeFarm(
  stats: PoolStats,
  farm: PoolFarm | null,
  cakeFarmApr: number | null,
): PoolStats {
  const sources: AprSource[] = [];
  if (stats.lpFeeApr24h !== null) sources.push("lpFee");
  if (cakeFarmApr !== null) sources.push("cakeFarm");

  return {
    ...stats,
    farm,
    cakeFarmApr,
    combinedApr: combinePoolApr(stats.lpFeeApr24h, cakeFarmApr),
    aprSources: sources,
  };
}

// ─── Pool list (the lane) ────────────────────────────────────────────────────

/** Orderings the explorer accepts. `apr24h` is unfiltered and TVL-dust heavy. */
export type PoolListOrder = "tvlUSD" | "volumeUSD24h" | "apr24h";

export interface PancakePoolListParams {
  /** Defaults to `tvlUSD`: an ingest order, not a verdict about the pools. */
  orderBy?: PoolListOrder;
  /** `endCursor` of the previous page. Omit for the first page. */
  after?: string | undefined;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn;
}

export interface PoolListPage {
  rows: PoolStats[];
  endCursor: string | null;
  hasNextPage: boolean;
}

/** Reads one page of the BSC V3 pool list, newest aggregates included. */
export async function fetchPancakePoolList(
  params: PancakePoolListParams = {},
): Promise<PoolListPage> {
  const query = new URLSearchParams({
    chains: CHAIN,
    protocols: PROTOCOL,
    orderBy: params.orderBy ?? "tvlUSD",
    limit: String(EXPLORER_PAGE_SIZE),
  });
  if (params.after !== undefined && params.after !== "") query.set("after", params.after);

  const data = await fetchJson({
    source: SOURCE,
    url: `${EXPLORER_BASE}/pools/list?${query.toString()}`,
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
  });

  if (!isRecord(data)) throw new AdapterError(SOURCE, "unexpected pool list payload");

  const rows: PoolStats[] = [];
  for (const row of asArray(data["rows"])) {
    const stats = normalizeExplorerPoolRow(row);
    if (stats !== null) rows.push(stats);
  }

  return {
    rows,
    endCursor: parseStr(data["endCursor"]),
    hasNextPage: data["hasNextPage"] === true,
  };
}

/**
 * Reads every BSC V3 pool with a live CAKE farm.
 *
 * Unlike the list endpoint this one is not paginated — 577 pools arrived in a
 * single 183ms call — which makes the farmed set, and therefore the candidate
 * set for MasterChefV3 reads, essentially free to refresh.
 */
export async function fetchPancakeFarmedPools(
  params: { signal?: AbortSignal | undefined; fetchFn?: FetchFn } = {},
): Promise<PoolStats[]> {
  const query = new URLSearchParams({ chains: CHAIN, protocols: PROTOCOL });
  const data = await fetchJson({
    source: SOURCE,
    url: `${EXPLORER_BASE}/pools/farming?${query.toString()}`,
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
  });

  // A record here means the endpoint answered with a validation complaint
  // rather than a list; treating that as "no farms" would silence every farm.
  if (!Array.isArray(data)) throw new AdapterError(SOURCE, "unexpected farming payload");

  const rows: PoolStats[] = [];
  for (const row of data) {
    const stats = normalizeExplorerPoolRow(row);
    if (stats !== null) rows.push(stats);
  }
  return rows;
}

/**
 * Maps one list or farming row onto {@link PoolStats}. Exported for tests.
 *
 * The `protocols` and `chains` query filters are re-checked here rather than
 * trusted: the same class of upstream that ignores a `topics` filter on
 * `eth_getLogs` can ignore this one, and a non-V3 row would carry a 32-byte
 * pool id where every consumer expects an address.
 */
export function normalizeExplorerPoolRow(data: unknown): PoolStats | null {
  if (!isRecord(data)) return null;

  if (parseStr(data["protocol"]) !== PROTOCOL) return null;
  const chainId = parseNum(data["chainId"]);
  if (chainId !== null && chainId !== CHAIN_ID) return null;

  const pool = normalizeAddress(data["id"]);
  const token0 = readTokenRef(data["token0"]);
  const token1 = readTokenRef(data["token1"]);
  const fee = parseNum(data["feeTier"]);
  if (pool === null || token0 === null || token1 === null || fee === null) return null;

  const lpFeeApr24h = toAprPercent(data["apr24h"]);

  return {
    pool,
    protocol: PROTOCOL,
    token0: token0.address,
    token1: token1.address,
    token0Symbol: token0.symbol,
    token1Symbol: token1.symbol,
    fee: Math.trunc(fee),
    liquidity: null,
    sqrtPriceX96: null,
    tick: null,
    tvlUsd: positiveOrNull(parseNum(data["tvlUSD"])),
    volume24hUsd: nonNegativeOrNull(parseNum(data["volumeUSD24h"])),
    lpFeeApr24h,
    lpFeeApr7d: null,
    cakeFarmApr: null,
    combinedApr: null,
    aprSources: lpFeeApr24h === null ? [] : ["lpFee"],
    farm: null,
    tier: "unclassified",
    tokenOrigin: UNKNOWN_ORIGINS,
    asOf: Date.now(),
    source: SOURCE,
  };
}

// ─── One pool ────────────────────────────────────────────────────────────────

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
 * A fallback result is strictly poorer (no USD or APR fields) but never wrong,
 * so the degradation is visible in the data rather than hidden behind an error.
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

/**
 * Reads one pool from PancakeSwap's cached explorer API. No credentials.
 *
 * Two requests in parallel, because the per-pool endpoint carries chain state
 * and raw fee totals but no APR, while the APR endpoint carries both fee-APR
 * windows and nothing else. Only the first decides whether the pool exists; an
 * APR outage costs the APR fields, not the record.
 */
export async function fetchPancakePoolStats(params: PancakePoolParams): Promise<PoolStats> {
  const address = params.address.toLowerCase();
  const [data, apr] = await Promise.all([
    fetchJson({
      source: SOURCE,
      url: `${EXPLORER_BASE}/pools/${PROTOCOL}/${CHAIN}/${address}`,
      fetchFn: params.fetchFn ?? globalThis.fetch,
      signal: params.signal,
    }),
    readPoolAprOrNull(params),
  ]);

  const stats = normalizeExplorerPool(address, data, apr);
  if (stats === null) throw new AdapterError(SOURCE, "unexpected pool payload");
  return stats;
}

/** Both fee-APR windows for one pool, as percentages. */
export interface PoolAprReading {
  lpFeeApr24h: number | null;
  lpFeeApr7d: number | null;
}

const NO_APR: PoolAprReading = { lpFeeApr24h: null, lpFeeApr7d: null };

/** Reads `apr24h` and `apr7d` for one pool. */
export async function fetchPancakePoolApr(params: PancakePoolParams): Promise<PoolAprReading> {
  const address = params.address.toLowerCase();
  const data = await fetchJson({
    source: SOURCE,
    url: `${EXPLORER_BASE}/pools/apr/${PROTOCOL}/${CHAIN}/${address}`,
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
  });

  if (!isRecord(data)) throw new AdapterError(SOURCE, "unexpected pool apr payload");
  return {
    lpFeeApr24h: toAprPercent(data["apr24h"]),
    lpFeeApr7d: toAprPercent(data["apr7d"]),
  };
}

/** The APR half of a pool read, degraded to nulls rather than failing the read. */
async function readPoolAprOrNull(params: PancakePoolParams): Promise<PoolAprReading> {
  try {
    return await fetchPancakePoolApr(params);
  } catch {
    return NO_APR;
  }
}

/**
 * Exported for tests. Returns `null` when the payload does not describe a pool,
 * which the caller turns into an error rather than a half-empty record.
 *
 * Note what is *not* computed here: this endpoint returns `feeUSD24h` and
 * `protocolFeeUSD24h`, from which a fee APR is one division away. Deriving it
 * would reintroduce the mismatch with PancakeSwap's UI that this adapter exists
 * to avoid, so the APR comes from `apr` or not at all.
 */
export function normalizeExplorerPool(
  address: string,
  data: unknown,
  apr: PoolAprReading = NO_APR,
): PoolStats | null {
  if (!isRecord(data)) return null;

  const token0 = readTokenRef(data["token0"]);
  const token1 = readTokenRef(data["token1"]);
  const fee = parseNum(data["feeTier"]);
  const liquidity = parseBigintString(data["liquidity"]);
  const sqrtPriceX96 = parseBigintString(data["sqrtPrice"]);
  const tick = parseNum(data["tick"]);

  if (token0 === null || token1 === null || fee === null || liquidity === null) return null;

  return {
    pool: address.toLowerCase(),
    protocol: PROTOCOL,
    token0: token0.address,
    token1: token1.address,
    token0Symbol: token0.symbol,
    token1Symbol: token1.symbol,
    fee: Math.trunc(fee),
    liquidity,
    sqrtPriceX96: sqrtPriceX96 ?? "0",
    tick: tick === null ? 0 : Math.trunc(tick),
    tvlUsd: positiveOrNull(parseNum(data["tvlUSD"])),
    volume24hUsd: nonNegativeOrNull(parseNum(data["volumeUSD24h"])),
    lpFeeApr24h: apr.lpFeeApr24h,
    lpFeeApr7d: apr.lpFeeApr7d,
    cakeFarmApr: null,
    combinedApr: null,
    aprSources: apr.lpFeeApr24h === null ? [] : ["lpFee"],
    farm: null,
    tier: "unclassified",
    tokenOrigin: UNKNOWN_ORIGINS,
    asOf: Date.now(),
    source: SOURCE,
  };
}

// ─── CAKE price ──────────────────────────────────────────────────────────────

/**
 * Reads the CAKE price in USD from the explorer's own price index.
 *
 * PancakeSwap's reference implementation reads CoinGecko for this; using their
 * price service instead keeps the farm APR consistent with the TVL it is
 * divided by, and adds no upstream that this plane does not already depend on.
 */
export async function fetchCakePriceUsd(
  params: { signal?: AbortSignal | undefined; fetchFn?: FetchFn } = {},
): Promise<number> {
  const prices = await fetchTokenPricesUsd([CAKE_ADDRESS], params);
  const price = prices.get(CAKE_ADDRESS);
  if (price === undefined) throw new AdapterError(SOURCE, "cake price unavailable");
  return price;
}

/**
 * Reads USD prices for a set of tokens in one call.
 *
 * Tokens the index does not carry are simply absent from the result, never
 * zero: the endpoint drops what it has not indexed, so position is meaningless
 * and only the response's own keys can be trusted.
 */
export async function fetchTokenPricesUsd(
  addresses: string[],
  params: { signal?: AbortSignal | undefined; fetchFn?: FetchFn } = {},
): Promise<Map<string, number>> {
  const tokens = [...new Set(addresses.map((address) => normalizeAddress(address)))].filter(
    (address): address is string => address !== null,
  );
  const prices = new Map<string, number>();
  if (tokens.length === 0) return prices;

  const data = await fetchJson({
    source: SOURCE,
    url: `${EXPLORER_BASE}/tokens/price/list/${tokens.map((t) => `${CHAIN_ID}:${t}`).join(",")}`,
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
  });

  if (!isRecord(data)) throw new AdapterError(SOURCE, "unexpected price payload");

  for (const [key, value] of Object.entries(data)) {
    // Keyed by the request key; matched case-insensitively, since an upstream
    // echoing a checksummed address would otherwise read as absent.
    const address = normalizeAddress(key.split(":").pop());
    if (address === null || !isRecord(value)) continue;
    const price = parseNum(value["priceUSD"]);
    if (price !== null && price > 0) prices.set(address, price);
  }
  return prices;
}

/** Tick spacing per fee tier, read off the pool contracts on 2026-08-14. */
const TICK_SPACING: Record<number, number> = { 100: 1, 500: 10, 2500: 50, 10000: 200 };

/** Everything the range estimator needs about a pool, in one payload. */
export interface PoolRangeInputs {
  pool: string;
  fee: number;
  tickSpacing: number;
  /** Q64.96 price, as a decimal string. */
  sqrtPriceX96: string;
  /** In-range liquidity at the current tick, as a decimal string. */
  liquidity: string;
  tick: number;
  tvlUsd: number | null;
  token0: { address: string; symbol: string | null; decimals: number };
  token1: { address: string; symbol: string | null; decimals: number };
}

/**
 * Reads the pool state a range estimate is built from.
 *
 * Separate from {@link fetchPancakePoolStats} because the estimator needs two
 * things `PoolStats` does not carry — token decimals, without which raw amounts
 * cannot be valued, and the fee tier's tick spacing — and needs neither the APR
 * fields nor the lane's classification.
 */
export async function fetchPoolRangeInputs(params: PancakePoolParams): Promise<PoolRangeInputs> {
  const address = params.address.toLowerCase();
  const data = await fetchJson({
    source: SOURCE,
    url: `${EXPLORER_BASE}/pools/${PROTOCOL}/${CHAIN}/${address}`,
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
  });

  if (!isRecord(data)) throw new AdapterError(SOURCE, "unexpected pool payload");

  const token0 = readTokenDetail(data["token0"]);
  const token1 = readTokenDetail(data["token1"]);
  const fee = parseNum(data["feeTier"]);
  const liquidity = parseBigintString(data["liquidity"]);
  const sqrtPriceX96 = parseBigintString(data["sqrtPrice"]);
  const tick = parseNum(data["tick"]);

  if (token0 === null || token1 === null || fee === null) {
    throw new AdapterError(SOURCE, "unexpected pool payload");
  }
  if (liquidity === null || sqrtPriceX96 === null || sqrtPriceX96 === "0") {
    // Without a price there is no range to place, and an invented one would be
    // worse than refusing: every number downstream divides by it.
    throw new AdapterError(SOURCE, "pool has no price");
  }

  const tickSpacing = TICK_SPACING[Math.trunc(fee)];
  if (tickSpacing === undefined) {
    throw new AdapterError(SOURCE, `unknown fee tier ${Math.trunc(fee)}`);
  }

  return {
    pool: address,
    fee: Math.trunc(fee),
    tickSpacing,
    sqrtPriceX96,
    liquidity,
    tick: tick === null ? 0 : Math.trunc(tick),
    tvlUsd: positiveOrNull(parseNum(data["tvlUSD"])),
    token0,
    token1,
  };
}

/** A token reference with decimals, which the range math cannot do without. */
function readTokenDetail(value: unknown): PoolRangeInputs["token0"] | null {
  if (!isRecord(value)) return null;
  const address = normalizeAddress(value["id"] ?? value["address"]);
  const decimals = parseNum(value["decimals"]);
  if (address === null || decimals === null || decimals < 0 || decimals > 36) return null;
  return { address, symbol: parseStr(value["symbol"]), decimals: Math.trunc(decimals) };
}

// ─── Token list ──────────────────────────────────────────────────────────────

const TOKEN_LIST_URL = "https://tokens.pancakeswap.finance/pancakeswap-extended.json";

/**
 * Reads the addresses on PancakeSwap Extended, their curated token list.
 *
 * This is the list their own UI checks before warning a user that a token is
 * unrecognized, which makes it a real editorial signal rather than an inference:
 * a wash-trading pool can manufacture volume and TVL, but not a listing.
 * Measured 2026-08-14: 972 BSC entries.
 */
export async function fetchPancakeTokenList(
  params: { signal?: AbortSignal | undefined; fetchFn?: FetchFn } = {},
): Promise<string[]> {
  const data = await fetchJson({
    source: SOURCE,
    url: TOKEN_LIST_URL,
    fetchFn: params.fetchFn ?? globalThis.fetch,
    signal: params.signal,
  });

  if (!isRecord(data)) throw new AdapterError(SOURCE, "unexpected token list payload");
  const tokens = asArray(data["tokens"]);
  // An empty list would silently unlabel every pool, so it reads as a failure
  // rather than as "PancakeSwap lists nothing".
  if (tokens.length === 0) throw new AdapterError(SOURCE, "empty token list");

  const addresses: string[] = [];
  for (const token of tokens) {
    if (!isRecord(token)) continue;
    if (parseNum(token["chainId"]) !== CHAIN_ID) continue;
    const address = normalizeAddress(token["address"]);
    if (address !== null) addresses.push(address);
  }
  return [...new Set(addresses)];
}

// ─── Shared parsing ──────────────────────────────────────────────────────────

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

// ─── On-chain fallback ───────────────────────────────────────────────────────

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
 * Reads one pool directly from the chain. USD and APR fields stay `null`: a node
 * knows the pool's state, not what it is worth.
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
        protocol: PROTOCOL,
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
        lpFeeApr24h: null,
        lpFeeApr7d: null,
        cakeFarmApr: null,
        combinedApr: null,
        aprSources: [],
        farm: null,
    tier: "unclassified",
    tokenOrigin: UNKNOWN_ORIGINS,
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
