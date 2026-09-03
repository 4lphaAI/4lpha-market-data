import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { MemoryStore, PostgresStore, type PutOptions } from "../src/core/store.js";
import { FakePg } from "./fakePg.js";
import { OhlcvTransport } from "../src/adapters/ohlcvTransport.js";
import { fetchDexCandles, fetchDexPair } from "../src/adapters/dexPaprika.js";
import { aggregateCandles, getPoolOhlcv, normalizeChart, poolOhlcvDiagnostics, poolOhlcvKey } from "../src/query/poolOhlcv.js";

const POOL = "0x172fcd41e0913e95784454622d1c3724f546f849";
const A = "0x0000000000000000000000000000000000000001";
const B = "0x0000000000000000000000000000000000000002";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const pair = { base: { address: A, name: "A", symbol: "A" }, quote: { address: B, name: "B", symbol: "B" } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const urlOf = (input: string | URL | Request) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
const last = (ms = 60_000) => Math.floor(Date.now() / ms) * ms - ms;
const bar = (timestamp = last()) => ({ timestamp, open: 2, high: 4, low: 1, close: 3, volume: 20 });
function gecko(timestamp = last()) {
  return json({ data: { attributes: { ohlcv_list: [[timestamp / 1000, 2, 4, 1, 3, 20]] } }, meta: pair });
}
function dexDetail() { return json({ id: POOL, chain: "bsc", base_token_id: B, quote_token_id: A, tokens: [] }); }
function dexPage(url: URL, intervalMs = 60_000) {
  const end = Number(url.searchParams.get("end")) * 1000;
  return json([{ time_open: new Date(end - intervalMs).toISOString(), time_close: new Date(end).toISOString(),
    open: 0.5, high: 1, low: 0.25, close: 1 / 3, volume: 50 }]);
}
const params = { poolAddress: POOL, interval: "1m" as const, limit: 20, currency: "token" as const };

describe("exact-pool fallback", () => {
  it("coalesces concurrent limits and caches the shared 500-bucket view", async () => {
    const store = new MemoryStore(); let calls = 0;
    globalThis.fetch = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return gecko(); };
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => getPoolOhlcv(store, { ...params, limit: i + 1 })));
    assert.equal(calls, 1); assert.ok(results.every((r) => r?.candles[0]?.close === 3));
    await getPoolOhlcv(store, { ...params, limit: 500 });
    assert.equal(calls, 1); assert.equal(poolOhlcvDiagnostics(store).coalesced, 39);
    assert.equal(poolOhlcvKey(POOL, "1m", 10), poolOhlcvKey(POOL, "1m", 500));
  });
  it("bounds concurrent cold charts with fail-fast admission", async () => {
    const store = new MemoryStore(); let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    globalThis.fetch = async () => { if (++calls === 4) ready(); await gate; return gecko(); };
    const first = Array.from({ length: 4 }, (_, i) => getPoolOhlcv(store, {
      ...params, poolAddress: `0x${(i + 100).toString(16).padStart(40, "0")}`,
    }));
    try {
      await started;
      assert.equal(await getPoolOhlcv(store, params), null);
      assert.equal(calls, 4);
      assert.equal(poolOhlcvDiagnostics(store).admissionDenied, 1);
    } finally { release(); await Promise.all(first); }
  });
  it("does not cancel shared work when the first waiter aborts", async () => {
    const store = new MemoryStore(); const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++; controller.abort();
      assert.equal(init?.signal?.aborted, false);
      return gecko();
    };
    const [a, b] = await Promise.all([getPoolOhlcv(store, { ...params, signal: controller.signal }), getPoolOhlcv(store, params)]);
    assert.ok(a); assert.ok(b); assert.equal(calls, 1);
  });
  it("does not keep polling a closed daily chart before the next close", async () => {
    let ttl = 0;
    class ObservedStore extends MemoryStore {
      override async put(key: string, payload: unknown, opts: PutOptions) {
        ttl = opts.freshForMs; return super.put(key, payload, opts);
      }
    }
    const nextClose = last(86_400_000) + 172_800_000;
    globalThis.fetch = async () => gecko(last(86_400_000));
    assert.ok(await getPoolOhlcv(new ObservedStore(), { ...params, interval: "1d" }));
    assert.ok(ttl >= nextClose - Date.now());
    assert.ok(ttl <= 86_400_000);
  });
  it("falls through a Gecko 429 to two Dex pages and normalizes the inverse pair", async () => {
    const store = new MemoryStore(); const urls: URL[] = [];
    globalThis.fetch = async (input) => {
      const u = urlOf(input); urls.push(u);
      if (u.hostname === "api.geckoterminal.com") return json({}, 429);
      return u.pathname.endsWith("ohlcv") ? dexPage(u) : dexDetail();
    };
    const result = await getPoolOhlcv(store, params);
    assert.equal(result?.source, "dexpaprika"); assert.equal(result?.base.address, A);
    assert.equal(result?.quote.address, B); assert.equal(result?.candles.at(-1)?.close, 3);
    assert.equal(result?.candles.at(-1)?.high, 4); assert.equal(result?.candles.at(-1)?.low, 1);
    assert.equal(result?.candles.at(-1)?.volume, null);
    assert.equal(result?.volumeUnavailableReason, "provider_volume_unit_unverified");
    const pages = urls.filter((u) => u.pathname.endsWith("ohlcv"));
    assert.equal(pages.length, 2);
    assert.equal(pages[0]?.searchParams.get("start"), pages[1]?.searchParams.get("end"));
  });
  it("does not mix a price ratio into legacy USD requests", async () => {
    const store = new MemoryStore(); let calls = 0;
    globalThis.fetch = async (input) => { calls++; assert.equal(urlOf(input).hostname, "api.geckoterminal.com"); return json({}, 429); };
    assert.equal(await getPoolOhlcv(store, { ...params, currency: "usd" }), null);
    assert.equal(calls, 1);
  });
  it("preserves the old cache timestamp when both providers fail, and suppresses immediate retries", async () => {
    const now = Date.now(); const store = new MemoryStore(() => now - 180_000);
    const data = normalizeChart([bar(last() - 180_000)], pair, "token", "geckoterminal", 0, Date.now(), 60_000);
    await store.put(poolOhlcvKey(POOL, "1m", undefined, "token"), data, { source: "geckoterminal", freshForMs: 0, deadAfterMs: 86_400_000 });
    let calls = 0; globalThis.fetch = async () => { calls++; return json({}, 503); };
    const first = await getPoolOhlcv(store, params); const second = await getPoolOhlcv(store, params);
    assert.equal(first?.asOf, now - 180_000); assert.equal(second?.asOf, first?.asOf);
    assert.equal(first?.staleness, "stale"); assert.equal(calls, 2);
  });
  it("discards an incomplete Dex paging pass", async () => {
    const store = new MemoryStore(); let pages = 0;
    globalThis.fetch = async (input) => {
      const u = urlOf(input);
      if (u.hostname.includes("gecko")) return json({}, 503);
      if (!u.pathname.endsWith("ohlcv")) return dexDetail();
      return ++pages === 1 ? dexPage(u) : json({}, 503);
    };
    assert.equal(await getPoolOhlcv(store, params), null);
    assert.equal(await store.get(poolOhlcvKey(POOL, "1m", undefined, "token")), null);
  });
  it("fetches six non-overlapping hourly windows for 500 four-hour buckets", async () => {
    const store = new MemoryStore(); let pages = 0;
    globalThis.fetch = async (input) => {
      const u = urlOf(input);
      if (u.hostname.includes("gecko")) return json({}, 503);
      if (!u.pathname.endsWith("ohlcv")) return dexDetail();
      pages++; assert.equal(u.searchParams.get("interval"), "1h"); return dexPage(u, 3_600_000);
    };
    const result = await getPoolOhlcv(store, { ...params, interval: "4h", limit: 500 });
    assert.equal(pages, 6); assert.equal(result?.source, "dexpaprika");
    assert.ok(result?.candles.every((row) => row.timestamp % 14_400_000 === 0));
  });
  it("bounds daily pages to one year and reserves an inclusive boundary slot", async () => {
    let pages = 0;
    globalThis.fetch = async (input) => {
      const u = urlOf(input);
      if (u.hostname.includes("gecko")) return json({}, 503);
      if (!u.pathname.endsWith("ohlcv")) return dexDetail();
      const buckets = (Number(u.searchParams.get("end")) - Number(u.searchParams.get("start"))) / 86_400;
      assert.ok(buckets <= 365);
      assert.equal(Number(u.searchParams.get("limit")), buckets + 1);
      pages++; return dexPage(u, 86_400_000);
    };
    assert.ok(await getPoolOhlcv(new MemoryStore(), { ...params, interval: "1d" }));
    assert.equal(pages, 2);
  });
  it("rejects stale upstream history instead of stamping it fresh", async () => {
    const store = new MemoryStore();
    globalThis.fetch = async (input) => urlOf(input).hostname.includes("gecko") ? gecko(last() - 3_600_000) : json({}, 404);
    assert.equal(await getPoolOhlcv(store, params), null);
  });
  it("ignores ambiguous legacy caches", async () => {
    const store = new MemoryStore();
    await store.put(`pool:ohlcv:${POOL}:1m:20`, { candles: [bar()] }, { source: "geckoterminal", freshForMs: 60_000, deadAfterMs: 86_400_000 });
    globalThis.fetch = async () => json({}, 503);
    assert.equal(await getPoolOhlcv(store, params), null);
  });
  it("keeps closed bars only and does not mutate or forward-fill gaps", () => {
    const bars = [bar(60_000), bar(180_000), bar(240_000)];
    const chart = normalizeChart(bars, pair, "token", "geckoterminal", 0, 240_000, 60_000);
    assert.deepEqual(chart.candles.map((r) => r.timestamp), [60_000, 180_000]);
    assert.equal(bars.length, 3);
  });
  it("aggregates high/low/open/close chronologically", () => {
    const result = aggregateCandles([{ ...bar(3_600_000), open: 3, close: 4, high: 5 }, bar(0)], 14_400_000);
    assert.deepEqual(result, [{ timestamp: 0, open: 2, close: 4, high: 5, low: 1, volume: 40 }]);
  });
});

describe("OHLCV transport protection", () => {
  it("shares the rolling request budget between independent replicas", async () => {
    const pg = new FakePg();
    const a = await PostgresStore.create("postgres://unused", { client: pg });
    const b = await PostgresStore.create("postgres://unused", { client: pg });
    let calls = 0; const raw: typeof fetch = async () => { calls++; return json({}); };
    const clients = [new OhlcvTransport(a).fetch("geckoterminal", raw), new OhlcvTransport(b).fetch("geckoterminal", raw)];
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => clients[i % 2]!("https://unused"))
      .map((call) => call.then(() => true, () => false)));
    assert.equal(calls, 8); assert.equal(results.filter(Boolean).length, 8);
  });
  it("persists Retry-After and rejects calls during cooldown without hitting upstream", async () => {
    let now = Date.now(); const store = new MemoryStore(() => now); let calls = 0;
    const raw: typeof fetch = async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after": "120" } }); };
    await new OhlcvTransport(store, () => now).fetch("geckoterminal", raw)("https://unused");
    now += 61_000;
    await assert.rejects(new OhlcvTransport(store, () => now).fetch("geckoterminal", raw)("https://unused"), /cooling down/);
    assert.equal(calls, 1);
  });
  it("treats 402 as monthly quota exhaustion and preserves bigint TTLs in Postgres", async () => {
    const pg = new FakePg(); const store = await PostgresStore.create("postgres://unused", { client: pg });
    const reset = Date.now() + 30 * 86_400_000;
    await new OhlcvTransport(store).fetch("dexpaprika", async () => json({ resets_at: new Date(reset).toISOString() }, 402))("https://unused");
    const saved = await store.get<{ until: number }>("ohlcv-control:dexpaprika:cooldown:402");
    assert.equal(saved?.data.until, reset);
    await assert.rejects(new OhlcvTransport(store).fetch("dexpaprika", async () => { assert.fail("must not retry"); })("https://unused"), /cooling down/);
  });
});

describe("DexPaprika adapter validation", () => {
  it("rejects metadata for another pool", async () => {
    await assert.rejects(fetchDexPair({ poolAddress: POOL, fetchFn: async () => json({ id: A, chain: "bsc" }) }), /identity/);
  });
  it("rejects malformed candles and discards duplicate boundary bars", async () => {
    const u = new URL("https://unused?end=120");
    const sample = await dexPage(u).json() as unknown[];
    const result = await fetchDexCandles({ poolAddress: POOL, interval: "1m", start: 0, end: 120, limit: 2,
      fetchFn: async () => json([...sample, ...sample]) });
    assert.equal(result.length, 1);
    await assert.rejects(fetchDexCandles({ poolAddress: POOL, interval: "1m", start: 0, end: 120, limit: 2,
      fetchFn: async () => json([{ time_open: "invalid" }]) }), /invalid candle/);
  });
  it("sends an optional key only in Authorization, never in the URL", async () => {
    const previous = process.env["DEXPAPRIKA_API_KEY"];
    process.env["DEXPAPRIKA_API_KEY"] = "test-only-key";
    try {
      await fetchDexPair({ poolAddress: POOL, fetchFn: async (input, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), "test-only-key");
        assert.ok(!urlOf(input).href.includes("test-only-key")); return dexDetail();
      } });
    } finally { if (previous === undefined) delete process.env["DEXPAPRIKA_API_KEY"]; else process.env["DEXPAPRIKA_API_KEY"] = previous; }
  });
});
