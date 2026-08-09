import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { MemoryStore } from "../src/core/store.js";
import type { PoolStats, VenusHealth } from "../src/core/models.js";
import { POOLS_INDEX_KEY, SEED_POOLS_KEY, poolKey, seedPools } from "../src/adapters/pancake.js";
import {
  PANCAKE_POOLS_JOB,
  pancakePoolsJob,
  readStoredPools,
  readTrackedPools,
  runPancakePools,
} from "../src/jobs/pancakePools.js";
import {
  TRACKED_VENUS_OWNERS_KEY,
  VENUS_HEALTH_HOT_JOB,
  VENUS_HEALTH_JOB,
  readHotVenusOwners,
  readTrackedVenusOwners,
  runVenusHealth,
  venusHealthHotJob,
  venusHealthJob,
  venusKey,
} from "../src/jobs/venusHealth.js";

const POOL_A = "0xcc2bffaec373a6004bb6ccc8a62cdd66061f7c6a";
const POOL_B = "0x8fb4243b553ac29ba088acf00b9b7da24bd6690c";
const OWNER_A = "0xaa00000000000000000000000000000000000001";
const OWNER_B = "0xbb00000000000000000000000000000000000002";
const TOKEN = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(handler: (url: URL) => Response): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(href);
    return handler(new URL(href));
  }) as typeof globalThis.fetch;
  return seen;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function explorerPool(pool: string, token0: string): Response {
  return json({
    id: pool,
    token0: { id: token0, symbol: "AAA", decimals: 18 },
    token1: { id: "0x55d398326f99059ff775485246999027b3197955", symbol: "USDT", decimals: 18 },
    feeTier: 2500,
    liquidity: "1000",
    sqrtPrice: "2000",
    tick: 10,
    tvlUSD: "1000",
    volumeUSD24h: "50",
    feeUSD24h: "1",
  });
}

describe("pancake-pools job", () => {
  it("defaults to the verified seed list", async () => {
    const store = new MemoryStore();
    assert.deepEqual(await readTrackedPools(store), seedPools());
  });

  it("lets an operator override the pool set", async () => {
    const store = new MemoryStore();
    await store.put(SEED_POOLS_KEY, [POOL_A.toUpperCase(), POOL_A, "nonsense"], {
      source: "operator",
      freshForMs: 60_000,
      deadAfterMs: 600_000,
    });
    assert.deepEqual(await readTrackedPools(store), [POOL_A]);
  });

  it("writes one snapshot per pool plus a sorted index", async () => {
    const store = new MemoryStore();
    await store.put(SEED_POOLS_KEY, [POOL_B, POOL_A], {
      source: "operator",
      freshForMs: 60_000,
      deadAfterMs: 600_000,
    });
    installFetch((url) => explorerPool(url.pathname.split("/").pop() ?? "", TOKEN));

    const result = await runPancakePools(store, AbortSignal.timeout(5_000));
    assert.deepEqual(result, { attempted: 2, updated: 2, failed: 0 });
    assert.deepEqual((await store.get<string[]>(POOLS_INDEX_KEY))?.data, [POOL_B, POOL_A].sort());
    assert.equal((await store.get<PoolStats>(poolKey(POOL_A)))?.data.fee, 2500);
  });

  it("publishes the pools that worked and counts the ones that did not", async () => {
    const store = new MemoryStore();
    await store.put(SEED_POOLS_KEY, [POOL_A, POOL_B], {
      source: "operator",
      freshForMs: 60_000,
      deadAfterMs: 600_000,
    });
    installFetch((url) =>
      url.pathname.endsWith(POOL_A) ? explorerPool(POOL_A, TOKEN) : json({}, 500),
    );

    const result = await runPancakePools(store, AbortSignal.timeout(5_000));
    assert.deepEqual(result, { attempted: 2, updated: 1, failed: 1 });
    assert.deepEqual((await store.get<string[]>(POOLS_INDEX_KEY))?.data, [POOL_A]);
  });

  it("keeps an index entry whose pool failed this cycle", async () => {
    const store = new MemoryStore();
    await store.put(POOLS_INDEX_KEY, [POOL_B], {
      source: "pancake",
      freshForMs: 60_000,
      deadAfterMs: 600_000,
    });
    await store.put(SEED_POOLS_KEY, [POOL_A], {
      source: "operator",
      freshForMs: 60_000,
      deadAfterMs: 600_000,
    });
    installFetch(() => explorerPool(POOL_A, TOKEN));

    await runPancakePools(store, AbortSignal.timeout(5_000));
    assert.deepEqual((await store.get<string[]>(POOLS_INDEX_KEY))?.data, [POOL_B, POOL_A].sort());
  });

  it("fails the cycle when no pool could be read", async () => {
    const store = new MemoryStore();
    await store.put(SEED_POOLS_KEY, [POOL_A], {
      source: "operator",
      freshForMs: 60_000,
      deadAfterMs: 600_000,
    });
    installFetch(() => json({}, 503));

    await assert.rejects(
      () => runPancakePools(store, AbortSignal.timeout(5_000)),
      /no pools updated/u,
    );
  });

  it("reads back only pools that actually have a snapshot", async () => {
    const store = new MemoryStore();
    await store.put(POOLS_INDEX_KEY, [POOL_A, POOL_B, "junk"], {
      source: "pancake",
      freshForMs: 60_000,
      deadAfterMs: 600_000,
    });
    await store.put(poolKey(POOL_A), { pool: POOL_A }, {
      source: "pancake",
      freshForMs: 60_000,
      deadAfterMs: 600_000,
    });

    const pools = await readStoredPools(store);
    assert.equal(pools.length, 1);
    assert.equal(pools[0]?.stats.pool, POOL_A);
    assert.equal(pools[0]?.staleness, "fresh");
  });

  it("registers on a two-minute cadence inside a 25s timeout", () => {
    const spec = pancakePoolsJob(new MemoryStore());
    assert.equal(spec.name, PANCAKE_POOLS_JOB);
    assert.equal(spec.intervalMs, 120_000);
    assert.equal(spec.timeoutMs, 25_000);
  });
});

describe("venus-health jobs", () => {
  it("tracks nobody until an operator says so", async () => {
    const store = new MemoryStore();
    assert.deepEqual(await readTrackedVenusOwners(store), []);
  });

  it("normalizes and deduplicates the tracked owner list", async () => {
    const store = new MemoryStore();
    await store.put(TRACKED_VENUS_OWNERS_KEY, [OWNER_A.toUpperCase(), OWNER_A, 7, "nope"], {
      source: "operator",
      freshForMs: 60_000,
      deadAfterMs: 600_000,
    });
    assert.deepEqual(await readTrackedVenusOwners(store), [OWNER_A]);
  });

  it("succeeds as a no-op with an empty owner list", async () => {
    const store = new MemoryStore();
    const seen = installFetch(() => json({}, 500));
    const result = await runVenusHealth(store, [], AbortSignal.timeout(5_000));
    assert.deepEqual(result, { attempted: 0, updated: 0, failed: 0, hot: 0 });
    assert.equal(seen.length, 0);
  });

  it("narrows the hot set to owners stored at DANGER or worse", async () => {
    const store = new MemoryStore();
    await store.put(TRACKED_VENUS_OWNERS_KEY, [OWNER_A, OWNER_B], {
      source: "operator",
      freshForMs: 60_000,
      deadAfterMs: 600_000,
    });
    await putHealth(store, OWNER_A, "HEALTHY");
    await putHealth(store, OWNER_B, "LIQUIDATABLE");

    assert.deepEqual(await readHotVenusOwners(store), [OWNER_B]);
  });

  it("leaves an owner out of the hot set until it has been read once", async () => {
    const store = new MemoryStore();
    await store.put(TRACKED_VENUS_OWNERS_KEY, [OWNER_A], {
      source: "operator",
      freshForMs: 60_000,
      deadAfterMs: 600_000,
    });
    assert.deepEqual(await readHotVenusOwners(store), []);
  });

  it("fails the cycle when every owner read fails", async () => {
    const store = new MemoryStore();
    // Every RPC endpoint unreachable, so every per-owner read fails.
    globalThis.fetch = (async () => {
      throw new Error("network disabled in test");
    }) as typeof globalThis.fetch;

    await assert.rejects(
      () => runVenusHealth(store, [OWNER_A], AbortSignal.timeout(5_000)),
      /no venus owners updated/u,
    );
  });

  it("registers a 60s sweep and a 15s hot loop", () => {
    const store = new MemoryStore();
    const base = venusHealthJob(store);
    const hot = venusHealthHotJob(store);
    assert.equal(base.name, VENUS_HEALTH_JOB);
    assert.equal(base.intervalMs, 60_000);
    assert.equal(base.timeoutMs, 30_000);
    assert.equal(hot.name, VENUS_HEALTH_HOT_JOB);
    assert.equal(hot.intervalMs, 15_000);
  });
});

async function putHealth(store: MemoryStore, owner: string, tier: VenusHealth["tier"]): Promise<void> {
  const health: VenusHealth = {
    owner,
    healthFactor: tier === "HEALTHY" ? 3 : 0.5,
    tier,
    collateralValueUsd: 100,
    borrowValueUsd: tier === "HEALTHY" ? 10 : 200,
    assets: [],
    asOf: Date.now(),
  };
  await store.put(venusKey(owner), health, {
    source: "venus",
    freshForMs: 90_000,
    deadAfterMs: 900_000,
  });
}
