import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { MemoryStore } from "../src/core/store.js";
import type { PoolStats, VenusHealth } from "../src/core/models.js";
import { POOLS_INDEX_KEY, SEED_POOLS_KEY, poolKey, seedPools } from "../src/adapters/pancake.js";
import {
  MAX_LANE_POOLS,
  PANCAKE_POOLS_JOB,
  POOLS_LANE_KEY,
  type RunPancakePoolsOptions,
  pancakePoolsJob,
  readPoolsLane,
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

const USDT = "0x55d398326f99059ff775485246999027b3197955";

/** A per-pool explorer payload: identity plus chain state, but no APR. */
function explorerPool(pool: string, token0: string): Response {
  return json({
    id: pool,
    token0: { id: token0, symbol: "AAA", decimals: 18 },
    token1: { id: USDT, symbol: "USDT", decimals: 18 },
    feeTier: 2500,
    liquidity: "1000",
    sqrtPrice: "2000",
    tick: 10,
    tvlUSD: "1000",
    volumeUSD24h: "50",
    feeUSD24h: "1",
  });
}

/** A list row. `apr24h` is a fraction upstream, as it is on the live endpoint. */
function listRow(pool: string, tvlUsd: number, apr24h = "0.1"): unknown {
  return {
    id: pool,
    chainId: 56,
    protocol: "v3",
    feeTier: 100,
    tvlUSD: String(tvlUsd),
    volumeUSD24h: "1000",
    apr24h,
    token0: { id: TOKEN, symbol: "AAA", decimals: 18 },
    token1: { id: USDT, symbol: "USDT", decimals: 18 },
  };
}

function listPage(rows: unknown[], endCursor: string | null): Response {
  return json({ rows, endCursor, hasNextPage: endCursor !== null });
}

/** Distinct, valid pool addresses for bulk fixtures. */
function generatedPool(index: number): string {
  return `0x${(index + 1).toString(16).padStart(40, "0")}`;
}

const CAKE_PRICE_BODY = {
  "56:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82": { priceUSD: "2" },
};

interface PancakeUpstream {
  /** One response per page request, in order. */
  pages?: Response[];
  farming?: Response;
  pool?: (address: string) => Response;
}

/** Routes the four explorer endpoints the job touches. */
function installPancakeFetch(upstream: PancakeUpstream): string[] {
  let page = 0;
  return installFetch((url) => {
    const path = url.pathname;
    if (path === "/api/cached/pools/list") {
      const response = upstream.pages?.[page];
      page += 1;
      return response ?? json({}, 503);
    }
    if (url.host === "tokens.pancakeswap.finance") {
      return json({ tokens: [{ chainId: 56, address: USDT }] });
    }
    if (path === "/api/cached/pools/farming") return upstream.farming ?? json([]);
    if (path.startsWith("/api/cached/tokens/price/list/")) return json(CAKE_PRICE_BODY);
    if (path.startsWith("/api/cached/pools/apr/")) return json({ apr24h: "0.2", apr7d: "0.15" });

    const address = path.split("/").pop() ?? "";
    return upstream.pool?.(address) ?? explorerPool(address, TOKEN);
  });
}

/** Emissions for the named pools; everything else reads as unfarmed. */
function emissionsFor(pools: Record<string, number>): RunPancakePoolsOptions["readEmissions"] {
  return async (requested) => ({
    cakePerSecond: 1,
    totalAllocPoint: 100,
    farms: new Map(
      requested
        .filter((pool) => pool in pools)
        .map((pool) => [pool, { pid: 1, allocPoint: 10, cakePerYear: pools[pool] ?? 0 }]),
    ),
  });
}

/** No chain and no live emissions: both are driven through injection. */
const OFFLINE: RunPancakePoolsOptions = { rpcUrls: [], readEmissions: emissionsFor({}) };

async function putOperatorPools(store: MemoryStore, pools: string[]): Promise<void> {
  await store.put(SEED_POOLS_KEY, pools, {
    source: "operator",
    freshForMs: 60_000,
    deadAfterMs: 600_000,
  });
}

describe("pancake-pools job", () => {
  it("defaults to the verified seed list", async () => {
    const store = new MemoryStore();
    assert.deepEqual(await readTrackedPools(store), seedPools());
  });

  it("lets an operator override the pool set", async () => {
    const store = new MemoryStore();
    await putOperatorPools(store, [POOL_A.toUpperCase(), POOL_A, "nonsense"]);
    assert.deepEqual(await readTrackedPools(store), [POOL_A]);
  });

  it("walks the cursor until the list says there is no next page", async () => {
    const store = new MemoryStore();
    await putOperatorPools(store, [POOL_A]);
    const seen = installPancakeFetch({
      pages: [
        listPage([listRow(generatedPool(1), 900)], "cursor-2"),
        listPage([listRow(generatedPool(2), 800)], null),
      ],
    });

    const result = await runPancakePools(store, AbortSignal.timeout(5_000), OFFLINE);
    assert.equal(result.pagesRead, 2);
    assert.equal(result.complete, true);
    assert.equal(result.discovered, 2);

    const listCalls = seen.filter((href) => href.includes("/pools/list"));
    assert.equal(listCalls.length, 2);
    assert.equal(new URL(listCalls[0] ?? "").searchParams.get("after"), null);
    assert.equal(new URL(listCalls[1] ?? "").searchParams.get("after"), "cursor-2");
  });

  it("publishes the lane as one snapshot, ordered by TVL", async () => {
    const store = new MemoryStore();
    await putOperatorPools(store, [POOL_A]);
    installPancakeFetch({
      pages: [listPage([listRow(generatedPool(1), 500), listRow(generatedPool(2), 900)], null)],
    });

    await runPancakePools(store, AbortSignal.timeout(5_000), OFFLINE);
    const lane = await readPoolsLane(store);
    assert.equal(lane?.pools.length, 3);
    assert.deepEqual(
      lane?.pools.map((pool) => pool.tvlUsd),
      [1000, 900, 500],
    );
  });

  it("keeps the operator's pools in the lane whatever their TVL", async () => {
    const store = new MemoryStore();
    await putOperatorPools(store, [POOL_A]);
    const pageCount = MAX_LANE_POOLS / 50;
    // A full lane of pools, every one of them richer than the seeded pool.
    installPancakeFetch({
      pages: Array.from({ length: pageCount }, (_, page) =>
        listPage(
          Array.from({ length: 50 }, (_, row) => listRow(generatedPool(page * 50 + row), 1_000_000)),
          page === pageCount - 1 ? null : `cursor-${page + 2}`,
        ),
      ),
    });

    const result = await runPancakePools(store, AbortSignal.timeout(5_000), OFFLINE);
    assert.equal(result.discovered, MAX_LANE_POOLS);
    assert.equal(result.lane, MAX_LANE_POOLS);

    const lane = await readPoolsLane(store);
    assert.ok(lane?.pools.some((pool) => pool.pool === POOL_A));
  });

  it("carries the stored lane over when paging breaks part-way", async () => {
    const store = new MemoryStore();
    await putOperatorPools(store, [POOL_A]);
    installPancakeFetch({ pages: [listPage([listRow(generatedPool(1), 900)], "cursor-2")] });
    await runPancakePools(store, AbortSignal.timeout(5_000), OFFLINE);

    // Second cycle: the first page answers with a different pool, the second dies.
    installPancakeFetch({
      pages: [listPage([listRow(generatedPool(2), 800)], "cursor-2"), json({}, 502)],
    });
    const result = await runPancakePools(store, AbortSignal.timeout(5_000), OFFLINE);
    assert.equal(result.complete, false);

    const pools = (await readPoolsLane(store))?.pools.map((pool) => pool.pool) ?? [];
    // A broken pass must not shrink the lane: the earlier pool is still there.
    assert.ok(pools.includes(generatedPool(1)));
    assert.ok(pools.includes(generatedPool(2)));
  });

  it("completes a degraded seed row from the same pool's list row", async () => {
    const store = new MemoryStore();
    await putOperatorPools(store, [POOL_A]);
    // The per-pool read fails and falls through to the chain, which is also
    // unreachable here — but the pool is on the list page, with its USD figures.
    installPancakeFetch({
      pages: [listPage([listRow(POOL_A, 4_242, "1.5")], null)],
      pool: () => json({}, 500),
    });

    await runPancakePools(store, AbortSignal.timeout(5_000), OFFLINE);
    const row = (await readPoolsLane(store))?.pools.find((pool) => pool.pool === POOL_A);
    assert.equal(row?.tvlUsd, 4_242);
    assert.equal(row?.lpFeeApr24h, 150);
  });

  it("leaves a carried row's farm APR alone rather than repricing stale TVL", async () => {
    const store = new MemoryStore();
    await putOperatorPools(store, [POOL_A]);
    const carried = generatedPool(1);
    installPancakeFetch({
      pages: [listPage([listRow(carried, 1_000_000)], null)],
      farming: json([listRow(carried, 1_000_000)]),
    });
    await runPancakePools(store, AbortSignal.timeout(5_000), {
      rpcUrls: [],
      readEmissions: emissionsFor({ [carried]: 50_000 }),
    });
    const before = (await readPoolsLane(store))?.pools.find((pool) => pool.pool === carried);
    assert.equal(before?.cakeFarmApr, 10);

    // Paging breaks, so the pool is carried over at its old TVL. Emissions have
    // since doubled; applying them to that TVL would invent a number from two
    // different moments and file it under the older `asOf`.
    installPancakeFetch({
      pages: [listPage([], "cursor-2"), json({}, 502)],
      farming: json([listRow(carried, 1_000_000)]),
    });
    await runPancakePools(store, AbortSignal.timeout(5_000), {
      rpcUrls: [],
      readEmissions: emissionsFor({ [carried]: 100_000 }),
    });

    const after = (await readPoolsLane(store))?.pools.find((pool) => pool.pool === carried);
    assert.equal(after?.cakeFarmApr, 10);
    assert.equal(after?.asOf, before?.asOf);
  });

  it("does not let an empty-but-complete pass wipe the lane", async () => {
    const store = new MemoryStore();
    await putOperatorPools(store, [POOL_A]);
    installPancakeFetch({ pages: [listPage([listRow(generatedPool(1), 900)], null)] });
    await runPancakePools(store, AbortSignal.timeout(5_000), OFFLINE);

    // `{rows: [], hasNextPage: false}` walks to the end without objecting.
    installPancakeFetch({ pages: [listPage([], null)] });
    const result = await runPancakePools(store, AbortSignal.timeout(5_000), OFFLINE);
    assert.equal(result.complete, true);
    assert.equal(result.replaced, false);

    const pools = (await readPoolsLane(store))?.pools.map((pool) => pool.pool) ?? [];
    assert.ok(pools.includes(generatedPool(1)));
  });

  it("does not restamp a tracked pool that failed this cycle", async () => {
    let now = 1_000_000;
    const store = new MemoryStore(() => now);
    await putOperatorPools(store, [POOL_A]);
    installPancakeFetch({ pages: [listPage([listRow(generatedPool(1), 900)], null)] });
    await runPancakePools(store, AbortSignal.timeout(5_000), OFFLINE);
    const before = await store.get<PoolStats>(poolKey(POOL_A));

    now += 120_000;
    installPancakeFetch({
      pages: [listPage([listRow(generatedPool(1), 900)], null)],
      pool: () => json({}, 500),
    });
    await runPancakePools(store, AbortSignal.timeout(5_000), OFFLINE);

    // The pool is still carried in the lane, but its own record must keep saying
    // when it was last actually read.
    const after = await store.get<PoolStats>(poolKey(POOL_A));
    assert.equal(after?.asOf, before?.asOf);
  });

  it("replaces the lane on a complete pass, so a delisted pool drops out", async () => {
    const store = new MemoryStore();
    await putOperatorPools(store, [POOL_A]);
    installPancakeFetch({ pages: [listPage([listRow(generatedPool(1), 900)], null)] });
    await runPancakePools(store, AbortSignal.timeout(5_000), OFFLINE);

    installPancakeFetch({ pages: [listPage([listRow(generatedPool(2), 800)], null)] });
    await runPancakePools(store, AbortSignal.timeout(5_000), OFFLINE);

    const pools = (await readPoolsLane(store))?.pools.map((pool) => pool.pool) ?? [];
    assert.ok(!pools.includes(generatedPool(1)));
    assert.ok(pools.includes(generatedPool(2)));
  });

  it("prices CAKE emissions only for pools the farming list knows", async () => {
    const store = new MemoryStore();
    await putOperatorPools(store, [POOL_A]);
    const farmed = generatedPool(1);
    const plain = generatedPool(2);
    installPancakeFetch({
      pages: [listPage([listRow(farmed, 1_000_000, "0.1"), listRow(plain, 900_000, "0.2")], null)],
      farming: json([listRow(farmed, 1_000_000)]),
    });

    const result = await runPancakePools(store, AbortSignal.timeout(5_000), {
      rpcUrls: [],
      // 50,000 CAKE/yr at $2 over $1,000,000 of TVL is 10%.
      readEmissions: emissionsFor({ [farmed]: 50_000 }),
    });
    assert.equal(result.farmPriced, 3);

    const lane = await readPoolsLane(store);
    const withFarm = lane?.pools.find((pool) => pool.pool === farmed);
    const without = lane?.pools.find((pool) => pool.pool === plain);

    assert.equal(withFarm?.lpFeeApr24h, 10);
    assert.equal(withFarm?.cakeFarmApr, 10);
    assert.equal(withFarm?.combinedApr, 20);
    assert.deepEqual(withFarm?.aprSources, ["lpFee", "cakeFarm"]);

    // Absent from the farming list is a real answer: this pool earns no CAKE.
    assert.equal(without?.cakeFarmApr, 0);
    assert.equal(without?.combinedApr, 20);
  });

  it("leaves every farm APR unknown when the emission read fails", async () => {
    const store = new MemoryStore();
    await putOperatorPools(store, [POOL_A]);
    const farmed = generatedPool(1);
    installPancakeFetch({
      pages: [listPage([listRow(farmed, 1_000_000)], null)],
      farming: json([listRow(farmed, 1_000_000)]),
    });

    const result = await runPancakePools(store, AbortSignal.timeout(5_000), {
      rpcUrls: [],
      readEmissions: async () => {
        throw new Error("rpc down");
      },
    });
    // Never 0: reporting "no CAKE" for a farmed pool understates its yield.
    assert.equal(result.farmPriced, 0);
    const lane = await readPoolsLane(store);
    for (const pool of lane?.pools ?? []) {
      assert.equal(pool.cakeFarmApr, null);
      assert.equal(pool.combinedApr, null);
      assert.deepEqual(pool.aprSources, ["lpFee"]);
    }
  });

  it("labels the lane from the launchpad contracts and the curated sets", async () => {
    const store = new MemoryStore();
    await putOperatorPools(store, [POOL_A]);
    // Both list rows are TOKEN/USDT, and the launchpad says TOKEN is its own.
    installPancakeFetch({ pages: [listPage([listRow(generatedPool(1), 900)], null)] });

    const result = await runPancakePools(store, AbortSignal.timeout(5_000), {
      ...OFFLINE,
      readOrigins: async (tokens) =>
        new Map(tokens.map((token) => [token, token === TOKEN ? "fourmeme" : "none"])),
    });
    assert.equal(result.tiered, result.lane);

    const row = (await readPoolsLane(store))?.pools.find(
      (pool) => pool.pool === generatedPool(1),
    );
    assert.equal(row?.tier, "degen");
    assert.deepEqual(row?.tokenOrigin, { token0: "fourmeme", token1: "allowlist" });
  });

  it("keeps the label steady even while the ranking lane moves", async () => {
    const store = new MemoryStore();
    await putOperatorPools(store, [POOL_A]);
    let calls = 0;
    const options: RunPancakePoolsOptions = {
      ...OFFLINE,
      readOrigins: async (tokens) => {
        calls += 1;
        return new Map(tokens.map((token) => [token, token === TOKEN ? "fourmeme" : "none"]));
      },
    };

    installPancakeFetch({ pages: [listPage([listRow(generatedPool(1), 900)], null)] });
    await runPancakePools(store, AbortSignal.timeout(5_000), options);
    installPancakeFetch({ pages: [listPage([listRow(generatedPool(1), 900)], null)] });
    await runPancakePools(store, AbortSignal.timeout(5_000), options);

    const row = (await readPoolsLane(store))?.pools.find(
      (pool) => pool.pool === generatedPool(1),
    );
    // The old lane-derived label flipped between runs depending on whether the
    // token was trending. Provenance is asked once and then never moves.
    assert.equal(row?.tier, "degen");
    assert.equal(calls, 1);
  });

  it("still publishes the lane when the seed pools cannot be read", async () => {
    const store = new MemoryStore();
    await putOperatorPools(store, [POOL_A]);
    installPancakeFetch({
      pages: [listPage([listRow(generatedPool(1), 900)], null)],
      pool: () => json({}, 500),
    });

    const result = await runPancakePools(store, AbortSignal.timeout(5_000), OFFLINE);
    assert.equal(result.failed, 1);
    assert.equal(result.lane, 1);
  });

  it("writes a per-pool snapshot and a sorted index for the tracked set only", async () => {
    const store = new MemoryStore();
    await putOperatorPools(store, [POOL_B, POOL_A]);
    installPancakeFetch({ pages: [listPage([listRow(generatedPool(1), 900)], null)] });

    await runPancakePools(store, AbortSignal.timeout(5_000), OFFLINE);
    assert.deepEqual((await store.get<string[]>(POOLS_INDEX_KEY))?.data, [POOL_A, POOL_B].sort());
    assert.equal((await store.get<PoolStats>(poolKey(POOL_A)))?.data.fee, 2500);
    // The discovered pool lives in the lane, not in a key of its own.
    assert.equal(await store.get<PoolStats>(poolKey(generatedPool(1))), null);
  });

  it("keeps an index entry whose pool failed this cycle", async () => {
    const store = new MemoryStore();
    await store.put(POOLS_INDEX_KEY, [POOL_B], {
      source: "pancake",
      freshForMs: 60_000,
      deadAfterMs: 600_000,
    });
    await putOperatorPools(store, [POOL_A]);
    installPancakeFetch({ pages: [listPage([], null)] });

    await runPancakePools(store, AbortSignal.timeout(5_000), OFFLINE);
    assert.deepEqual((await store.get<string[]>(POOLS_INDEX_KEY))?.data, [POOL_B, POOL_A].sort());
  });

  it("fails the cycle without restamping the lane when nothing could be read", async () => {
    const store = new MemoryStore();
    await putOperatorPools(store, [POOL_A]);
    installPancakeFetch({ pages: [listPage([listRow(generatedPool(1), 900)], null)] });
    await runPancakePools(store, AbortSignal.timeout(5_000), OFFLINE);
    const before = await store.get<unknown>(POOLS_LANE_KEY);

    installPancakeFetch({ pages: [json({}, 503)], pool: () => json({}, 503) });
    await assert.rejects(
      () => runPancakePools(store, AbortSignal.timeout(5_000), OFFLINE),
      /no pools read/u,
    );

    // Republishing would restamp the surviving rows into looking freshly read.
    const after = await store.get<unknown>(POOLS_LANE_KEY);
    assert.equal(after?.asOf, before?.asOf);
  });

  it("re-validates stored rows, dropping any that no longer describe a pool", async () => {
    const store = new MemoryStore();
    await store.put(
      POOLS_LANE_KEY,
      [{ pool: POOL_A, token0: TOKEN, token1: USDT, fee: 100 }, { junk: true }],
      { source: "pancake", freshForMs: 60_000, deadAfterMs: 600_000 },
    );

    const lane = await readPoolsLane(store);
    assert.equal(lane?.pools.length, 1);
    assert.equal(lane?.pools[0]?.pool, POOL_A);
    // A row written before these fields existed reads as unknown, not as zero.
    assert.equal(lane?.pools[0]?.combinedApr, null);
    assert.equal(lane?.pools[0]?.tier, "unclassified");
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

  it("registers on the explorer's own cache cadence, inside a 30s timeout", () => {
    const spec = pancakePoolsJob(new MemoryStore());
    assert.equal(spec.name, PANCAKE_POOLS_JOB);
    assert.equal(spec.intervalMs, 60_000);
    assert.equal(spec.timeoutMs, 30_000);
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
