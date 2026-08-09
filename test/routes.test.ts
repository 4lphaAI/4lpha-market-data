import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import { createServer } from "../src/server.js";
import { emptyTokenSnapshot } from "../src/core/models.js";
import { klinesKey } from "../src/query/klines.js";
import { tokenKey } from "../src/jobs/tokenStore.js";
import { COINS_UNIVERSE_KEY, MEME_UNIVERSE_KEY } from "../src/universe.js";

const ADDRESS = "0x75fd4cf6f8392e41e70391d60c90c0d5211603a1";
const MEME_ADDRESS = "0xaa00000000000000000000000000000000000001";

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
