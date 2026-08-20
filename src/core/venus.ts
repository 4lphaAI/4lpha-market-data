/** Exact, versioned wire contracts for the BNB Chain Venus Core Pool. */

export const VENUS_CHAIN_ID = 56 as const;
export const VENUS_CORE_COMPTROLLER = "0xfd36e2c2a6789db23113685031d7f16329158384";
export const VENUS_LENS = "0xe797804c5d4410777c70ef8769c4eb9c39bef662";
export const VENUS_PRIME_V2 = "0x059eaba8676b03e4e8f009efb7f587c28450f50f";

export const VENUS_CORE_MARKETS_KEY = "venus:core:markets:v1";
export const VENUS_TRACKING_NAMESPACE = "venus-core";

export function venusCoreAccountKey(owner: string): string {
  return `venus:core:account:v2:${owner.toLowerCase()}`;
}

export function venusCoreRewardsKey(owner: string): string {
  return `venus:core:rewards:v2:${owner.toLowerCase()}`;
}

export interface ExactAmount {
  /** Unsigned base-unit integer. */
  value: string;
  decimals: number;
}

export interface VenusBlockRef {
  number: string;
  hash: string;
  timestamp: string;
}

export interface VenusContracts {
  comptroller: string;
  oracle: string;
  deviationBoundedOracle: string;
  vaiController: string;
  xvs: string;
  primeV2: string;
}

export type VenusObservationStatus = "available" | "unsupported" | "unavailable";

export type VenusUnavailableCode =
  | "snapshot_error"
  | "invalid_oracle_price"
  | "market_read_failed"
  | "protocol_error"
  | "protocol_mismatch"
  | "unsupported_emode"
  | "incoherent_block"
  | "current_estimate_failed"
  | "claim_reverted"
  | "account_shortfall"
  | "blacklisted"
  | "insufficient_reward_balance"
  | "protocol_paused";

export interface VenusUnavailable {
  code: VenusUnavailableCode;
  scope: "account" | "market" | "reward" | "block";
  market?: string;
}

export interface VenusRiskResult {
  collateral: ExactAmount;
  debt: ExactAmount;
  liquidity: ExactAmount;
  shortfall: ExactAmount;
  /** 1e18 ratio, null when debt is zero. */
  healthFactor: ExactAmount | null;
}

export interface VenusProtocolCheck {
  errorCode: string;
  liquidity: ExactAmount;
  shortfall: ExactAmount;
  matched: boolean;
}

export interface VenusMarketFactors {
  collateralFactor: ExactAmount;
  liquidationThreshold: ExactAmount;
  liquidationIncentive: ExactAmount;
}

export interface VenusPriceSet {
  scaleKind: "venus_underlying_price";
  decimals: number;
  spot: string;
  boundedCollateral: string;
  boundedDebt: string;
}

export interface VenusAccountPosition {
  vToken: string;
  vTokenSymbol: string;
  vTokenDecimals: number;
  underlying: {
    address: string | null;
    symbol: string;
    decimals: number;
    native: boolean;
  };
  collateralMember: boolean;
  vTokenBalance: ExactAmount;
  suppliedUnderlyingStored: ExactAmount;
  suppliedUnderlyingCurrent: ExactAmount | null;
  borrowStored: ExactAmount;
  borrowCurrent: ExactAmount | null;
  prices: VenusPriceSet;
  coreFactors: VenusMarketFactors;
  effectiveFactors: VenusMarketFactors;
  listed: boolean;
  borrowAllowed: boolean;
  forcedLiquidation: { market: boolean; user: boolean; effective: boolean };
}

export interface VenusCoreAccountSnapshotV2 {
  schemaVersion: 2;
  chainId: typeof VENUS_CHAIN_ID;
  pool: "core";
  owner: string;
  status: VenusObservationStatus;
  block: VenusBlockRef;
  observedAt: number;
  contracts: VenusContracts;
  eMode: {
    userPoolId: string;
    label: string;
    active: boolean;
    allowCorePoolFallback: boolean;
    supported: boolean;
  };
  vaiDebt: ExactAmount;
  protocolSnapshot: {
    borrowingPower: VenusRiskResult;
    liquidationRisk: VenusRiskResult;
    borrowingPowerCheck: VenusProtocolCheck;
    liquidationCheck: VenusProtocolCheck;
  } | null;
  fullyAccruedEstimate: {
    borrowingPower: VenusRiskResult;
    liquidationRisk: VenusRiskResult;
    kind: "fully_accrued_estimate";
  } | null;
  /** Conservative scheduler input, never transaction authority. */
  wakeRiskHealthFactor: ExactAmount | null;
  wakeRiskStatus: "available" | "unavailable";
  economicLiquidationCondition: {
    protocolShortfall: boolean;
    forcedMarket: boolean;
    forcedVai: boolean;
    effective: boolean;
  };
  positions: VenusAccountPosition[];
  unavailable: VenusUnavailable[];
}

export interface VenusActionPauses {
  mint: boolean;
  redeem: boolean;
  borrow: boolean;
  repay: boolean;
  seize: boolean;
  liquidate: boolean;
  transfer: boolean;
  enterMarket: boolean;
  exitMarket: boolean;
}

export interface VenusCoreMarket {
  vToken: string;
  vTokenSymbol: string;
  vTokenDecimals: number;
  underlying: { address: string | null; symbol: string; decimals: number; native: boolean };
  listed: boolean;
  borrowAllowed: boolean;
  poolId: string;
  coreFactors: VenusMarketFactors;
  prices: VenusPriceSet;
  supplyCap: ExactAmount;
  borrowCap: ExactAmount;
  supplyHeadroom: ExactAmount;
  borrowHeadroom: ExactAmount;
  forcedLiquidation: boolean;
  actionPaused: VenusActionPauses;
  supplyRatePerBlock: ExactAmount;
  borrowRatePerBlock: ExactAmount;
  supplyApyPct: number;
  borrowApyPct: number;
  cash: ExactAmount;
  totalSupply: ExactAmount;
  totalBorrows: ExactAmount;
  totalReserves: ExactAmount;
  exchangeRateStored: ExactAmount;
  reserveFactor: ExactAmount;
  xvsSupplySpeed: ExactAmount;
  xvsBorrowSpeed: ExactAmount;
}

export interface VenusEModeMarket {
  vToken: string;
  listed: boolean;
  borrowAllowed: boolean;
  factors: VenusMarketFactors;
}

export interface VenusEModePool {
  poolId: string;
  label: string;
  active: boolean;
  allowCorePoolFallback: boolean;
  markets: VenusEModeMarket[];
}

export interface VenusCoreMarketsSnapshotV1 {
  schemaVersion: 1;
  chainId: typeof VENUS_CHAIN_ID;
  pool: "core";
  block: VenusBlockRef;
  observedAt: number;
  contracts: VenusContracts;
  protocolPaused: boolean;
  vai: { mintPaused: boolean; repayPaused: boolean };
  markets: VenusCoreMarket[];
  eModePools: VenusEModePool[];
}

export interface VenusRewardObservation {
  mechanism: "xvs" | "prime-v2";
  distributor: string;
  rewardToken: string;
  rewardTokenSymbol: string;
  rewardTokenDecimals: number;
  vToken: string | null;
  markets: Array<{ vToken: string; entitlement: ExactAmount }>;
  entitlement: ExactAmount;
  payoutNow: ExactAmount;
  remainingAfterSimulatedClaim: ExactAmount;
  claimAvailable: boolean;
  claimStatus: "available" | "zero" | VenusUnavailableCode;
}

export interface VenusCoreRewardsSnapshotV2 {
  schemaVersion: 2;
  chainId: typeof VENUS_CHAIN_ID;
  pool: "core";
  owner: string;
  status: VenusObservationStatus;
  block: VenusBlockRef;
  observedAt: number;
  contracts: VenusContracts;
  primeHolder: boolean;
  rewards: VenusRewardObservation[];
  unavailable: VenusUnavailable[];
}

export function exact(value: bigint, decimals: number): ExactAmount {
  return { value: value.toString(), decimals };
}

export function exactValue(value: ExactAmount): bigint {
  return BigInt(value.value);
}
