import type { Address } from "viem";
import type { BscClient } from "../chain/rpc.js";
import { isContractLevelFailure, withBscClient } from "../chain/rpc.js";
import {
  VENUS_CHAIN_ID,
  VENUS_CORE_COMPTROLLER,
  VENUS_LENS,
  exact,
  type VenusAccountPosition,
  type VenusActionPauses,
  type VenusBlockRef,
  type VenusContracts,
  type VenusCoreAccountSnapshotV2,
  type VenusCoreMarket,
  type VenusCoreMarketsSnapshotV1,
  type VenusCoreRewardsSnapshotV2,
  type VenusEModePool,
  type VenusMarketFactors,
  type VenusRewardObservation,
  type VenusUnavailable,
} from "../core/venus.js";
import { calculateVenusRisk, conservativeHealthFactor, riskMatchesProtocol } from "../query/venusRisk.js";
import { AdapterError, normalizeAddress } from "./http.js";
import {
  ERC20_METADATA_ABI,
  VENUS_COMPTROLLER_ABI,
  VENUS_DBO_ABI,
  VENUS_LENS_ABI,
  VENUS_ORACLE_ABI,
  VENUS_PRIME_V2_ABI,
  VENUS_VAI_CONTROLLER_ABI,
  VENUS_VTOKEN_ABI,
} from "./venusAbis.js";

const SOURCE = "venus-core";
const E18 = 10n ** 18n;
const COMPTROLLER = VENUS_CORE_COMPTROLLER as Address;
const LENS = VENUS_LENS as Address;

interface VenusReadOptions {
  signal?: AbortSignal | undefined;
  rpcUrls?: string[] | undefined;
}

interface PinnedContext {
  blockNumber: bigint;
  block: VenusBlockRef;
  contracts: VenusContracts;
  markets: readonly Address[];
}

interface MarketIdentity {
  vTokenSymbol: string;
  vTokenDecimals: number;
  underlyingAddress: Address | null;
  underlyingSymbol: string;
  underlyingDecimals: number;
  native: boolean;
}

interface RawPosition {
  vToken: Address;
  snapshot: readonly [bigint, bigint, bigint, bigint];
  collateralMember: boolean;
}

class DeterministicObservationError extends Error {
  constructor(
    readonly code: VenusUnavailable["code"],
    readonly market?: string,
  ) {
    super(code);
    this.name = "DeterministicObservationError";
  }
}

function lower(address: Address | string): string {
  return address.toLowerCase();
}

function factors(cf: bigint, lt: bigint, li: bigint): VenusMarketFactors {
  return {
    collateralFactor: exact(cf, 18),
    liquidationThreshold: exact(lt, 18),
    liquidationIncentive: exact(li, 18),
  };
}

function amountHeadroom(cap: bigint, used: bigint): bigint {
  return cap > used ? cap - used : 0n;
}

function apyPct(ratePerBlock: bigint): number {
  const dailyRate = (Number(ratePerBlock) / 1e18) * 192_000;
  if (!Number.isFinite(dailyRate)) return 0;
  return (Math.pow(1 + dailyRate, 365) - 1) * 100;
}

async function readPinnedContext(client: BscClient): Promise<PinnedContext> {
  const header = await client.getBlock({ blockTag: "latest" });
  const blockNumber = header.number;
  const [oracle, dbo, vaiController, xvs, prime, markets] = await Promise.all([
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "oracle", blockNumber }),
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "deviationBoundedOracle", blockNumber }),
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "vaiController", blockNumber }),
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "getXVSAddress", blockNumber }),
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "prime", blockNumber }),
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "getAllMarkets", blockNumber }),
  ]);
  return {
    blockNumber,
    block: { number: blockNumber.toString(), hash: header.hash, timestamp: header.timestamp.toString() },
    contracts: {
      comptroller: lower(COMPTROLLER),
      oracle: lower(oracle),
      deviationBoundedOracle: lower(dbo),
      vaiController: lower(vaiController),
      xvs: lower(xvs),
      primeV2: lower(prime),
    },
    markets,
  };
}

async function requireCoherentBlock(client: BscClient, context: PinnedContext): Promise<void> {
  const after = await client.getBlock({ blockNumber: context.blockNumber });
  if (after.hash.toLowerCase() !== context.block.hash.toLowerCase()) {
    throw new AdapterError(SOURCE, "incoherent pinned block");
  }
}

async function readIdentity(client: BscClient, vToken: Address, blockNumber: bigint): Promise<MarketIdentity> {
  const [vTokenSymbol, vTokenDecimals] = await Promise.all([
    client.readContract({ address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "symbol", blockNumber }),
    client.readContract({ address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "decimals", blockNumber }),
  ]);
  if (vTokenSymbol === "vBNB") {
    return {
      vTokenSymbol,
      vTokenDecimals,
      underlyingAddress: null,
      underlyingSymbol: "BNB",
      underlyingDecimals: 18,
      native: true,
    };
  }
  const underlyingAddress = await client.readContract({
    address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "underlying", blockNumber,
  });
  const [underlyingSymbol, underlyingDecimals] = await Promise.all([
    client.readContract({ address: underlyingAddress, abi: ERC20_METADATA_ABI, functionName: "symbol", blockNumber }),
    client.readContract({ address: underlyingAddress, abi: ERC20_METADATA_ABI, functionName: "decimals", blockNumber }),
  ]);
  return { vTokenSymbol, vTokenDecimals, underlyingAddress, underlyingSymbol, underlyingDecimals, native: false };
}

async function readActionPauses(
  client: BscClient,
  vToken: Address,
  blockNumber: bigint,
): Promise<VenusActionPauses> {
  const values = await Promise.all(
    Array.from({ length: 9 }, (_, action) => client.readContract({
      address: COMPTROLLER,
      abi: VENUS_COMPTROLLER_ABI,
      functionName: "actionPaused",
      args: [vToken, action],
      blockNumber,
    })),
  );
  return {
    mint: values[0] ?? true,
    redeem: values[1] ?? true,
    borrow: values[2] ?? true,
    repay: values[3] ?? true,
    seize: values[4] ?? true,
    liquidate: values[5] ?? true,
    transfer: values[6] ?? true,
    enterMarket: values[7] ?? true,
    exitMarket: values[8] ?? true,
  };
}

async function readCoreMarket(
  client: BscClient,
  vToken: Address,
  context: PinnedContext,
): Promise<VenusCoreMarket> {
  const { blockNumber } = context;
  const identity = await readIdentity(client, vToken, blockNumber);
  const [market, supplyCap, borrowCap, forced, actionPaused, supplyRate, borrowRate, cash, totalSupply,
    totalBorrows, totalReserves, exchangeRate, reserveFactor, spot, bounded, xvsSupplySpeed, xvsBorrowSpeed] = await Promise.all([
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "markets", args: [vToken], blockNumber }),
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "supplyCaps", args: [vToken], blockNumber }),
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "borrowCaps", args: [vToken], blockNumber }),
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "isForcedLiquidationEnabled", args: [vToken], blockNumber }),
    readActionPauses(client, vToken, blockNumber),
    client.readContract({ address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "supplyRatePerBlock", blockNumber }),
    client.readContract({ address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "borrowRatePerBlock", blockNumber }),
    client.readContract({ address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "getCash", blockNumber }),
    client.readContract({ address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "totalSupply", blockNumber }),
    client.readContract({ address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "totalBorrows", blockNumber }),
    client.readContract({ address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "totalReserves", blockNumber }),
    client.readContract({ address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "exchangeRateStored", blockNumber }),
    client.readContract({ address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "reserveFactorMantissa", blockNumber }),
    client.readContract({ address: context.contracts.oracle as Address, abi: VENUS_ORACLE_ABI, functionName: "getUnderlyingPrice", args: [vToken], blockNumber }),
    client.readContract({ address: context.contracts.deviationBoundedOracle as Address, abi: VENUS_DBO_ABI, functionName: "getBoundedPricesView", args: [vToken], blockNumber }),
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "venusSupplySpeeds", args: [vToken], blockNumber }),
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "venusBorrowSpeeds", args: [vToken], blockNumber }),
  ]);
  if (spot === 0n || bounded[0] === 0n || bounded[1] === 0n) {
    throw new AdapterError(SOURCE, "invalid market oracle price");
  }
  const suppliedUnderlying = (totalSupply * exchangeRate) / E18;
  return {
    vToken: lower(vToken),
    vTokenSymbol: identity.vTokenSymbol,
    vTokenDecimals: identity.vTokenDecimals,
    underlying: {
      address: identity.underlyingAddress === null ? null : lower(identity.underlyingAddress),
      symbol: identity.underlyingSymbol,
      decimals: identity.underlyingDecimals,
      native: identity.native,
    },
    listed: market[0],
    borrowAllowed: market[6],
    poolId: market[5].toString(),
    coreFactors: factors(market[1], market[3], market[4]),
    prices: {
      scaleKind: "venus_underlying_price",
      decimals: 36 - identity.underlyingDecimals,
      spot: spot.toString(),
      boundedCollateral: bounded[0].toString(),
      boundedDebt: bounded[1].toString(),
    },
    supplyCap: exact(supplyCap, identity.underlyingDecimals),
    borrowCap: exact(borrowCap, identity.underlyingDecimals),
    supplyHeadroom: exact(amountHeadroom(supplyCap, suppliedUnderlying), identity.underlyingDecimals),
    borrowHeadroom: exact(amountHeadroom(borrowCap, totalBorrows), identity.underlyingDecimals),
    forcedLiquidation: forced,
    actionPaused,
    supplyRatePerBlock: exact(supplyRate, 18),
    borrowRatePerBlock: exact(borrowRate, 18),
    supplyApyPct: apyPct(supplyRate),
    borrowApyPct: apyPct(borrowRate),
    cash: exact(cash, identity.underlyingDecimals),
    totalSupply: exact(totalSupply, identity.vTokenDecimals),
    totalBorrows: exact(totalBorrows, identity.underlyingDecimals),
    totalReserves: exact(totalReserves, identity.underlyingDecimals),
    exchangeRateStored: exact(exchangeRate, 18 + identity.underlyingDecimals - identity.vTokenDecimals),
    reserveFactor: exact(reserveFactor, 18),
    xvsSupplySpeed: exact(xvsSupplySpeed, 18),
    xvsBorrowSpeed: exact(xvsBorrowSpeed, 18),
  };
}

async function readEModePools(client: BscClient, lastPoolId: bigint, blockNumber: bigint): Promise<VenusEModePool[]> {
  const pools: VenusEModePool[] = [];
  for (let poolId = 1n; poolId <= lastPoolId; poolId += 1n) {
    const [pool, vTokens] = await Promise.all([
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "pools", args: [poolId], blockNumber }),
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "getPoolVTokens", args: [poolId], blockNumber }),
    ]);
    const markets = await Promise.all(vTokens.map(async (vToken) => {
      const market = await client.readContract({
        address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "poolMarkets", args: [poolId, vToken], blockNumber,
      });
      return {
        vToken: lower(vToken), listed: market[0], borrowAllowed: market[6], factors: factors(market[1], market[3], market[4]),
      };
    }));
    pools.push({ poolId: poolId.toString(), label: pool[0], active: pool[1], allowCorePoolFallback: pool[2], markets });
  }
  return pools;
}

export async function fetchVenusCoreMarkets(options: VenusReadOptions = {}): Promise<VenusCoreMarketsSnapshotV1> {
  return withBscClient(async (client) => {
    const context = await readPinnedContext(client);
    const [lastPoolId, protocolPaused, mintPaused, repayPaused, markets] = await Promise.all([
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "lastPoolId", blockNumber: context.blockNumber }),
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "protocolPaused", blockNumber: context.blockNumber }),
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "mintVAIGuardianPaused", blockNumber: context.blockNumber }),
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "repayVAIGuardianPaused", blockNumber: context.blockNumber }),
      Promise.all(context.markets.map((market) => readCoreMarket(client, market, context))),
    ]);
    const eModePools = await readEModePools(client, lastPoolId, context.blockNumber);
    await requireCoherentBlock(client, context);
    return {
      schemaVersion: 1,
      chainId: VENUS_CHAIN_ID,
      pool: "core",
      block: context.block,
      observedAt: Date.now(),
      contracts: context.contracts,
      protocolPaused,
      vai: { mintPaused, repayPaused },
      markets,
      eModePools,
    };
  }, options);
}

async function simulateCurrent(
  client: BscClient,
  vToken: Address,
  owner: Address,
  blockNumber: bigint,
): Promise<{ borrow: bigint; exchangeRate: bigint }> {
  const [borrow, exchangeRate] = await Promise.all([
    client.simulateContract({
      address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "borrowBalanceCurrent", args: [owner], account: owner, blockNumber,
    }).then((result) => result.result),
    client.simulateContract({
      address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "exchangeRateCurrent", account: owner, blockNumber,
    }).then((result) => result.result),
  ]);
  return { borrow, exchangeRate };
}

async function readAccountPosition(
  client: BscClient,
  raw: RawPosition,
  owner: Address,
  context: PinnedContext,
): Promise<{
  position: VenusAccountPosition;
  storedRisk: Parameters<typeof calculateVenusRisk>[0][number];
  currentRisk: Parameters<typeof calculateVenusRisk>[0][number] | null;
}> {
  const identity = await readIdentity(client, raw.vToken, context.blockNumber);
  const [market, effectiveCf, effectiveLt, effectiveLi, spot, bounded, forcedMarket, forcedUser] = await Promise.all([
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "markets", args: [raw.vToken], blockNumber: context.blockNumber }),
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "getEffectiveLtvFactor", args: [owner, raw.vToken, 0], blockNumber: context.blockNumber }),
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "getEffectiveLtvFactor", args: [owner, raw.vToken, 1], blockNumber: context.blockNumber }),
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "getEffectiveLiquidationIncentive", args: [owner, raw.vToken], blockNumber: context.blockNumber }),
    client.readContract({ address: context.contracts.oracle as Address, abi: VENUS_ORACLE_ABI, functionName: "getUnderlyingPrice", args: [raw.vToken], blockNumber: context.blockNumber }),
    client.readContract({ address: context.contracts.deviationBoundedOracle as Address, abi: VENUS_DBO_ABI, functionName: "getBoundedPricesView", args: [raw.vToken], blockNumber: context.blockNumber }),
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "isForcedLiquidationEnabled", args: [raw.vToken], blockNumber: context.blockNumber }),
    client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "isForcedLiquidationEnabledForUser", args: [owner, raw.vToken], blockNumber: context.blockNumber }),
  ]);
  if (spot === 0n || bounded[0] === 0n || bounded[1] === 0n) {
    throw new DeterministicObservationError("invalid_oracle_price", lower(raw.vToken));
  }
  const [, vTokenBalance, borrowStored, exchangeStored] = raw.snapshot;
  const storedSupply = (vTokenBalance * exchangeStored) / E18;
  let current: Awaited<ReturnType<typeof simulateCurrent>> | null;
  try {
    current = await simulateCurrent(client, raw.vToken, owner, context.blockNumber);
  } catch (error) {
    if (!isContractLevelFailure(error)) throw error;
    current = null;
  }
  const currentSupply = current === null ? null : (vTokenBalance * current.exchangeRate) / E18;
  const common = {
    collateralMember: raw.collateralMember,
    vTokenBalance,
    collateralFactor: effectiveCf,
    liquidationThreshold: effectiveLt,
    collateralPrice: bounded[0],
    debtPrice: bounded[1],
    spotPrice: spot,
  };
  const position: VenusAccountPosition = {
    vToken: lower(raw.vToken),
    vTokenSymbol: identity.vTokenSymbol,
    vTokenDecimals: identity.vTokenDecimals,
    underlying: {
      address: identity.underlyingAddress === null ? null : lower(identity.underlyingAddress),
      symbol: identity.underlyingSymbol,
      decimals: identity.underlyingDecimals,
      native: identity.native,
    },
    collateralMember: raw.collateralMember,
    vTokenBalance: exact(vTokenBalance, identity.vTokenDecimals),
    suppliedUnderlyingStored: exact(storedSupply, identity.underlyingDecimals),
    suppliedUnderlyingCurrent: currentSupply === null ? null : exact(currentSupply, identity.underlyingDecimals),
    borrowStored: exact(borrowStored, identity.underlyingDecimals),
    borrowCurrent: current === null ? null : exact(current.borrow, identity.underlyingDecimals),
    prices: {
      scaleKind: "venus_underlying_price",
      decimals: 36 - identity.underlyingDecimals,
      spot: spot.toString(),
      boundedCollateral: bounded[0].toString(),
      boundedDebt: bounded[1].toString(),
    },
    coreFactors: factors(market[1], market[3], market[4]),
    effectiveFactors: factors(effectiveCf, effectiveLt, effectiveLi),
    listed: market[0],
    borrowAllowed: market[6],
    forcedLiquidation: { market: forcedMarket, user: forcedUser, effective: forcedMarket || forcedUser },
  };
  return {
    position,
    storedRisk: { ...common, exchangeRate: exchangeStored, borrowBalance: borrowStored },
    currentRisk: current === null ? null : { ...common, exchangeRate: current.exchangeRate, borrowBalance: current.borrow },
  };
}

async function readAccountAtContext(
  client: BscClient,
  normalized: string,
  context: PinnedContext,
): Promise<VenusCoreAccountSnapshotV2> {
    const owner = normalized as Address;
    const [assetsIn, userPoolId, lastPoolId, vaiDebt, borrowingPower, accountLiquidity, snapshots] = await Promise.all([
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "getAssetsIn", args: [owner], blockNumber: context.blockNumber }),
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "userPoolId", args: [owner], blockNumber: context.blockNumber }),
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "lastPoolId", blockNumber: context.blockNumber }),
      client.readContract({ address: context.contracts.vaiController as Address, abi: VENUS_VAI_CONTROLLER_ABI, functionName: "getVAIRepayAmount", args: [owner], blockNumber: context.blockNumber }),
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "getBorrowingPower", args: [owner], blockNumber: context.blockNumber }),
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "getAccountLiquidity", args: [owner], blockNumber: context.blockNumber }),
      Promise.all(context.markets.map(async (vToken) => ({
        vToken,
        snapshot: await client.readContract({ address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "getAccountSnapshot", args: [owner], blockNumber: context.blockNumber }),
      }))),
    ]);
    const assetSet = new Set(assetsIn.map(lower));
    const raw: RawPosition[] = snapshots.map(({ vToken, snapshot }) => ({
      vToken, snapshot, collateralMember: assetSet.has(lower(vToken)),
    }));
    const poolSupported = userPoolId <= lastPoolId;
    const pool = userPoolId === 0n
      ? (["Core", true, true] as const)
      : poolSupported
        ? await client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "pools", args: [userPoolId], blockNumber: context.blockNumber })
        : (["Unknown", false, false] as const);
    const unavailableSnapshot = (unavailable: VenusUnavailable): VenusCoreAccountSnapshotV2 => ({
      schemaVersion: 2,
      chainId: VENUS_CHAIN_ID,
      pool: "core",
      owner: normalized,
      status: poolSupported ? "unavailable" : "unsupported",
      block: context.block,
      observedAt: Date.now(),
      contracts: context.contracts,
      eMode: {
        userPoolId: userPoolId.toString(), label: pool[0], active: pool[1], allowCorePoolFallback: pool[2], supported: poolSupported,
      },
      vaiDebt: exact(vaiDebt, 18),
      protocolSnapshot: null,
      fullyAccruedEstimate: null,
      wakeRiskHealthFactor: null,
      wakeRiskStatus: "unavailable",
      economicLiquidationCondition: {
        protocolShortfall: accountLiquidity[2] > 0n,
        forcedMarket: false,
        forcedVai: false,
        effective: accountLiquidity[2] > 0n,
      },
      positions: [],
      unavailable: [
        ...(poolSupported ? [] : [{ code: "unsupported_emode", scope: "account" } as const]),
        unavailable,
      ],
    });
    const snapshotError = raw.find((entry) => entry.snapshot[0] !== 0n);
    if (snapshotError !== undefined) {
      return unavailableSnapshot({ code: "snapshot_error", scope: "market", market: lower(snapshotError.vToken) });
    }
    const active = raw.filter((entry) => entry.snapshot[1] !== 0n || entry.snapshot[2] !== 0n || entry.collateralMember);
    let reads: Awaited<ReturnType<typeof readAccountPosition>>[];
    try {
      reads = await Promise.all(active.map((entry) => readAccountPosition(client, entry, owner, context)));
    } catch (error) {
      if (error instanceof DeterministicObservationError) {
        return unavailableSnapshot({ code: error.code, scope: "market", ...(error.market === undefined ? {} : { market: error.market }) });
      }
      throw error;
    }
    const stored = calculateVenusRisk(reads.map((entry) => entry.storedRisk), vaiDebt);
    const currentInputs = reads.map((entry) => entry.currentRisk);
    const current = currentInputs.every((entry) => entry !== null)
      ? calculateVenusRisk(currentInputs, vaiDebt)
      : null;
    const borrowingMatched = riskMatchesProtocol(stored.borrowingPower, borrowingPower[0], borrowingPower[1], borrowingPower[2]);
    const liquidationMatched = riskMatchesProtocol(stored.liquidationRisk, accountLiquidity[0], accountLiquidity[1], accountLiquidity[2]);
    const unavailable: VenusUnavailable[] = [];
    if (!poolSupported) unavailable.push({ code: "unsupported_emode", scope: "account" });
    if (borrowingPower[0] !== 0n || accountLiquidity[0] !== 0n) unavailable.push({ code: "protocol_error", scope: "account" });
    if (!borrowingMatched || !liquidationMatched) unavailable.push({ code: "protocol_mismatch", scope: "account" });
    if (current === null) unavailable.push({ code: "current_estimate_failed", scope: "account" });
    const forcedMarket = reads.some((entry) => entry.position.borrowStored.value !== "0" && entry.position.forcedLiquidation.effective);
    const [forcedVaiMarket, forcedVaiUser] = vaiDebt === 0n ? [false, false] : await Promise.all([
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "isForcedLiquidationEnabled", args: [context.contracts.vaiController as Address], blockNumber: context.blockNumber }),
      client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "isForcedLiquidationEnabledForUser", args: [owner, context.contracts.vaiController as Address], blockNumber: context.blockNumber }),
    ]);
    const available = unavailable.length === 0;
    return {
      schemaVersion: 2,
      chainId: VENUS_CHAIN_ID,
      pool: "core",
      owner: normalized,
      status: poolSupported ? (available ? "available" : "unavailable") : "unsupported",
      block: context.block,
      observedAt: Date.now(),
      contracts: context.contracts,
      eMode: {
        userPoolId: userPoolId.toString(), label: pool[0], active: pool[1], allowCorePoolFallback: pool[2], supported: poolSupported,
      },
      vaiDebt: exact(vaiDebt, 18),
      protocolSnapshot: {
        borrowingPower: stored.borrowingPower,
        liquidationRisk: stored.liquidationRisk,
        borrowingPowerCheck: {
          errorCode: borrowingPower[0].toString(), liquidity: exact(borrowingPower[1], 18), shortfall: exact(borrowingPower[2], 18), matched: borrowingMatched,
        },
        liquidationCheck: {
          errorCode: accountLiquidity[0].toString(), liquidity: exact(accountLiquidity[1], 18), shortfall: exact(accountLiquidity[2], 18), matched: liquidationMatched,
        },
      },
      fullyAccruedEstimate: current === null ? null : { ...current, kind: "fully_accrued_estimate" },
      wakeRiskHealthFactor: available && current !== null
        ? conservativeHealthFactor(stored.liquidationRisk, current.liquidationRisk)
        : null,
      wakeRiskStatus: available ? "available" : "unavailable",
      economicLiquidationCondition: {
        protocolShortfall: accountLiquidity[2] > 0n,
        forcedMarket,
        forcedVai: forcedVaiMarket || forcedVaiUser,
        effective: accountLiquidity[2] > 0n || forcedMarket || forcedVaiMarket || forcedVaiUser,
      },
      positions: reads.map((entry) => entry.position),
      unavailable,
    };
}

export async function fetchVenusCoreAccount(
  ownerInput: string,
  options: VenusReadOptions = {},
): Promise<VenusCoreAccountSnapshotV2> {
  const normalized = normalizeAddress(ownerInput);
  if (normalized === null) throw new AdapterError(SOURCE, "invalid owner address");
  return withBscClient(async (client) => {
    const context = await readPinnedContext(client);
    const snapshot = await readAccountAtContext(client, normalized, context);
    await requireCoherentBlock(client, context);
    return snapshot;
  }, options);
}

/**
 * Read a scheduler chunk against one RPC client, one discovered contract set and
 * one pinned block. Fulfilled/rejected results stay aligned with ownerInputs so
 * one deterministic account failure cannot erase the rest of a sweep chunk.
 */
export async function fetchVenusCoreAccounts(
  ownerInputs: readonly string[],
  options: VenusReadOptions = {},
): Promise<PromiseSettledResult<VenusCoreAccountSnapshotV2>[]> {
  const normalized = ownerInputs.map((owner) => {
    const address = normalizeAddress(owner);
    if (address === null) throw new AdapterError(SOURCE, "invalid owner address");
    return address;
  });
  if (normalized.length === 0) return [];
  return withBscClient(async (client) => {
    const context = await readPinnedContext(client);
    const settled = await Promise.allSettled(
      normalized.map((owner) => readAccountAtContext(client, owner, context)),
    );
    if (settled.every((result) => result.status === "rejected")) {
      throw settled[0]?.reason ?? new AdapterError(SOURCE, "account batch failed");
    }
    await requireCoherentBlock(client, context);
    return settled;
  }, options);
}

function claimStatusFromError(error: unknown): VenusRewardObservation["claimStatus"] {
  if (isContractLevelFailure(error)) return "claim_reverted";
  throw error;
}

export function interpretXvsClaimSimulation(
  entitlement: bigint,
  balanceBefore: bigint,
  balanceAfter: bigint,
  remaining: bigint,
): Pick<VenusRewardObservation, "payoutNow" | "remainingAfterSimulatedClaim" | "claimAvailable" | "claimStatus"> {
  const payout = balanceAfter >= balanceBefore ? balanceAfter - balanceBefore : 0n;
  const claimAvailable = entitlement > 0n && payout > 0n;
  const claimStatus: VenusRewardObservation["claimStatus"] = entitlement === 0n
    ? "zero"
    : payout > 0n
      ? "available"
      : remaining > 0n
        ? "insufficient_reward_balance"
        : "zero";
  return {
    payoutNow: exact(payout, 18),
    remainingAfterSimulatedClaim: exact(remaining, 18),
    claimAvailable,
    claimStatus,
  };
}

async function readTokenIdentity(client: BscClient, token: Address, blockNumber: bigint): Promise<{ symbol: string; decimals: number }> {
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_METADATA_ABI, functionName: "symbol", blockNumber }),
    client.readContract({ address: token, abi: ERC20_METADATA_ABI, functionName: "decimals", blockNumber }),
  ]);
  return { symbol, decimals };
}

async function readXvsReward(
  client: BscClient,
  owner: Address,
  context: PinnedContext,
  listedMarkets: Address[],
): Promise<VenusRewardObservation> {
  const summary = await client.readContract({
    address: LENS, abi: VENUS_LENS_ABI, functionName: "pendingRewards", args: [owner, COMPTROLLER], blockNumber: context.blockNumber,
  });
  const token = summary.rewardTokenAddress;
  const tokenIdentity = await readTokenIdentity(client, token, context.blockNumber);
  const entitlement = summary.totalRewards + summary.pendingRewards.reduce((sum, reward) => sum + reward.amount, 0n);
  let payout = 0n;
  let remaining = entitlement;
  let claimAvailable = entitlement > 0n;
  let claimStatus: VenusRewardObservation["claimStatus"] = entitlement === 0n ? "zero" : "available";
  if (entitlement > 0n) {
    try {
      const simulation = await client.multicall({
        allowFailure: true,
        blockNumber: context.blockNumber,
        contracts: [
          { address: token, abi: ERC20_METADATA_ABI, functionName: "balanceOf", args: [owner] },
          { address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "claimVenus", args: [owner, listedMarkets] },
          { address: token, abi: ERC20_METADATA_ABI, functionName: "balanceOf", args: [owner] },
          { address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "venusAccrued", args: [owner] },
        ],
      });
      const before = simulation[0];
      const claim = simulation[1];
      const after = simulation[2];
      const accrued = simulation[3];
      if (before?.status !== "success" || claim?.status !== "success" || after?.status !== "success" || accrued?.status !== "success") {
        claimAvailable = false;
        claimStatus = "claim_reverted";
      } else {
        const interpreted = interpretXvsClaimSimulation(entitlement, before.result, after.result, accrued.result);
        payout = BigInt(interpreted.payoutNow.value);
        remaining = BigInt(interpreted.remainingAfterSimulatedClaim.value);
        claimAvailable = interpreted.claimAvailable;
        claimStatus = interpreted.claimStatus;
      }
    } catch (error) {
      claimAvailable = false;
      claimStatus = claimStatusFromError(error);
    }
  }
  return {
    mechanism: "xvs",
    distributor: lower(COMPTROLLER),
    rewardToken: lower(token),
    rewardTokenSymbol: tokenIdentity.symbol,
    rewardTokenDecimals: tokenIdentity.decimals,
    vToken: null,
    markets: summary.pendingRewards
      .filter((reward) => reward.amount > 0n)
      .map((reward) => ({ vToken: lower(reward.vTokenAddress), entitlement: exact(reward.amount, tokenIdentity.decimals) })),
    entitlement: exact(entitlement, tokenIdentity.decimals),
    payoutNow: exact(payout, tokenIdentity.decimals),
    remainingAfterSimulatedClaim: exact(remaining, tokenIdentity.decimals),
    claimAvailable,
    claimStatus,
  };
}

export async function fetchVenusCoreRewards(
  ownerInput: string,
  options: VenusReadOptions = {},
): Promise<VenusCoreRewardsSnapshotV2> {
  const normalized = normalizeAddress(ownerInput);
  if (normalized === null) throw new AdapterError(SOURCE, "invalid owner address");
  const owner = normalized as Address;
  return withBscClient(async (client) => {
    const context = await readPinnedContext(client);
    const listed = (await Promise.all(context.markets.map(async (vToken) => ({
      vToken,
      market: await client.readContract({ address: COMPTROLLER, abi: VENUS_COMPTROLLER_ABI, functionName: "markets", args: [vToken], blockNumber: context.blockNumber }),
    })))).filter((entry) => entry.market[0]).map((entry) => entry.vToken);
    const primeAddress = context.contracts.primeV2 as Address;
    const [xvs, primeHolder, primePaused, primePending] = await Promise.all([
      readXvsReward(client, owner, context, listed),
      client.readContract({ address: primeAddress, abi: VENUS_PRIME_V2_ABI, functionName: "isUserPrimeHolder", args: [owner], blockNumber: context.blockNumber }),
      client.readContract({ address: primeAddress, abi: VENUS_PRIME_V2_ABI, functionName: "paused", blockNumber: context.blockNumber }),
      client.readContract({ address: primeAddress, abi: VENUS_PRIME_V2_ABI, functionName: "getPendingRewardsStatic", args: [owner], blockNumber: context.blockNumber }),
    ]);
    const primeRewards = await Promise.all(primePending.map(async (pending) => {
      const identity = await readTokenIdentity(client, pending.rewardToken, context.blockNumber);
      let payout = 0n;
      let available = pending.amount > 0n && !primePaused;
      let status: VenusRewardObservation["claimStatus"] = pending.amount === 0n ? "zero" : primePaused ? "protocol_paused" : "available";
      if (pending.amount > 0n && !primePaused) {
        try {
          payout = await client.simulateContract({
            address: primeAddress,
            abi: VENUS_PRIME_V2_ABI,
            functionName: "claimInterest",
            args: [pending.vToken, owner],
            account: owner,
            blockNumber: context.blockNumber,
          }).then((result) => result.result);
          if (payout === 0n) {
            available = false;
            status = "insufficient_reward_balance";
          }
        } catch (error) {
          available = false;
          status = claimStatusFromError(error);
        }
      }
      return {
        mechanism: "prime-v2" as const,
        distributor: lower(primeAddress),
        rewardToken: lower(pending.rewardToken),
        rewardTokenSymbol: identity.symbol,
        rewardTokenDecimals: identity.decimals,
        vToken: lower(pending.vToken),
        markets: [{ vToken: lower(pending.vToken), entitlement: exact(pending.amount, identity.decimals) }],
        entitlement: exact(pending.amount, identity.decimals),
        payoutNow: exact(payout, identity.decimals),
        remainingAfterSimulatedClaim: exact(pending.amount > payout ? pending.amount - payout : 0n, identity.decimals),
        claimAvailable: available,
        claimStatus: status,
      } satisfies VenusRewardObservation;
    }));
    await requireCoherentBlock(client, context);
    return {
      schemaVersion: 2,
      chainId: VENUS_CHAIN_ID,
      pool: "core",
      owner: normalized,
      status: "available",
      block: context.block,
      observedAt: Date.now(),
      contracts: context.contracts,
      primeHolder,
      rewards: [xvs, ...primeRewards],
      unavailable: [],
    };
  }, options);
}
