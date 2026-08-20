import type { VenusRiskResult } from "../core/venus.js";
import { exact } from "../core/venus.js";

const E18 = 10n ** 18n;

/** Inputs are raw values exactly as returned by Venus contracts. */
export interface VenusRiskMarketInput {
  collateralMember: boolean;
  vTokenBalance: bigint;
  exchangeRate: bigint;
  borrowBalance: bigint;
  collateralFactor: bigint;
  liquidationThreshold: bigint;
  collateralPrice: bigint;
  debtPrice: bigint;
  spotPrice: bigint;
}

export interface VenusRiskPair {
  borrowingPower: VenusRiskResult;
  liquidationRisk: VenusRiskResult;
}

/** Mirrors ExponentialNoError.mul_ and truncates at every Solidity Exp multiplication. */
function mulExp(left: bigint, right: bigint): bigint {
  return (left * right) / E18;
}

function collateralValue(
  balance: bigint,
  exchangeRate: bigint,
  factor: bigint,
  price: bigint,
): bigint {
  const factorTimesExchange = mulExp(factor, exchangeRate);
  const tokensToDenom = mulExp(factorTimesExchange, price);
  return (tokensToDenom * balance) / E18;
}

function debtValue(balance: bigint, price: bigint): bigint {
  return (price * balance) / E18;
}

function result(collateral: bigint, debt: bigint): VenusRiskResult {
  const difference = collateral >= debt ? collateral - debt : debt - collateral;
  return {
    collateral: exact(collateral, 18),
    debt: exact(debt, 18),
    liquidity: exact(collateral >= debt ? difference : 0n, 18),
    shortfall: exact(debt > collateral ? difference : 0n, 18),
    healthFactor: debt === 0n ? null : exact((collateral * E18) / debt, 18),
  };
}

/**
 * Reconstructs both current Core Comptroller weighting strategies.
 * VAI repay amount is already 1e18-denominated and is debt in both paths.
 */
export function calculateVenusRisk(
  markets: VenusRiskMarketInput[],
  vaiRepayAmount: bigint,
): VenusRiskPair {
  let cfCollateral = 0n;
  let cfDebt = vaiRepayAmount;
  let ltCollateral = 0n;
  let ltDebt = vaiRepayAmount;

  for (const market of markets) {
    if (market.collateralMember) {
      cfCollateral += collateralValue(
        market.vTokenBalance,
        market.exchangeRate,
        market.collateralFactor,
        market.collateralPrice,
      );
      ltCollateral += collateralValue(
        market.vTokenBalance,
        market.exchangeRate,
        market.liquidationThreshold,
        market.spotPrice,
      );
    }
    cfDebt += debtValue(market.borrowBalance, market.debtPrice);
    ltDebt += debtValue(market.borrowBalance, market.spotPrice);
  }

  return {
    borrowingPower: result(cfCollateral, cfDebt),
    liquidationRisk: result(ltCollateral, ltDebt),
  };
}

export function conservativeHealthFactor(
  stored: VenusRiskResult,
  accrued: VenusRiskResult | null,
): { value: string; decimals: number } | null {
  const first = stored.healthFactor;
  const second = accrued?.healthFactor ?? null;
  if (first === null) return second;
  if (second === null) return first;
  return BigInt(first.value) <= BigInt(second.value) ? first : second;
}

export function riskMatchesProtocol(
  risk: VenusRiskResult,
  errorCode: bigint,
  liquidity: bigint,
  shortfall: bigint,
): boolean {
  return (
    errorCode === 0n &&
    BigInt(risk.liquidity.value) === liquidity &&
    BigInt(risk.shortfall.value) === shortfall
  );
}
