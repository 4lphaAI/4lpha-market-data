import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyTokenSnapshot, mergeTokenSnapshot, type TokenSnapshot } from "../src/core/models.js";

function base(overrides: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    ...emptyTokenSnapshot("0xAbC0000000000000000000000000000000000001"),
    priceUsd: 2,
    marketCapUsd: 2_000,
    volume24hUsd: 500,
    holders: 120,
    priceChange24hPct: 5,
    symbol: "ABC",
    ...overrides,
  };
}

describe("emptyTokenSnapshot", () => {
  it("lowercases the address and nulls every metric", () => {
    const snapshot = emptyTokenSnapshot("0xAB0000000000000000000000000000000000000F");
    assert.equal(snapshot.address, "0xab0000000000000000000000000000000000000f");
    assert.equal(snapshot.priceUsd, null);
    assert.equal(snapshot.marketCapUsd, null);
    assert.equal(snapshot.volume24hUsd, null);
    assert.equal(snapshot.holders, null);
    assert.equal(snapshot.priceChange24hPct, null);
    assert.deepEqual(snapshot.updatedFields, []);
  });
});

describe("mergeTokenSnapshot", () => {
  it("never lets null or undefined overwrite a known value", () => {
    const merged = mergeTokenSnapshot(base(), {
      priceUsd: null,
      marketCapUsd: null,
      volume24hUsd: null,
      holders: null,
      priceChange24hPct: null,
    });

    assert.equal(merged.priceUsd, 2);
    assert.equal(merged.marketCapUsd, 2_000);
    assert.equal(merged.volume24hUsd, 500);
    assert.equal(merged.holders, 120);
    assert.equal(merged.priceChange24hPct, 5);
    assert.deepEqual(merged.updatedFields, []);
  });

  it("rejects implausible zeros for price, market cap and holders", () => {
    const merged = mergeTokenSnapshot(base(), {
      priceUsd: 0,
      marketCapUsd: 0,
      holders: 0,
    });

    assert.equal(merged.priceUsd, 2);
    assert.equal(merged.marketCapUsd, 2_000);
    assert.equal(merged.holders, 120);
    assert.deepEqual(merged.updatedFields, []);
  });

  it("accepts plausible zeros for volume and price change", () => {
    const merged = mergeTokenSnapshot(base(), {
      volume24hUsd: 0,
      priceChange24hPct: 0,
    });

    assert.equal(merged.volume24hUsd, 0);
    assert.equal(merged.priceChange24hPct, 0);
    assert.deepEqual(merged.updatedFields.sort(), ["priceChange24hPct", "volume24hUsd"]);
  });

  it("accepts negative price change but not a negative price", () => {
    const merged = mergeTokenSnapshot(base(), { priceChange24hPct: -12.5, priceUsd: -1 });
    assert.equal(merged.priceChange24hPct, -12.5);
    assert.equal(merged.priceUsd, 2);
  });

  it("rejects NaN and Infinity from a broken provider", () => {
    const merged = mergeTokenSnapshot(base(), {
      priceUsd: Number.NaN,
      volume24hUsd: Number.POSITIVE_INFINITY,
    });
    assert.equal(merged.priceUsd, 2);
    assert.equal(merged.volume24hUsd, 500);
  });

  it("overwrites with better values and reports them in updatedFields", () => {
    const merged = mergeTokenSnapshot(base(), { priceUsd: 3.5, holders: 130 });
    assert.equal(merged.priceUsd, 3.5);
    assert.equal(merged.holders, 130);
    assert.deepEqual(merged.updatedFields.sort(), ["holders", "priceUsd"]);
  });

  it("fills a null base field from an incoming value", () => {
    const merged = mergeTokenSnapshot(base({ holders: null }), { holders: 9 });
    assert.equal(merged.holders, 9);
  });

  it("only takes a non-empty trimmed symbol", () => {
    assert.equal(mergeTokenSnapshot(base(), { symbol: "   " }).symbol, "ABC");
    assert.equal(mergeTokenSnapshot(base(), { symbol: " XYZ " }).symbol, "XYZ");
  });

  it("keeps the base address and backfills an empty one", () => {
    const kept = mergeTokenSnapshot(base(), {
      address: "0xffffffffffffffffffffffffffffffffffffffff",
    });
    assert.equal(kept.address, "0xabc0000000000000000000000000000000000001");

    const backfilled = mergeTokenSnapshot(
      { ...emptyTokenSnapshot(""), address: "" },
      { address: "0xFFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfF" },
    );
    assert.equal(backfilled.address, "0xffffffffffffffffffffffffffffffffffffffff");
  });

  it("resets updatedFields on every merge rather than accumulating", () => {
    const first = mergeTokenSnapshot(base(), { priceUsd: 9 });
    assert.deepEqual(first.updatedFields, ["priceUsd"]);
    const second = mergeTokenSnapshot(first, { holders: 500 });
    assert.deepEqual(second.updatedFields, ["holders"]);
  });

  it("does not mutate the base snapshot", () => {
    const original = base();
    mergeTokenSnapshot(original, { priceUsd: 99 });
    assert.equal(original.priceUsd, 2);
  });
});
