import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { MemoryStore, PostgresStore } from "../src/core/store.js";
import type { SnapshotStore } from "../src/core/store.js";
import { createScheduler } from "../src/core/scheduler.js";
import { createServer } from "../src/server.js";
import type { RwaToken, Venue } from "../src/core/models.js";
import { runBinanceRwa } from "../src/jobs/binanceRwa.js";
import type { PoolSlot0 } from "../src/jobs/majorsPrices.js";
import {
  SPREAD_HISTORY_KEY,
  SPREAD_RETENTION_MS,
  computePoint,
  normalizeSpreadHistory,
  runSpreadHistory,
  selectWatchedVenues,
  stockPriceFromSlot0,
  summarizeSeries,
  type SpreadHistorySnapshot,
  type SpreadPoint,
} from "../src/jobs/spreadHistory.js";
import { RWA_VENUES_KEY } from "../src/universe.js";
import { FakePg } from "./fakePg.js";
import { fakeFetch, jsonResponse } from "./helpers.js";
import { NVDAB, NVDAB_ROW, USDT } from "./rwaFixtures.js";

const USDC = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const PCS = "0x8fb4243b553ac29ba088acf00b9b7da24bd6690c";
const UNI = "0xdd9d5164ccbc57be377a964fc064135b03d06177";
const ok = (data: unknown) => jsonResponse({ code: 0, msg: "success", data, timestamp: 1, success: true });
const signal = () => new AbortController().signal;
const TTL = { source: "test", freshForMs: 60_000, deadAfterMs: 600_000 };

let clock = 1_700_000_000_000;
const now = () => clock;
afterEach(() => {
  clock = 1_700_000_000_000;
  delete process.env["BINANCE_WEB3_API_KEY"];
  delete process.env["BINANCE_WEB3_SECRET_KEY"];
});

const venue = (over: Partial<Venue>): Venue => ({
  dex: "pancakeswap", version: "v3", pool: PCS, feeTier: 2500, quote: { address: USDT, symbol: "USDT" },
  priceUsd: 215, liquidityUsd: 2_730_000, volume24hUsd: 1, asOf: 1, ...over,
});

/** sqrtPriceX96 for `price` token1-per-token0 with equal decimals. */
const sqrtFor = (price: number): bigint => BigInt(Math.round(Math.sqrt(price) * 2 ** 48)) * 2n ** 48n;

async function seed(store: SnapshotStore, venues: Venue[]): Promise<void> {
  process.env["BINANCE_WEB3_API_KEY"] = "k";
  process.env["BINANCE_WEB3_SECRET_KEY"] = "s";
  await store.put(RWA_VENUES_KEY, { byAddress: { [NVDAB]: venues }, sweptAt: {}, cursor: null }, TTL);
  // NVDAB_ROW: referencePrice 215.62, ratio 1, decimals 18.
  await runBinanceRwa(store, signal(), { fetchFn: fakeFetch(() => ok([NVDAB_ROW])).fetch });
}

describe("selectWatchedVenues", () => {
  it("keeps stable-quoted v3 venues with a known fee tier at or above the floor, deepest two", () => {
    const chosen = selectWatchedVenues([
      venue({ pool: "0x1000000000000000000000000000000000000001", liquidityUsd: 50_000, feeTier: 500 }),
      venue({ pool: UNI, dex: "uniswap", feeTier: 500, quote: { address: USDC, symbol: "USDC" }, liquidityUsd: 325_000 }),
      venue({ pool: "0x2000000000000000000000000000000000000002", quote: { address: WBNB, symbol: "WBNB" }, liquidityUsd: 9_000_000 }),
      venue({ pool: "0x3000000000000000000000000000000000000003", version: "v2", feeTier: null, liquidityUsd: 100_000 }),
      venue({ pool: "0x4000000000000000000000000000000000000004", feeTier: null, liquidityUsd: 100_000 }),
      venue({ pool: "0x5000000000000000000000000000000000000005", liquidityUsd: 9_999 }),
      venue({}),
    ]);
    assert.deepEqual(chosen.map((v) => [v.pool, v.liquidityUsd]), [[PCS, 2_730_000], [UNI, 325_000]]);
  });
});

describe("stockPriceFromSlot0 / computePoint", () => {
  it("prices the stock on either side of the pool and with unequal decimals", () => {
    const s0: PoolSlot0 = { pool: PCS, token0: NVDAB, token1: USDT, sqrtPriceX96: sqrtFor(215.5), tick: 0 };
    assert.ok(Math.abs(stockPriceFromSlot0(s0, NVDAB, 18, USDT)! - 215.5) < 1e-6);
    // Stock as token1: sqrtPrice encodes stock-per-USDT; the inversion must recover 215.5.
    const s1: PoolSlot0 = { pool: PCS, token0: USDT, token1: NVDAB, sqrtPriceX96: sqrtFor(1 / 215.5), tick: 0 };
    assert.ok(Math.abs(stockPriceFromSlot0(s1, NVDAB, 18, USDT)! - 215.5) < 1e-4);
    // 18-decimal quote against a 6-decimal stock: 215.5 quote per whole stock = 215.5e12 raw ratio.
    const s6: PoolSlot0 = { pool: PCS, token0: NVDAB, token1: USDT, sqrtPriceX96: sqrtFor(215.5e12), tick: 0 };
    assert.ok(Math.abs(stockPriceFromSlot0(s6, NVDAB, 6, USDT)! - 215.5) < 1e-3);
    // A pool whose tokens are not stock+quote is refused, as is a zero price.
    assert.equal(stockPriceFromSlot0({ ...s0, token1: WBNB }, NVDAB, 18, USDT), null);
    assert.equal(stockPriceFromSlot0({ ...s0, sqrtPriceX96: 0n }, NVDAB, 18, USDT), null);
  });

  it("computes NAV and cross spreads with the fee round trip, and degrades without the second pool", () => {
    const token = { address: NVDAB, symbol: "NVDAB", platform: "bstock", referencePriceUsd: 200, tokenToShareRatio: 1.01, decimals: 18 } as unknown as RwaToken;
    const venues = selectWatchedVenues([venue({}), venue({ pool: UNI, dex: "uniswap", feeTier: 500, liquidityUsd: 325_000 })]);
    const slot0s = new Map<string, PoolSlot0>([
      [PCS, { pool: PCS, token0: NVDAB, token1: USDT, sqrtPriceX96: sqrtFor(204), tick: 0 }], // NAV 202 → +99 bps
      [UNI, { pool: UNI, token0: NVDAB, token1: USDT, sqrtPriceX96: sqrtFor(205), tick: 0 }], // 49 bps apart
    ]);
    const p = computePoint(5, token, venues, slot0s)!;
    assert.deepEqual(p, [5, 99, 49, 30, 2_730_000, 325_000]);
    const only = computePoint(5, token, venues, new Map([[PCS, slot0s.get(PCS)!]]))!;
    assert.deepEqual(only, [5, 99, null, null, 2_730_000, null]);
    assert.equal(computePoint(5, token, venues, new Map([[UNI, slot0s.get(UNI)!]])), null, "no deepest pool, no point");
    assert.equal(computePoint(5, { ...token, referencePriceUsd: null }, venues, slot0s), null);
  });
});

describe("spread-history job", () => {
  for (const [label, make] of [
    ["MemoryStore", async () => new MemoryStore(now) as SnapshotStore],
    ["PostgresStore via FakePg", async () => PostgresStore.create("postgres://unused", { client: new FakePg(), now })],
  ] as const) {
    it(`appends a point per cycle, trims to 48 h, keeps token0/token1 (${label})`, async () => {
      const store = await make();
      await seed(store, [venue({}), venue({ pool: UNI, dex: "uniswap", feeTier: 500, liquidityUsd: 325_000 })]);
      const asked: string[][] = [];
      const readSlot0s = async (pools: readonly { pool: string }[]) => {
        asked.push(pools.map((p) => p.pool));
        return [
          { pool: PCS, token0: NVDAB, token1: USDT, sqrtPriceX96: sqrtFor(215.62), tick: 0 },
          { pool: UNI, token0: USDT, token1: NVDAB, sqrtPriceX96: sqrtFor(1 / 216), tick: 0 },
        ];
      };
      const c1 = await runSpreadHistory(store, signal(), { readSlot0s, now });
      assert.deepEqual(c1, { watched: 1, pointsWritten: 1, poolsRead: 2, poolsMissing: 0 });
      clock += 60_000;
      await runSpreadHistory(store, signal(), { readSlot0s, now });
      let snap = normalizeSpreadHistory((await store.get<SpreadHistorySnapshot>(SPREAD_HISTORY_KEY))!.data);
      const series = snap.byAddress[NVDAB]!;
      assert.equal(series.points.length, 2);
      assert.deepEqual(series.points[1]!.slice(1), [0, 18, 30, 2_730_000, 325_000]);
      assert.equal(series.venues[0]!.token0, NVDAB, "resolved from the chain and cached");
      assert.deepEqual(asked[0], [PCS, UNI]);

      clock += SPREAD_RETENTION_MS + 1;
      await seed(store, [venue({}), venue({ pool: UNI, dex: "uniswap", feeTier: 500, liquidityUsd: 325_000 })]); // RWA snapshot fresh again
      await runSpreadHistory(store, signal(), { readSlot0s, now });
      snap = normalizeSpreadHistory((await store.get<SpreadHistorySnapshot>(SPREAD_HISTORY_KEY))!.data);
      assert.equal(snap.byAddress[NVDAB]!.points.length, 1, "the two old points aged out");
    });
  }

  it("writes no point for a pool that did not answer, and throws without republishing when none did", async () => {
    const store = new MemoryStore(now);
    await seed(store, [venue({})]);
    await runSpreadHistory(store, signal(), { readSlot0s: async () => [{ pool: PCS, token0: NVDAB, token1: USDT, sqrtPriceX96: sqrtFor(215), tick: 0 }], now });
    clock += 60_000;
    await assert.rejects(runSpreadHistory(store, signal(), { readSlot0s: async () => [], now }), /no pool answered/);
    const snap = normalizeSpreadHistory((await store.get<SpreadHistorySnapshot>(SPREAD_HISTORY_KEY))!.data);
    assert.equal(snap.byAddress[NVDAB]!.points.length, 1);
    assert.equal(snap.cursorTs, 1_700_000_000_000, "previous record untouched");
  });

  it("is a no-op with nothing to watch", async () => {
    const store = new MemoryStore(now);
    const c = await runSpreadHistory(store, signal(), { readSlot0s: async () => { throw new Error("must not read"); }, now });
    assert.equal(c.watched, 0);
    assert.equal(await store.get(SPREAD_HISTORY_KEY), null);
  });
});

describe("/spreads routes", () => {
  it("summarises the window and serves raw points; validates hours", async () => {
    const store = new MemoryStore();
    const base = Date.now(); // the routes window on wall-clock time
    const pts: SpreadPoint[] = [];
    for (let i = 0; i < 120; i++) {
      // 100 quiet minutes, then 20 where the cross spread clears the 30 bps fee and NAV is −80.
      const hot = i >= 100;
      pts.push([base - (120 - i) * 60_000, hot ? -80 : -10, hot ? 45 : 12, 30, 2_730_000, 325_000]);
    }
    const snap: SpreadHistorySnapshot = {
      byAddress: { [NVDAB]: { symbol: "NVDAB", platform: "bstock", underlyingTicker: "NVDA", venues: [{ pool: PCS, dex: "pancakeswap", version: "v3", feeTier: 2500, quote: USDT, liquidityUsd: 2_730_000, token0: NVDAB, token1: USDT }, { pool: UNI, dex: "uniswap", version: "v3", feeTier: 500, quote: USDT, liquidityUsd: 325_000, token0: NVDAB, token1: USDT }], points: pts } },
      cursorTs: base,
    };
    await store.put(SPREAD_HISTORY_KEY, snap, TTL);
    const summary = summarizeSeries(NVDAB, snap.byAddress[NVDAB]!, base - 24 * 3_600_000);
    assert.equal(summary.samples, 120);
    assert.equal(summary.minutesAboveFee, 20);
    assert.equal(summary.minutesNavBeyondFee, 20, "|−80| > the deepest venue's 25 bps");
    assert.deepEqual(summary.crossBps, { p50: 12, max: 45 });
    assert.deepEqual(summary.navBps, { min: -80, p50: -10, max: -10 });
    assert.equal(summary.latest?.crossBps, 45);
    // A 1-hour window sees only the last 60 points.
    assert.equal(summarizeSeries(NVDAB, snap.byAddress[NVDAB]!, base - 3_600_000).samples, 60);

    const app = createServer({ scheduler: createScheduler(store), store });
    const list = await app.request("/spreads?hours=3");
    assert.equal(list.status, 200);
    const body = (await list.json()) as { data: Array<{ symbol: string; samples: number }>; meta: { hours: number; watched: number; minLiquidityUsd: number } };
    assert.equal(body.data[0]?.symbol, "NVDAB");
    assert.equal(body.data[0]?.samples, 120);
    assert.equal(body.meta.watched, 1);
    assert.equal(body.meta.minLiquidityUsd, 10_000);

    const one = await app.request(`/spreads/${NVDAB}?hours=1`);
    const oneBody = (await one.json()) as { data: { points: unknown[] }; meta: { pointShape: string[] } };
    // The route windows on wall-clock time a few ms after `base`, so the point exactly 60 min old falls out.
    assert.equal(oneBody.data.points.length, 59);
    assert.deepEqual(oneBody.meta.pointShape, ["tsMs", "navBps", "crossBps", "feeBps", "liqA", "liqB"]);

    assert.equal((await app.request("/spreads?hours=0")).status, 400);
    assert.equal((await app.request("/spreads?hours=49")).status, 400);
    assert.equal((await app.request(`/spreads/${USDT}`)).status, 404);
    assert.equal((await app.request("/spreads/nope")).status, 400);
  });

  it("drops malformed series on read and lists spread:history in /status", async () => {
    const store = new MemoryStore(now);
    await store.put(SPREAD_HISTORY_KEY, { byAddress: { [NVDAB]: { symbol: "NVDAB", venues: [], points: [[1, 2, null, null, 3, null], "junk", [1]] }, nope: {} }, cursorTs: "x" }, TTL);
    const snap = normalizeSpreadHistory((await store.get<unknown>(SPREAD_HISTORY_KEY))!.data);
    assert.equal(snap.byAddress[NVDAB]!.points.length, 1);
    assert.equal(Object.keys(snap.byAddress).length, 1);
    assert.equal(snap.cursorTs, 0);
    const app = createServer({ scheduler: createScheduler(store), store });
    const status = (await (await app.request("/status")).json()) as { data: { snapshots: Array<{ key: string }> } };
    assert.ok(status.data.snapshots.some((s) => s.key === SPREAD_HISTORY_KEY));
  });
});

describe("spreadHistoryJob switch", () => {
  it("is off unless SPREAD_HISTORY_ENABLED=true, and a disabled job neither reads nor writes", async () => {
    const { isSpreadHistoryEnabled, spreadHistoryJob } = await import("../src/jobs/spreadHistory.js");
    delete process.env["SPREAD_HISTORY_ENABLED"];
    assert.equal(isSpreadHistoryEnabled(), false);
    assert.equal(isSpreadHistoryEnabled({ SPREAD_HISTORY_ENABLED: "true" }), true);
    const store = new MemoryStore(now);
    await seed(store, [venue({})]);
    const job = spreadHistoryJob(store);
    assert.equal(job.intervalMs, 60 * 60_000, "an hourly no-op, not a per-minute multicall");
    await job.run(signal());
    assert.equal(await store.get(SPREAD_HISTORY_KEY), null);
  });
});
