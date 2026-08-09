/**
 * Venus Core Pool health-factor adapter (BSC).
 *
 * The Comptroller address below is the Core Pool Unitroller taken from Venus's
 * own deployment manifest, not from memory:
 * https://github.com/VenusProtocol/venus-protocol/blob/main/deployments/bscmainnet_addresses.json
 * (`Unitroller`), cross-checked against the BscScan label "Venus: Core Pool
 * Comptroller". The Unitroller is the proxy every Comptroller call goes through.
 *
 * The math mirrors Venus's own `getAccountLiquidity`, and was verified against
 * it on a live borrower: this module's collateral minus borrows reproduced the
 * contract's reported liquidity exactly. That equivalence is what makes the
 * health factor safe to drive a repayment from.
 *
 * Everything is bigint until the very last step. Prices are scaled
 * `1e(36 - underlyingDecimals)` by the Venus oracle, which is precisely what
 * makes the USD conversion decimals-agnostic:
 *
 *   borrowUsd(1e18) = borrowBalance * price / 1e18
 *   supplyUsd(1e18) = (vTokenBalance * exchangeRate / 1e18) * price / 1e18
 *
 * so no underlying `decimals()` read is needed at all.
 */

import type { VenusAssetPosition, VenusHealth, VenusTier } from "../core/models.js";
import { type BscClient, withBscClient } from "../chain/rpc.js";
import { AdapterError, normalizeAddress } from "./http.js";

const SOURCE = "venus";

/** Venus Core Pool Unitroller (Comptroller proxy) on BNB Smart Chain. */
export const VENUS_COMPTROLLER = "0xfD36E2c2a6789Db23113685031d7F16329158384";

const E18 = 10n ** 18n;

/** Health-factor band boundaries. A borrow-free account is always healthy. */
export const HEALTHY_AT = 1.5;
export const WARNING_AT = 1.15;
export const LIQUIDATABLE_BELOW = 1;

/**
 * Bands a health factor. `null` means nothing is borrowed, which cannot be
 * liquidated and is therefore healthy.
 */
export function venusTier(healthFactor: number | null): VenusTier {
  if (healthFactor === null) return "HEALTHY";
  if (healthFactor >= HEALTHY_AT) return "HEALTHY";
  if (healthFactor >= WARNING_AT) return "WARNING";
  if (healthFactor >= LIQUIDATABLE_BELOW) return "DANGER";
  return "LIQUIDATABLE";
}

/** True for a tier that needs the fast re-check loop. */
export function isHotTier(tier: VenusTier): boolean {
  return tier === "DANGER" || tier === "LIQUIDATABLE";
}

/** Raw per-market chain reads for one owner, before any USD conversion. */
export interface VenusMarketRead {
  /** vToken symbol, e.g. `vUSDT`. */
  symbol: string;
  /** `getAccountSnapshot` field 2: vToken balance, always 8 decimals. */
  vTokenBalance: bigint;
  /** `getAccountSnapshot` field 3: borrow balance in underlying units. */
  borrowBalance: bigint;
  /** `getAccountSnapshot` field 4, scaled `1e(18 + underlyingDecimals - 8)`. */
  exchangeRateMantissa: bigint;
  /** `markets(vToken).collateralFactorMantissa`, scaled 1e18. */
  collateralFactorMantissa: bigint;
  /** `oracle.getUnderlyingPrice(vToken)`, scaled `1e(36 - underlyingDecimals)`. */
  underlyingPrice: bigint;
}

/**
 * Pure health computation, exported so it can be tested against hand-computed
 * fixtures without a chain. Markets the owner neither supplies nor borrows are
 * dropped, so `assets` lists only real exposure.
 */
export function computeVenusHealth(
  owner: string,
  markets: VenusMarketRead[],
  asOf: number,
): VenusHealth {
  let collateral = 0n;
  let borrow = 0n;
  const assets: VenusAssetPosition[] = [];

  for (const market of markets) {
    const supplyUsd = (market.vTokenBalance * market.exchangeRateMantissa) / E18;
    const supplyValue = (supplyUsd * market.underlyingPrice) / E18;
    const borrowValue = (market.borrowBalance * market.underlyingPrice) / E18;

    collateral += (supplyValue * market.collateralFactorMantissa) / E18;
    borrow += borrowValue;

    if (supplyValue === 0n && borrowValue === 0n) continue;
    assets.push({
      symbol: market.symbol,
      supplyUsd: toUsd(supplyValue),
      borrowUsd: toUsd(borrowValue),
    });
  }

  // Kept in bigint one step longer than strictly necessary so the ratio is not
  // formed from two already-rounded doubles.
  const healthFactor = borrow === 0n ? null : toUsd((collateral * E18) / borrow);

  return {
    owner: owner.toLowerCase(),
    healthFactor,
    tier: venusTier(healthFactor),
    collateralValueUsd: toUsd(collateral),
    borrowValueUsd: toUsd(borrow),
    assets,
    asOf,
  };
}

/** Converts a 1e18-scaled bigint to a number, rounded to six decimals. */
function toUsd(value: bigint): number {
  return Number((value * 1_000_000n) / E18) / 1_000_000;
}

const COMPTROLLER_ABI = [
  { type: "function", name: "oracle", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "getAssetsIn",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "markets",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "isListed", type: "bool" },
      { name: "collateralFactorMantissa", type: "uint256" },
      { name: "isVenus", type: "bool" },
    ],
  },
] as const;

const VTOKEN_ABI = [
  {
    type: "function",
    name: "getAccountSnapshot",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "error", type: "uint256" },
      { name: "vTokenBalance", type: "uint256" },
      { name: "borrowBalance", type: "uint256" },
      { name: "exchangeRateMantissa", type: "uint256" },
    ],
  },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const ORACLE_ABI = [
  {
    type: "function",
    name: "getUnderlyingPrice",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * vToken symbols never change, so they are cached for the process lifetime and
 * kept out of the per-cycle read set.
 */
const symbolCache = new Map<string, string>();

/** Exported for tests, which must not inherit symbols from an earlier case. */
export function clearVenusSymbolCache(): void {
  symbolCache.clear();
}

export interface VenusHealthParams {
  owner: string;
  signal?: AbortSignal | undefined;
  /** Overrides the environment RPC endpoint list. Tests use this. */
  rpcUrls?: string[] | undefined;
}

/**
 * Reads an owner's whole Venus position.
 *
 * Three round trips at most: the entry set, then one Multicall3-batched fan-out
 * per market, then the symbols that are not yet cached. An owner in no markets
 * is a valid, healthy, empty answer rather than an error.
 */
export async function fetchVenusHealth(params: VenusHealthParams): Promise<VenusHealth> {
  const owner = normalizeAddress(params.owner);
  if (owner === null) throw new AdapterError(SOURCE, "invalid owner address");

  return withBscClient(
    async (client) => {
      const comptroller = { address: VENUS_COMPTROLLER as `0x${string}`, abi: COMPTROLLER_ABI } as const;
      const account = owner as `0x${string}`;

      const [oracle, assets] = await Promise.all([
        client.readContract({ ...comptroller, functionName: "oracle" }),
        client.readContract({ ...comptroller, functionName: "getAssetsIn", args: [account] }),
      ]);

      if (assets.length === 0) return computeVenusHealth(owner, [], Date.now());

      const reads = await Promise.all(
        assets.map(async (vToken) => {
          const [snapshot, market, price] = await Promise.all([
            client.readContract({
              address: vToken,
              abi: VTOKEN_ABI,
              functionName: "getAccountSnapshot",
              args: [account],
            }),
            client.readContract({ ...comptroller, functionName: "markets", args: [vToken] }),
            client.readContract({
              address: oracle,
              abi: ORACLE_ABI,
              functionName: "getUnderlyingPrice",
              args: [vToken],
            }),
          ]);
          return { vToken, snapshot, market, price };
        }),
      );

      const symbols = await Promise.all(reads.map((read) => readVTokenSymbol(client, read.vToken)));

      const markets: VenusMarketRead[] = [];
      for (const [index, read] of reads.entries()) {
        // Field 0 is Venus's own error code; a non-zero snapshot is unusable and
        // silently treating it as zeros would understate a borrow.
        if (read.snapshot[0] !== 0n) {
          throw new AdapterError(SOURCE, `account snapshot error ${read.snapshot[0].toString()}`);
        }
        markets.push({
          symbol: symbols[index] ?? read.vToken.toLowerCase(),
          vTokenBalance: read.snapshot[1],
          borrowBalance: read.snapshot[2],
          exchangeRateMantissa: read.snapshot[3],
          collateralFactorMantissa: read.market[1],
          underlyingPrice: read.price,
        });
      }

      return computeVenusHealth(owner, markets, Date.now());
    },
    { signal: params.signal, rpcUrls: params.rpcUrls },
  );
}

async function readVTokenSymbol(client: BscClient, vToken: `0x${string}`): Promise<string | null> {
  const key = vToken.toLowerCase();
  const cached = symbolCache.get(key);
  if (cached !== undefined) return cached;

  try {
    const symbol = await client.readContract({
      address: vToken,
      abi: VTOKEN_ABI,
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
