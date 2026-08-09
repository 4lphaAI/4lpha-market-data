import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchPancakePoolStats,
  fetchPoolStats,
  normalizeExplorerPool,
  poolKey,
  seedPools,
} from "../src/adapters/pancake.js";
import { fakeFetch, jsonResponse, textResponse } from "./helpers.js";

const POOL = "0xCC2bFfaeC373a6004bb6cCc8a62Cdd66061f7C6a";
const LOWER = POOL.toLowerCase();

/** A live explorer response, trimmed to the fields the normalizer reads. */
const EXPLORER_POOL = {
  id: LOWER,
  token0: {
    id: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436",
    symbol: "NVDAB",
    decimals: 18,
  },
  token1: {
    id: "0x55d398326f99059ff775485246999027b3197955",
    symbol: "USDT",
    decimals: 18,
  },
  feeTier: 500,
  liquidity: "1947475966191175457735",
  sqrtPrice: "1187202354464281119897578974267",
  tick: 54143,
  tvlUSD: "3209.6914354648143",
  volumeUSD24h: "2596.37578719614",
  feeUSD24h: "1.29818789359809",
};

describe("seed pools", () => {
  it("lists the verified V3 pools, lowercased and unique", () => {
    const pools = seedPools();
    assert.equal(pools.length, 6);
    assert.equal(new Set(pools).size, pools.length);
    for (const pool of pools) assert.match(pool, /^0x[0-9a-f]{40}$/u);
  });

  it("returns a fresh array so callers cannot corrupt the static list", () => {
    seedPools().push("0xdeadbeef");
    assert.equal(seedPools().length, 6);
  });

  it("namespaces the store key by pool address", () => {
    assert.equal(poolKey(POOL), `pool:${LOWER}`);
  });
});

describe("normalizeExplorerPool", () => {
  it("maps the explorer payload onto PoolStats", () => {
    const stats = normalizeExplorerPool(POOL, EXPLORER_POOL);
    assert.ok(stats !== null);
    assert.equal(stats.pool, LOWER);
    assert.equal(stats.token0, "0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
    assert.equal(stats.token1, "0x55d398326f99059ff775485246999027b3197955");
    assert.equal(stats.token0Symbol, "NVDAB");
    assert.equal(stats.token1Symbol, "USDT");
    assert.equal(stats.fee, 500);
    assert.equal(stats.liquidity, "1947475966191175457735");
    assert.equal(stats.sqrtPriceX96, "1187202354464281119897578974267");
    assert.equal(stats.tick, 54143);
    assert.equal(stats.source, "pancake");
  });

  it("keeps liquidity and sqrtPrice as strings so no precision is lost", () => {
    const stats = normalizeExplorerPool(POOL, EXPLORER_POOL);
    assert.ok(stats !== null);
    // Both exceed Number.MAX_SAFE_INTEGER; round-tripping must be exact.
    assert.equal(BigInt(stats.liquidity).toString(), "1947475966191175457735");
    assert.equal(BigInt(stats.sqrtPriceX96).toString(), "1187202354464281119897578974267");
  });

  it("annualizes 24h fees over TVL for the APR", () => {
    const stats = normalizeExplorerPool(POOL, EXPLORER_POOL);
    // 1.29818789359809 / 3209.6914354648143 * 365 * 100 = 14.7639...%
    assert.equal(stats?.aprPct, 14.76);
  });

  it("leaves APR null when TVL is dust, rather than reporting a huge number", () => {
    const stats = normalizeExplorerPool(POOL, { ...EXPLORER_POOL, tvlUSD: "0.004" });
    assert.equal(stats?.aprPct, null);
    assert.equal(stats?.tvlUsd, 0.004);
  });

  it("leaves APR null when fees are missing", () => {
    const stats = normalizeExplorerPool(POOL, { ...EXPLORER_POOL, feeUSD24h: undefined });
    assert.equal(stats?.aprPct, null);
  });

  it("keeps a real zero volume distinct from an absent one", () => {
    assert.equal(normalizeExplorerPool(POOL, { ...EXPLORER_POOL, volumeUSD24h: "0" })?.volume24hUsd, 0);
    assert.equal(
      normalizeExplorerPool(POOL, { ...EXPLORER_POOL, volumeUSD24h: null })?.volume24hUsd,
      null,
    );
  });

  it("rejects a payload without the pool identity fields", () => {
    assert.equal(normalizeExplorerPool(POOL, { ...EXPLORER_POOL, token0: null }), null);
    assert.equal(normalizeExplorerPool(POOL, { ...EXPLORER_POOL, feeTier: "n/a" }), null);
    assert.equal(normalizeExplorerPool(POOL, { ...EXPLORER_POOL, liquidity: "1.5e21" }), null);
    assert.equal(normalizeExplorerPool(POOL, null), null);
    assert.equal(normalizeExplorerPool(POOL, [EXPLORER_POOL]), null);
  });

  it("tolerates a missing symbol without losing the pool", () => {
    const stats = normalizeExplorerPool(POOL, {
      ...EXPLORER_POOL,
      token0: { id: EXPLORER_POOL.token0.id },
    });
    assert.equal(stats?.token0Symbol, null);
    assert.equal(stats?.token0, EXPLORER_POOL.token0.id);
  });
});

describe("fetchPancakePoolStats", () => {
  it("requests the cached explorer endpoint with the lowercased address", async () => {
    const fake = fakeFetch(() => jsonResponse(EXPLORER_POOL));
    await fetchPancakePoolStats({ address: POOL, fetchFn: fake.fetch });

    const url = new URL(fake.calls[0]?.url ?? "https://example.invalid");
    assert.equal(url.host, "explorer.pancakeswap.com");
    assert.equal(url.pathname, `/api/cached/pools/v3/bsc/${LOWER}`);
  });

  it("sends no credential header", async () => {
    const fake = fakeFetch(() => jsonResponse(EXPLORER_POOL));
    await fetchPancakePoolStats({ address: POOL, fetchFn: fake.fetch });
    const headers = fake.calls[0]?.headers ?? {};
    assert.equal(headers["x-apikey"], undefined);
    assert.equal(headers["authorization"], undefined);
  });

  it("rejects a payload that is not a pool", async () => {
    const fake = fakeFetch(() => jsonResponse({ message: "internal error" }));
    await assert.rejects(
      () => fetchPancakePoolStats({ address: POOL, fetchFn: fake.fetch }),
      /unexpected pool payload/u,
    );
  });

  it("surfaces an upstream failure as a sanitized error", async () => {
    const fake = fakeFetch(() => textResponse("boom", 500));
    await assert.rejects(
      () => fetchPancakePoolStats({ address: POOL, fetchFn: fake.fetch }),
      /upstream responded 500/u,
    );
  });
});

describe("fetchPoolStats", () => {
  it("serves the explorer result without touching the chain", async () => {
    const fake = fakeFetch(() => jsonResponse(EXPLORER_POOL));
    const stats = await fetchPoolStats({ address: POOL, fetchFn: fake.fetch, rpcUrls: [] });
    assert.equal(stats.source, "pancake");
    assert.equal(stats.tvlUsd, 3209.6914354648143);
  });

  it("reports the explorer failure when the chain fallback also fails", async () => {
    const fake = fakeFetch(() => textResponse("gateway", 502));
    await assert.rejects(
      // An empty endpoint list makes the on-chain path fail immediately.
      () => fetchPoolStats({ address: POOL, fetchFn: fake.fetch, rpcUrls: [] }),
      /upstream responded 502/u,
    );
  });
});
