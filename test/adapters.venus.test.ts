import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  VENUS_COMPTROLLER,
  computeVenusHealth,
  isHotTier,
  venusTier,
  type VenusMarketRead,
} from "../src/adapters/venus.js";
import { AdapterError } from "../src/adapters/http.js";
import { fetchVenusHealth } from "../src/adapters/venus.js";

const OWNER = "0xD8D6EA18FE17B0B1D0D873E547907B6EEAC962FA";
const LOWER = OWNER.toLowerCase();

/*
 * Fixture scaling, straight from the Venus contracts:
 *   vTokenBalance        — always 8 decimals
 *   exchangeRateMantissa — scaled 1e(18 + underlyingDecimals - 8)
 *   underlyingPrice      — scaled 1e(36 - underlyingDecimals)
 *   collateralFactor     — scaled 1e18
 *
 * so that:
 *   supplyUsd = vTokenBalance * exchangeRate / 1e18 * price / 1e18   (1e18-scaled)
 *   borrowUsd = borrowBalance * price / 1e18                        (1e18-scaled)
 */

/**
 * 1,000 USDC supplied at $1.00, collateral factor 0.80.
 *
 * underlying = 1e11 * 1e28 / 1e18 = 1e21          -> 1,000 USDC (18 decimals)
 * supplyUsd  = 1e21 * 1e18 / 1e18 = 1e21          -> $1,000
 * collateral = 1e21 * 0.8e18 / 1e18 = 8e20        -> $800
 */
const USDC_COLLATERAL: VenusMarketRead = {
  symbol: "vUSDC",
  vTokenBalance: 100_000_000_000n, // 1,000 vTokens at 8 decimals
  borrowBalance: 0n,
  exchangeRateMantissa: 10n ** 28n,
  collateralFactorMantissa: 800_000_000_000_000_000n, // 0.80
  underlyingPrice: 10n ** 18n, // $1.00, 18-decimal underlying
};

/**
 * 0.01 BTCB borrowed at $50,000.
 *
 * borrowUsd = 1e16 * 5e22 / 1e18 = 5e20           -> $500
 */
const BTC_BORROW: VenusMarketRead = {
  symbol: "vBTC",
  vTokenBalance: 0n,
  borrowBalance: 10_000_000_000_000_000n, // 0.01 BTCB at 18 decimals
  exchangeRateMantissa: 10n ** 28n,
  collateralFactorMantissa: 700_000_000_000_000_000n, // 0.70
  underlyingPrice: 50_000n * 10n ** 18n, // $50,000
};

describe("venusTier", () => {
  it("treats a borrow-free account as healthy", () => {
    assert.equal(venusTier(null), "HEALTHY");
  });

  it("bands each boundary on the safe side", () => {
    assert.equal(venusTier(2), "HEALTHY");
    assert.equal(venusTier(1.5), "HEALTHY");
    assert.equal(venusTier(1.4999), "WARNING");
    assert.equal(venusTier(1.15), "WARNING");
    assert.equal(venusTier(1.1499), "DANGER");
    assert.equal(venusTier(1), "DANGER");
    assert.equal(venusTier(0.9999), "LIQUIDATABLE");
    assert.equal(venusTier(0), "LIQUIDATABLE");
  });

  it("marks only DANGER and worse as needing the fast loop", () => {
    assert.equal(isHotTier("HEALTHY"), false);
    assert.equal(isHotTier("WARNING"), false);
    assert.equal(isHotTier("DANGER"), true);
    assert.equal(isHotTier("LIQUIDATABLE"), true);
  });
});

describe("computeVenusHealth", () => {
  it("computes collateral, borrows and the health factor from a known fixture", () => {
    // $800 weighted collateral / $500 borrowed = 1.6
    const health = computeVenusHealth(OWNER, [USDC_COLLATERAL, BTC_BORROW], 1_700_000_000_000);

    assert.equal(health.owner, LOWER);
    assert.equal(health.collateralValueUsd, 800);
    assert.equal(health.borrowValueUsd, 500);
    assert.equal(health.healthFactor, 1.6);
    assert.equal(health.tier, "HEALTHY");
    assert.equal(health.asOf, 1_700_000_000_000);

    assert.deepEqual(health.assets, [
      { symbol: "vUSDC", supplyUsd: 1000, borrowUsd: 0 },
      { symbol: "vBTC", supplyUsd: 0, borrowUsd: 500 },
    ]);
  });

  it("is decimals-agnostic, because the oracle price absorbs the scaling", () => {
    // The same 0.01 BTC at $50,000, expressed with an 8-decimal underlying:
    // price scales to 1e(36-8) = 1e28, balance to 1e6. 1e6 * 5e32 / 1e18 = 5e20.
    const eightDecimals: VenusMarketRead = {
      symbol: "vBTC8",
      vTokenBalance: 0n,
      borrowBalance: 1_000_000n, // 0.01 at 8 decimals
      exchangeRateMantissa: 10n ** 18n,
      collateralFactorMantissa: 700_000_000_000_000_000n,
      underlyingPrice: 50_000n * 10n ** 28n,
    };

    const eighteen = computeVenusHealth(OWNER, [BTC_BORROW], 0);
    const eight = computeVenusHealth(OWNER, [eightDecimals], 0);
    assert.equal(eight.borrowValueUsd, eighteen.borrowValueUsd);
    assert.equal(eight.borrowValueUsd, 500);
  });

  it("reports a null health factor when nothing is borrowed", () => {
    const health = computeVenusHealth(OWNER, [USDC_COLLATERAL], 0);
    assert.equal(health.healthFactor, null);
    assert.equal(health.tier, "HEALTHY");
    assert.equal(health.borrowValueUsd, 0);
    assert.equal(health.collateralValueUsd, 800);
  });

  it("crosses into DANGER when the borrow approaches the collateral", () => {
    // $800 collateral / $750 borrowed = 1.0666..., inside [1.0, 1.15)
    const health = computeVenusHealth(
      OWNER,
      [USDC_COLLATERAL, { ...BTC_BORROW, borrowBalance: 15_000_000_000_000_000n }],
      0,
    );
    assert.equal(health.borrowValueUsd, 750);
    assert.equal(health.tier, "DANGER");
    assert.ok(health.healthFactor !== null && Math.abs(health.healthFactor - 1.066666) < 1e-5);
  });

  it("is LIQUIDATABLE once borrows exceed weighted collateral", () => {
    // $800 collateral / $1,000 borrowed = 0.8
    const health = computeVenusHealth(
      OWNER,
      [USDC_COLLATERAL, { ...BTC_BORROW, borrowBalance: 20_000_000_000_000_000n }],
      0,
    );
    assert.equal(health.borrowValueUsd, 1000);
    assert.equal(health.healthFactor, 0.8);
    assert.equal(health.tier, "LIQUIDATABLE");
  });

  it("applies each market's own collateral factor", () => {
    // Same $1,000 supplied at 0.70 instead of 0.80 weights to $700, not $800.
    const health = computeVenusHealth(
      OWNER,
      [{ ...USDC_COLLATERAL, collateralFactorMantissa: 700_000_000_000_000_000n }],
      0,
    );
    assert.equal(health.collateralValueUsd, 700);
  });

  it("ignores a market the owner entered but never used", () => {
    const empty: VenusMarketRead = { ...USDC_COLLATERAL, vTokenBalance: 0n };
    const health = computeVenusHealth(OWNER, [empty, BTC_BORROW], 0);
    assert.deepEqual(
      health.assets.map((asset) => asset.symbol),
      ["vBTC"],
    );
  });

  it("returns an empty healthy position for an owner in no markets", () => {
    const health = computeVenusHealth(OWNER, [], 0);
    assert.deepEqual(health.assets, []);
    assert.equal(health.collateralValueUsd, 0);
    assert.equal(health.borrowValueUsd, 0);
    assert.equal(health.healthFactor, null);
    assert.equal(health.tier, "HEALTHY");
  });

  it("keeps full precision on values far beyond Number's integer range", () => {
    // 1,000 BTC at $50,000 = $50,000,000 of supply from a single market.
    const whale: VenusMarketRead = {
      symbol: "vBTC",
      vTokenBalance: 100_000_000_000n,
      borrowBalance: 0n,
      exchangeRateMantissa: 10n ** 28n,
      collateralFactorMantissa: 10n ** 18n,
      underlyingPrice: 50_000n * 10n ** 18n,
    };
    const health = computeVenusHealth(OWNER, [whale], 0);
    assert.equal(health.collateralValueUsd, 50_000_000);
  });
});

describe("fetchVenusHealth", () => {
  it("pins the Core Pool Unitroller from the Venus deployment manifest", () => {
    assert.equal(VENUS_COMPTROLLER, "0xfD36E2c2a6789Db23113685031d7F16329158384");
  });

  it("rejects a malformed owner before any network call", async () => {
    await assert.rejects(
      () => fetchVenusHealth({ owner: "not-an-address", rpcUrls: [] }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterError);
        assert.match(error.message, /invalid owner address/u);
        return true;
      },
    );
  });

  it("fails with a sanitized error when no endpoint is configured", async () => {
    await assert.rejects(
      () => fetchVenusHealth({ owner: OWNER, rpcUrls: [] }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterError);
        assert.match(error.message, /no rpc endpoint configured/u);
        return true;
      },
    );
  });
});
