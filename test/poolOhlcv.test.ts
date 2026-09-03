import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { MemoryStore } from "../src/core/store.js";
import { createScheduler } from "../src/core/scheduler.js";
import { createServer } from "../src/server.js";
import { getPoolOhlcv, poolOhlcvKey } from "../src/query/poolOhlcv.js";

const POOL = "0xcc2bffaec373a6004bb6ccc8a62cdd66061f7c6a";
const originalFetch = globalThis.fetch;

function geckoResponse(): Response {
  const timestamp = Math.floor(Date.now() / 14_400_000) * 14_400 - 14_400;
  return new Response(JSON.stringify({
    data: { attributes: { ohlcv_list: [[timestamp, 1, 2, 0.5, 1.5, 10]] } },
    meta: { base: { address: "0x0000000000000000000000000000000000000001", symbol: "BASE" },
      quote: { address: "0x0000000000000000000000000000000000000002", symbol: "QUOTE" } },
  }));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("getPoolOhlcv", () => {
  it("maps canonical intervals and serves a fresh cache hit", async () => {
    const urls: URL[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(new URL(href));
      return geckoResponse();
    }) as typeof globalThis.fetch;
    const store = new MemoryStore();

    const first = await getPoolOhlcv(store, { poolAddress: POOL, interval: "4h", limit: 300 });
    const second = await getPoolOhlcv(store, { poolAddress: POOL, interval: "4h", limit: 300 });

    assert.equal(first?.source, "geckoterminal");
    assert.equal(first?.base?.symbol, "BASE");
    assert.equal(urls[0]?.pathname.endsWith("/ohlcv/hour"), true);
    assert.equal(urls[0]?.searchParams.get("aggregate"), "4");
    assert.equal(second?.candles.length, 1);
    assert.equal(urls.length, 1);
    assert.notEqual(await store.get(poolOhlcvKey(POOL, "4h", 300)), null);
    await store.close();
  });
});

describe("GET /pools/:address/ohlcv", () => {
  it("returns normalized candles and pair metadata", async () => {
    globalThis.fetch = (async () => {
      const raw = await geckoResponse().json() as { data: { attributes: { ohlcv_list: number[][] } } };
      raw.data.attributes.ohlcv_list[0]![0] = Math.floor(Date.now() / 900_000) * 900 - 900;
      return new Response(JSON.stringify(raw));
    }) as typeof globalThis.fetch;
    const store = new MemoryStore();
    const app = createServer({ scheduler: createScheduler(store), store });

    const response = await app.request(`/pools/${POOL}/ohlcv?interval=15m&limit=20`);
    const body = (await response.json()) as Record<string, Record<string, unknown> | unknown[]>;

    assert.equal(response.status, 200);
    assert.equal((body["data"] as unknown[]).length, 1);
    assert.equal((body["meta"] as Record<string, unknown>)["interval"], "15m");
    const meta = body["meta"] as Record<string, unknown>;
    const quote = meta["quote"] as Record<string, unknown>;
    assert.equal(quote["symbol"], "QUOTE");
    assert.equal(meta["priceCurrency"], "usd");
    assert.equal(meta["volumeCurrency"], "usd");
    assert.equal(meta["schemaVersion"], 2);
    assert.equal(meta["closedCandlesOnly"], true);
    await store.close();
  });

  it("validates the pool address, interval and limit", async () => {
    const store = new MemoryStore();
    const app = createServer({ scheduler: createScheduler(store), store });

    assert.equal((await app.request("/pools/nope/ohlcv")).status, 400);
    assert.equal((await app.request(`/pools/${POOL}/ohlcv?interval=7m`)).status, 400);
    assert.equal((await app.request(`/pools/${POOL}/ohlcv?limit=501`)).status, 400);
    assert.equal((await app.request(`/pools/${POOL}/ohlcv?currency=native`)).status, 400);
    await store.close();
  });
});
