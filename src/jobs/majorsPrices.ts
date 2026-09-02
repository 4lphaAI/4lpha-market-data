/**
 * `majors-prices` job — USD prices for the fixed set of major BSC tokens.
 *
 * The `/tokens` surface is otherwise fed only by the lane universes, so the
 * tokens every wallet actually holds (WBNB, USDT, USDC, BTCB, ETH, CAKE) had no
 * snapshot at all and the consumer's portfolio priced them as `—`. This job
 * closes that gap from the chain the plane already reads: PancakeSwap V3
 * `slot0` on the deepest pool for each major, one multicall per tick.
 *
 * Anchor: **USDT = 1.00 USD**, stated as an assumption, never measured. Every
 * other price is a pool ratio against a token already priced this tick, so a
 * pool the chain would not answer for prices nothing downstream of it — a
 * missing price is a missing write, never a stale price under a fresh stamp.
 *
 * Arithmetic is bigint end to end, converted to the wire's `number` only at the
 * final step: `price(token1 per token0) = sqrtPriceX96² / 2^192`, decimal-
 * adjusted by `10^(dec0 − dec1)` and inverted when the wanted token is token0.
 */

import { withBscClient } from "../chain/rpc.js";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import { mergeTokenIntoStore } from "./tokenStore.js";

export const MAJORS_PRICES_JOB = "majors-prices";

/** Source stamped on every snapshot this job writes. */
export const MAJORS_PRICE_SOURCE = "pancake-v3-slot0";

/** The one price this job assumes rather than reads. */
export const USD_ANCHOR: { symbol: string; address: string } = {
  symbol: "USDT",
  address: "0x55d398326f99059ff775485246999027b3197955",
};

export interface MajorToken {
  symbol: string;
  /** Lowercased BSC address. */
  address: string;
  /** `decimals()` read on chain 2026-09-02 and pinned; the test re-asserts it. */
  decimals: number;
}

/** Every token this job prices, the anchor included. */
export const MAJOR_TOKENS: readonly MajorToken[] = [
  { symbol: "WBNB", address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", decimals: 18 },
  { symbol: "USDT", address: USD_ANCHOR.address, decimals: 18 },
  { symbol: "USDC", address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18 },
  { symbol: "BTCB", address: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c", decimals: 18 },
  { symbol: "ETH", address: "0x2170ed0880ac9a755fd29b2688956bd959f933f8", decimals: 18 },
  { symbol: "CAKE", address: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82", decimals: 18 },
];

/**
 * One pool that prices `base` in terms of `quote`. `token0`/`token1` are the
 * pool's own ordering, pinned so the inversion is decided at build time and
 * re-checked against the chain on every read.
 */
export interface PricePool {
  pool: string;
  token0: string;
  token1: string;
  /** Address of the token this pool is used to price. */
  base: string;
  /** Address of the token the price is denominated in. Must be priced first. */
  quote: string;
}

/**
 * Deepest PancakeSwap V3 pool per major, measured 2026-09-02 by `liquidity()`
 * across all four fee tiers via the factory (`0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865`).
 *
 * All five quote in USDT directly. The spec suggested routing BTCB/ETH/CAKE
 * through WBNB; the USDT pools were 2–20x deeper on the day and cost one fewer
 * hop, so a single pool's drift cannot compound through WBNB. The composition
 * logic still handles a WBNB-quoted pool, so a swap here needs no code change.
 *
 * Ordered: a pool's quote must be priced by an earlier entry or the anchor.
 */
export const PRICE_POOLS: readonly PricePool[] = [
  // WBNB/USDT 0.01% — the one price that must never be missing (native BNB
  // is priced off it by the consumer).
  {
    pool: "0x172fcd41e0913e95784454622d1c3724f546f849",
    token0: "0x55d398326f99059ff775485246999027b3197955",
    token1: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    base: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    quote: USD_ANCHOR.address,
  },
  // USDC/USDT 0.01%
  {
    pool: "0x92b7807bf19b7dddf89b706143896d05228f3121",
    token0: "0x55d398326f99059ff775485246999027b3197955",
    token1: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
    base: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
    quote: USD_ANCHOR.address,
  },
  // BTCB/USDT 0.05%
  {
    pool: "0x46cf1cf8c69595804ba91dfdd8d6b960c9b0a7c4",
    token0: "0x55d398326f99059ff775485246999027b3197955",
    token1: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c",
    base: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c",
    quote: USD_ANCHOR.address,
  },
  // ETH/USDT 0.05%
  {
    pool: "0xbe141893e4c6ad9272e8c04bab7e6a10604501a5",
    token0: "0x2170ed0880ac9a755fd29b2688956bd959f933f8",
    token1: "0x55d398326f99059ff775485246999027b3197955",
    base: "0x2170ed0880ac9a755fd29b2688956bd959f933f8",
    quote: USD_ANCHOR.address,
  },
  // CAKE/USDT 0.25%
  {
    pool: "0x7f51c8aaa6b0599abd16674e2b17fec7a9f674a1",
    token0: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
    token1: "0x55d398326f99059ff775485246999027b3197955",
    base: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
    quote: USD_ANCHOR.address,
  },
];

// ─── Price math ──────────────────────────────────────────────────────────────

/** Fixed-point scale every intermediate price is carried at. */
export const PRICE_SCALE = 10n ** 18n;

const Q192 = 2n ** 192n;

export interface SqrtPriceInput {
  sqrtPriceX96: bigint;
  decimals0: number;
  decimals1: number;
  /** Which side of the pool the price is *for*. */
  wanted: "token0" | "token1";
}

/**
 * Price of the wanted token in units of the other, scaled by {@link PRICE_SCALE}.
 *
 * `sqrtPriceX96² / 2^192` is token1 per one raw unit of token0; adjusting by
 * `10^(dec0 − dec1)` makes it per whole token. Inverting for `token0` is done
 * on the exact ratio, not on the rounded result, so the two orderings of one
 * pool agree to the scale's last digit rather than drifting apart.
 */
export function priceFromSqrtPriceX96(input: SqrtPriceInput): bigint {
  if (input.sqrtPriceX96 <= 0n) throw new RangeError("sqrtPriceX96 must be positive");
  const squared = input.sqrtPriceX96 * input.sqrtPriceX96;
  const shift = BigInt(input.decimals0 - input.decimals1);
  // token1 per token0 = squared × 10^shift / 2^192; kept as a ratio n/d.
  const n = shift >= 0n ? squared * 10n ** shift : squared;
  const d = shift >= 0n ? Q192 : Q192 * 10n ** -shift;
  return input.wanted === "token0" ? (n * PRICE_SCALE) / d : (d * PRICE_SCALE) / n;
}

/** Converts a {@link PRICE_SCALE} fixed-point value to the wire's `number`. */
export function scaledToNumber(scaled: bigint): number {
  const whole = scaled / PRICE_SCALE;
  const frac = (scaled % PRICE_SCALE).toString().padStart(18, "0");
  return Number(`${whole}.${frac}`);
}

// ─── Chain read ──────────────────────────────────────────────────────────────

export interface PoolSlot0 {
  pool: string;
  token0: string;
  token1: string;
  sqrtPriceX96: bigint;
  tick: number;
}

/** Reads the pools' state; returns one entry per pool that answered. */
export type ReadPoolSlot0s = (
  pools: readonly PricePool[],
  signal: AbortSignal,
) => Promise<PoolSlot0[]>;

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
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/**
 * Every read is issued in the same tick inside one client, so viem's multicall
 * batching folds the whole set into a single `eth_call`. A pool that fails is
 * dropped from the result, not the batch; a transport failure rotates endpoints.
 */
export const readPoolSlot0sOnchain: ReadPoolSlot0s = async (pools, signal) =>
  withBscClient(
    async (client) => {
      const settled = await Promise.allSettled(
        pools.map(async (entry): Promise<PoolSlot0> => {
          const pool = { address: entry.pool as `0x${string}`, abi: POOL_ABI } as const;
          const [slot0, token0, token1] = await Promise.all([
            client.readContract({ ...pool, functionName: "slot0" }),
            client.readContract({ ...pool, functionName: "token0" }),
            client.readContract({ ...pool, functionName: "token1" }),
          ]);
          return {
            pool: entry.pool,
            token0: token0.toLowerCase(),
            token1: token1.toLowerCase(),
            sqrtPriceX96: slot0[0],
            tick: Number(slot0[1]),
          };
        }),
      );
      const answered = settled
        .filter((r): r is PromiseFulfilledResult<PoolSlot0> => r.status === "fulfilled")
        .map((r) => r.value);
      // Nothing answered means the endpoint did not, so let the rotation try the next one.
      if (answered.length === 0 && pools.length > 0) throw new Error("no pool answered");
      return answered;
    },
    { signal },
  );

// ─── Job ─────────────────────────────────────────────────────────────────────

export interface MajorsPricesResult {
  /** Tokens written this tick, anchor included. */
  written: string[];
  /** Tokens left untouched, with the reason. */
  skipped: Record<string, string>;
  /** USD prices computed this tick, by address. */
  prices: Record<string, number>;
}

export interface RunMajorsPricesOptions {
  readSlot0s?: ReadPoolSlot0s;
  tokens?: readonly MajorToken[];
  pools?: readonly PricePool[];
}

/**
 * Prices every major it can and writes each one through the shared merge path,
 * so a richer snapshot from a lane keeps its volume and holders. A token whose
 * pool failed, disagreed with its pin, or depends on an unpriced quote is
 * skipped outright — the existing record simply ages.
 */
export async function runMajorsPrices(
  store: SnapshotStore,
  signal: AbortSignal,
  options: RunMajorsPricesOptions = {},
): Promise<MajorsPricesResult> {
  const tokens = options.tokens ?? MAJOR_TOKENS;
  const pools = options.pools ?? PRICE_POOLS;
  const readSlot0s = options.readSlot0s ?? readPoolSlot0sOnchain;
  const byAddress = new Map(tokens.map((t) => [t.address, t]));

  const result: MajorsPricesResult = { written: [], skipped: {}, prices: {} };
  const usd = new Map<string, bigint>([[USD_ANCHOR.address, PRICE_SCALE]]);

  let observed: PoolSlot0[];
  try {
    observed = await readSlot0s(pools, signal);
  } catch (error) {
    throw new Error(`pool read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const slot0ByPool = new Map(observed.map((s) => [s.pool.toLowerCase(), s]));

  for (const entry of pools) {
    const base = byAddress.get(entry.base);
    const quote = byAddress.get(entry.quote);
    if (base === undefined || quote === undefined) {
      result.skipped[entry.base] = "pool references a token outside the majors set";
      continue;
    }
    const state = slot0ByPool.get(entry.pool);
    if (state === undefined) {
      result.skipped[entry.base] = "pool unreadable";
      continue;
    }
    if (state.token0 !== entry.token0 || state.token1 !== entry.token1) {
      result.skipped[entry.base] = "pool token ordering differs from pin";
      continue;
    }
    if (state.sqrtPriceX96 <= 0n) {
      result.skipped[entry.base] = "pool uninitialised";
      continue;
    }
    const quoteUsd = usd.get(entry.quote);
    if (quoteUsd === undefined) {
      result.skipped[entry.base] = `quote ${quote.symbol} unpriced this tick`;
      continue;
    }

    const baseIsToken0 = entry.base === entry.token0;
    const [decimals0, decimals1] = baseIsToken0
      ? [base.decimals, quote.decimals]
      : [quote.decimals, base.decimals];
    const inQuote = priceFromSqrtPriceX96({
      sqrtPriceX96: state.sqrtPriceX96,
      decimals0,
      decimals1,
      wanted: baseIsToken0 ? "token0" : "token1",
    });
    usd.set(entry.base, (inQuote * quoteUsd) / PRICE_SCALE);
  }

  for (const token of tokens) {
    const scaled = usd.get(token.address);
    if (scaled === undefined) {
      result.skipped[token.address] ??= "no pool prices this token";
      continue;
    }
    const priceUsd = scaledToNumber(scaled);
    if (!(priceUsd > 0)) {
      result.skipped[token.address] = "price rounded to zero";
      continue;
    }
    await mergeTokenIntoStore(store, MAJORS_PRICE_SOURCE, {
      address: token.address,
      symbol: token.symbol,
      priceUsd,
      marketCapUsd: null,
      volume24hUsd: null,
      holders: null,
      priceChange24hPct: null,
      updatedFields: [],
    });
    result.prices[token.address] = priceUsd;
    result.written.push(token.address);
  }

  const wbnb = tokens.find((t) => t.symbol === "WBNB");
  if (wbnb !== undefined && !result.written.includes(wbnb.address)) {
    throw new Error(`WBNB unpriced: ${result.skipped[wbnb.address] ?? "unknown"}`);
  }
  return result;
}

/** Job registration for the scheduler. */
export function majorsPricesJob(store: SnapshotStore): JobSpec {
  return {
    name: MAJORS_PRICES_JOB,
    intervalMs: 30_000,
    jitterMs: 3_000,
    timeoutMs: 20_000,
    run: async (signal) => {
      const result = await runMajorsPrices(store, signal);
      for (const [address, reason] of Object.entries(result.skipped)) {
        console.warn(`[${MAJORS_PRICES_JOB}] skipped ${address}: ${reason}`);
      }
    },
  };
}
