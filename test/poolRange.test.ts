import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStore } from "../src/core/store.js";
import type { PoolRangeInputs } from "../src/adapters/pancake.js";
import {
  type RangeBasis,
  amountsForLiquidity,
  estimateRange,
  loadRangeSnapshot,
  priceToTick,
  rangeKey,
  snapTick,
  sqrtRatioAtTick,
  tickToPrice,
} from "../src/query/poolRange.js";
import { fakeFetch, jsonResponse, textResponse } from "./helpers.js";

const POOL = "0x172fcd41e0913e95784454622d1c3724f546f849";
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";

/**
 * 2^96 written out. `String(2 ** 96)` yields exponential notation, which is not
 * a decimal integer and is rejected on the way in — the same trap a payload
 * carrying a stringified float would spring.
 */
const Q96 = "79228162514264337593543950336";

/** A pool priced at exactly 1.0, so every expectation can be reasoned about. */
function inputs(overrides: Partial<PoolRangeInputs> = {}): PoolRangeInputs {
  return {
    pool: POOL,
    fee: 500,
    tickSpacing: 10,
    sqrtPriceX96: Q96,
    // Deep enough that a $10k position is a rounding error against it, which is
    // the regime the concentration comparisons are meant to describe.
    liquidity: "10000000000000000000000000000",
    tick: 0,
    tvlUsd: 100_000_000,
    token0: { address: USDT, symbol: "USDT", decimals: 18 },
    token1: { address: WBNB, symbol: "WBNB", decimals: 18 },
    ...overrides,
  };
}

const BASIS: RangeBasis = { lpFeeApr24h: 10, lpFeeApr7d: 8, tvlUsd: 100_000_000 };
const PRICES = { token0Usd: 1, token1Usd: 1 };

describe("tick arithmetic", () => {
  it("round-trips a price through its tick", () => {
    for (const price of [0.5, 1, 1.0001, 600, 0.0016528]) {
      const tick = priceToTick(price, 18, 18);
      assert.ok(Math.abs(tickToPrice(tick, 18, 18) / price - 1) < 1e-9, `price ${price}`);
    }
  });

  it("takes the decimal difference out before the logarithm", () => {
    // A human price of 1.0 between an 18-decimal and a 6-decimal token is a
    // raw price of 1e-12; reading it as 1.0 would place the range 12 orders of
    // magnitude away from where the caller asked for it.
    const withDecimals = priceToTick(1, 18, 6);
    const naive = priceToTick(1, 18, 18);
    assert.equal(naive, 0);
    assert.ok(withDecimals < -270_000, `expected a deeply negative tick, got ${withDecimals}`);
    assert.ok(Math.abs(tickToPrice(withDecimals, 18, 6) - 1) < 1e-6);
  });

  it("snaps onto the fee tier's grid, outward in both directions", () => {
    assert.equal(snapTick(105, 10, "down"), 100);
    assert.equal(snapTick(105, 10, "up"), 110);
    assert.equal(snapTick(-105, 10, "down"), -110);
    assert.equal(snapTick(-105, 10, "up"), -100);
    assert.equal(snapTick(100, 10, "down"), 100);
  });

  it("clamps to the protocol's own tick bounds", () => {
    assert.equal(snapTick(5_000_000, 200, "up"), 887_272);
    assert.equal(snapTick(-5_000_000, 200, "down"), -887_272);
  });

  it("agrees with the sqrt ratio it is paired with", () => {
    assert.ok(Math.abs(sqrtRatioAtTick(0) - 1) < 1e-12);
    assert.ok(Math.abs(sqrtRatioAtTick(200) ** 2 - 1.0001 ** 200) < 1e-9);
  });
});

describe("amountsForLiquidity", () => {
  const sqrtA = sqrtRatioAtTick(-1000);
  const sqrtB = sqrtRatioAtTick(1000);

  it("holds only token0 below the range", () => {
    const { amount0Raw, amount1Raw } = amountsForLiquidity(sqrtA * 0.9, sqrtA, sqrtB, 1);
    assert.ok(amount0Raw > 0);
    assert.equal(amount1Raw, 0);
  });

  it("holds only token1 above the range", () => {
    const { amount0Raw, amount1Raw } = amountsForLiquidity(sqrtB * 1.1, sqrtA, sqrtB, 1);
    assert.equal(amount0Raw, 0);
    assert.ok(amount1Raw > 0);
  });

  it("holds both inside, and scales linearly with liquidity", () => {
    const one = amountsForLiquidity(1, sqrtA, sqrtB, 1);
    const ten = amountsForLiquidity(1, sqrtA, sqrtB, 10);
    assert.ok(one.amount0Raw > 0 && one.amount1Raw > 0);
    assert.ok(Math.abs(ten.amount0Raw / one.amount0Raw - 10) < 1e-9);
    assert.ok(Math.abs(ten.amount1Raw / one.amount1Raw - 10) < 1e-9);
  });
});

describe("estimateRange", () => {
  it("builds a position worth exactly the capital asked for", () => {
    for (const [lower, upper] of [
      [0.5, 2],
      [0.98, 1.02],
      [0.999, 1.001],
    ]) {
      const estimate = estimateRange(
        inputs(),
        { lowerPrice: lower ?? 0, upperPrice: upper ?? 0, capitalUsd: 10_000 },
        PRICES,
        BASIS,
      );
      const value =
        (estimate.position.amount0 ?? 0) * PRICES.token0Usd +
        (estimate.position.amount1 ?? 0) * PRICES.token1Usd;
      assert.ok(Math.abs(value / 10_000 - 1) < 1e-9, `range ${lower}-${upper} valued ${value}`);
    }
  });

  it("earns more from the same capital as the range narrows", () => {
    const wide = estimateRange(
      inputs(),
      { lowerPrice: 0.5, upperPrice: 2, capitalUsd: 10_000 },
      PRICES,
      BASIS,
    );
    const tight = estimateRange(
      inputs(),
      { lowerPrice: 0.99, upperPrice: 1.01, capitalUsd: 10_000 },
      PRICES,
      BASIS,
    );

    assert.ok((tight.concentrationMultiplier ?? 0) > (wide.concentrationMultiplier ?? 0) * 5);
    assert.ok((tight.estimatedAprPct ?? 0) > (wide.estimatedAprPct ?? 0) * 5);

    // The pool's own APR is the yardstick: a position earns it scaled by how
    // much more liquidity per dollar it holds than the pool average. Pinning
    // that identity is what keeps the estimate anchored to the number that was
    // verified against PancakeSwap's UI, rather than drifting into its own.
    for (const estimate of [wide, tight]) {
      const expected = 10 * (estimate.concentrationMultiplier ?? 0);
      assert.ok(
        Math.abs((estimate.estimatedAprPct ?? 0) / expected - 1) < 1e-3,
        `apr ${String(estimate.estimatedAprPct)} vs poolApr x multiplier ${expected}`,
      );
    }
  });

  it("beats the pool's own APR once the range is tighter than its average", () => {
    const estimate = estimateRange(
      inputs(),
      { lowerPrice: 0.999, upperPrice: 1.001, capitalUsd: 10_000 },
      PRICES,
      BASIS,
    );
    assert.ok((estimate.concentrationMultiplier ?? 0) > 1);
    assert.ok((estimate.estimatedAprPct ?? 0) > BASIS.lpFeeApr24h!);
  });

  it("reports a real zero for a range the price is not inside", () => {
    const estimate = estimateRange(
      inputs(),
      { lowerPrice: 1.5, upperPrice: 2, capitalUsd: 10_000 },
      PRICES,
      BASIS,
    );
    assert.equal(estimate.inRange, false);
    assert.equal(estimate.estimatedAprPct, 0);
    assert.equal(estimate.feeSharePct, 0);
    // Still says what the position would consist of — it is placeable, just idle.
    assert.ok((estimate.position.amount0 ?? 0) > 0);
    assert.equal(estimate.position.amount1, 0);
  });

  it("dilutes a position large next to the pool it joins", () => {
    const small = estimateRange(
      inputs(),
      { lowerPrice: 0.99, upperPrice: 1.01, capitalUsd: 1_000 },
      PRICES,
      BASIS,
    );
    const huge = estimateRange(
      inputs(),
      { lowerPrice: 0.99, upperPrice: 1.01, capitalUsd: 100_000_000 },
      PRICES,
      BASIS,
    );

    // Share cannot exceed the whole pool, however much capital is thrown at it.
    assert.ok((huge.feeSharePct ?? 0) < 100);
    // And the APR per dollar has to fall, because the fees are not growing.
    assert.ok((huge.estimatedAprPct ?? 0) < (small.estimatedAprPct ?? 0));
  });

  it("snaps the requested bounds onto the grid and says where they landed", () => {
    const estimate = estimateRange(
      inputs({ tickSpacing: 50, fee: 2500 }),
      { lowerPrice: 0.99, upperPrice: 1.01, capitalUsd: 10_000 },
      PRICES,
      BASIS,
    );
    assert.equal(Math.abs(estimate.ticks.lower % 50), 0);
    assert.equal(Math.abs(estimate.ticks.upper % 50), 0);
    // Snapping is outward, so the placeable range always contains the asked one.
    assert.ok(estimate.prices.lower <= 0.99);
    assert.ok(estimate.prices.upper >= 1.01);
    assert.deepEqual(estimate.requested, {
      lowerPrice: 0.99,
      upperPrice: 1.01,
      capitalUsd: 10_000,
    });
  });

  it("names the input it is missing instead of guessing a number", () => {
    const noPrice = estimateRange(
      inputs(),
      { lowerPrice: 0.99, upperPrice: 1.01, capitalUsd: 10_000 },
      { token0Usd: null, token1Usd: 1 },
      BASIS,
    );
    assert.equal(noPrice.position.liquidity, null);
    assert.equal(noPrice.estimatedAprPct, null);
    assert.ok(noPrice.unavailable.some((entry) => entry.includes("USDT")));
    // The parts that need no price are still answered.
    assert.equal(noPrice.inRange, true);
    assert.ok(noPrice.ticks.lower < noPrice.ticks.upper);

    const noApr = estimateRange(
      inputs(),
      { lowerPrice: 0.99, upperPrice: 1.01, capitalUsd: 10_000 },
      PRICES,
      { lpFeeApr24h: null, lpFeeApr7d: null, tvlUsd: 1_000_000 },
    );
    assert.equal(noApr.estimatedAprPct, null);
    assert.ok((noApr.position.liquidity ?? 0) > 0);
    assert.ok(noApr.unavailable.includes("pool fee APR"));
  });

  it("always states what it assumed", () => {
    const estimate = estimateRange(
      inputs(),
      { lowerPrice: 0.99, upperPrice: 1.01, capitalUsd: 10_000 },
      PRICES,
      BASIS,
    );
    assert.ok(estimate.assumptions.length >= 3);
    assert.ok(estimate.assumptions.some((a) => a.includes("impermanent loss")));
  });
});

describe("loadRangeSnapshot", () => {
  const poolBody = {
    id: POOL,
    token0: { id: USDT, symbol: "USDT", decimals: 18 },
    token1: { id: WBNB, symbol: "WBNB", decimals: 18 },
    feeTier: 500,
    liquidity: "10000000000000000000000000000",
    sqrtPrice: Q96,
    tick: 0,
    tvlUSD: "100000000",
  };

  function explorer(): ReturnType<typeof fakeFetch> {
    return fakeFetch((call) => {
      if (call.url.includes("/pools/apr/")) return jsonResponse({ apr24h: "0.1", apr7d: "0.08" });
      if (call.url.includes("/tokens/price/list/")) {
        return jsonResponse({ [`56:${USDT}`]: { priceUSD: "1" }, [`56:${WBNB}`]: { priceUSD: "600" } });
      }
      return jsonResponse(poolBody);
    });
  }

  it("reads the pool, its APR and both token prices, then caches them together", async () => {
    const store = new MemoryStore();
    const fake = explorer();
    const loaded = await loadRangeSnapshot(store, POOL, { fetchFn: fake.fetch });

    assert.equal(loaded.snapshot.inputs.tickSpacing, 10);
    assert.equal(loaded.snapshot.basis.lpFeeApr24h, 10);
    assert.equal(loaded.snapshot.prices.token1Usd, 600);
    assert.notEqual(await store.get(rangeKey(POOL)), null);

    // A second range on the same pool is a second question about one set of
    // facts, and must not pay for them again.
    const calls = fake.calls.length;
    const again = await loadRangeSnapshot(store, POOL, { fetchFn: fake.fetch });
    assert.equal(fake.calls.length, calls);
    assert.equal(again.staleness, "fresh");
  });

  it("serves the aged copy when the refresh fails", async () => {
    let now = 1_000_000;
    const store = new MemoryStore(() => now);
    await loadRangeSnapshot(store, POOL, { fetchFn: explorer().fetch });

    now += 600_000;
    const loaded = await loadRangeSnapshot(store, POOL, {
      fetchFn: fakeFetch(() => textResponse("gateway", 502)).fetch,
    });
    assert.equal(loaded.snapshot.inputs.pool, POOL);
    assert.notEqual(loaded.staleness, "fresh");
  });

  it("propagates the failure when there is nothing stored to fall back on", async () => {
    const store = new MemoryStore();
    await assert.rejects(
      () => loadRangeSnapshot(store, POOL, { fetchFn: fakeFetch(() => textResponse("x", 500)).fetch }),
      /upstream responded 500/u,
    );
  });

  it("refuses a pool with no price rather than dividing by it", async () => {
    const store = new MemoryStore();
    const fake = fakeFetch((call) =>
      call.url.includes("/pools/v3/")
        ? jsonResponse({ ...poolBody, sqrtPrice: "0" })
        : jsonResponse({}),
    );
    await assert.rejects(
      () => loadRangeSnapshot(store, POOL, { fetchFn: fake.fetch }),
      /pool has no price/u,
    );
  });

  it("keeps the estimate alive when only the token prices are missing", async () => {
    const store = new MemoryStore();
    const fake = fakeFetch((call) => {
      if (call.url.includes("/pools/apr/")) return jsonResponse({ apr24h: "0.1", apr7d: "0.08" });
      if (call.url.includes("/tokens/price/list/")) return textResponse("nope", 500);
      return jsonResponse(poolBody);
    });

    const loaded = await loadRangeSnapshot(store, POOL, { fetchFn: fake.fetch });
    assert.equal(loaded.snapshot.prices.token0Usd, null);
    assert.equal(loaded.snapshot.basis.lpFeeApr24h, 10);
  });
});
