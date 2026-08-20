import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { interpretXvsClaimSimulation } from "../src/adapters/venusCore.js";
import { MemoryStore } from "../src/core/store.js";
import { calculateVenusRisk, conservativeHealthFactor, riskMatchesProtocol } from "../src/query/venusRisk.js";

const E18 = 10n ** 18n;

describe("Venus v2 exact risk math", () => {
  it("separates the bounded-CF borrowing path from the spot-LT liquidation path", () => {
    const risk = calculateVenusRisk([{
      collateralMember: true,
      vTokenBalance: 100n * E18,
      exchangeRate: E18,
      borrowBalance: 50n * E18,
      collateralFactor: 800_000_000_000_000_000n,
      liquidationThreshold: 900_000_000_000_000_000n,
      collateralPrice: 900_000_000_000_000_000n,
      debtPrice: 1_100_000_000_000_000_000n,
      spotPrice: E18,
    }], 0n);

    assert.equal(risk.borrowingPower.collateral.value, (72n * E18).toString());
    assert.equal(risk.borrowingPower.debt.value, (55n * E18).toString());
    assert.equal(risk.liquidationRisk.collateral.value, (90n * E18).toString());
    assert.equal(risk.liquidationRisk.debt.value, (50n * E18).toString());
  });

  it("does not count a supplied market outside getAssetsIn as collateral", () => {
    const risk = calculateVenusRisk([{
      collateralMember: false,
      vTokenBalance: 1_000n * E18,
      exchangeRate: E18,
      borrowBalance: 0n,
      collateralFactor: E18,
      liquidationThreshold: E18,
      collateralPrice: E18,
      debtPrice: E18,
      spotPrice: E18,
    }], 25n * E18);
    assert.equal(risk.borrowingPower.collateral.value, "0");
    assert.equal(risk.borrowingPower.debt.value, (25n * E18).toString());
    assert.equal(risk.borrowingPower.shortfall.value, (25n * E18).toString());
  });

  it("adds VAI debt to both protocol paths and preserves zero-debt as null", () => {
    const withVai = calculateVenusRisk([], 7n * E18);
    assert.equal(withVai.borrowingPower.debt.value, (7n * E18).toString());
    assert.equal(withVai.liquidationRisk.debt.value, (7n * E18).toString());
    assert.equal(calculateVenusRisk([], 0n).liquidationRisk.healthFactor, null);
  });

  it("requires exact protocol equality and uses the conservative health factor", () => {
    const stored = calculateVenusRisk([], 1n * E18).liquidationRisk;
    const accrued = { ...stored, healthFactor: { value: "900000000000000000", decimals: 18 } };
    assert.equal(riskMatchesProtocol(stored, 0n, 0n, 1n * E18), true);
    assert.equal(riskMatchesProtocol(stored, 0n, 0n, 1n * E18 + 1n), false);
    assert.equal(conservativeHealthFactor(stored, accrued)?.value, "0");
  });
});

describe("MemoryStore tracking parity", () => {
  it("caps distinct subjects but reference-counts one subject", async () => {
    const store = new MemoryStore();
    assert.equal((await store.addTrackingReference("venus-core", "a", "one", 1)).accepted, true);
    assert.equal((await store.addTrackingReference("venus-core", "a", "two", 1)).referenceCount, 2);
    assert.equal((await store.addTrackingReference("venus-core", "b", "one", 1)).accepted, false);
    assert.deepEqual(await store.listTrackedSubjects("venus-core"), ["a"]);
    assert.equal((await store.removeTrackingReference("venus-core", "a", "one")).referenceCount, 1);
    assert.equal((await store.removeTrackingReference("venus-core", "a", "two")).referenceCount, 0);
  });

  it("keeps a scheduler lease until its TTL", async () => {
    let now = 100;
    const store = new MemoryStore(() => now);
    assert.equal(await store.acquireSchedulerLease("risk", "a", 10), true);
    assert.equal(await store.acquireSchedulerLease("risk", "b", 10), false);
    now = 111;
    assert.equal(await store.acquireSchedulerLease("risk", "b", 10), true);
  });
});

describe("Venus XVS claim simulation semantics", () => {
  it("keeps entitlement, payout-now, and claim availability separate", () => {
    const unavailable = interpretXvsClaimSimulation(10n, 100n, 100n, 10n);
    assert.equal(unavailable.payoutNow.value, "0");
    assert.equal(unavailable.remainingAfterSimulatedClaim.value, "10");
    assert.equal(unavailable.claimAvailable, false);
    assert.equal(unavailable.claimStatus, "insufficient_reward_balance");

    const partial = interpretXvsClaimSimulation(10n, 100n, 106n, 4n);
    assert.equal(partial.payoutNow.value, "6");
    assert.equal(partial.remainingAfterSimulatedClaim.value, "4");
    assert.equal(partial.claimAvailable, true);
    assert.equal(partial.claimStatus, "available");

    const zero = interpretXvsClaimSimulation(0n, 100n, 100n, 0n);
    assert.equal(zero.claimAvailable, false);
    assert.equal(zero.claimStatus, "zero");
  });
});
