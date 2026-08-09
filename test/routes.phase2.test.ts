import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import { createServer } from "../src/server.js";
import type { PoolStats, UniverseEntry, VenusHealth } from "../src/core/models.js";
import { POOLS_INDEX_KEY, poolKey } from "../src/adapters/pancake.js";
import { venusKey } from "../src/jobs/venusHealth.js";
import { securityKey, type StoredSecurity } from "../src/query/security.js";
import { MEME_UNIVERSE_KEY } from "../src/universe.js";

/** NVDAB — present in the static bStocks lane. */
const TOKEN = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
/** Not in any lane, so the route has to fall back. */
const UNLISTED = "0xaa00000000000000000000000000000000000001";
const QUOTE = "0x55d398326f99059ff775485246999027b3197955";
const POOL_A = "0xcc2bffaec373a6004bb6ccc8a62cdd66061f7c6a";
const POOL_B = "0x787f3ebb965a7c5484d08b143809d8c4b043cd45";
const OWNER = "0xd8d6ea18fe17b0b1d0d873e547907b6eeac962fa";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env["OKX_API_KEY"];
  delete process.env["OKX_SECRET_KEY"];
  delete process.env["OKX_PASSPHRASE"];
  delete process.env["GMGN_API_KEY"];
});

/** Blocks every outbound call, proving a route was served from the store. */
function blockNetwork(): void {
  globalThis.fetch = (async () => {
    throw new Error("network disabled in test");
  }) as typeof globalThis.fetch;
}

function build(): { app: ReturnType<typeof createServer>; store: MemoryStore } {
  const store = new MemoryStore();
  const app = createServer({ scheduler: createScheduler(store), store });
  return { app, store };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envelope(body: unknown): Record<string, unknown> {
  assert.ok(isRecord(body), "response body must be an object");
  return body;
}

const TTL = { source: "test", freshForMs: 600_000, deadAfterMs: 3_600_000 };

async function putSecurity(store: MemoryStore, address: string): Promise<void> {
  const payload: StoredSecurity = {
    summary: { riskLevel: "warn", flags: ["mintable"], scannedAt: 1, source: "onchainos" },
    sources: [{ source: "onchainos", riskLevel: "warn", flags: ["mintable"] }],
  };
  await store.put(securityKey(address), payload, TTL);
}

function pool(address: string, token0: string, token1: string): PoolStats {
  return {
    pool: address,
    token0,
    token1,
    token0Symbol: "AAA",
    token1Symbol: "BBB",
    fee: 2500,
    liquidity: "1000",
    sqrtPriceX96: "2000",
    tick: 10,
    tvlUsd: 1000,
    volume24hUsd: 50,
    aprPct: 36.5,
    asOf: 1,
    source: "pancake",
  };
}

describe("GET /security/:address", () => {
  it("serves a stored verdict with its sources and staleness", async () => {
    const { app, store } = build();
    blockNetwork();
    await putSecurity(store, TOKEN);

    const res = await app.request(`/security/${TOKEN}`);
    assert.equal(res.status, 200);
    const body = envelope(await res.json());
    assert.deepEqual(body["data"], {
      riskLevel: "warn",
      flags: ["mintable"],
      scannedAt: 1,
      source: "onchainos",
    });
    const meta = envelope(body["meta"]);
    assert.equal(meta["address"], TOKEN);
    assert.equal(meta["staleness"], "fresh");
    assert.deepEqual(meta["sources"], [
      { source: "onchainos", riskLevel: "warn", flags: ["mintable"] },
    ]);
    await store.close();
  });

  it("accepts an explicit lane and echoes it", async () => {
    const { app, store } = build();
    blockNetwork();
    await putSecurity(store, TOKEN);

    const res = await app.request(`/security/${TOKEN}?lane=bstocks`);
    assert.equal(envelope(envelope(await res.json())["meta"])["lane"], "bstocks");
    await store.close();
  });

  it("infers the lane from the universe when none is given", async () => {
    const { app, store } = build();
    blockNetwork();
    await putSecurity(store, UNLISTED);
    const entries: UniverseEntry[] = [
      { address: UNLISTED, symbol: "PEPE", lane: "meme", source: "fourmeme" },
    ];
    await store.put(MEME_UNIVERSE_KEY, entries, TTL);

    const res = await app.request(`/security/${UNLISTED}`);
    assert.equal(envelope(envelope(await res.json())["meta"])["lane"], "meme");
    await store.close();
  });

  it("reads a static bStock as the bstocks lane, with its slower TTL", async () => {
    const { app, store } = build();
    blockNetwork();
    await putSecurity(store, TOKEN);

    const res = await app.request(`/security/${TOKEN}`);
    assert.equal(envelope(envelope(await res.json())["meta"])["lane"], "bstocks");
    await store.close();
  });

  it("falls back to the shortest-lived lane for an unknown token", async () => {
    const { app, store } = build();
    blockNetwork();
    await putSecurity(store, UNLISTED);

    const res = await app.request(`/security/${UNLISTED}`);
    assert.equal(envelope(envelope(await res.json())["meta"])["lane"], "meme");
    await store.close();
  });

  it("answers unavailable rather than erroring when nothing can be scanned", async () => {
    const { app, store } = build();
    blockNetwork();

    const res = await app.request(`/security/${TOKEN}`);
    assert.equal(res.status, 200);
    const data = envelope(envelope(await res.json())["data"]);
    assert.equal(data["riskLevel"], "unavailable");
    await store.close();
  });

  it("rejects a malformed address and an unknown lane", async () => {
    const { app, store } = build();
    blockNetwork();

    const bad = await app.request("/security/0xnope");
    assert.equal(bad.status, 400);
    assert.equal(envelope(envelope(await bad.json())["error"])["code"], "invalid_address");

    const lane = await app.request(`/security/${TOKEN}?lane=stonks`);
    assert.equal(lane.status, 400);
    assert.equal(envelope(envelope(await lane.json())["error"])["code"], "invalid_lane");
    await store.close();
  });
});

describe("GET /pools", () => {
  it("lists stored pools with their staleness", async () => {
    const { app, store } = build();
    await store.put(POOLS_INDEX_KEY, [POOL_A, POOL_B], TTL);
    await store.put(poolKey(POOL_A), pool(POOL_A, TOKEN, QUOTE), TTL);
    await store.put(poolKey(POOL_B), pool(POOL_B, QUOTE, QUOTE), TTL);

    const res = await app.request("/pools");
    assert.equal(res.status, 200);
    const body = envelope(await res.json());
    const data = body["data"];
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 2);
    assert.equal(envelope(data[0])["staleness"], "fresh");
    assert.equal(envelope(body["meta"])["total"], 2);
    await store.close();
  });

  it("filters on either side of the pair", async () => {
    const { app, store } = build();
    await store.put(POOLS_INDEX_KEY, [POOL_A, POOL_B], TTL);
    await store.put(poolKey(POOL_A), pool(POOL_A, TOKEN, QUOTE), TTL);
    await store.put(poolKey(POOL_B), pool(POOL_B, QUOTE, TOKEN), TTL);

    // Mixed case, to prove the filter normalizes before comparing.
    const res = await app.request(`/pools?token=0x02FCA66C1D1AFB4E2A7884261EB00F63598A7436`);
    const body = envelope(await res.json());
    assert.ok(Array.isArray(body["data"]));
    assert.equal(body["data"].length, 2);
    assert.equal(envelope(body["meta"])["token"], TOKEN);

    const none = await app.request("/pools?token=0x1111111111111111111111111111111111111111");
    assert.deepEqual(envelope(await none.json())["data"], []);
    await store.close();
  });

  it("returns an empty list before the job has ever run", async () => {
    const { app, store } = build();
    const body = envelope(await (await app.request("/pools")).json());
    assert.deepEqual(body["data"], []);
    assert.equal(envelope(body["meta"])["total"], 0);
    await store.close();
  });

  it("rejects a malformed token filter", async () => {
    const { app, store } = build();
    const res = await app.request("/pools?token=nope");
    assert.equal(res.status, 400);
    await store.close();
  });
});

describe("GET /venus/:owner", () => {
  const health: VenusHealth = {
    owner: OWNER,
    healthFactor: 1.6,
    tier: "HEALTHY",
    collateralValueUsd: 800,
    borrowValueUsd: 500,
    assets: [{ symbol: "vUSDT", supplyUsd: 1000, borrowUsd: 500 }],
    asOf: 1,
  };

  it("serves a tracked owner's stored position", async () => {
    const { app, store } = build();
    await store.put(venusKey(OWNER), health, { ...TTL, source: "venus" });

    const res = await app.request(`/venus/${OWNER.toUpperCase()}`);
    assert.equal(res.status, 200);
    const body = envelope(await res.json());
    assert.deepEqual(body["data"], health);
    assert.equal(envelope(body["meta"])["staleness"], "fresh");
    await store.close();
  });

  it("404s an untracked owner with a hint naming the operator key", async () => {
    const { app, store } = build();
    const res = await app.request(`/venus/${OWNER}`);
    assert.equal(res.status, 404);
    const error = envelope(envelope(await res.json())["error"]);
    assert.equal(error["code"], "not_found");
    assert.match(String(error["message"]), /tracked:venus-owners/u);
    await store.close();
  });

  it("rejects a malformed owner", async () => {
    const { app, store } = build();
    const res = await app.request("/venus/0xnope");
    assert.equal(res.status, 400);
    await store.close();
  });
});

describe("GET /snapshots/:key for the phase 2 prefixes", () => {
  it("serves the new data prefixes", async () => {
    const { app, store } = build();
    for (const key of [securityKey(TOKEN), poolKey(POOL_A), POOLS_INDEX_KEY, venusKey(OWNER)]) {
      await store.put(key, [], TTL);
      assert.equal((await app.request(`/snapshots/${key}`)).status, 200, `expected ${key} readable`);
    }
    await store.close();
  });

  it("still refuses the operator-controlled tracking keys", async () => {
    const { app, store } = build();
    await store.put("tracked:venus-owners", [OWNER], TTL);
    assert.equal((await app.request("/snapshots/tracked:venus-owners")).status, 404);
    await store.close();
  });
});
