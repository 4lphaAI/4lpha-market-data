import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { SnapshotStore } from "../src/core/store.js";
import { MemoryStore, PostgresStore } from "../src/core/store.js";
import { createScheduler } from "../src/core/scheduler.js";
import { createServer } from "../src/server.js";
import { runBinanceRwa } from "../src/jobs/binanceRwa.js";
import { runBstockTrending } from "../src/jobs/bstockTrending.js";
import {
  bstockTicker,
  lastTrendingMark,
  loadStaticSectors,
  MAX_SECTOR_ROWS,
  TRENDING_KEY,
  trendingScanDue,
  type TrendingSnapshot,
} from "../src/query/bstockSectors.js";
import { buildUniverse } from "../src/universe.js";
import { FakePg } from "./fakePg.js";
import { fakeFetch, jsonResponse } from "./helpers.js";
import { ARQQON, ARQQON_ROW, NVDAB, NVDAB_ROW } from "./rwaFixtures.js";

const ok = (data: unknown) => jsonResponse({ code: 0, msg: "success", data, timestamp: 1, success: true });
const signal = () => new AbortController().signal;
const HOUR = 60 * 60_000;
/** 2026-09-26 14:00 UTC — a scan mark. */
const MARK = Date.UTC(2026, 8, 26, 14);

/** The trending tab as the API answers it: the Ondo token when both issuers list the ticker. */
const NVDAON_ROW = { ...NVDAB_ROW, tokenContractAddress: "0xbbbb000000000000000000000000000000000001", tokenSymbol: "NVDAon", platformId: "ondo" };
const MSTRON_ROW = { ...NVDAB_ROW, tokenContractAddress: "0xbbbb000000000000000000000000000000000002", tokenSymbol: "MSTRon", platformId: "ondo", underlyingTicker: "MSTR" };
/** MSTRB is on the static bStocks floor only — no RWA row, so no `underlyingTicker`. */
const MSTRB = "0xe87afb3076aeb0f9b14e368de8145ae6a2826a14";

function setCredentials(): void {
  process.env["BINANCE_WEB3_API_KEY"] = "unit-test-key";
  process.env["BINANCE_WEB3_SECRET_KEY"] = "unit-test-secret";
}
afterEach(() => {
  delete process.env["BINANCE_WEB3_API_KEY"];
  delete process.env["BINANCE_WEB3_SECRET_KEY"];
});

function clock(start: number): { now: () => number; set: (ms: number) => void } {
  let t = start;
  return { now: () => t, set: (ms) => { t = ms; } };
}

describe("trending schedule", () => {
  it("marks 14:00 UTC, yesterday's before it", () => {
    assert.equal(lastTrendingMark(MARK), MARK);
    assert.equal(lastTrendingMark(MARK + 9 * HOUR), MARK);
    assert.equal(lastTrendingMark(MARK - 1), MARK - 24 * HOUR);
  });

  it("is due once per mark, keyed off the stored read rather than uptime", () => {
    assert.equal(trendingScanDue(null, MARK - HOUR), true, "never read");
    assert.equal(trendingScanDue(MARK - 2 * HOUR, MARK - HOUR), false, "read after yesterday's mark");
    assert.equal(trendingScanDue(MARK - HOUR, MARK + 1), true, "today's mark passed");
    assert.equal(trendingScanDue(MARK + 1, MARK + 5 * HOUR), false, "already read today");
  });
});

describe("bstock-trending job", () => {
  for (const [label, make] of [
    ["MemoryStore", (now: () => number) => new MemoryStore(now) as SnapshotStore],
    ["PostgresStore via FakePg", (now: () => number) => PostgresStore.create("postgres://unused", { client: new FakePg(), now })],
  ] as const) {
    it(`reads the tab once per day as tickers (${label})`, async () => {
      setCredentials();
      const c = clock(MARK + HOUR);
      const store = await make(c.now);
      const fake = fakeFetch(() => ok([NVDAON_ROW, MSTRON_ROW]));

      const first = await runBstockTrending(store, signal(), { fetchFn: fake.fetch, now: c.now() });
      assert.deepEqual(first, { scanned: true, tickers: 2, rows: 2 });
      assert.match(fake.calls[0]!.url, /tabId=35/);
      const record = await store.get<TrendingSnapshot>(TRENDING_KEY);
      assert.deepEqual(record?.data, { tabId: 35, tickers: ["NVDA", "MSTR"] });

      c.set(MARK + 20 * HOUR);
      assert.deepEqual(await runBstockTrending(store, signal(), { fetchFn: fake.fetch, now: c.now() }), { scanned: false });
      assert.equal(fake.calls.length, 1, "no second call before the next mark");

      c.set(MARK + 24 * HOUR + 1);
      assert.equal((await runBstockTrending(store, signal(), { fetchFn: fake.fetch, now: c.now() })).scanned, true);
      assert.equal(fake.calls.length, 2);
    });
  }

  it("refuses a tab that answers the whole list and keeps the previous read", async () => {
    setCredentials();
    const c = clock(MARK + HOUR);
    const store = new MemoryStore(c.now);
    await runBstockTrending(store, signal(), { fetchFn: fakeFetch(() => ok([NVDAON_ROW])).fetch, now: c.now() });

    c.set(MARK + 25 * HOUR);
    const everything = Array.from({ length: MAX_SECTOR_ROWS + 1 }, (_, i) => ({
      ...NVDAB_ROW,
      tokenContractAddress: `0x${(i + 1).toString(16).padStart(40, "0")}`,
    }));
    await assert.rejects(
      runBstockTrending(store, signal(), { fetchFn: fakeFetch(() => ok(everything)).fetch, now: c.now() }),
      /no longer a sector filter/,
    );
    await assert.rejects(
      runBstockTrending(store, signal(), { fetchFn: fakeFetch(() => ok([])).fetch, now: c.now() }),
      /returned no rows/,
    );
    const record = await store.get<TrendingSnapshot>(TRENDING_KEY);
    assert.deepEqual(record?.data.tickers, ["NVDA"]);
  });
});

describe("bStock sector labels", () => {
  it("ships the fixed baskets for the allowlisted bStocks", () => {
    const fixed = loadStaticSectors();
    assert.ok(fixed, "data/bstock-sectors.json must load");
    assert.deepEqual(fixed.byAddress.get(NVDAB), ["mag7", "ai-chips", "big-tech"]);
    assert.deepEqual(fixed.byAddress.get(MSTRB), ["crypto-stocks"]);
  });

  it("derives the ticker from a static-floor symbol", () => {
    assert.equal(bstockTicker({ symbol: "MSTRB" }), "MSTR");
    assert.equal(bstockTicker({ symbol: "NVDAB", underlyingTicker: "nvda" }), "NVDA");
    assert.equal(bstockTicker({ symbol: "X" }), null);
  });

  async function seeded(c: { now: () => number }): Promise<MemoryStore> {
    setCredentials();
    const store = new MemoryStore(c.now);
    await runBinanceRwa(store, signal(), { fetchFn: fakeFetch(() => ok([NVDAB_ROW, ARQQON_ROW])).fetch });
    await runBstockTrending(store, signal(), { fetchFn: fakeFetch(() => ok([NVDAON_ROW, MSTRON_ROW])).fetch, now: c.now() });
    return store;
  }

  it("labels bStocks by ticker, static floor included, and leaves Ondo rows alone", async () => {
    const store = await seeded(clock(MARK + HOUR));
    const universe = await buildUniverse(store);
    const byAddress = new Map(universe.entries.map((e) => [e.address, e]));

    assert.deepEqual(byAddress.get(NVDAB)?.sectors, ["mag7", "ai-chips", "big-tech", "trending"]);
    assert.deepEqual(byAddress.get(MSTRB)?.sectors, ["crypto-stocks", "trending"], "matched off the symbol, not the Ondo address in the tab");
    assert.equal(byAddress.get(ARQQON)?.sectors, undefined, "Ondo rows carry no labels");

    const lane = universe.lanes.bstocks.sectors;
    assert.equal(lane?.trendingAsOf, MARK + HOUR);
    assert.equal(lane?.trendingStaleness, "fresh");
    assert.equal(typeof lane?.fixedGeneratedAt, "string");
  });

  it("drops the trending label once the read is dead, but still reports its age", async () => {
    const c = clock(MARK + HOUR);
    const store = await seeded(c);
    c.set(MARK + HOUR + 73 * HOUR);
    const universe = await buildUniverse(store);
    const nvda = universe.entries.find((e) => e.address === NVDAB);
    assert.deepEqual(nvda?.sectors, ["mag7", "ai-chips", "big-tech"]);
    assert.equal(universe.lanes.bstocks.sectors?.trendingStaleness, "dead");
    assert.equal(universe.lanes.bstocks.sectors?.trendingAsOf, MARK + HOUR);
  });

  it("filters /universe by sector and rejects what cannot be answered", async () => {
    const store = await seeded(clock(MARK + HOUR));
    const app = createServer({ scheduler: createScheduler(store), store });

    const mag7 = await app.request("/universe?lane=bstocks&sector=mag7");
    assert.equal(mag7.status, 200);
    const body = (await mag7.json()) as { data: Array<{ symbol: string; lane: string }>; meta: { sector: string } };
    assert.equal(body.meta.sector, "mag7");
    assert.ok(body.data.length > 0 && body.data.every((e) => e.lane === "bstocks"));
    assert.ok(body.data.some((e) => e.symbol === "NVDAB"));
    assert.ok(!body.data.some((e) => e.symbol === "MSTRB"));

    const trending = (await (await app.request("/universe?sector=trending")).json()) as { data: Array<{ symbol: string }> };
    assert.deepEqual(trending.data.map((e) => e.symbol).sort(), ["MSTRB", "NVDAB"]);

    assert.equal((await app.request("/universe?sector=nope")).status, 400);
    assert.equal((await app.request("/universe?lane=ondo&sector=mag7")).status, 400);
  });
});
