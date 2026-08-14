import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import { createServer } from "../src/server.js";
import type { PoolStats, PoolTier } from "../src/core/models.js";
import { MAX_LANE_POOLS, POOLS_LANE_KEY } from "../src/jobs/pancakePools.js";

const USDT = "0x55d398326f99059ff775485246999027b3197955";
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const MEME = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";

function build(): { app: ReturnType<typeof createServer>; store: MemoryStore } {
  const store = new MemoryStore();
  const app = createServer({ scheduler: createScheduler(store), store });
  return { app, store };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface PoolOverrides {
  token1?: string;
  fee?: number;
  tvlUsd?: number | null;
  volume24hUsd?: number | null;
  lpFeeApr24h?: number | null;
  cakeFarmApr?: number | null;
  tier?: PoolTier;
}

function pool(address: string, overrides: PoolOverrides = {}): PoolStats {
  const lpFeeApr24h = overrides.lpFeeApr24h === undefined ? 10 : overrides.lpFeeApr24h;
  const cakeFarmApr = overrides.cakeFarmApr === undefined ? 0 : overrides.cakeFarmApr;
  const combinedApr =
    lpFeeApr24h === null || cakeFarmApr === null ? null : lpFeeApr24h + cakeFarmApr;

  return {
    pool: address,
    protocol: "v3",
    token0: USDT,
    token1: overrides.token1 ?? WBNB,
    token0Symbol: "USDT",
    token1Symbol: "WBNB",
    fee: overrides.fee ?? 100,
    liquidity: null,
    sqrtPriceX96: null,
    tick: null,
    tvlUsd: overrides.tvlUsd === undefined ? 1_000_000 : overrides.tvlUsd,
    volume24hUsd: overrides.volume24hUsd === undefined ? 500_000 : overrides.volume24hUsd,
    lpFeeApr24h,
    lpFeeApr7d: lpFeeApr24h,
    cakeFarmApr,
    combinedApr,
    aprSources: cakeFarmApr === null ? ["lpFee"] : ["lpFee", "cakeFarm"],
    farm: null,
    tier: overrides.tier ?? "unclassified",
    tokenOrigin: { token0: "unknown", token1: "unknown" },
    asOf: 1,
    source: "pancake",
  };
}

function address(index: number): string {
  return `0x${(index + 1).toString(16).padStart(40, "0")}`;
}

async function putLane(store: MemoryStore, pools: PoolStats[]): Promise<void> {
  await store.put(POOLS_LANE_KEY, pools, {
    source: "pancake",
    freshForMs: 300_000,
    deadAfterMs: 3_600_000,
  });
}

async function get(
  app: ReturnType<typeof createServer>,
  query: string,
): Promise<{ status: number; data: Array<Record<string, unknown>>; meta: Record<string, unknown> }> {
  const res = await app.request(`/pools/top${query}`);
  const body = (await res.json()) as unknown;
  assert.ok(isRecord(body));
  const data = Array.isArray(body["data"]) ? (body["data"] as Array<Record<string, unknown>>) : [];
  const meta = isRecord(body["meta"]) ? body["meta"] : {};
  return { status: res.status, data, meta };
}

describe("GET /pools/top", () => {
  it("serves the lane ordered by combined APR, best first", async () => {
    const { app, store } = build();
    await putLane(store, [
      pool(address(1), { lpFeeApr24h: 5, cakeFarmApr: 1 }),
      pool(address(2), { lpFeeApr24h: 30, cakeFarmApr: 12 }),
      pool(address(3), { lpFeeApr24h: 20, cakeFarmApr: 0 }),
    ]);

    const { status, data, meta } = await get(app, "");
    assert.equal(status, 200);
    assert.deepEqual(
      data.map((row) => row["combinedApr"]),
      [42, 20, 6],
    );
    assert.equal(meta["total"], 3);
    assert.equal(meta["matched"], 3);
    assert.equal(meta["returned"], 3);
    assert.equal(meta["orderBy"], "combinedApr");
    assert.equal(meta["aprField"], "combinedApr");
    assert.equal(meta["staleness"], "fresh");
  });

  it("says plainly that this is the top of a TVL-ordered lane, not every pool", async () => {
    const { app, store } = build();
    await putLane(store, [pool(address(1))]);

    const { meta } = await get(app, "");
    assert.equal(meta["cap"], MAX_LANE_POOLS);
    assert.equal(meta["ingestOrder"], "tvlUSD");
  });

  it("applies the caller's floors instead of any threshold of its own", async () => {
    const { app, store } = build();
    await putLane(store, [
      // A dust pool with a spectacular APR — kept unless the caller excludes it.
      pool(address(1), { tvlUsd: 13, lpFeeApr24h: 700 }),
      pool(address(2), { tvlUsd: 5_000_000, lpFeeApr24h: 25 }),
    ]);

    const unfiltered = await get(app, "");
    assert.equal(unfiltered.data.length, 2);
    assert.equal(unfiltered.data[0]?.["combinedApr"], 700);

    const filtered = await get(app, "?minTvlUsd=100000");
    assert.equal(filtered.data.length, 1);
    assert.equal(filtered.data[0]?.["pool"], address(2));
    assert.equal(filtered.meta["total"], 2);
    assert.equal(filtered.meta["matched"], 1);
  });

  it("filters on the APR field the caller names", async () => {
    const { app, store } = build();
    await putLane(store, [
      pool(address(1), { lpFeeApr24h: 5, cakeFarmApr: 40 }),
      pool(address(2), { lpFeeApr24h: 30, cakeFarmApr: 1 }),
    ]);

    const combined = await get(app, "?minAprPct=20");
    assert.equal(combined.data.length, 2);

    const feesOnly = await get(app, "?aprField=lpFeeApr24h&minAprPct=20");
    assert.equal(feesOnly.data.length, 1);
    assert.equal(feesOnly.data[0]?.["pool"], address(2));
    assert.equal(feesOnly.meta["orderBy"], "lpFeeApr24h");
  });

  it("excludes a pool whose APR is unknown once a floor is set", async () => {
    const { app, store } = build();
    await putLane(store, [
      pool(address(1), { lpFeeApr24h: 40, cakeFarmApr: null }),
      pool(address(2), { lpFeeApr24h: 25, cakeFarmApr: 5 }),
    ]);

    // Unfiltered, the unpriced pool is still lane data, just sorted last.
    const all = await get(app, "");
    assert.equal(all.data.length, 2);
    assert.equal(all.data[1]?.["pool"], address(1));
    assert.equal(all.data[1]?.["combinedApr"], null);

    // Asking for pools above 20% asks for pools *known* to be above 20%.
    const floored = await get(app, "?minAprPct=20");
    assert.equal(floored.data.length, 1);
    assert.equal(floored.data[0]?.["pool"], address(2));
  });

  it("screens wash-traded pools by volume-to-TVL when asked", async () => {
    const { app, store } = build();
    await putLane(store, [
      pool(address(1), { tvlUsd: 1_000, volume24hUsd: 5_000_000 }),
      pool(address(2), { tvlUsd: 1_000_000, volume24hUsd: 2_000_000 }),
    ]);

    const { data } = await get(app, "?maxVolTvlRatio=20");
    assert.equal(data.length, 1);
    assert.equal(data[0]?.["pool"], address(2));
  });

  it("filters by token, fee tier and tier label", async () => {
    const { app, store } = build();
    await putLane(store, [
      pool(address(1), { token1: MEME, fee: 2500, tier: "degen" }),
      pool(address(2), { fee: 100, tier: "core" }),
    ]);

    assert.equal((await get(app, `?token=${MEME}`)).data.length, 1);
    assert.equal((await get(app, "?feeTier=2500")).data.length, 1);
    assert.equal((await get(app, "?tier=core")).data[0]?.["pool"], address(2));
    // Nothing is labelled yet, so the label is a pass-through, not a promise.
    assert.equal((await get(app, "?tier=unclassified")).data.length, 0);
  });

  it("orders by a non-APR field on request", async () => {
    const { app, store } = build();
    await putLane(store, [
      pool(address(1), { tvlUsd: 100, lpFeeApr24h: 90 }),
      pool(address(2), { tvlUsd: 900, lpFeeApr24h: 1 }),
    ]);

    const { data, meta } = await get(app, "?orderBy=tvlUsd");
    assert.equal(data[0]?.["pool"], address(2));
    assert.equal(meta["orderBy"], "tvlUsd");
  });

  it("limits the page and never beyond the lane cap", async () => {
    const { app, store } = build();
    await putLane(store, [pool(address(1)), pool(address(2)), pool(address(3))]);

    const limited = await get(app, "?limit=2");
    assert.equal(limited.data.length, 2);
    assert.equal(limited.meta["matched"], 3);
    assert.equal(limited.meta["returned"], 2);

    const oversized = await get(app, `?limit=${MAX_LANE_POOLS * 10}`);
    assert.equal(oversized.data.length, 3);
  });

  it("rejects a query it cannot honour rather than answering with nothing", async () => {
    const { app, store } = build();
    await putLane(store, [pool(address(1))]);

    for (const query of [
      "?minAprPct=abc",
      "?limit=0",
      "?limit=2.5",
      "?tier=safe",
      "?orderBy=vibes",
      "?aprField=tvlUsd",
      "?token=notanaddress",
    ]) {
      const res = await app.request(`/pools/top${query}`);
      assert.equal(res.status, 400, query);
      const body = (await res.json()) as Record<string, Record<string, unknown>>;
      assert.equal(body["error"]?.["code"], "invalid_query");
    }
  });

  it("answers an empty lane without pretending it has one", async () => {
    const { app } = build();
    const { status, data, meta } = await get(app, "");
    assert.equal(status, 200);
    assert.equal(data.length, 0);
    assert.equal(meta["total"], 0);
    assert.equal(meta["asOf"], null);
    assert.equal(meta["staleness"], null);
  });

  it("reports the lane's own age, so a stale answer is visible as one", async () => {
    let now = 1_000_000;
    const store = new MemoryStore(() => now);
    const app = createServer({ scheduler: createScheduler(store), store });
    await putLane(store, [pool(address(1))]);

    now += 600_000;
    const { meta } = await get(app, "");
    assert.equal(meta["staleness"], "stale");
  });
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Serves the two endpoints a live per-pool read touches. */
function installExplorer(handler: (path: string) => Response): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(href);
    return handler(new URL(href).pathname);
  }) as typeof globalThis.fetch;
  return { calls };
}

function explorerPoolBody(poolAddress: string): unknown {
  return {
    id: poolAddress,
    token0: { id: USDT, symbol: "USDT", decimals: 18 },
    token1: { id: WBNB, symbol: "WBNB", decimals: 18 },
    feeTier: 500,
    liquidity: "1000",
    sqrtPrice: "2000",
    tick: 10,
    tvlUSD: "4242",
    volumeUSD24h: "50",
  };
}

describe("GET /pools/:address", () => {
  it("serves a lane row, farm pricing and tier included", async () => {
    const { app, store } = build();
    installExplorer(() => new Response("unreachable", { status: 500 }));
    await putLane(store, [pool(address(1), { cakeFarmApr: 4, tier: "core" })]);

    const res = await app.request(`/pools/${address(1)}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    assert.equal(body["data"]?.["combinedApr"], 14);
    assert.equal(body["data"]?.["tier"], "core");
    assert.equal(body["meta"]?.["source"], "lane");
  });

  it("reads a pool off the lane live, and caches it on the way out", async () => {
    const { app, store } = build();
    const explorer = installExplorer((path) =>
      path.includes("/pools/apr/")
        ? new Response(JSON.stringify({ apr24h: "0.5", apr7d: "0.4" }))
        : new Response(JSON.stringify(explorerPoolBody(address(9)))),
    );

    const first = await app.request(`/pools/${address(9)}`);
    assert.equal(first.status, 200);
    const body = (await first.json()) as Record<string, Record<string, unknown>>;
    assert.equal(body["data"]?.["lpFeeApr24h"], 50);
    assert.equal(body["meta"]?.["source"], "live");
    // Off the lane, so nothing has priced its farm or classified its tokens.
    assert.equal(body["data"]?.["cakeFarmApr"], null);
    assert.equal(body["data"]?.["tier"], "unclassified");

    const upstreamCalls = explorer.calls.length;
    const second = await app.request(`/pools/${address(9)}`);
    const cached = (await second.json()) as Record<string, Record<string, unknown>>;
    assert.equal(cached["meta"]?.["source"], "cache");
    assert.equal(explorer.calls.length, upstreamCalls);
    assert.notEqual(await store.get(`pool:${address(9)}`), null);
  });

  it("serves a dead snapshot rather than nothing when the read fails", async () => {
    let now = 1_000_000;
    const store = new MemoryStore(() => now);
    const app = createServer({ scheduler: createScheduler(store), store });
    await store.put(`pool:${address(9)}`, pool(address(9)), {
      source: "pancake",
      freshForMs: 300_000,
      deadAfterMs: 3_600_000,
    });
    now += 7_200_000;
    installExplorer(() => new Response("gateway", { status: 502 }));

    const res = await app.request(`/pools/${address(9)}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    assert.equal(body["meta"]?.["staleness"], "dead");
    assert.equal(body["meta"]?.["source"], "cache");
  });

  it("404s a pool that does not exist, and 400s something that is not an address", async () => {
    const { app } = build();
    installExplorer(() => new Response("{}", { status: 404 }));

    const missing = await app.request(`/pools/${address(9)}`);
    assert.equal(missing.status, 404);

    const invalid = await app.request("/pools/not-an-address");
    assert.equal(invalid.status, 400);
  });

  it("does not shadow the range route either", async () => {
    const { app, store } = build();
    await putLane(store, [pool(address(1))]);
    installExplorer(() => new Response("{}", { status: 500 }));

    // Both live under /pools/:address; the deeper path must not be swallowed.
    const res = await app.request(`/pools/${address(1)}/range?lower=1&upper=2&capital=100`);
    assert.notEqual(res.status, 400);
  });

  it("does not shadow the /pools/top route", async () => {
    const { app, store } = build();
    await putLane(store, [pool(address(1))]);
    const res = await app.request("/pools/top");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(Array.isArray(body["data"]));
  });
});

describe("GET /pools/:address/range", () => {
  const Q96 = "79228162514264337593543950336";

  function installRangeExplorer(): void {
    installExplorer((path) => {
      if (path.includes("/pools/apr/")) {
        return new Response(JSON.stringify({ apr24h: "0.1", apr7d: "0.08" }));
      }
      if (path.includes("/tokens/price/list/")) {
        return new Response(
          JSON.stringify({
            [`56:${USDT}`]: { priceUSD: "1" },
            [`56:${WBNB}`]: { priceUSD: "1" },
          }),
        );
      }
      return new Response(
        JSON.stringify({
          id: address(9),
          token0: { id: USDT, symbol: "USDT", decimals: 18 },
          token1: { id: WBNB, symbol: "WBNB", decimals: 18 },
          feeTier: 500,
          liquidity: "10000000000000000000000000000",
          sqrtPrice: Q96,
          tick: 0,
          tvlUSD: "100000000",
        }),
      );
    });
  }

  it("estimates a position and says what it assumed", async () => {
    const { app } = build();
    installRangeExplorer();

    const res = await app.request(`/pools/${address(9)}/range?lower=0.99&upper=1.01&capital=10000`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    const data = body["data"] ?? {};

    assert.equal(data["inRange"], true);
    assert.ok((data["estimatedAprPct"] as number) > 0);
    const position = data["position"] as Record<string, number>;
    // The position is worth what was asked for, both tokens priced at $1 here.
    assert.ok(Math.abs((position["amount0"] ?? 0) + (position["amount1"] ?? 0) - 10_000) < 1);
    assert.ok((data["assumptions"] as string[]).length > 0);
    assert.deepEqual(data["unavailable"], []);
  });

  it("rejects a range it cannot act on", async () => {
    const { app } = build();
    installRangeExplorer();

    for (const query of [
      "?upper=2&capital=100",
      "?lower=1&capital=100",
      "?lower=1&upper=2",
      "?lower=2&upper=1&capital=100",
      "?lower=0&upper=2&capital=100",
      "?lower=1&upper=2&capital=0",
      "?lower=abc&upper=2&capital=100",
    ]) {
      const res = await app.request(`/pools/${address(9)}/range${query}`);
      assert.equal(res.status, 400, query);
      const body = (await res.json()) as Record<string, Record<string, unknown>>;
      assert.equal(body["error"]?.["code"], "invalid_query");
    }
  });

  it("404s a pool it cannot price, and 400s a bad address", async () => {
    const { app } = build();
    installExplorer(() => new Response("gateway", { status: 502 }));

    const missing = await app.request(`/pools/${address(9)}/range?lower=1&upper=2&capital=100`);
    assert.equal(missing.status, 404);

    const invalid = await app.request("/pools/nope/range?lower=1&upper=2&capital=100");
    assert.equal(invalid.status, 400);
  });

  it("pays for the pool's facts once, however many ranges are asked about", async () => {
    const { app } = build();
    installRangeExplorer();

    await app.request(`/pools/${address(9)}/range?lower=0.99&upper=1.01&capital=10000`);
    const explorer = installExplorer(() => new Response("must not be called", { status: 500 }));
    const second = await app.request(`/pools/${address(9)}/range?lower=0.9&upper=1.1&capital=500`);

    assert.equal(second.status, 200);
    assert.equal(explorer.calls.length, 0);
  });
});
