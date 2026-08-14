/**
 * Range economics for one PancakeSwap V3 position.
 *
 * `/pools/top` answers "which pool", and its APR is the pool's — the number
 * PancakeSwap's UI shows, earned by the pool's liquidity as a whole. It is not
 * the number a particular position earns, and on a concentrated-liquidity AMM
 * the gap between the two is the entire decision: the same capital in a narrow
 * range holds far more liquidity and takes a proportionally larger share of the
 * same fees, at the cost of falling out of range sooner. This module answers
 * "which range", for a stated amount of capital.
 *
 * The arithmetic is exact, and it needs no tick-liquidity scan to get there —
 * a pleasant surprise, since that scan is the expensive part (21 pages for the
 * deepest pool). Fees accrue to whatever liquidity is in range, so a position's
 * share is `L / (L_active + L)`, and both terms are already known: `L` follows
 * from the capital and the chosen bounds, `L_active` is the pool's own
 * `liquidity`. The tick array would only be needed to model what happens as the
 * price *moves* across ticks, which is a different question.
 *
 * What is exact and what is assumed, kept apart on purpose:
 *
 * - Exact: the position's liquidity, its token amounts, its share of pool fees,
 *   whether the range brackets the current price.
 * - Assumed: that trading volume repeats and the price stays in range. The APR
 *   here is last-24h fees projected forward, the same convention as every LP
 *   calculator and as the pool APR it is derived from. It is a projection, and
 *   `assumptions` says so on every response.
 *
 * Impermanent loss is deliberately not modelled. It is a function of where the
 * price ends up, not of anything measurable now, and a number invented for it
 * would be indistinguishable in the payload from the ones that are real.
 */

import type { PoolRangeInputs } from "../adapters/pancake.js";
import type { SnapshotStore } from "../core/store.js";
import type { FetchFn } from "../adapters/http.js";
import {
  fetchPancakePoolApr,
  fetchPoolRangeInputs,
  fetchTokenPricesUsd,
} from "../adapters/pancake.js";

/** Widest tick a V3 pool admits, from the protocol's own bounds. */
const MIN_TICK = -887272;
const MAX_TICK = 887272;

const TICK_BASE = 1.0001;

/**
 * Converts a human price (token1 per token0) to its tick.
 *
 * Ticks index the *raw* price, so the decimal difference has to come out before
 * the logarithm: a pool of an 18-decimal token against a 6-decimal one is a
 * factor of 1e12 away from where the human number says it is.
 */
export function priceToTick(price: number, decimals0: number, decimals1: number): number {
  const raw = price * 10 ** (decimals1 - decimals0);
  return Math.log(raw) / Math.log(TICK_BASE);
}

/** The inverse: a tick back to a human price. */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return TICK_BASE ** tick * 10 ** (decimals0 - decimals1);
}

/** `sqrt(1.0001^tick)`, the form every position formula is written in. */
export function sqrtRatioAtTick(tick: number): number {
  return TICK_BASE ** (tick / 2);
}

/** Snaps a tick onto the fee tier's grid, the way a real position must sit. */
export function snapTick(tick: number, spacing: number, direction: "down" | "up"): number {
  const snapped =
    direction === "down"
      ? Math.floor(tick / spacing) * spacing
      : Math.ceil(tick / spacing) * spacing;
  return Math.min(MAX_TICK, Math.max(MIN_TICK, snapped));
}

/**
 * Raw token amounts held by one unit of liquidity over `[sqrtA, sqrtB]`.
 *
 * Three cases, and they are not interchangeable: below the range the position is
 * entirely token0, above it entirely token1, and only inside does it hold both
 * and earn anything.
 */
export function amountsForLiquidity(
  sqrtPrice: number,
  sqrtA: number,
  sqrtB: number,
  liquidity: number,
): { amount0Raw: number; amount1Raw: number } {
  if (sqrtPrice <= sqrtA) {
    return { amount0Raw: liquidity * (1 / sqrtA - 1 / sqrtB), amount1Raw: 0 };
  }
  if (sqrtPrice >= sqrtB) {
    return { amount0Raw: 0, amount1Raw: liquidity * (sqrtB - sqrtA) };
  }
  return {
    amount0Raw: liquidity * (1 / sqrtPrice - 1 / sqrtB),
    amount1Raw: liquidity * (sqrtPrice - sqrtA),
  };
}

export interface RangeRequest {
  /** Lower bound, as a human price of token0 in token1. */
  lowerPrice: number;
  upperPrice: number;
  capitalUsd: number;
}

/** The pool-level APR this estimate is scaled from. */
export interface RangeBasis {
  lpFeeApr24h: number | null;
  lpFeeApr7d: number | null;
  tvlUsd: number | null;
}

export interface RangeEstimate {
  pool: string;
  fee: number;
  token0Symbol: string | null;
  token1Symbol: string | null;
  requested: { lowerPrice: number; upperPrice: number; capitalUsd: number };
  ticks: { lower: number; upper: number; current: number; spacing: number };
  /** The snapped bounds and the live price, all as token1 per token0. */
  prices: { lower: number; upper: number; current: number };
  /** False when the range does not bracket the current price — it earns nothing. */
  inRange: boolean;
  /** Token amounts the position would need, in human units. */
  position: { liquidity: number | null; amount0: number | null; amount1: number | null };
  poolLiquidity: number;
  /** The position's share of the pool's fees, as a percentage. */
  feeSharePct: number | null;
  /** Liquidity per dollar against the pool's average. 1 = no concentration gain. */
  concentrationMultiplier: number | null;
  estimatedAprPct: number | null;
  estimatedApr7dPct: number | null;
  basis: RangeBasis;
  /** Inputs that were missing, and therefore what above is `null` and why. */
  unavailable: string[];
  assumptions: string[];
}

const ASSUMPTIONS = [
  "fees projected from the trailing window at the current volume",
  "price assumed to stay within the range; out of range the position earns nothing",
  "impermanent loss not modelled",
];

/**
 * Estimates what one position would earn.
 *
 * Pure: every upstream value is an argument, so the whole thing is testable
 * without a network or a chain.
 */
export function estimateRange(
  inputs: PoolRangeInputs,
  request: RangeRequest,
  prices: { token0Usd: number | null; token1Usd: number | null },
  basis: RangeBasis,
): RangeEstimate {
  const { decimals: d0 } = inputs.token0;
  const { decimals: d1 } = inputs.token1;

  const tickLower = snapTick(priceToTick(request.lowerPrice, d0, d1), inputs.tickSpacing, "down");
  const tickUpper = snapTick(priceToTick(request.upperPrice, d0, d1), inputs.tickSpacing, "up");

  const sqrtPrice = Number(inputs.sqrtPriceX96) / 2 ** 96;
  const sqrtA = sqrtRatioAtTick(tickLower);
  const sqrtB = sqrtRatioAtTick(tickUpper);
  const inRange = sqrtPrice > sqrtA && sqrtPrice < sqrtB;

  const poolLiquidity = Number(inputs.liquidity);
  const unavailable: string[] = [];
  if (prices.token0Usd === null) unavailable.push(`price of ${inputs.token0.symbol ?? "token0"}`);
  if (prices.token1Usd === null) unavailable.push(`price of ${inputs.token1.symbol ?? "token1"}`);
  if (basis.lpFeeApr24h === null) unavailable.push("pool fee APR");
  if (basis.tvlUsd === null) unavailable.push("pool TVL");

  const estimate: RangeEstimate = {
    pool: inputs.pool,
    fee: inputs.fee,
    token0Symbol: inputs.token0.symbol,
    token1Symbol: inputs.token1.symbol,
    requested: {
      lowerPrice: request.lowerPrice,
      upperPrice: request.upperPrice,
      capitalUsd: request.capitalUsd,
    },
    ticks: { lower: tickLower, upper: tickUpper, current: inputs.tick, spacing: inputs.tickSpacing },
    prices: {
      lower: tickToPrice(tickLower, d0, d1),
      upper: tickToPrice(tickUpper, d0, d1),
      current: sqrtPrice * sqrtPrice * 10 ** (d0 - d1),
    },
    inRange,
    position: { liquidity: null, amount0: null, amount1: null },
    poolLiquidity,
    feeSharePct: null,
    concentrationMultiplier: null,
    estimatedAprPct: null,
    estimatedApr7dPct: null,
    basis,
    unavailable,
    assumptions: ASSUMPTIONS,
  };

  const { token0Usd, token1Usd } = prices;
  if (token0Usd === null || token1Usd === null) return estimate;

  // Liquidity is linear in capital, so the position's L is read off the value of
  // a single unit of it rather than solved for.
  const unit = amountsForLiquidity(sqrtPrice, sqrtA, sqrtB, 1);
  const valuePerUnit =
    (unit.amount0Raw / 10 ** d0) * token0Usd + (unit.amount1Raw / 10 ** d1) * token1Usd;
  if (!(valuePerUnit > 0)) return estimate;

  const liquidity = request.capitalUsd / valuePerUnit;
  const amounts = amountsForLiquidity(sqrtPrice, sqrtA, sqrtB, liquidity);
  estimate.position = {
    liquidity,
    amount0: amounts.amount0Raw / 10 ** d0,
    amount1: amounts.amount1Raw / 10 ** d1,
  };

  // Out of range the position holds one asset and earns no fees at all. Saying
  // so as a real zero is the point of the field.
  if (!inRange) {
    estimate.feeSharePct = 0;
    estimate.concentrationMultiplier = 0;
    estimate.estimatedAprPct = 0;
    estimate.estimatedApr7dPct = 0;
    return estimate;
  }

  // Adding L dilutes the pool it joins, so the share is against the total after
  // the deposit. For a position large next to the pool that difference is the
  // whole answer, which is why the small-position shortcut is not taken here.
  const share = liquidity / (poolLiquidity + liquidity);
  estimate.feeSharePct = share * 100;

  if (basis.tvlUsd !== null && basis.tvlUsd > 0 && poolLiquidity > 0) {
    estimate.concentrationMultiplier =
      liquidity / request.capitalUsd / (poolLiquidity / basis.tvlUsd);
  }

  estimate.estimatedAprPct = projectApr(basis.lpFeeApr24h, basis.tvlUsd, share, request.capitalUsd);
  estimate.estimatedApr7dPct = projectApr(basis.lpFeeApr7d, basis.tvlUsd, share, request.capitalUsd);
  return estimate;
}

/**
 * Scales a pool APR down onto one position.
 *
 * Deliberately built from the pool's own `lpFeeApr24h` rather than from raw fee
 * totals: that figure is PancakeSwap's, already net of the protocol fee cut and
 * already verified to match their UI, and re-deriving it from `feeUSD24h` is the
 * exact mistake this codebase carries a regression test against.
 */
function projectApr(
  poolAprPct: number | null,
  tvlUsd: number | null,
  share: number,
  capitalUsd: number,
): number | null {
  if (poolAprPct === null || tvlUsd === null || tvlUsd <= 0 || capitalUsd <= 0) return null;
  const poolFeesPerYear = (poolAprPct / 100) * tvlUsd;
  return ((poolFeesPerYear * share) / capitalUsd) * 100;
}

// ─── Reading the inputs ──────────────────────────────────────────────────────

/** Everything one estimate needs from upstream, cached as a unit. */
export interface RangeSnapshot {
  inputs: PoolRangeInputs;
  basis: RangeBasis;
  prices: { token0Usd: number | null; token1Usd: number | null };
}

/** Store key for a pool's range inputs. Under `pool:` so `/snapshots` can read it. */
export function rangeKey(address: string): string {
  return `pool:range:${address.toLowerCase()}`;
}

/**
 * A minute, matching the pool lane. What is cached is the *inputs*, never an
 * estimate: a caller sweeping twenty candidate ranges over one pool is asking
 * twenty questions about one set of facts, and should pay for it once.
 */
const RANGE_FRESH_FOR_MS = 60_000;
const RANGE_DEAD_AFTER_MS = 60 * 60_000;

export interface LoadRangeOptions {
  signal?: AbortSignal | undefined;
  fetchFn?: FetchFn | undefined;
}

/**
 * Serves a pool's range inputs, refreshing them when the copy has aged out.
 *
 * A refresh that fails falls back to the stored copy however old it is, and
 * only a pool with no copy at all propagates the failure — this path is
 * analysis, not a gate, so a minute-old price beats no answer. The staleness of
 * whatever answered comes back with it, so the caller can tell the difference.
 */
export async function loadRangeSnapshot(
  store: SnapshotStore,
  address: string,
  options: LoadRangeOptions = {},
): Promise<{ snapshot: RangeSnapshot; asOf: number; staleness: string }> {
  const key = rangeKey(address);
  const stored = await store.get<RangeSnapshot>(key);
  if (stored !== null && stored.staleness === "fresh") {
    return { snapshot: stored.data, asOf: stored.asOf, staleness: stored.staleness };
  }

  try {
    const params = {
      address,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    };
    const [inputs, apr] = await Promise.all([
      fetchPoolRangeInputs(params),
      fetchPancakePoolApr(params).catch(() => ({ lpFeeApr24h: null, lpFeeApr7d: null })),
    ]);

    const priced = await fetchTokenPricesUsd([inputs.token0.address, inputs.token1.address], {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    }).catch(() => new Map<string, number>());

    const snapshot: RangeSnapshot = {
      inputs,
      basis: { ...apr, tvlUsd: inputs.tvlUsd },
      prices: {
        token0Usd: priced.get(inputs.token0.address) ?? null,
        token1Usd: priced.get(inputs.token1.address) ?? null,
      },
    };
    await store.put(key, snapshot, {
      source: "pancake",
      freshForMs: RANGE_FRESH_FOR_MS,
      deadAfterMs: RANGE_DEAD_AFTER_MS,
    });
    return { snapshot, asOf: Date.now(), staleness: "fresh" };
  } catch (error) {
    if (stored !== null) {
      return { snapshot: stored.data, asOf: stored.asOf, staleness: stored.staleness };
    }
    throw error;
  }
}
