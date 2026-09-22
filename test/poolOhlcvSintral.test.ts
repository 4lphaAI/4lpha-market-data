import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { MemoryStore } from "../src/core/store.js";
import { getPoolOhlcv } from "../src/query/poolOhlcv.js";
import { USD_ANCHOR } from "../src/jobs/majorsPrices.js";
import { poolKey } from "../src/adapters/pancake.js";
import type { PoolStats } from "../src/core/models.js";

const addr = (hex: string) => `0x${hex.padStart(40, "0")}`;
const POOL = "0x172fcd41e0913e95784454622d1c3724f546f849";
const TOKEN = addr("abc");
const OTHER_QUOTE = addr("dead");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const last15m = () => Math.floor(Date.now() / 900_000) * 900_000 - 900_000;
function sintralRow(timestamp = last15m()) { return [1, 2, 0.5, 1.5, 50, timestamp / 1000]; }
function gecko() {
  return json({ data: { attributes: { ohlcv_list: [[last15m() / 1000, 2, 4, 1, 3, 20]] } },
    meta: { base: { address: TOKEN, name: "T", symbol: "T" }, quote: { address: OTHER_QUOTE, name: "USDT", symbol: "USDT" } } });
}
const usEquityParams = { poolAddress: POOL, interval: "15m" as const, limit: 20, currency: "usd" as const, tokenAddress: TOKEN, usEquity: true };

describe("Sintral for usd+token pool requests (widened 2026-09-22, was usEquity-only per handoff §11)", () => {
  it("tries Sintral first for a usEquity pool on 15m/1h and reports its provenance", async () => {
    const store = new MemoryStore();
    const calls: string[] = [];
    globalThis.fetch = async (input) => { calls.push(new URL(String(input)).host); return json({ data: [sintralRow()] }); };
    const chart = await getPoolOhlcv(store, usEquityParams);
    assert.equal(chart!.source, "sintral");
    assert.equal(chart!.base.address, TOKEN);
    assert.equal(chart!.quote.address, USD_ANCHOR.address);
    assert.equal(chart!.priceCurrency, "usd");
    assert.equal(calls[0], "dquery.sintral.io");
  });
  it("falls through to Gecko when Sintral fails", async () => {
    const store = new MemoryStore();
    let sintralCalled = false;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.host === "dquery.sintral.io") { sintralCalled = true; return json({}, 500); }
      return gecko();
    };
    const chart = await getPoolOhlcv(store, usEquityParams);
    assert.ok(sintralCalled);
    assert.equal(chart!.source, "geckoterminal");
  });
  it("tries Sintral for an ordinary usd+token pool too, not just usEquity ones", async () => {
    const store = new MemoryStore();
    const hosts: string[] = [];
    globalThis.fetch = async (input) => { hosts.push(new URL(String(input)).host); return gecko(); };
    await getPoolOhlcv(store, { ...usEquityParams, usEquity: false });
    assert.ok(hosts.includes("dquery.sintral.io"));
  });
  it("tries Sintral on 1m and 5m too, not just 15m/1h", async () => {
    const store = new MemoryStore();
    const hosts: string[] = [];
    globalThis.fetch = async (input) => { hosts.push(new URL(String(input)).host); return gecko(); };
    await getPoolOhlcv(store, { ...usEquityParams, interval: "5m" });
    assert.ok(hosts.includes("dquery.sintral.io"));
  });
  it("never calls Sintral for an interval it has no mapping for (4h/1d)", async () => {
    const store = new MemoryStore();
    const hosts: string[] = [];
    globalThis.fetch = async (input) => { hosts.push(new URL(String(input)).host); return gecko(); };
    await getPoolOhlcv(store, { ...usEquityParams, interval: "4h" });
    assert.ok(!hosts.includes("dquery.sintral.io"));
  });
  it("never calls Sintral for a token-ratio request, even on a usEquity pool", async () => {
    const store = new MemoryStore();
    const hosts: string[] = [];
    globalThis.fetch = async (input) => { hosts.push(new URL(String(input)).host); return gecko(); };
    await getPoolOhlcv(store, { ...usEquityParams, currency: "token" });
    assert.ok(!hosts.includes("dquery.sintral.io"));
  });
  it("skips Sintral when a cached pool snapshot shows the token isn't one of its two legs", async () => {
    const store = new MemoryStore();
    const wrongToken = addr("bad");
    const stats: PoolStats = {
      pool: POOL, protocol: "v3", token0: TOKEN, token1: OTHER_QUOTE,
      token0Symbol: "T", token1Symbol: "USDT", fee: 100, liquidity: null, sqrtPriceX96: null, tick: null,
      tvlUsd: null, volume24hUsd: null, lpFeeApr24h: null, lpFeeApr7d: null, cakeFarmApr: null,
      combinedApr: null, aprSources: [], farm: null, tier: "unclassified",
      tokenOrigin: { token0: "unknown", token1: "unknown" }, asOf: 1, source: "pancake",
    };
    await store.put(poolKey(POOL), stats, { source: "pancake", freshForMs: 60_000, deadAfterMs: 600_000 });
    const hosts: string[] = [];
    globalThis.fetch = async (input) => { hosts.push(new URL(String(input)).host); return gecko(); };
    const chart = await getPoolOhlcv(store, { ...usEquityParams, tokenAddress: wrongToken, usEquity: false });
    assert.ok(!hosts.includes("dquery.sintral.io"));
    // Gecko also refuses it (identity mismatch) and there's nothing cached to fall back to.
    assert.equal(chart, null);
  });
});
