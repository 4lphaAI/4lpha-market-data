import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import { createServer } from "../src/server.js";
import { emptyTokenSnapshot } from "../src/core/models.js";
import { klinesKey } from "../src/query/klines.js";
import { tokenKey } from "../src/jobs/tokenStore.js";
import { decimalsKey, type DecimalsReader, type TokenDecimals } from "../src/query/decimals.js";
import { COINS_UNIVERSE_KEY, MEME_UNIVERSE_KEY } from "../src/universe.js";

const ADDRESS = "0x75fd4cf6f8392e41e70391d60c90c0d5211603a1";
const MEME_ADDRESS = "0xaa00000000000000000000000000000000000001";
/** In the frozen allowlist under its `static` source. */
const USDT = "0x55d398326f99059ff775485246999027b3197955";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Blocks every outbound call, proving a route was served from the store. */
function blockNetwork(): void {
  globalThis.fetch = (async () => {
    throw new Error("network disabled in test");
  }) as typeof globalThis.fetch;
}

/**
 * The token route reads `decimals()` through on a cache miss, so every server
 * here is built with an offline reader. The default reports `unavailable`,
 * which is the honest "no chain in this process"; tests that care about the
 * number pass their own.
 */
function build(
  readTokenDecimals: DecimalsReader = async () => ({ kind: "unavailable" }),
): { app: ReturnType<typeof createServer>; store: MemoryStore } {
  const store = new MemoryStore();
  const app = createServer({ scheduler: createScheduler(store), store, readTokenDecimals });
  return { app, store };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envelope(body: unknown): Record<string, unknown> {
  assert.ok(isRecord(body), "response body must be an object");
  return body;
}

describe("GET /universe", () => {
  it("returns the merged universe with per-lane meta", async () => {
    const { app, store } = build();
    await store.put(
      MEME_UNIVERSE_KEY,
      [{ address: MEME_ADDRESS, symbol: "MEME", lane: "meme", source: "fourmeme" }],
      { source: "fourmeme", freshForMs: 60_000, deadAfterMs: 900_000 },
    );

    const res = await app.request("/universe");
    assert.equal(res.status, 200);

    const body = envelope(await res.json());
    assert.ok(Array.isArray(body["data"]));
    assert.equal(body["data"].length, 26);

    const meta = body["meta"];
    assert.ok(isRecord(meta));
    assert.equal(meta["total"], 26);
    const lanes = meta["lanes"];
    assert.ok(isRecord(lanes));
    assert.ok(isRecord(lanes["meme"]));
    assert.equal(lanes["meme"]["count"], 1);
    assert.equal(lanes["meme"]["staleness"], "fresh");
    await store.close();
  });

  it("filters by lane", async () => {
    const { app, store } = build();
    await store.put(
      COINS_UNIVERSE_KEY,
      [{ address: MEME_ADDRESS, symbol: "COIN", lane: "coins", source: "binance" }],
      { source: "binance", freshForMs: 60_000, deadAfterMs: 900_000 },
    );

    const res = await app.request("/universe?lane=coins");
    const body = envelope(await res.json());
    assert.ok(Array.isArray(body["data"]));
    assert.equal(body["data"].length, 1);
    await store.close();
  });

  it("serves the frozen allowlist lane in full", async () => {
    const { app, store } = build();
    blockNetwork();

    const res = await app.request("/universe?lane=allowlist");
    assert.equal(res.status, 200);

    const body = envelope(await res.json());
    const data = body["data"];
    assert.ok(Array.isArray(data));
    // 221 of the snapshot's 222: the BNB row is the `"native"` sentinel, which
    // has no contract address.
    assert.equal(data.length, 221);

    const meta = body["meta"];
    assert.ok(isRecord(meta));
    assert.equal(meta["total"], 221);
    assert.equal(meta["lane"], "allowlist");
    const lanes = meta["lanes"];
    assert.ok(isRecord(lanes));
    assert.ok(isRecord(lanes["allowlist"]));
    assert.equal(lanes["allowlist"]["count"], 221);
    assert.equal(lanes["allowlist"]["staleness"], "fresh");
    assert.equal(lanes["allowlist"]["asOf"], null);

    // Each row names its first `sources` entry, and the lane keeps the bStocks
    // the merged universe would otherwise have claimed for its own lane.
    assert.deepEqual(
      data.find((entry) => isRecord(entry) && entry["address"] === USDT),
      { address: USDT, symbol: "USDT", lane: "allowlist", source: "static" },
    );
    assert.deepEqual(
      data.find((entry) => isRecord(entry) && entry["address"] === ADDRESS),
      { address: ADDRESS, symbol: "AMDB", lane: "allowlist", source: "bstocks" },
    );
    await store.close();
  });

  it("rejects an unknown lane with 400", async () => {
    const { app, store } = build();
    const res = await app.request("/universe?lane=stonks");
    assert.equal(res.status, 400);
    const body = envelope(await res.json());
    assert.ok(isRecord(body["error"]));
    assert.equal(body["error"]["code"], "invalid_lane");
    await store.close();
  });
});

describe("GET /tokens/:address", () => {
  it("returns the stored snapshot with freshness meta", async () => {
    const { app, store } = build();
    const snapshot = { ...emptyTokenSnapshot(ADDRESS), priceUsd: 1.5, symbol: "AMDB" };
    await store.put(tokenKey(ADDRESS), snapshot, {
      source: "binance",
      freshForMs: 60_000,
      deadAfterMs: 900_000,
    });

    const res = await app.request(`/tokens/${ADDRESS.toUpperCase()}`);
    assert.equal(res.status, 200);

    const body = envelope(await res.json());
    assert.ok(isRecord(body["data"]));
    assert.equal(body["data"]["priceUsd"], 1.5);
    assert.ok(isRecord(body["meta"]));
    assert.equal(body["meta"]["source"], "binance");
    assert.equal(body["meta"]["staleness"], "fresh");
    await store.close();
  });

  it("404s for an unknown token and 400s for a malformed address", async () => {
    const { app, store } = build();

    const missing = await app.request(`/tokens/${ADDRESS}`);
    assert.equal(missing.status, 404);

    const malformed = await app.request("/tokens/0xnope");
    assert.equal(malformed.status, 400);
    const body = envelope(await malformed.json());
    assert.ok(isRecord(body["error"]));
    assert.equal(body["error"]["code"], "invalid_address");
    await store.close();
  });

  it("carries the chain decimals and caches them off the response path", async () => {
    let reads = 0;
    const { app, store } = build(async () => {
      reads += 1;
      return { kind: "answered", decimals: 6 };
    });
    await store.put(tokenKey(ADDRESS), emptyTokenSnapshot(ADDRESS), {
      source: "binance",
      freshForMs: 60_000,
      deadAfterMs: 900_000,
    });

    const first = envelope(await (await app.request(`/tokens/${ADDRESS}`)).json());
    assert.ok(isRecord(first["data"]));
    assert.equal(first["data"]["decimals"], 6);
    assert.ok(isRecord(first["meta"]));
    assert.equal(first["meta"]["decimalsSource"], "bsc-rpc");
    // The snapshot's own provenance is untouched by the added field.
    assert.equal(first["meta"]["source"], "binance");
    assert.deepEqual(first["data"]["updatedFields"], []);

    const second = envelope(await (await app.request(`/tokens/${ADDRESS}`)).json());
    assert.ok(isRecord(second["data"]));
    assert.equal(second["data"]["decimals"], 6);
    assert.equal(reads, 1, "second hit must be served from the cache");
    await store.close();
  });

  it("serves the rest of the payload when decimals cannot be read", async () => {
    const { app, store } = build(async () => {
      throw new Error("all rpc endpoints failed");
    });
    await store.put(tokenKey(ADDRESS), { ...emptyTokenSnapshot(ADDRESS), priceUsd: 1.5 }, {
      source: "binance",
      freshForMs: 60_000,
      deadAfterMs: 900_000,
    });

    const res = await app.request(`/tokens/${ADDRESS}`);
    assert.equal(res.status, 200);
    const body = envelope(await res.json());
    assert.ok(isRecord(body["data"]));
    assert.equal(body["data"]["decimals"], null);
    assert.equal(body["data"]["priceUsd"], 1.5);
    assert.ok(isRecord(body["meta"]));
    assert.equal(body["meta"]["decimalsSource"], null, "an unread field claims no producer");
    assert.equal(body["meta"]["staleness"], "fresh");
    // An outage is not a fact about the token, so it is never cached.
    assert.equal(await store.get<TokenDecimals>(decimalsKey(ADDRESS)), null);
    await store.close();
  });

  it("leaves the batch route's shape alone", async () => {
    const { app, store } = build(async () => ({ kind: "answered", decimals: 6 }));
    await store.put(tokenKey(ADDRESS), emptyTokenSnapshot(ADDRESS), {
      source: "binance",
      freshForMs: 60_000,
      deadAfterMs: 900_000,
    });

    const body = envelope(await (await app.request(`/tokens?addresses=${ADDRESS}`)).json());
    assert.ok(Array.isArray(body["data"]));
    const [row] = body["data"];
    assert.ok(isRecord(row));
    assert.ok(!("decimals" in row), "decimals belong to the single-token route only");
    await store.close();
  });
});

describe("GET /klines/:address", () => {
  it("serves cached candles without hitting an upstream", async () => {
    const { app, store } = build();
    blockNetwork();
    await store.put(
      klinesKey(ADDRESS, "1m", 100),
      [{ timestamp: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
      { source: "onchainos", freshForMs: 300_000, deadAfterMs: 3_600_000 },
    );

    const res = await app.request(`/klines/${ADDRESS}`);
    assert.equal(res.status, 200);

    const body = envelope(await res.json());
    assert.ok(Array.isArray(body["data"]));
    assert.equal(body["data"].length, 1);
    assert.ok(isRecord(body["meta"]));
    assert.equal(body["meta"]["interval"], "1m");
    assert.equal(body["meta"]["limit"], 100);
    assert.equal(body["meta"]["source"], "onchainos");
    await store.close();
  });

  it("honours interval and limit query parameters", async () => {
    const { app, store } = build();
    blockNetwork();
    await store.put(klinesKey(ADDRESS, "15m", 5), [], {
      source: "sintral",
      freshForMs: 300_000,
      deadAfterMs: 3_600_000,
    });

    const res = await app.request(`/klines/${ADDRESS}?interval=15m&limit=5`);
    const body = envelope(await res.json());
    assert.ok(isRecord(body["meta"]));
    assert.equal(body["meta"]["interval"], "15m");
    assert.equal(body["meta"]["source"], "sintral");
    await store.close();
  });

  it("validates address, interval and limit", async () => {
    const { app, store } = build();
    blockNetwork();

    assert.equal((await app.request("/klines/0xnope")).status, 400);
    assert.equal((await app.request(`/klines/${ADDRESS}?interval=7m`)).status, 400);
    assert.equal((await app.request(`/klines/${ADDRESS}?limit=501`)).status, 400);
    assert.equal((await app.request(`/klines/${ADDRESS}?limit=0`)).status, 400);
    assert.equal((await app.request(`/klines/${ADDRESS}?limit=abc`)).status, 400);
    await store.close();
  });

  it("404s when nothing is cached and every source fails", async () => {
    const { app, store } = build();
    blockNetwork();

    const res = await app.request(`/klines/${ADDRESS}?limit=10`);
    assert.equal(res.status, 404);
    await store.close();
  });
});

describe("GET /snapshots/:key", () => {
  it("returns an allowlisted record with its metadata", async () => {
    const { app, store } = build();
    await store.put("heartbeat", { ts: 1 }, {
      source: "heartbeat",
      freshForMs: 60_000,
      deadAfterMs: 300_000,
    });

    const res = await app.request("/snapshots/heartbeat");
    assert.equal(res.status, 200);
    const body = envelope(await res.json());
    assert.ok(isRecord(body["meta"]));
    assert.equal(body["meta"]["key"], "heartbeat");
    assert.equal(body["meta"]["staleness"], "fresh");
    await store.close();
  });

  it("serves every allowlisted prefix", async () => {
    const { app, store } = build();
    for (const key of [MEME_UNIVERSE_KEY, tokenKey(ADDRESS), klinesKey(ADDRESS, "1m", 10)]) {
      await store.put(key, [], { source: "test", freshForMs: 60_000, deadAfterMs: 900_000 });
      const res = await app.request(`/snapshots/${key}`);
      assert.equal(res.status, 200, `expected ${key} to be readable`);
    }
    await store.close();
  });

  it("404s for a key outside the allowlist even when it exists", async () => {
    const { app, store } = build();
    await store.put("tracked:addresses", [ADDRESS], {
      source: "operator",
      freshForMs: 60_000,
      deadAfterMs: 900_000,
    });

    assert.equal((await app.request("/snapshots/tracked:addresses")).status, 404);
    assert.equal((await app.request("/snapshots/heartbeat-extra")).status, 404);
    await store.close();
  });

  it("404s for an allowlisted key with no record", async () => {
    const { app, store } = build();
    assert.equal((await app.request(`/snapshots/${tokenKey(ADDRESS)}`)).status, 404);
    await store.close();
  });
});
