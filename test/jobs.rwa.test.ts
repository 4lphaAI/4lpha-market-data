import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import type { SnapshotStore } from "../src/core/store.js";
import { MemoryStore, PostgresStore } from "../src/core/store.js";
import { createScheduler } from "../src/core/scheduler.js";
import { createServer } from "../src/server.js";
import { runBinanceRwa, type RwaUniverseSnapshot, type ShareFactsReader } from "../src/jobs/binanceRwa.js";
import {
  VENUES_MIN_SPACING_MS,
  runStockVenues,
  selectVenuePairs,
  type FeeOutcome,
  type VenuesSnapshot,
} from "../src/jobs/stockVenues.js";
import { readTokenSnapshot } from "../src/jobs/tokenStore.js";
import { normalizeDexPairs } from "../src/adapters/dexScreener.js";
import { RWA_UNIVERSE_KEY, RWA_VENUES_KEY, buildUniverse, bstockAddresses } from "../src/universe.js";
import { FakePg } from "./fakePg.js";
import { fakeFetch, jsonResponse } from "./helpers.js";
import { ARQQON, ARQQON_ROW, NVDAB, NVDAB_PAIRS, NVDAB_ROW, USDT } from "./rwaFixtures.js";

const SECRET = "unit-test-secret";
const ok = (data: unknown) => jsonResponse({ code: 0, msg: "success", data, timestamp: 1, success: true });
const TTL = { source: "test", freshForMs: 60_000, deadAfterMs: 600_000 };

/** A bStock the static list does not know, as the API lists ~21 of them. */
const HOODB = "0xaaaa000000000000000000000000000000000001";
const HOODB_ROW = { ...NVDAB_ROW, tokenContractAddress: HOODB, tokenSymbol: "HOODB", tokenName: "Robinhood", underlyingTicker: "HOOD", tokenPrice: "120", referencePrice: "119" };

function setCredentials(): void {
  process.env["BINANCE_WEB3_API_KEY"] = "unit-test-key";
  process.env["BINANCE_WEB3_SECRET_KEY"] = SECRET;
}
afterEach(() => {
  delete process.env["BINANCE_WEB3_API_KEY"];
  delete process.env["BINANCE_WEB3_SECRET_KEY"];
});

async function pgStore(): Promise<PostgresStore> {
  return PostgresStore.create("postgres://unused", { client: new FakePg() });
}

const signal = () => new AbortController().signal;

describe("binance-rwa job", () => {
  for (const [label, make] of [
    ["MemoryStore", async () => new MemoryStore() as SnapshotStore],
    ["PostgresStore via FakePg", pgStore],
  ] as const) {
    it(`writes the snapshot and merges prices, not underlying volume (${label})`, async () => {
      setCredentials();
      const store = await make();
      const fake = fakeFetch(() => ok([NVDAB_ROW, ARQQON_ROW, HOODB_ROW, { junk: true }]));
      const result = await runBinanceRwa(store, signal(), { fetchFn: fake.fetch });
      assert.equal(result.rows, 3);
      assert.equal(result.dropped, 1);
      assert.deepEqual(result.byPlatform, { bstock: 2, ondo: 1 });
      assert.equal(result.priced, 3);

      const record = await store.get<RwaUniverseSnapshot>(RWA_UNIVERSE_KEY);
      assert.ok(record);
      assert.equal(record.source, "binance-rwa");
      assert.equal(record.staleness, "fresh");
      assert.equal(record.data.rows.length, 3);
      assert.equal(record.data.rows[0]!.navPremiumBps, 10);

      const nvda = await readTokenSnapshot(store, NVDAB);
      assert.equal(nvda?.priceUsd, 215.84);
      assert.equal(nvda?.marketCapUsd, 28385091);
      assert.equal(nvda?.volume24hUsd, null, "SPY's exchange volume must never read as on-chain volume");
      assert.equal(nvda?.symbol, "NVDAB");
    });
  }

  it("throws on an empty list and keeps the previous snapshot", async () => {
    setCredentials();
    const store = new MemoryStore();
    await store.put(RWA_UNIVERSE_KEY, { rows: [], byPlatform: {} }, { ...TTL, source: "previous" });
    const fake = fakeFetch(() => ok([]));
    await assert.rejects(runBinanceRwa(store, signal(), { fetchFn: fake.fetch }), /no BSC rows/);
    assert.equal((await store.get(RWA_UNIVERSE_KEY))?.source, "previous");
  });

  it("propagates an adapter error without touching the store", async () => {
    setCredentials();
    const store = new MemoryStore();
    const fake = fakeFetch(() => new Response("", { status: 503 }));
    await assert.rejects(runBinanceRwa(store, signal(), { fetchFn: fake.fetch }), /503/);
    assert.equal(await store.get(RWA_UNIVERSE_KEY), null);
    assert.equal(await readTokenSnapshot(store, NVDAB), null);
  });
});

async function seedRwa(store: SnapshotStore, rows = [NVDAB_ROW, ARQQON_ROW, HOODB_ROW]): Promise<void> {
  setCredentials();
  const fake = fakeFetch(() => ok(rows));
  await runBinanceRwa(store, signal(), { fetchFn: fake.fetch });
}

describe("stock-venues job", () => {
  it("keeps only stock-as-base pairs on Pancake/Uniswap against a real quote, and labels Uniswap v3", () => {
    const pairs = normalizeDexPairs(NVDAB_PAIRS);
    const chosen = selectVenuePairs(NVDAB, pairs, new Set([NVDAB]));
    assert.deepEqual(
      chosen.map((p) => `${p.dex}/${p.version}`),
      ["pancakeswap/v3", "uniswap/v3", "pancakeswap/v2"],
      "memecoin-quoted-in-NVDAB and Topaz are not venues",
    );
  });

  it("sweeps in rotation with spacing, reads fee tiers once, drops a mislabelled v3, keeps failures' previous venues", async () => {
    const store = new MemoryStore();
    await seedRwa(store);
    const addresses = [NVDAB, ARQQON, HOODB].sort();
    // HOODB was swept before and will fail this time: its old venues must survive untouched.
    const hoodVenue = { dex: "pancakeswap", version: "v3", pool: "0x5000000000000000000000000000000000000005", feeTier: 2500, quote: { address: USDT, symbol: "USDT" }, priceUsd: 120, liquidityUsd: 289000, volume24hUsd: 184000, asOf: 999 };
    await store.put(RWA_VENUES_KEY, { byAddress: { [HOODB]: [hoodVenue] }, sweptAt: { [HOODB]: 999 }, cursor: null }, { ...TTL, source: "previous" });

    const sleeps: number[] = [];
    let t = 1_000_000;
    const now = () => t;
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    };
    const feeCalls: string[][] = [];
    const readFees = async (pools: string[]): Promise<Map<string, FeeOutcome>> => {
      feeCalls.push(pools);
      const out = new Map<string, FeeOutcome>();
      for (const pool of pools) {
        if (pool === "0x8fb4243b553ac29ba088acf00b9b7da24bd6690c") out.set(pool, 500);
        else if (pool === "0xdd9d5164ccbc57be377a964fc064135b03d06177") out.set(pool, "not-a-pool");
        // any other pool: transport failure → unresolved
      }
      return out;
    };
    const fake = fakeFetch((call) => {
      if (call.url.endsWith(`/${NVDAB}`)) return jsonResponse(NVDAB_PAIRS);
      if (call.url.endsWith(`/${ARQQON}`)) return jsonResponse([]);
      return new Response("", { status: 500 }); // HOODB fails
    });

    // Cycle 1: two per cycle → the first two addresses in sorted order.
    const c1 = await runStockVenues(store, signal(), { fetchFn: fake.fetch, sleep, now, readFees, perCycle: 2 });
    assert.equal(c1.swept, 2);
    assert.deepEqual(fake.calls.map((c) => c.url.split("/").pop()), addresses.slice(0, 2));
    assert.deepEqual(sleeps, [VENUES_MIN_SPACING_MS], "one gap between two calls");

    // Cycle 2: continues after the cursor, wraps, and hits the failing token.
    const c2 = await runStockVenues(store, signal(), { fetchFn: fake.fetch, sleep, now, readFees, perCycle: 2 });
    assert.equal(c2.swept, 2);
    assert.equal(c2.failed, 1);
    assert.deepEqual(fake.calls.slice(2).map((c) => c.url.split("/").pop()), [addresses[2], addresses[0]]);

    const snap = (await store.get<VenuesSnapshot>(RWA_VENUES_KEY))!.data;
    const nvda = snap.byAddress[NVDAB]!;
    assert.deepEqual(
      nvda.map((v) => [v.dex, v.version, v.feeTier, v.quote.symbol, v.liquidityUsd]),
      [
        ["pancakeswap", "v3", 500, "USDT", 2729189.89],
        ["pancakeswap", "v2", null, "WBNB", 15000],
      ],
      "deepest first; the 'uniswap' pool that is not a v3 contract is dropped",
    );
    assert.deepEqual(snap.byAddress[HOODB], [hoodVenue], "a failed read keeps the previous venues byte for byte");
    assert.equal(snap.sweptAt[HOODB], 999, "and does not advance the token's sweptAt");
    assert.equal(snap.byAddress[ARQQON]!.length, 0, "a token with no pools is recorded as swept with none");
    // Fee tiers are immutable: the second read of NVDAB asked the chain for nothing new.
    assert.equal(feeCalls.length, 1);
    assert.deepEqual(feeCalls[0]!.sort(), ["0x8fb4243b553ac29ba088acf00b9b7da24bd6690c", "0xdd9d5164ccbc57be377a964fc064135b03d06177"]);
    assert.equal(c2.feesRead, 0);
  });

  it("keeps feeTier null on a transport failure and asks the chain again next sweep", async () => {
    const store = new MemoryStore();
    await seedRwa(store, [NVDAB_ROW]);
    const feeCalls: string[][] = [];
    let chainUp = false;
    const readFees = async (pools: string[]): Promise<Map<string, FeeOutcome>> => {
      feeCalls.push([...pools].sort());
      return chainUp ? new Map(pools.map((p) => [p, 500 as FeeOutcome])) : new Map();
    };
    const fake = fakeFetch(() => jsonResponse(NVDAB_PAIRS));
    const opts = { fetchFn: fake.fetch, sleep: async () => undefined, readFees };

    await runStockVenues(store, signal(), opts);
    let nvda = (await store.get<VenuesSnapshot>(RWA_VENUES_KEY))!.data.byAddress[NVDAB]!;
    assert.deepEqual(nvda.map((v) => [v.version, v.feeTier]), [["v3", null], ["v3", null], ["v2", null]], "unanswered v3 pools stay, with no guessed tier");

    chainUp = true;
    await runStockVenues(store, signal(), opts);
    nvda = (await store.get<VenuesSnapshot>(RWA_VENUES_KEY))!.data.byAddress[NVDAB]!;
    assert.deepEqual(nvda.map((v) => [v.version, v.feeTier]), [["v3", 500], ["v3", 500], ["v2", null]]);
    assert.equal(feeCalls.length, 2, "the null pools were re-asked");
    assert.deepEqual(feeCalls[0], feeCalls[1]);
  });

  it("advances the cursor only past what was attempted when aborted mid-batch", async () => {
    const store = new MemoryStore();
    await seedRwa(store);
    const addresses = [NVDAB, ARQQON, HOODB].sort();
    const controller = new AbortController();
    const fake = fakeFetch(() => {
      controller.abort(); // abort after the first read completes
      return jsonResponse([]);
    });
    const c = await runStockVenues(store, controller.signal, { fetchFn: fake.fetch, sleep: async () => undefined, readFees: async () => new Map(), perCycle: 3 });
    assert.equal(c.swept, 1);
    assert.equal(c.cursor, addresses[0], "not the last planned address");
    assert.equal(fake.calls.length, 1);
    // The next cycle resumes at the second address rather than skipping the unread tail.
    const c2 = await runStockVenues(store, signal(), { fetchFn: fakeFetch(() => jsonResponse([])).fetch, sleep: async () => undefined, readFees: async () => new Map(), perCycle: 1 });
    assert.equal(c2.cursor, addresses[1]);
  });

  it("throws without republishing when every read fails", async () => {
    const store = new MemoryStore();
    await seedRwa(store);
    await store.put(RWA_VENUES_KEY, { byAddress: {}, sweptAt: {}, cursor: null }, { ...TTL, source: "previous" });
    const fake = fakeFetch(() => new Response("", { status: 429 }));
    await assert.rejects(runStockVenues(store, signal(), { fetchFn: fake.fetch, sleep: async () => undefined, perCycle: 2 }), /no venue reads succeeded/);
    assert.equal((await store.get(RWA_VENUES_KEY))?.source, "previous");
  });

  it("falls back to the static bStocks when the RWA snapshot is absent", async () => {
    const store = new MemoryStore();
    const fake = fakeFetch(() => jsonResponse([]));
    const c = await runStockVenues(store, signal(), { fetchFn: fake.fetch, sleep: async () => undefined, readFees: async () => new Map(), perCycle: 100 });
    assert.equal(c.swept, bstockAddresses().length);
  });

  it("round-trips the venues snapshot through Postgres", async () => {
    const store = await pgStore();
    await seedRwa(store, [NVDAB_ROW]);
    const fake = fakeFetch(() => jsonResponse(NVDAB_PAIRS));
    await runStockVenues(store, signal(), {
      fetchFn: fake.fetch,
      sleep: async () => undefined,
      readFees: async (pools) => new Map(pools.map((p) => [p, 500 as FeeOutcome])),
    });
    const universe = await buildUniverse(store);
    const row = universe.entries.find((e) => e.address === NVDAB)!;
    assert.equal(row.venues?.length, 3);
    assert.equal(row.venues?.[0]?.feeTier, 500);
  });
});

describe("buildUniverse with the RWA lanes", () => {
  it("is exactly the static bStocks with no snapshot", async () => {
    const universe = await buildUniverse(new MemoryStore());
    assert.equal(universe.lanes.bstocks.count, 25);
    assert.equal(universe.lanes.bstocks.source, "static");
    assert.equal(universe.lanes.bstocks.staleness, "fresh");
    assert.equal(universe.lanes.ondo.count, 0);
    assert.equal(universe.lanes.ondo.staleness, null);
  });

  it("overwrites static rows with API rows, adds API-only bStocks, and puts Ondo in its own lane", async () => {
    const store = new MemoryStore();
    await seedRwa(store);
    const universe = await buildUniverse(store);

    assert.equal(universe.lanes.bstocks.count, 26, "25 static + HOODB");
    assert.equal(universe.lanes.bstocks.source, "static+binance-rwa");
    assert.equal(universe.lanes.bstocks.staleness, "fresh");
    assert.equal(universe.lanes.ondo.count, 1);

    const nvda = universe.entries.find((e) => e.address === NVDAB)!;
    assert.equal(nvda.lane, "bstocks");
    assert.equal(nvda.source, "binance-rwa");
    assert.equal(nvda.marketHours, "us-equities", "kept for the execution plane until the joint schema change");
    assert.equal(nvda.platform, "bstock");
    assert.equal(nvda.underlyingTicker, "NVDA");
    assert.equal(nvda.premiumBps, null, "no venue yet: the pool-vs-reference premium is unknown, not NAV-vs-reference");
    assert.equal(nvda.tokenPriceUsd, 215.84);
    assert.equal(nvda.openState, true);
    assert.equal(nvda.staleness, "fresh");
    assert.equal(nvda.venues, undefined, "never swept");

    const hood = universe.entries.find((e) => e.address === HOODB)!;
    assert.equal(hood.lane, "bstocks");
    const untouched = universe.entries.find((e) => e.address === bstockAddresses()[0])!;
    assert.equal(untouched.source, "static");
    assert.equal(untouched.platform, undefined);

    const arqq = universe.entries.find((e) => e.address === ARQQON)!;
    assert.equal(arqq.lane, "ondo");
    assert.equal(arqq.openState, false);
    assert.equal(arqq.reasonCode, "UNSUPPORTED");
    assert.equal(arqq.marketHours, undefined);
  });

  it("serves a dead snapshot's rows with staleness dead, and the static floor regardless", async () => {
    let t = 1_000_000;
    const store = new MemoryStore(() => t);
    await seedRwa(store);
    t += 48 * 60 * 60_000;
    const universe = await buildUniverse(store);
    assert.equal(universe.lanes.bstocks.staleness, "dead");
    assert.equal(universe.lanes.bstocks.count, 26);
    assert.equal(universe.entries.find((e) => e.address === HOODB)?.staleness, "dead");
  });

  it("ignores a stored payload of the wrong shape", async () => {
    const store = new MemoryStore();
    await store.put(RWA_UNIVERSE_KEY, ["not", "rows"], TTL);
    await store.put(RWA_VENUES_KEY, { byAddress: "nope" }, TTL);
    const universe = await buildUniverse(store);
    assert.equal(universe.lanes.bstocks.count, 25);
    assert.equal(universe.lanes.ondo.count, 0);
  });
});

describe("GET /universe with the RWA lanes", () => {
  it("filters ?lane=ondo and ?lane=bstocks, rejects an unknown lane", async () => {
    const store = new MemoryStore();
    await seedRwa(store);
    const app = createServer({ scheduler: createScheduler(store), store });

    const ondo = await app.request("/universe?lane=ondo");
    assert.equal(ondo.status, 200);
    const ondoBody = (await ondo.json()) as { data: Array<{ address: string; lane: string }>; meta: { lanes: Record<string, { count: number }> } };
    assert.deepEqual(ondoBody.data.map((e) => e.address), [ARQQON]);
    assert.equal(ondoBody.meta.lanes["ondo"]?.count, 1);

    const bstocks = await app.request("/universe?lane=bstocks");
    const bstocksBody = (await bstocks.json()) as { data: Array<{ address: string; tokenPriceUsd?: number }> };
    assert.equal(bstocksBody.data.length, 26);
    assert.equal(bstocksBody.data.find((e) => e.address === NVDAB)?.tokenPriceUsd, 215.84);

    const bad = await app.request("/universe?lane=xstock");
    assert.equal(bad.status, 400);
  });

  it("lists universe:rwa and venues:rwa in /status", async () => {
    const store = new MemoryStore();
    const app = createServer({ scheduler: createScheduler(store), store });
    const res = await app.request("/status");
    const body = (await res.json()) as { data: { snapshots: Array<{ key: string }> } };
    const keys = body.data.snapshots.map((s) => s.key);
    assert.ok(keys.includes("universe:rwa"));
    assert.ok(keys.includes("venues:rwa"));
  });
});

describe("per-address share ratio, decimals and reference basis (D1, R3.8, R5.9)", () => {
  const PYPLB = "0x2806a561fc1f9259b2d54a281796bde0d92762ae";
  const AAPLB = "0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a";
  const COHRB = "0x5131859a059b2446abeefe0f5d313b3c54ff3d36";
  const CRDOB = "0x6e7d451f9d30327d32020f116fa79c23b24e9c8d";
  const PER_ADDRESS = [PYPLB, AAPLB, COHRB, CRDOB];
  // On-chain `uiMultiplier()` values measured 2026-10-04.
  const MULTIPLIER: Record<string, bigint> = {
    [PYPLB]: 1001771778813000000n, [AAPLB]: 1000603906076000000n, [COHRB]: 1000000000000000000n, [CRDOB]: 1000000000000000000n,
  };
  // `/rwa/price`: tokenPrice is the per-share price, referencePrice is one ratio lower; `underlying-market`
  // carries a deliberately absurd referencePrice that must never be used.
  const PRICE: Record<string, { tokenPrice: string; referencePrice: string }> = {
    [PYPLB]: { tokenPrice: "53.11", referencePrice: "53.016067" },
    [AAPLB]: { tokenPrice: "333.55", referencePrice: "333.35" },
    [COHRB]: { tokenPrice: "336.96", referencePrice: "336.96" },
    [CRDOB]: { tokenPrice: "120.5", referencePrice: "120.5" },
  };
  function upstream(): ReturnType<typeof fakeFetch> {
    return fakeFetch((call) => {
      if (call.url.includes("/rwa/tokens")) return ok([NVDAB_ROW]);
      if (call.url.includes("/rwa/price")) {
        return ok(PER_ADDRESS.map((a) => ({ tokenContractAddress: a, platformId: "bstock", ...PRICE[a] })));
      }
      if (call.url.includes("/rwa/underlying-market")) {
        const address = PER_ADDRESS.find((a) => call.url.includes(a));
        return ok({ tokenContractAddress: address, platformId: "bstock", statusInfo: { openState: true, marketStatus: null, reasonCode: "TRADING" },
          marketData: { referencePrice: "999999", marketCap: "1" } });
      }
      return jsonResponse({ code: 500, msg: "unexpected", data: null }, 500);
    });
  }
  const fullReader = (calls?: string[][]): ShareFactsReader => async (addresses) => {
    calls?.push([...addresses]);
    return new Map(addresses.map((a) => [a, { uiMultiplier: MULTIPLIER[a]!, decimals: 18 }]));
  };
  async function rowsOf(options: Parameters<typeof runBinanceRwa>[2]): Promise<Map<string, Record<string, unknown>>> {
    setCredentials();
    const store = new MemoryStore();
    await runBinanceRwa(store, signal(), options);
    const snapshot = (await store.get<RwaUniverseSnapshot>(RWA_UNIVERSE_KEY))!.data;
    return new Map(snapshot.rows.map((row) => [row.address, row as unknown as Record<string, unknown>]));
  }

  it("fills the ratio as uiMultiplier / 1e18 and decimals from the chain (vector PYPLB 1.001771778813)", async () => {
    const calls: string[][] = [];
    const rows = await rowsOf({ fetchFn: upstream().fetch, readShareFacts: fullReader(calls) });
    assert.equal(calls.length, 1, "one read set per cycle");
    assert.deepEqual([...calls[0]!].sort(), [...PER_ADDRESS].sort(), "per-address rows only, never the listed ones");
    assert.equal(rows.get(PYPLB)?.["tokenToShareRatio"], Number(1001771778813000000n) / 1e18);
    assert.ok(Math.abs((rows.get(PYPLB)?.["tokenToShareRatio"] as number) - 1.001771778813) < 1e-12);
    assert.equal(rows.get(COHRB)?.["tokenToShareRatio"], 1);
    for (const a of PER_ADDRESS) assert.equal(rows.get(a)?.["decimals"], 18);
  });

  it("sets referencePriceUsd to /rwa/price tokenPrice, never the underlying-market value, and tokenPriceUsd to reference x ratio", async () => {
    const rows = await rowsOf({ fetchFn: upstream().fetch, readShareFacts: fullReader() });
    const pypl = rows.get(PYPLB)!;
    assert.equal(pypl["referencePriceUsd"], 53.11);
    assert.ok(Math.abs((pypl["tokenPriceUsd"] as number) - 53.11 * (Number(1001771778813000000n) / 1e18)) < 1e-9);
    assert.equal(pypl["navPremiumBps"], 18, "ratio minus one in bps");
    assert.equal(rows.get(COHRB)?.["referencePriceUsd"], 336.96);
    assert.equal(rows.get(COHRB)?.["tokenPriceUsd"], 336.96);
    assert.equal(rows.get(COHRB)?.["navPremiumBps"], 0);
    for (const a of PER_ADDRESS) assert.notEqual(rows.get(a)?.["referencePriceUsd"], 999999, "the underlying-market reference is never used");
  });

  it("QCOMB-style vector: price 188.56 with ratio 1.003804323224 gives reference 188.56, token 189.2773, +38 bps", async () => {
    const reader: ShareFactsReader = async (addresses) =>
      new Map(addresses.map((a) => [a, { uiMultiplier: 1003804323224000000n, decimals: 18 }]));
    const fake = fakeFetch((call) => {
      if (call.url.includes("/rwa/tokens")) return ok([NVDAB_ROW]);
      if (call.url.includes("/rwa/price")) return ok([{ tokenContractAddress: COHRB, platformId: "bstock", tokenPrice: "188.56", referencePrice: "187.845" }]);
      if (call.url.includes("/rwa/underlying-market") && call.url.includes(COHRB)) {
        return ok({ tokenContractAddress: COHRB, platformId: "bstock", statusInfo: { openState: true, reasonCode: "TRADING" }, marketData: {} });
      }
      return jsonResponse({ code: 500, msg: "down", data: null }, 500);
    });
    const row = (await rowsOf({ fetchFn: fake.fetch, readShareFacts: reader })).get(COHRB)!;
    assert.equal(row["referencePriceUsd"], 188.56);
    assert.ok(Math.abs((row["tokenPriceUsd"] as number) - 189.2773) < 1e-4);
    assert.equal(row["navPremiumBps"], 38);
  });

  it("a ratio that cannot be read leaves ratio and decimals null and keeps tokenPriceUsd the per-share price", async () => {
    const rows = await rowsOf({ fetchFn: upstream().fetch });
    for (const a of PER_ADDRESS) {
      const row = rows.get(a)!;
      assert.equal(row["tokenToShareRatio"], null);
      assert.equal(row["decimals"], null);
      assert.equal(row["tokenPriceUsd"], row["referencePriceUsd"]);
      assert.equal(row["navPremiumBps"], 0);
    }
  });

  it("a failed or zero multiplier read, a decimals of 255 and a revert each null both fields for that token only", async () => {
    const reader: ShareFactsReader = async () => new Map([
      [PYPLB, { uiMultiplier: 0n, decimals: 18 }],
      [AAPLB, { uiMultiplier: MULTIPLIER[AAPLB]!, decimals: 255 }],
      [COHRB, null],
      [CRDOB, { uiMultiplier: MULTIPLIER[CRDOB]!, decimals: 18 }],
    ]);
    const rows = await rowsOf({ fetchFn: upstream().fetch, readShareFacts: reader });
    for (const a of [PYPLB, AAPLB, COHRB]) {
      assert.equal(rows.get(a)?.["tokenToShareRatio"], null, a);
      assert.equal(rows.get(a)?.["decimals"], null, a);
    }
    assert.equal(rows.get(CRDOB)?.["tokenToShareRatio"], 1);
    assert.equal(rows.get(CRDOB)?.["decimals"], 18);
  });

  it("a throwing reader nulls every per-address token and still publishes the four rows", async () => {
    const rows = await rowsOf({ fetchFn: upstream().fetch, readShareFacts: async () => { throw new Error("all rpc endpoints failed"); } });
    for (const a of PER_ADDRESS) {
      assert.ok(rows.has(a), a);
      assert.equal(rows.get(a)?.["tokenToShareRatio"], null);
      assert.equal(rows.get(a)?.["decimals"], null);
    }
  });

  it("a ratio from an earlier cycle is never carried into a cycle that fails to read", async () => {
    setCredentials();
    const store = new MemoryStore();
    const fake = upstream();
    await runBinanceRwa(store, signal(), { fetchFn: fake.fetch, readShareFacts: fullReader() });
    await runBinanceRwa(store, signal(), { fetchFn: fake.fetch, readShareFacts: async () => { throw new Error("down"); } });
    const rows = (await store.get<RwaUniverseSnapshot>(RWA_UNIVERSE_KEY))!.data.rows;
    assert.equal(rows.find((r) => r.address === PYPLB)?.tokenToShareRatio, null);
  });

  it("a hanging chain read still yields four per-address rows, with null ratios, within the 2.5 s budget", async () => {
    setCredentials();
    const store = new MemoryStore();
    const started = Date.now();
    const never: ShareFactsReader = () => new Promise(() => {});
    await runBinanceRwa(store, signal(), { fetchFn: upstream().fetch, readShareFacts: never });
    assert.ok(Date.now() - started < 6_000, "published within 6 s");
    const rows = (await store.get<RwaUniverseSnapshot>(RWA_UNIVERSE_KEY))!.data.rows;
    for (const a of PER_ADDRESS) {
      const row = rows.find((r) => r.address === a);
      assert.ok(row, `${a} present`);
      assert.equal(row?.tokenToShareRatio, null);
      assert.equal(row?.decimals, null);
    }
  });

  it("per-address Binance reads slower than the D1 budget are not cut by it: all four rows stay", async () => {
    setCredentials();
    const base = upstream().fetch;
    const slowFetch: typeof base = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/rwa/underlying-market")) await new Promise((resolve) => setTimeout(resolve, 800));
      return base(input, init);
    };
    const rows = await rowsOf({ fetchFn: slowFetch, readShareFacts: fullReader() });
    for (const a of PER_ADDRESS) {
      assert.ok(rows.has(a), a + " present");
      assert.equal(rows.get(a)?.["decimals"], 18, "the chain read ran after the Binance reads, on its own budget");
    }
  });

  it("the scheduled job wires the live chain reader; a bare runBinanceRwa stays offline", () => {
    const source = readFileSync(new URL("../src/jobs/binanceRwa.ts", import.meta.url), "utf8");
    assert.ok(source.includes("runBinanceRwa(store, signal, { readShareFacts: readShareFactsOnChain })"));
  });

  it("a per-address row with no /rwa/price answer has null prices: the underlying-market reference is never a fallback", async () => {
    const withoutCohrb = fakeFetch((call) => {
      if (call.url.includes("/rwa/tokens")) return ok([NVDAB_ROW]);
      if (call.url.includes("/rwa/price")) return ok(PER_ADDRESS.filter((a) => a !== COHRB).map((a) => ({ tokenContractAddress: a, platformId: "bstock", ...PRICE[a] })));
      if (call.url.includes("/rwa/underlying-market")) {
        const address = PER_ADDRESS.find((a) => call.url.includes(a));
        return ok({ tokenContractAddress: address, platformId: "bstock", statusInfo: { openState: true, marketStatus: null, reasonCode: "TRADING" },
          marketData: { referencePrice: "999999", marketCap: "1" } });
      }
      return jsonResponse({ code: 500, msg: "unexpected", data: null }, 500);
    });
    const row = (await rowsOf({ fetchFn: withoutCohrb.fetch, readShareFacts: fullReader() })).get(COHRB)!;
    assert.equal(row["referencePriceUsd"], null);
    assert.equal(row["tokenPriceUsd"], null);
    assert.equal(row["navPremiumBps"], null);
    assert.equal(row["openState"], true, "the session fields still come from underlying-market");
  });

  it("listed rows are byte-identical with and without the chain reader", async () => {
    const withReader = await rowsOf({ fetchFn: upstream().fetch, readShareFacts: fullReader() });
    const without = await rowsOf({ fetchFn: upstream().fetch });
    assert.deepEqual(withReader.get(NVDAB), without.get(NVDAB));
  });
});

// Keep the USDT import meaningful: the venue filter admits it as a quote.
void USDT;
