import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateFeatures, featureKey, FEATURE_INDEX_KEY, poolFeatureInput, readTradingFeatures,
  type FeatureInput, type FeatureSnapshot } from "../src/query/tradingFeatures.js";
import { runTradingFeatures, FEATURE_WATCHLIST_KEY, FEATURE_STATE_KEY, featureSelection } from "../src/jobs/tradingFeatures.js";
import { MemoryStore, PostgresStore, type SnapshotStore } from "../src/core/store.js";
import { FakePg } from "./fakePg.js";
import { getPoolOhlcv, normalizeChart, poolOhlcvKey, type PoolOhlcvResult } from "../src/query/poolOhlcv.js";
import { createServer } from "../src/server.js";
import { createScheduler } from "../src/core/scheduler.js";
import { fetchDexCandles } from "../src/adapters/dexPaprika.js";
import { normalizeGeckoPoolOhlcv } from "../src/adapters/geckoTerminal.js";

const POOL = "0x0000000000000000000000000000000000000010";
const BASE = "0x0000000000000000000000000000000000000001";
const QUOTE = "0x0000000000000000000000000000000000000002";
const CLOSE = 1_800_000_000_000;
const NOW = CLOSE + 20_000;
const STEP = 300_000;
function input(count = 120): FeatureInput {
  return { chainId: 56, poolAddress: POOL, baseAddress: BASE, quoteAddress: QUOTE, priceCurrency: "usd",
    volumeCurrency: "usd", volumeUnavailableReason: null, source: "geckoterminal", interval: "5m",
    observedAt: NOW - 1000, conflictingTimestamps: [],
    candles: Array.from({ length: count }, (_, i) => ({ timestamp: CLOSE - (count - i) * STEP,
      open: 100, high: i === count - 1 ? 111 : 101, low: 99, close: i === count - 1 ? 110 : 100, volume: i === count - 1 ? 30 : 10 })) };
}
function near(actual: number | null, expected: number) { assert.ok(actual !== null && Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`); }
function chart(data = input()): PoolOhlcvResult {
  return { schemaVersion: 2, candles: data.candles, base: { address: data.baseAddress, symbol: "BASE", name: "Base" },
    quote: { address: data.quoteAddress, symbol: "QUOTE", name: "Quote" }, priceCurrency: data.priceCurrency,
    volumeCurrency: "usd", volumeUnavailableReason: data.volumeUnavailableReason, poolAddress: data.poolAddress,
    interval: data.interval, limit: 500, source: data.source, asOf: data.observedAt, staleness: "fresh" };
}
async function configure(store: SnapshotStore, pools = [POOL]) {
  await store.put(FEATURE_WATCHLIST_KEY, pools.map((pool) => ({ pool, currency: "usd" })), { source: "test", freshForMs: 60_000, deadAfterMs: 60_000 });
}

describe("deterministic closed trading features", () => {
  it("matches independent last-bar shock arithmetic for all seven outputs", () => {
    // 119 flat closes seed both EMAs at 100 and Wilder ATR at 2.
    // Last close jumps to 110: EMA += 10*alpha, TR=12, ATR=(26+12)/14.
    const result = calculateFeatures(input(), NOW);
    near(result.metrics.roc10Pct.value, 10);
    near(result.metrics.ema12.value, 100 + 20 / 13);
    near(result.metrics.ema26.value, 100 + 20 / 27);
    near(result.metrics.emaSpreadPct.value, ((100 + 20 / 13) / (100 + 20 / 27) - 1) * 100);
    near(result.metrics.atr14.value, 19 / 7);
    near(result.metrics.atrPct.value, (19 / 7) / 110 * 100);
    near(result.metrics.rvol20.value, 3);
    assert.equal(result.volume.baseline, 10);
    assert.equal(result.volume.usableBaselineBars, 20);
    assert.equal(result.coverage.contiguousBars, 120);
    assert.equal(result.evaluationClose, CLOSE);
  });
  it("pins bounded EMA and ATR history independently of older bars", () => {
    const data = input(500);
    for (const bar of data.candles.slice(0, 380)) Object.assign(bar, { open: 1000, high: 1001, low: 999, close: 1000 });
    assert.deepEqual(calculateFeatures(data, NOW).metrics, calculateFeatures(input(), NOW).metrics);
    assert.equal(calculateFeatures(input(119), NOW).metrics.ema26.reason, "insufficient_history");
    assert.equal(calculateFeatures(input(15), NOW).metrics.atr14.requiredBars, 120);
    assert.equal(calculateFeatures(input(11), NOW).metrics.roc10Pct.available, true);
  });
  it("uses close + publication lag, never blindly drops the last element", () => {
    const data = input(121); data.observedAt = CLOSE;
    assert.equal(calculateFeatures(data, CLOSE).evaluationClose, CLOSE - STEP);
    assert.equal(calculateFeatures(data, CLOSE + 14_999).evaluationClose, CLOSE - STEP);
    assert.equal(calculateFeatures(data, CLOSE + 15_000).evaluationClose, CLOSE);
    data.candles.push({ ...data.candles.at(-1)!, timestamp: CLOSE });
    assert.equal(calculateFeatures(data, NOW).coverage.excludedUnclosedBars, 1);
    assert.equal(calculateFeatures(data, NOW).evaluationClose, CLOSE);
  });
  it("does not replay a provider revision before its observation time", () => {
    const data = input(); data.observedAt = NOW + 1;
    assert.equal(calculateFeatures(data, NOW).metrics.ema12.reason, "observation_after_evaluation");
    const capturedOpen = input(); capturedOpen.observedAt = CLOSE - 1;
    assert.equal(calculateFeatures(capturedOpen, NOW).coverage.excludedUnclosedBars, 1);
    assert.equal(calculateFeatures(capturedOpen, NOW).evaluationClose, CLOSE - STEP);
  });
  it("sorts unordered history, accepts identical duplicates and quarantines conflicts", () => {
    const data = input(); data.candles.reverse(); data.candles.push({ ...data.candles[0]! });
    const result = calculateFeatures(data, NOW);
    near(result.metrics.rvol20.value, 3);
    assert.equal(result.coverage.identicalDuplicates, 1);
    data.candles.push({ ...data.candles[0]!, close: 109 });
    assert.equal(calculateFeatures(data, NOW).metrics.ema12.reason, "conflicting_revision");
  });
  it("rejects bad OHLC, infinity, fractional and unaligned timestamps", () => {
    for (const patch of [{ high: 90 }, { low: 105 }, { open: 0 }, { close: Infinity }, { high: NaN },
      { timestamp: CLOSE - STEP + 0.5 }, { timestamp: CLOSE - STEP + 1 }]) {
      const data = input(); Object.assign(data.candles.at(-1)!, patch);
      assert.equal(calculateFeatures(data, NOW).metrics.ema12.reason, "invalid_bar");
    }
  });
  it("reports holes instead of filling them and permits shorter valid feature windows", () => {
    const data = input(121); data.candles.splice(110, 1);
    const result = calculateFeatures(data, NOW);
    assert.equal(result.coverage.missingBuckets, 1);
    assert.equal(result.coverage.contiguousBars, 10);
    assert.equal(result.metrics.roc10Pct.reason, "gap");
    const olderHole = input(); olderHole.candles.splice(10, 1);
    assert.equal(calculateFeatures(olderHole, NOW).metrics.rvol20.available, true);
  });
  it("distinguishes unknown volume, zero target, zero baseline and invalid volume", () => {
    const data = input(); data.candles.at(-1)!.volume = 0;
    assert.equal(calculateFeatures(data, NOW).metrics.rvol20.value, 0);
    for (const b of data.candles) b.volume = 0;
    assert.equal(calculateFeatures(data, NOW).metrics.rvol20.reason, "zero_baseline");
    data.candles.at(-1)!.volume = null;
    assert.equal(calculateFeatures(data, NOW).metrics.rvol20.reason, "invalid_volume");
    data.volumeUnavailableReason = "provider_volume_unit_unverified";
    assert.equal(calculateFeatures(data, NOW).metrics.rvol20.reason, "unknown_volume_unit");
    assert.equal(calculateFeatures(data, NOW).metrics.ema12.available, true);
    data.volumeUnavailableReason = null; data.candles.at(-1)!.volume = -1;
    assert.equal(calculateFeatures(data, NOW).metrics.rvol20.reason, "invalid_volume");
  });
  it("returns observed flat ATR zero and catches overflowing ratios", () => {
    const data = input(); for (const b of data.candles) Object.assign(b, { open: 100, high: 100, low: 100, close: 100 });
    assert.equal(calculateFeatures(data, NOW).metrics.atr14.value, 0);
    data.candles.at(-11)!.close = Number.MIN_VALUE; data.candles.at(-11)!.low = Number.MIN_VALUE;
    assert.equal(calculateFeatures(data, NOW).metrics.roc10Pct.reason, "numeric_overflow");
  });
  it("excludes stale successful input and binds IDs to pool, source and denomination", () => {
    const data = input();
    assert.equal(calculateFeatures(data, CLOSE + STEP + 90_000).metrics.rvol20.reason, "stale_input");
    const first = calculateFeatures(data, NOW);
    for (const patch of [{ poolAddress: BASE }, { source: "dexpaprika" }, { priceCurrency: "token" as const }]) {
      const other = calculateFeatures({ ...data, ...patch }, NOW);
      assert.notEqual(first.seriesId, other.seriesId); assert.notEqual(first.snapshotId, other.snapshotId);
    }
    assert.equal(calculateFeatures({ ...data, baseAddress: QUOTE }, NOW).metrics.ema12.reason, "invalid_identity");
  });
  it("preserves conflicting provider evidence through the existing chart normalizer", () => {
    const data = input();
    const pair = { base: { address: BASE, name: null, symbol: null }, quote: { address: QUOTE, name: null, symbol: null } };
    const raw = data.candles.map((b) => ({ ...b, volume: b.volume! }));
    raw.push({ ...raw.at(-1)!, close: 109 });
    const normalized = normalizeChart(raw, pair, "usd", "geckoterminal", CLOSE - 120 * STEP, CLOSE, STEP);
    const result = calculateFeatures(poolFeatureInput({ ...chart(), ...normalized }, "5m"), NOW);
    assert.equal(result.metrics.rvol20.reason, "conflicting_revision");
  });
  it("rejects conflicting Dex revisions before deduplication and fractional Gecko timestamps", async () => {
    const row = { time_open: new Date(CLOSE - STEP).toISOString(), open: 100, high: 111, low: 99, close: 110, volume: 10 };
    await assert.rejects(fetchDexCandles({ poolAddress: POOL, interval: "5m", start: (CLOSE - STEP) / 1000, end: CLOSE / 1000, limit: 2,
      fetchFn: async () => new Response(JSON.stringify([row, { ...row, close: 109 }])) }), /conflicting candle revision/);
    const normalized = normalizeGeckoPoolOhlcv({ data: { attributes: { ohlcv_list: [
      [(CLOSE - STEP) / 1000 + 0.0001, 100, 101, 99, 100, 10],
      [(CLOSE - STEP) / 1000, 100, 101, 99, 100, 10],
    ] } } });
    assert.equal(normalized.candles.length, 1);
  });
  it("keeps price features available on inverted fallback with unavailable volume", () => {
    const data = input(); const pair = { base: { address: QUOTE, name: null, symbol: null }, quote: { address: BASE, name: null, symbol: null } };
    const normalized = normalizeChart(data.candles.map((b) => ({ ...b, volume: b.volume! })), pair, "token", "dexpaprika", CLOSE - 120 * STEP, CLOSE, STEP);
    const result = calculateFeatures(poolFeatureInput({ ...chart(), ...normalized, source: "dexpaprika" }, "5m"), NOW);
    assert.equal(result.metrics.ema12.available, true);
    assert.equal(result.metrics.rvol20.reason, "unknown_volume_unit");
    near(result.metrics.roc10Pct.value, (100 / 110 - 1) * 100);
  });
});

describe("explicit trading target", () => {
  it("keeps the same explicit ratio target across Gecko 429 and reversed Dex metadata", async () => {
    const fetch = globalThis.fetch;
    const end = Math.floor(Date.now() / STEP) * STEP;
    const bars = Array.from({length: 500}, (_, i) => ({ timestamp: end - (500-i)*STEP, open: 2, high: 4, low: 1, close: 2, volume: 10 }));
    let failGecko = false, dexCalls = 0;
    globalThis.fetch = async (request) => {
      const url = new URL(String(request));
      if (url.hostname.includes("gecko")) {
        assert.equal(url.searchParams.get("token"), "base");
        if (failGecko) return new Response("{}", {status: 429});
        return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: bars.map(b=>[b.timestamp/1000,b.open,b.high,b.low,b.close,b.volume]) } },
          meta: {base: {address: BASE}, quote: {address: QUOTE}} }));
      }
      dexCalls++;
      if (!url.pathname.endsWith("ohlcv")) return new Response(JSON.stringify({id: POOL,chain:"bsc",base_token_id:QUOTE,quote_token_id:BASE,tokens:[]}));
      const start = Number(url.searchParams.get("start"))*1000, finish=Number(url.searchParams.get("end"))*1000;
      return new Response(JSON.stringify(bars.filter(b=>b.timestamp>=start&&b.timestamp<finish).map(b=>({time_open:new Date(b.timestamp).toISOString(),
        open:1/b.open,high:1/b.low,low:1/b.high,close:1/b.close,volume:10}))));
    };
    try {
      const params = {poolAddress:POOL,interval:"5m" as const,currency:"token" as const,tokenAddress:QUOTE,limit:500};
      const primary = await getPoolOhlcv(new MemoryStore(), params);
      failGecko = true;
      const store = new MemoryStore();
      const fallback = await getPoolOhlcv(store, params);
      assert.equal(fallback!.source,"dexpaprika"); assert.equal(dexCalls,3);
      assert.equal(fallback!.base.address,QUOTE); assert.equal(fallback!.quote.address,BASE);
      assert.equal(fallback!.priceCurrency,"token"); assert.equal(fallback!.candles.at(-1)!.high,1);
      const a=calculateFeatures(poolFeatureInput(primary!,"5m"),Date.now());
      const b=calculateFeatures(poolFeatureInput(fallback!,"5m"),Date.now());
      for (const name of ["roc10Pct","ema12","ema26","emaSpreadPct","atr14","atrPct"] as const) {
        assert.equal(b.metrics[name].available,true); near(b.metrics[name].value,a.metrics[name].value!);
      }
      assert.equal(b.metrics.rvol20.reason,"unknown_volume_unit");
      assert.notEqual(a.seriesId,b.seriesId);
      await getPoolOhlcv(store,{...params,limit:10}); assert.equal(dexCalls,3);
    } finally { globalThis.fetch=fetch; }
  });
  it("defaults seeds to ratios while preserving explicit USD selections", async () => {
    const store = new MemoryStore();
    assert.ok((await featureSelection(store)).pools.every(p=>p.currency==="token"));
    await configure(store);
    assert.ok((await featureSelection(store)).pools.every(p=>p.currency==="usd"));
    await store.put(FEATURE_WATCHLIST_KEY,[{pool:POOL,currency:"token",tokenAddress:QUOTE}],{source:"test",freshForMs:60000,deadAfterMs:60000});
    assert.equal((await featureSelection(store)).pools[0]!.tokenAddress,QUOTE);
  });
  it("requests USD target without reciprocating USD or contaminating chart cache", async () => {
    const fetch = globalThis.fetch;
    const store = new MemoryStore();
    let calls = 0;
    const close = Math.floor(Date.now() / STEP) * STEP;
    globalThis.fetch = async (url) => {
      calls++;
      const requested = new URL(String(url)).searchParams.get("token");
      const price = requested === QUOTE ? 600 : 1;
      return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [[(close - STEP) / 1000, price, price, price, price, 100]] } },
        meta: { base: { address: BASE }, quote: { address: QUOTE } } }));
    };
    try {
      const targeted = await getPoolOhlcv(store, { poolAddress: POOL, interval: "5m", limit: 500, tokenAddress: QUOTE });
      assert.equal(targeted!.base.address, QUOTE); assert.equal(targeted!.quote.address, BASE);
      assert.equal(targeted!.candles[0]!.close, 600); assert.equal(targeted!.candles[0]!.volume, 100);
      const oldChart = await getPoolOhlcv(store, { poolAddress: POOL, interval: "5m", limit: 10 });
      assert.equal(oldChart!.base.address, BASE); assert.equal(oldChart!.candles[0]!.close, 1);
      await getPoolOhlcv(store, { poolAddress: POOL, interval: "5m", limit: 20, tokenAddress: QUOTE });
      assert.equal(calls, 2);
      assert.notEqual(poolOhlcvKey(POOL, "5m"), poolOhlcvKey(POOL, "5m", 500, "usd", QUOTE));
      assert.equal(await getPoolOhlcv(store, { poolAddress: POOL, interval: "5m", limit: 20, tokenAddress: POOL }), null);
      assert.equal(await getPoolOhlcv(store, { poolAddress: POOL, interval: "5m", limit: 20, currency: "token", tokenAddress: "invalid" }), null);
    } finally { globalThis.fetch = fetch; }
  });
});

describe("bounded feature producer and store-only delivery", () => {
  it("rejects invalid and oversized configuration before upstream work", async () => {
    const store = new MemoryStore();
    await configure(store, Array(11).fill(POOL) as string[]);
    await assert.rejects(featureSelection(store), /maximum 10/);
    await configure(store, ["bad"]); await assert.rejects(featureSelection(store), /identity/);
    await configure(store, [POOL, POOL]); await assert.rejects(featureSelection(store), /identity/);
  });
  it("caps each pass, fairly advances attempts, and isolates missing pools", async () => {
    let time = NOW; const store = new MemoryStore(() => time);
    const pools = [POOL, BASE, QUOTE]; await configure(store, pools);
    const calls: string[] = [];
    const load: typeof import("../src/query/poolOhlcv.js").getPoolOhlcv = async (_store, p) => {
      calls.push(`${p.poolAddress}:${p.interval}`);
      return p.poolAddress === POOL ? null : { ...chart(), poolAddress: p.poolAddress, interval: p.interval };
    };
    const first = await runTradingFeatures(store, AbortSignal.timeout(1000), { now: () => time, load });
    assert.equal(first.attempted, 4); assert.equal(calls.length, 4);
    assert.equal((await runTradingFeatures(store, AbortSignal.timeout(1000), { now: () => time, load })).attempted, 0);
    time += 61_000;
    await runTradingFeatures(store, AbortSignal.timeout(1000), { now: () => time, load });
    assert.equal(new Set(calls).size, 8);
    assert.equal(Object.keys((await store.get<Record<string, unknown>>(FEATURE_STATE_KEY))!.data).length, 9);
  });
  it("does not write a success after cancellation or restamp stale history", async () => {
    const store = new MemoryStore(() => NOW); await configure(store);
    const signal = new AbortController(); signal.abort();
    await assert.rejects(runTradingFeatures(store, signal.signal));
    await assert.rejects(runTradingFeatures(store, AbortSignal.timeout(1000), { now: () => NOW, load: async () => ({ ...chart(), staleness: "stale" }) }), /unavailable/);
    assert.equal(await store.get(featureKey(POOL, "5m")), null);
  });
  it("shares producer admission across replicas, persists replay evidence and expires by input age in Postgres", async () => {
    let time = NOW; const pg = new FakePg();
    const store = await PostgresStore.create("unused", { client: pg, now: () => time });
    const replica = await PostgresStore.create("unused", { client: pg, now: () => time });
    await configure(store);
    let calls = 0;
    const load = async () => { calls++; return chart(); };
    await Promise.all([runTradingFeatures(store, AbortSignal.timeout(1000), { now: () => time, load }),
      runTradingFeatures(replica, AbortSignal.timeout(1000), { now: () => time, load })]);
    assert.equal(calls, 3);
    const saved = (await store.get<FeatureSnapshot>(featureKey(POOL, "5m")))!.data;
    assert.deepEqual(calculateFeatures(saved.input, saved.calculatedAt), saved);
    const fresh = await readTradingFeatures(replica, POOL, "5m", time); assert.equal(fresh!.metrics["rvol20"]!.value, 3);
    time = saved.expiresAt;
    const stale = await readTradingFeatures(replica, POOL, "5m", time);
    assert.equal(stale!.metrics["rvol20"]!.reason, "stale_input");
    assert.equal(stale!.identity.observedAt, NOW - 1000);
    assert.equal(stale!.calculatedAt, NOW);
    assert.ok(pg.queries.some((sql) => sql.includes("create table")));
    await store.close();
  });
  it("returns bounded identity-keyed partial batches, replay input and strict parameters", async () => {
    const store = new MemoryStore(); await configure(store);
    const data = input(); const now = Date.now(); const end = Math.floor((now - 15_000) / STEP) * STEP;
    for (const bar of data.candles) bar.timestamp += end - CLOSE;
    data.observedAt = now;
    const snapshot = calculateFeatures(data, now);
    await store.put(FEATURE_INDEX_KEY, await featureSelection(store), { source: "test", freshForMs: 60_000, deadAfterMs: 60_000 });
    await store.put(featureKey(POOL, "5m"), snapshot, { source: "test", freshForMs: 60_000, deadAfterMs: 60_000 });
    const app = createServer({ store, scheduler: createScheduler(store) });
    const response = await app.request(`/trading/features/v1?pools=${POOL},${BASE}&interval=5m`);
    assert.equal(response.status, 200);
    const body = await response.json() as { data: Record<string, { data: unknown; error?: { code: string } }> };
    assert.ok(body.data[POOL]!.data); assert.equal(body.data[BASE]!.error!.code, "outside_feature_watchlist");
    const evidence = await app.request(`/trading/features/v1/${POOL}/input?interval=5m&snapshotId=${snapshot.snapshotId}`);
    assert.equal(evidence.status, 200);
    assert.equal((await app.request(`/trading/features/v1/${POOL}/input?snapshotId=${"a".repeat(64)}`)).status, 404);
    for (const query of ["interval=4h", "limit=10", "asOf=1", "currency=token"]) {
      assert.equal((await app.request(`/trading/features/v1/${POOL}?${query}`)).status, 400);
    }
    assert.equal((await app.request(`/trading/features/v1?pools=${Array(11).fill(POOL).join(",")}`)).status, 400);
    assert.equal((await app.request("/trading/features/v1/pools")).status, 200);
  });
  it("protects feature routes with existing auth and never fetches on cache misses", async () => {
    const previous = process.env["DP_AUTH_TOKEN"];
    const fetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("must stay offline"); };
    process.env["DP_AUTH_TOKEN"] = "feature-test-token";
    try {
      const store = new MemoryStore(); const app = createServer({ store, scheduler: createScheduler(store) });
      for (const path of ["/trading/features/v1/pools", `/trading/features/v1/${POOL}`, `/trading/features/v1?pools=${POOL}`]) {
        assert.equal((await app.request(path)).status, 401);
        assert.notEqual((await app.request(path, { headers: { "x-dp-token": "feature-test-token" } })).status, 401);
      }
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = fetch;
      if (previous === undefined) delete process.env["DP_AUTH_TOKEN"]; else process.env["DP_AUTH_TOKEN"] = previous;
    }
  });
  it("rejects a future cached observation and separates currency keys", async () => {
    const store = new MemoryStore(() => NOW);
    const snapshot = calculateFeatures(input(), NOW);
    await store.put(featureKey(POOL, "5m"), snapshot, { source: "test", freshForMs: 60_000, deadAfterMs: 60_000 });
    assert.equal((await readTradingFeatures(store, POOL, "5m", NOW - 1))!.metrics["rvol20"]!.reason, "observation_after_evaluation");
    assert.equal(await readTradingFeatures(store, POOL, "5m", NOW, "token"), null);
    assert.notEqual(featureKey(POOL, "5m"), featureKey(POOL, "5m", "token"));
  });
});
