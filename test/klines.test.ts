import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../src/core/store.js";
import { getKlines, klinesKey, parseInterval, SUPPORTED_INTERVALS } from "../src/query/klines.js";
import type { Candle } from "../src/core/models.js";

const ADDRESS = "0x75fd4cf6f8392e41e70391d60c90c0d5211603a1";

const originalFetch = globalThis.fetch;
const originalEnv = {
  OKX_API_KEY: process.env["OKX_API_KEY"],
  OKX_SECRET_KEY: process.env["OKX_SECRET_KEY"],
  OKX_PASSPHRASE: process.env["OKX_PASSPHRASE"],
  BIRDEYE_API_KEY: process.env["BIRDEYE_API_KEY"],
};

/** Manually advanced clock so freshness transitions are deterministic. */
function fakeClock(start = 1_700_000_000_000) {
  let value = start;
  return {
    now: (): number => value,
    advance(ms: number): void {
      value += ms;
    },
  };
}

interface Behaviour {
  onchainos?: "ok" | "fail" | "empty";
  sintral?: "ok" | "fail" | "empty";
  birdeye?: "ok" | "fail" | "empty";
}

interface Observed {
  hosts: string[];
  onchainosBar: string | null;
  sintralInterval: string | null;
  birdeyeType: string | null;
}

/** Installs a global fetch that routes by host, so the real chain order is exercised. */
function installFetch(behaviour: Behaviour): Observed {
  const observed: Observed = {
    hosts: [],
    onchainosBar: null,
    sintralInterval: null,
    birdeyeType: null,
  };

  globalThis.fetch = (async (input: string | URL | Request) => {
    const href =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    observed.hosts.push(url.host);

    if (url.host === "web3.okx.com") {
      observed.onchainosBar = url.searchParams.get("bar");
      return respond(behaviour.onchainos ?? "fail", {
        code: "0",
        data: [["1700000000000", "1", "2", "0.5", "1.5", "10", "15", "1"]],
      });
    }
    if (url.host === "dquery.sintral.io") {
      observed.sintralInterval = url.searchParams.get("interval");
      return respond(behaviour.sintral ?? "fail", {
        data: [["2", "3", "1", "2.5", "20", 1_700_000_060_000]],
      });
    }
    if (url.host === "public-api.birdeye.so") {
      observed.birdeyeType = url.searchParams.get("type");
      return respond(behaviour.birdeye ?? "fail", {
        data: { items: [{ unixTime: 1_700_000_120, o: 3, h: 4, l: 2, c: 3.5, v: 30 }] },
      });
    }
    throw new Error(`unexpected host ${url.host}`);
  }) as typeof globalThis.fetch;

  return observed;
}

function respond(mode: "ok" | "fail" | "empty", body: unknown): Response {
  if (mode === "fail") return new Response("upstream down", { status: 503 });
  if (mode === "empty") {
    return new Response(JSON.stringify({ code: "0", success: true, data: [] }), { status: 200 });
  }
  return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => {
  process.env["OKX_API_KEY"] = "unit-test-key";
  process.env["OKX_SECRET_KEY"] = "unit-test-secret";
  process.env["OKX_PASSPHRASE"] = "unit-test-passphrase";
  process.env["BIRDEYE_API_KEY"] = "unit-test-birdeye";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("parseInterval", () => {
  it("accepts every supported interval and rejects anything else", () => {
    for (const interval of SUPPORTED_INTERVALS) {
      assert.equal(parseInterval(interval), interval);
    }
    assert.equal(parseInterval("3m"), null);
    assert.equal(parseInterval(""), null);
    assert.equal(parseInterval(undefined), null);
    assert.equal(parseInterval("toString"), null);
  });
});

describe("getKlines", () => {
  it("serves a fresh cache hit without touching the network", async () => {
    const clock = fakeClock();
    const store = new MemoryStore(clock.now);
    const cached: Candle[] = [
      { timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ];
    await store.put(klinesKey(ADDRESS, "1m", 10), cached, {
      source: "onchainos",
      freshForMs: 300_000,
      deadAfterMs: 3_600_000,
    });
    const observed = installFetch({ onchainos: "ok" });

    const result = await getKlines(store, { address: ADDRESS, interval: "1m", limit: 10 });

    assert.ok(result !== null);
    assert.equal(result.staleness, "fresh");
    assert.equal(result.source, "onchainos");
    assert.deepEqual(result.candles, cached);
    assert.deepEqual(observed.hosts, []);
    await store.close();
  });

  it("prefers OnchainOS and writes the result back to the store", async () => {
    const store = new MemoryStore();
    const observed = installFetch({ onchainos: "ok", sintral: "ok", birdeye: "ok" });

    const result = await getKlines(store, { address: ADDRESS, interval: "15m", limit: 5 });

    assert.ok(result !== null);
    assert.equal(result.source, "onchainos");
    assert.equal(observed.onchainosBar, "15m");
    assert.deepEqual(observed.hosts, ["web3.okx.com"]);

    const stored = await store.get<Candle[]>(klinesKey(ADDRESS, "15m", 5));
    assert.ok(stored !== null);
    assert.equal(stored.source, "onchainos");
    assert.equal(stored.data.length, 1);
    await store.close();
  });

  it("falls through to Sintral when OnchainOS fails", async () => {
    const store = new MemoryStore();
    const observed = installFetch({ onchainos: "fail", sintral: "ok", birdeye: "ok" });

    const result = await getKlines(store, { address: ADDRESS, interval: "1h", limit: 5 });

    assert.ok(result !== null);
    assert.equal(result.source, "sintral");
    assert.equal(observed.onchainosBar, "1H");
    assert.equal(observed.sintralInterval, "1h");
    assert.deepEqual(observed.hosts, ["web3.okx.com", "dquery.sintral.io"]);
    await store.close();
  });

  it("falls through to Birdeye when the first two fail", async () => {
    const store = new MemoryStore();
    const observed = installFetch({ onchainos: "fail", sintral: "fail", birdeye: "ok" });

    const result = await getKlines(store, { address: ADDRESS, interval: "1d", limit: 5 });

    assert.ok(result !== null);
    assert.equal(result.source, "birdeye");
    assert.equal(observed.birdeyeType, "1D");
    assert.deepEqual(observed.hosts, [
      "web3.okx.com",
      "dquery.sintral.io",
      "public-api.birdeye.so",
    ]);
    await store.close();
  });

  it("treats an empty candle list as no data and keeps walking the chain", async () => {
    const store = new MemoryStore();
    const observed = installFetch({ onchainos: "empty", sintral: "empty", birdeye: "ok" });

    const result = await getKlines(store, { address: ADDRESS, interval: "5m", limit: 5 });

    assert.equal(result?.source, "birdeye");
    assert.equal(observed.hosts.length, 3);
    await store.close();
  });

  it("skips OnchainOS entirely when its credentials are absent", async () => {
    delete process.env["OKX_API_KEY"];
    const store = new MemoryStore();
    const observed = installFetch({ sintral: "ok" });

    const result = await getKlines(store, { address: ADDRESS, interval: "1m", limit: 5 });

    assert.equal(result?.source, "sintral");
    assert.deepEqual(observed.hosts, ["dquery.sintral.io"]);
    await store.close();
  });

  it("returns the stale record when every source fails", async () => {
    const clock = fakeClock();
    const store = new MemoryStore(clock.now);
    const cached: Candle[] = [
      { timestamp: 7, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ];
    await store.put(klinesKey(ADDRESS, "1m", 10), cached, {
      source: "sintral",
      freshForMs: 300_000,
      deadAfterMs: 3_600_000,
    });
    clock.advance(600_000);
    installFetch({ onchainos: "fail", sintral: "fail", birdeye: "fail" });

    const result = await getKlines(store, { address: ADDRESS, interval: "1m", limit: 10 });

    assert.ok(result !== null);
    assert.equal(result.staleness, "stale");
    assert.equal(result.source, "sintral");
    assert.deepEqual(result.candles, cached);
    await store.close();
  });

  it("returns null when every source fails and nothing is cached", async () => {
    const store = new MemoryStore();
    installFetch({ onchainos: "fail", sintral: "fail", birdeye: "fail" });

    const result = await getKlines(store, { address: ADDRESS, interval: "1m", limit: 10 });

    assert.equal(result, null);
    await store.close();
  });

  it("rejects a malformed address before any network call", async () => {
    const store = new MemoryStore();
    const observed = installFetch({ onchainos: "ok" });

    assert.equal(await getKlines(store, { address: "0xnope", interval: "1m", limit: 10 }), null);
    assert.deepEqual(observed.hosts, []);
    await store.close();
  });

  it("clamps the limit into the supported range", async () => {
    const store = new MemoryStore();
    installFetch({ onchainos: "ok" });

    const result = await getKlines(store, { address: ADDRESS, interval: "1m", limit: 5_000 });

    assert.equal(result?.limit, 500);
    assert.ok((await store.get(klinesKey(ADDRESS, "1m", 500))) !== null);
    await store.close();
  });
});
