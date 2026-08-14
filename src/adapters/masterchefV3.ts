/**
 * MasterChefV3 adapter — the CAKE half of a pool's APR.
 *
 * PancakeSwap's pool list shows one APR made of two independent things: fees
 * paid by traders, and CAKE emitted to liquidity providers. The explorer API
 * carries the first and says nothing about the second, so the second is read
 * here, straight from the farm contract.
 *
 *     cakePerSecond = latestPeriodCakePerSecond() / 1e12 / 1e18
 *     cakePerYear   = cakePerSecond × allocPoint / totalAllocPoint × 31_536_000
 *     cakeFarmApr   = cakePerYear × cakePriceUsd / tvlUsd × 100
 *
 * Verified against PancakeSwap's own UI on 2026-08-14, to two decimals:
 * quq/USDT 14.96% (UI 14.97), USDT/WBNB 0.01% 3.19% (3.19), USDC/WBNB 0.01%
 * 0.63% (0.63). The remaining hundredth is the CAKE price moving between reads.
 *
 * Emissions are decided by veCAKE gauge voting, which is what makes
 * `allocPoint > 0` the one pool signal on this chain that cannot be manufactured
 * by wash trading: it costs locked CAKE and other people's votes.
 *
 * All reads are `eth_call` against the public BSC endpoints, folded into
 * Multicall3 batches by the shared client — no keyed RPC, no log scans.
 */

import type { PoolFarm } from "../core/models.js";
import { withBscClient } from "../chain/rpc.js";
import { normalizeAddress } from "./http.js";
import { roundAprPercent } from "./pancake.js";

/** MasterChefV3 on BSC. */
export const MASTERCHEF_V3 = "0x556B9306565093C855AEA9AE92A594704c2Cd59e" as const;

const SECONDS_PER_YEAR = 31_536_000;

/**
 * `latestPeriodCakePerSecond` is stored scaled by the contract's own 1e12
 * precision factor on top of CAKE's 18 decimals, so both divisions are needed
 * to reach CAKE per second.
 */
const CAKE_PER_SECOND_SCALE = 1e12 * 1e18;

const MASTERCHEF_ABI = [
  {
    type: "function",
    name: "latestPeriodCakePerSecond",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalAllocPoint",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "v3PoolAddressPid",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "poolInfo",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      { name: "allocPoint", type: "uint256" },
      { name: "v3Pool", type: "address" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "totalLiquidity", type: "uint256" },
      { name: "totalBoostLiquidity", type: "uint256" },
    ],
  },
] as const;

/**
 * A pool id is assigned once and never reassigned, so it is cached for the
 * process lifetime — the same reasoning as the ERC-20 symbol cache. Only ids
 * that survived the `v3Pool` check are cached; a wrong one would stick forever.
 */
const pidCache = new Map<string, bigint>();

/** Exported for tests, which must not inherit ids from an earlier case. */
export function clearPidCache(): void {
  pidCache.clear();
}

export interface CakeEmissions {
  /** CAKE emitted per second across all farms, at the current rate. */
  cakePerSecond: number;
  totalAllocPoint: number;
  /**
   * Farm slot per pool address, lowercased.
   *
   * A pool absent from this map was asked about and is **not farmed** — either
   * it has no MasterChefV3 slot, or its slot carries no allocation. Absence is
   * an answer here, not a gap: the call either resolves every requested pool or
   * throws, so a partial map cannot be observed.
   */
  farms: Map<string, PoolFarm>;
}

export interface FetchCakeEmissionsParams {
  /** Pool addresses to resolve. Best supplied from the farming list. */
  pools: string[];
  signal?: AbortSignal | undefined;
  /** Overrides the environment RPC endpoint list. Tests use this. */
  rpcUrls?: string[] | undefined;
}

const NO_EMISSIONS: CakeEmissions = {
  cakePerSecond: 0,
  totalAllocPoint: 0,
  farms: new Map(),
};

/**
 * Resolves CAKE emissions for a set of V3 pools.
 *
 * Two batched rounds: the emission globals and any uncached pool ids together,
 * then `poolInfo` for each id. With ids warm the first round is two calls
 * whatever the pool count.
 */
export async function fetchCakeEmissions(
  params: FetchCakeEmissionsParams,
): Promise<CakeEmissions> {
  const pools = [...new Set(params.pools.map((pool) => normalizeAddress(pool)))].filter(
    (pool): pool is string => pool !== null,
  );
  // An empty request performs no read at all; the globals in the result are
  // then placeholders, and no caller has a pool to apply them to.
  if (pools.length === 0) return { ...NO_EMISSIONS, farms: new Map() };

  return withBscClient(
    async (client) => {
      const chef = { address: MASTERCHEF_V3, abi: MASTERCHEF_ABI } as const;
      const uncached = pools.filter((pool) => !pidCache.has(pool));

      // Issued in the same tick so viem folds them into one Multicall3 request.
      const globals = Promise.all([
        client.readContract({ ...chef, functionName: "latestPeriodCakePerSecond" }),
        client.readContract({ ...chef, functionName: "totalAllocPoint" }),
      ]);
      const lookups = Promise.all(
        uncached.map((pool) =>
          client.readContract({
            ...chef,
            functionName: "v3PoolAddressPid",
            args: [pool as `0x${string}`],
          }),
        ),
      );
      const [[cakePerSecondRaw, totalAllocRaw], discovered] = await Promise.all([
        globals,
        lookups,
      ]);

      const pids = new Map<string, bigint>();
      for (const pool of pools) {
        const cached = pidCache.get(pool);
        if (cached !== undefined) pids.set(pool, cached);
      }
      uncached.forEach((pool, index) => {
        const pid = discovered[index];
        if (pid !== undefined) pids.set(pool, pid);
      });

      const ordered = [...pids.entries()];
      const infos = await Promise.all(
        ordered.map(([, pid]) =>
          client.readContract({ ...chef, functionName: "poolInfo", args: [pid] }),
        ),
      );

      const cakePerSecond = Number(cakePerSecondRaw) / CAKE_PER_SECOND_SCALE;
      const totalAllocPoint = Number(totalAllocRaw);
      const farms = new Map<string, PoolFarm>();

      for (const [index, [pool, pid]] of ordered.entries()) {
        const info = infos[index];
        if (info === undefined) continue;

        const [allocPointRaw, v3Pool] = info;
        // `v3PoolAddressPid` answers 0 for a pool it has never registered, and
        // slot 0 belongs to a real pool. Comparing the slot back to the address
        // asked about is what keeps an unregistered pool from inheriting it.
        if (v3Pool.toLowerCase() !== pool) continue;
        pidCache.set(pool, pid);

        const allocPoint = Number(allocPointRaw);
        if (allocPoint <= 0 || totalAllocPoint <= 0) continue;

        farms.set(pool, {
          pid: Number(pid),
          allocPoint,
          cakePerYear: cakePerSecond * (allocPoint / totalAllocPoint) * SECONDS_PER_YEAR,
        });
      }

      return { cakePerSecond, totalAllocPoint, farms };
    },
    { signal: params.signal, rpcUrls: params.rpcUrls },
  );
}

/**
 * Values a farm's yearly CAKE against a pool's TVL, as a percentage.
 *
 * `0` emissions is a real answer — the pool is not farmed — and stays `0`
 * whatever the price is. An unknown price or TVL is not: the result is `null`,
 * so a missing input never reads as "this pool pays nothing".
 */
export function computeCakeFarmApr(
  cakePerYear: number,
  cakePriceUsd: number | null,
  tvlUsd: number | null,
): number | null {
  if (!Number.isFinite(cakePerYear) || cakePerYear < 0) return null;
  if (cakePerYear === 0) return 0;
  if (cakePriceUsd === null || cakePriceUsd <= 0) return null;
  if (tvlUsd === null || tvlUsd <= 0) return null;
  return roundAprPercent(((cakePerYear * cakePriceUsd) / tvlUsd) * 100);
}
