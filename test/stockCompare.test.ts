import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { MemoryStore, PostgresStore } from "../src/core/store.js";
import { createScheduler } from "../src/core/scheduler.js";
import { createServer } from "../src/server.js";
import type { RwaToken } from "../src/core/models.js";
import { AdapterError } from "../src/adapters/http.js";
import { BinanceFlashRateBudgetError } from "../src/adapters/binanceFlash.js";
import type { RateLimiter } from "../src/adapters/rateLimiter.js";
import { BINANCE_FLASH_USDT_ADDRESS } from "../src/config/binanceFlash.js";
import { RWA_UNIVERSE_KEY } from "../src/universe.js";
import {
  STOCK_COMPARE_CYCLE_BUDGET_MS,
  STOCK_COMPARE_TAKER,
  createFlashQuote,
  parseFlashRouterResult,
  planStockCompareTickers,
  readStockCompareConfig,
  runStockCompare,
  stockCompareJobIfEnabled,
  type StockCompareQuoteFn,
  type StockCompareQuoteRequest,
  type StockCompareRawQuote,
} from "../src/jobs/stockCompare.js";
import {
  STOCK_COMPARE_KEY,
  buildAnsweredSize,
  classifyRoute,
  computeVerdicts,
  mergeStockCompareRows,
  normalizeStockCompare,
  stockCompareStaleness,
  venueNames,
  type StockCompareRow,
  type StockCompareSize,
  type StockCompareVersion,
} from "../src/query/stockCompare.js";
import { FakePg } from "./fakePg.js";
import { fakeFetch, jsonResponse } from "./helpers.js";

const TTL = { source: "test", freshForMs: 600_000, deadAfterMs: 6_000_000 };
const T0 = 1_700_000_000_000;
const MIN = 60_000;

const NVDAB_A = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const NVDAON_A = "0xa9ee28c80f960b889dfbd1902055218cba016f75";
const SPYB_A = "0x7138b48df7d98d7e3cc221bfe7192d0a178182d8";
const SPYON_A = "0x6a708ead771238919d85930b5a0f10454e1c331a";

const originalEnv = {
  key: process.env["BINANCE_WEB3_API_KEY"],
  secret: process.env["BINANCE_WEB3_SECRET_KEY"],
  token: process.env["DP_AUTH_TOKEN"],
  rps: process.env["BINANCE_RWA_RPS"],
};
const originalFetch = globalThis.fetch;
function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
afterEach(() => {
  restore("BINANCE_WEB3_API_KEY", originalEnv.key);
  restore("BINANCE_WEB3_SECRET_KEY", originalEnv.secret);
  restore("DP_AUTH_TOKEN", originalEnv.token);
  restore("BINANCE_RWA_RPS", originalEnv.rps);
  globalThis.fetch = originalFetch;
});

function rwaRow(over: Partial<RwaToken> & Pick<RwaToken, "address" | "symbol" | "platform" | "underlyingTicker">): RwaToken {
  return {
    name: null, underlyingName: null, decimals: 18, tokenToShareRatio: 1, tokenPriceUsd: null, referencePriceUsd: 100,
    navPremiumBps: null, underlyingMarketCapUsd: null, underlyingVolume24hUsd: null, openState: true, marketStatus: null,
    reasonCode: "TRADING", nextOpenMs: null, nextCloseMs: null, ...over,
  };
}
const NVDA_B = rwaRow({ address: NVDAB_A, symbol: "NVDAB", platform: "bstock", underlyingTicker: "NVDA", tokenToShareRatio: 1.0007782237528078, referencePriceUsd: 237.40985268157382 });
const NVDA_O = rwaRow({ address: NVDAON_A, symbol: "NVDAon", platform: "ondo", underlyingTicker: "NVDA", tokenToShareRatio: 1.0017152487959897, referencePriceUsd: 237.40985268157382, marketStatus: "regular" });
const SPY_B = rwaRow({ address: SPYB_A, symbol: "SPYB", platform: "bstock", underlyingTicker: "SPY", tokenToShareRatio: 1.0017297920368353, referencePriceUsd: 782.3234608923229 });
const SPY_O = rwaRow({ address: SPYON_A, symbol: "SPYon", platform: "ondo", underlyingTicker: "SPY", tokenToShareRatio: 1.0094730727840426, referencePriceUsd: 782.3234608923229, marketStatus: "regular" });

async function seedUniverse(store: MemoryStore, rows: RwaToken[]): Promise<void> {
  await store.put(RWA_UNIVERSE_KEY, { rows, byPlatform: {} }, TTL);
}

async function storedRows(store: MemoryStore): Promise<Record<string, StockCompareRow>> {
  return normalizeStockCompare((await store.get<unknown>(STOCK_COMPARE_KEY))?.data).rows;
}

// ---------------------------------------------------------------- fixtures ----

/** A virtual clock whose sleep advances it, so give-up and pacing logic runs in zero real time. */
function clock() {
  const state = { t: T0 };
  return {
    state,
    now: () => state.t,
    sleep: async (ms: number) => { state.t += ms; },
  };
}

function fakeLimiter(available: () => number) {
  const calls = { acquire: 0 };
  const limiter: RateLimiter = {
    acquire: async () => { calls.acquire++; },
    available,
  };
  return { limiter, calls };
}

interface QuoteCall { request: StockCompareQuoteRequest; at: number }

/**
 * A scripted aggregator: a buy gets `amount / pricePerToken` tokens, a sell pays back `amount x price x 0.999`
 * (a 10 bps round trip), legs fixed. `override` answers or throws for a specific call.
 */
function scriptedQuote(
  now: () => number,
  override: (request: StockCompareQuoteRequest, index: number) => StockCompareRawQuote | Error | undefined = () => undefined,
) {
  const calls: QuoteCall[] = [];
  const quote: StockCompareQuoteFn = async (request) => {
    const index = calls.length;
    calls.push({ request, at: now() });
    const forced = override(request, index);
    if (forced instanceof Error) throw forced;
    if (forced !== undefined) return forced;
    const amount = BigInt(request.amountAtomic);
    const isBuy = request.tokenIn === BINANCE_FLASH_USDT_ADDRESS;
    return isBuy
      ? { toTokenAmount: (amount / 100n).toString(), decimals: 18, legs: ["Rfq Neptunex"] }
      : { toTokenAmount: ((amount * 100n * 999n) / 1000n).toString(), decimals: 18, legs: ["Metric", "Elfomofi"] };
  };
  return { quote, calls };
}

const noRoute = () => new AdapterError("binance-rwa", "Path not found", undefined, "40465");

// ------------------------------------------------------------ maths (step 0) ----

describe("share and bps maths against the step-0 measurements", () => {
  it("NVDAB 500 USDT: -12 bps cost, 2 bps round trip, rfq buy", () => {
    const size = buildAnsweredSize({
      usdt: 500, tokensOut: 2106869604429252973 / 1e18, ratio: 1.0007782237528078, referencePriceUsd: 237.40985268157382,
      usdtBack: 499891121199307471154 / 1e18, sellCode: null, legs: ["Rfq Neptunex"],
    });
    assert.equal(size.costBps, -12);
    assert.equal(size.roundTripBps, 2);
    assert.ok(Math.abs((size.shares as number) - 2.1085092204) < 1e-8);
    assert.equal(size.route, "rfq");
    assert.deepEqual(size.venues, ["Rfq Neptunex"]);
  });

  it("NVDAB 5000 USDT: -12 bps cost, 3 bps round trip", () => {
    const size = buildAnsweredSize({
      usdt: 5000, tokensOut: 21068906669766691743 / 1e18, ratio: 1.0007782237528078, referencePriceUsd: 237.40985268157382,
      usdtBack: 4998528477707154668812 / 1e18, sellCode: null, legs: ["Rfq Neptunex", "Elfomofi"],
    });
    assert.equal(size.costBps, -12);
    assert.equal(size.roundTripBps, 3);
    assert.equal(size.route, "mixed");
  });

  it("SPYon 500 USDT: the thin-pool disaster, 57286 bps cost, 8537 bps round trip, amm", () => {
    const size = buildAnsweredSize({
      usdt: 500, tokensOut: 94094194819829772 / 1e18, ratio: 1.0094730727840426, referencePriceUsd: 782.3234608923229,
      usdtBack: 73141732436203231309 / 1e18, sellCode: null, legs: ["Pancakeswap V3"],
    });
    assert.equal(size.costBps, 57286);
    assert.equal(size.roundTripBps, 8537);
    assert.equal(size.route, "amm");
  });

  it("a sell-back that did not answer leaves roundTripBps null and carries its code", () => {
    const size = buildAnsweredSize({
      usdt: 100, tokensOut: 1, ratio: 1, referencePriceUsd: 100, usdtBack: null, sellCode: "sell_failed", legs: ["Metric"],
    });
    assert.equal(size.ok, true);
    assert.equal(size.roundTripBps, null);
    assert.equal(size.code, "sell_failed");
  });

  it("route classification and venue names", () => {
    assert.equal(classifyRoute(["Rfq Neptunex", "Rfq Halfmoon"]), "rfq");
    assert.equal(classifyRoute(["Metric", "Uniswap V4"]), "amm");
    assert.equal(classifyRoute(["Rfq Neptunex", "Elfomofi"]), "mixed");
    assert.equal(classifyRoute([]), null);
    assert.deepEqual(venueNames(["Metric", "Metric", "Elfomofi", "Kipseli", "Uniswap V4", "Genius"]), ["Metric", "Elfomofi", "Kipseli", "Uniswap V4"]);
    assert.deepEqual(venueNames(["ok <script>", "x".repeat(40), "", "Fine One"]), ["Fine One"]);
  });
});

// ----------------------------------------------------------------- verdicts ----

function size(usdt: number, shares: number | null, costBps: number | null, over: Partial<StockCompareSize> = {}): StockCompareSize {
  return {
    usdt, ok: shares !== null, tokensOut: shares, shares, costBps, roundTripBps: 3, route: "rfq", venues: ["Metric"], ...over,
  };
}
function version(issuer: "bstock" | "ondo", sizes: StockCompareSize[]): StockCompareVersion {
  const address = issuer === "bstock" ? NVDAB_A : NVDAON_A;
  return { issuer, symbol: issuer === "bstock" ? "NVDAB" : "NVDAon", address, ratio: 1, openState: true, marketStatus: null, sizes };
}
function row(versions: StockCompareVersion[], quotedAt = T0): StockCompareRow {
  return { ticker: "NVDA", quotedAt, referencePriceUsd: 100, versions };
}

describe("computeVerdicts", () => {
  it("edge 19.0 bps is about_same, 21.0 is not", () => {
    const a = computeVerdicts(row([version("bstock", [size(100, 1, 0)]), version("ondo", [size(100, 1.0019, 0)])]))[0]!;
    assert.equal(a.edgeBps, 19);
    assert.equal(a.about_same, true);
    assert.equal(a.best, "ondo");
    const b = computeVerdicts(row([version("bstock", [size(100, 1, 0)]), version("ondo", [size(100, 1.0021, 0)])]))[0]!;
    assert.equal(b.edgeBps, 21);
    assert.equal(b.about_same, false);
    assert.equal(b.best, "ondo");
  });

  it("exactly 20.0 bps is not about_same", () => {
    const v = computeVerdicts(row([version("bstock", [size(100, 1.002, 0)]), version("ondo", [size(100, 1, 0)])]))[0]!;
    assert.equal(v.edgeBps, 20);
    assert.equal(v.about_same, false);
    assert.equal(v.best, "bstock");
  });

  it("avoid lists a version costing more than 200 bps: 199 and 200 pass, 201 does not", () => {
    const at = (cost: number) => computeVerdicts(row([version("bstock", [size(100, 1, 0)]), version("ondo", [size(100, 0.9, cost)])]))[0]!.avoid;
    assert.deepEqual(at(199), []);
    assert.deepEqual(at(200), []);
    assert.deepEqual(at(201), ["ondo"]);
    assert.deepEqual(computeVerdicts(row([version("bstock", [size(100, 1, 450)]), version("ondo", [size(100, 1, 300)])]))[0]!.avoid, ["bstock", "ondo"]);
  });

  it("a single version with a route is `only`, with no edge", () => {
    const v = computeVerdicts(row([version("bstock", [size(5000, null, null, { ok: false, code: "no_route", route: null, venues: [] })]), version("ondo", [size(5000, 26.1, -1)])]))[0]!;
    assert.equal(v.only, "ondo");
    assert.equal(v.best, "ondo");
    assert.equal(v.edgeBps, null);
    assert.equal(v.about_same, false);
  });

  it("no version with a route leaves everything empty", () => {
    const failed = size(100, null, null, { ok: false, code: "quote_failed", route: null, venues: [] });
    const v = computeVerdicts(row([version("bstock", [failed]), version("ondo", [failed])]))[0]!;
    assert.deepEqual(v, { usdt: 100, best: null, edgeBps: null, about_same: false, avoid: [], only: null });
  });

  it("one verdict per size, ascending, each judged on its own size", () => {
    const verdicts = computeVerdicts(row([
      version("bstock", [size(5000, 6, 4), size(100, 1, 4), size(1000, 3, 4)]),
      version("ondo", [size(100, 2, 4), size(1000, 3, 4), size(5000, 6.5, 4)]),
    ]));
    assert.deepEqual(verdicts.map((v) => [v.usdt, v.best]), [[100, "ondo"], [1000, "bstock"], [5000, "ondo"]]);
    assert.equal(verdicts[1]!.about_same, true);
  });
});

describe("staleness", () => {
  it("fresh <= 30 min, stale <= 2 h, dead beyond", () => {
    assert.equal(stockCompareStaleness(T0, T0 + 30 * MIN), "fresh");
    assert.equal(stockCompareStaleness(T0, T0 + 30 * MIN + 1), "stale");
    assert.equal(stockCompareStaleness(T0, T0 + 120 * MIN), "stale");
    assert.equal(stockCompareStaleness(T0, T0 + 120 * MIN + 1), "dead");
    assert.equal(stockCompareStaleness(T0 + 5 * MIN, T0), "fresh");
  });
});

// -------------------------------------------------------------------- merge ----

describe("mergeStockCompareRows", () => {
  const r = (ticker: string, quotedAt: number): StockCompareRow => ({ ticker, quotedAt, referencePriceUsd: 10, versions: [] });

  it("a refreshed ticker is replaced, an untouched one keeps its row", () => {
    const merged = mergeStockCompareRows({ AAA: r("AAA", T0 - 10 * MIN), BBB: r("BBB", T0 - 20 * MIN) }, [r("AAA", T0)], T0);
    assert.equal(merged["AAA"]!.quotedAt, T0);
    assert.equal(merged["BBB"]!.quotedAt, T0 - 20 * MIN);
  });

  it("rows older than 2 h are dropped, exactly 2 h stays", () => {
    const merged = mergeStockCompareRows({ OLD: r("OLD", T0 - 120 * MIN - 1), EDGE: r("EDGE", T0 - 120 * MIN) }, [], T0);
    assert.deepEqual(Object.keys(merged), ["EDGE"]);
  });

  it("is bounded", () => {
    const many = Array.from({ length: 260 }, (_, i) => r(`T${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`, T0 - i));
    assert.equal(Object.keys(mergeStockCompareRows({}, many, T0)).length, 200);
  });
});

describe("normalizeStockCompare", () => {
  it("keeps a valid row, drops malformed ones, never throws", () => {
    const good = row([version("bstock", [size(100, 1, 1)]), version("ondo", [size(100, 1, 1)])]);
    const snapshot = normalizeStockCompare({
      rows: {
        NVDA: good,
        bad1: { ticker: "bad1" },
        SPY: { ...good, ticker: "SPY", versions: [{ issuer: "xstock" }] },
        QQQ: { ...good, ticker: "QQQ", referencePriceUsd: -1 },
        MISMATCH: { ...good, ticker: "OTHER" },
      },
    });
    assert.deepEqual(Object.keys(snapshot.rows), ["NVDA"]);
    assert.deepEqual(normalizeStockCompare(null), { rows: {} });
    assert.deepEqual(normalizeStockCompare("x"), { rows: {} });
  });
});

// ----------------------------------------------------------------- planning ----

describe("planStockCompareTickers", () => {
  it("needs a bStock and an Ondo row; xStocks, bad tickers and unusable rows are left out", () => {
    const xstock = rwaRow({ address: "0x00000000000000000000000000000000000000a1", symbol: "AAPLx", platform: "xstock", underlyingTicker: "AAPL" });
    const lonely = rwaRow({ address: "0x00000000000000000000000000000000000000a2", symbol: "TSLAB", platform: "bstock", underlyingTicker: "TSLA" });
    const dotted = [
      rwaRow({ address: "0x00000000000000000000000000000000000000a3", symbol: "BRKB", platform: "bstock", underlyingTicker: "BRK.B" }),
      rwaRow({ address: "0x00000000000000000000000000000000000000a4", symbol: "BRKBon", platform: "ondo", underlyingTicker: "BRK.B" }),
    ];
    const noRatio = [
      rwaRow({ address: "0x00000000000000000000000000000000000000a5", symbol: "MUB", platform: "bstock", underlyingTicker: "MU", tokenToShareRatio: null }),
      rwaRow({ address: "0x00000000000000000000000000000000000000a6", symbol: "MUon", platform: "ondo", underlyingTicker: "MU" }),
    ];
    const closedOndo = { ...SPY_O, openState: false, marketStatus: "closed" };
    const plan = planStockCompareTickers([NVDA_O, xstock, lonely, ...dotted, ...noRatio, SPY_B, closedOndo, NVDA_B]);
    assert.deepEqual(plan.map((p) => p.ticker), ["NVDA", "SPY"]);
    assert.deepEqual(plan[0]!.versions.map((v) => v.issuer), ["bstock", "ondo"]);
    assert.equal(plan[1]!.versions[1]!.row.openState, false);
  });
});

// -------------------------------------------------------------------- cycle ----

const OPTS = { config: { minHeadroom: 10, rps: 2 } };

describe("runStockCompare", () => {
  it("quotes each version at three sizes, sells back the exact quoted amount, and stores the merged rows", async () => {
    const store = new MemoryStore();
    await seedUniverse(store, [NVDA_B, NVDA_O, SPY_B, SPY_O]);
    const c = clock();
    const { limiter, calls: lim } = fakeLimiter(() => 18);
    const { quote, calls } = scriptedQuote(c.now);
    const result = await runStockCompare(store, new AbortController().signal, { ...OPTS, limiter, quote, now: c.now, sleep: c.sleep });

    assert.equal(result.endedBy, "complete");
    assert.equal(result.tickersQuoted, 2);
    assert.equal(result.quotesSent, 2 * 2 * 3 * 2);
    assert.equal(lim.acquire, result.quotesSent, "every send takes a slot from the shared limiter");
    assert.equal(result.published, true);

    // buy then sell-back of exactly the quoted amount, per size
    const first = calls[0]!.request;
    assert.equal(first.tokenIn, BINANCE_FLASH_USDT_ADDRESS);
    assert.equal(first.amountAtomic, (100n * 10n ** 18n).toString());
    const buy = await scriptedQuote(c.now).quote(first, new AbortController().signal);
    assert.deepEqual(calls[1]!.request, { tokenIn: first.tokenOut, tokenOut: BINANCE_FLASH_USDT_ADDRESS, amountAtomic: buy.toTokenAmount });
    const sizes = calls.filter((x) => x.request.tokenIn === BINANCE_FLASH_USDT_ADDRESS).map((x) => x.request.amountAtomic);
    assert.deepEqual([...new Set(sizes)], ["100000000000000000000", "1000000000000000000000", "5000000000000000000000"]);

    const rows = await storedRows(store);
    assert.deepEqual(Object.keys(rows), ["NVDA", "SPY"]);
    const nvda = rows["NVDA"]!;
    assert.equal(nvda.referencePriceUsd, 237.40985268157382);
    assert.deepEqual(nvda.versions.map((v) => [v.issuer, v.symbol, v.marketStatus]), [["bstock", "NVDAB", null], ["ondo", "NVDAon", "regular"]]);
    const s = nvda.versions[0]!.sizes[0]!;
    // 100 USDT at the scripted 100 USDT per token = 1 token = ratio shares
    assert.equal(s.tokensOut, 1);
    assert.ok(Math.abs((s.shares as number) - 1.00077822) < 1e-8);
    assert.equal(s.roundTripBps, 10);
    assert.equal(s.route, "rfq");
    assert.equal(s.ok, true);
    assert.equal(rows["SPY"]!.quotedAt, c.state.t);
    assert.ok(nvda.quotedAt > T0 && nvda.quotedAt < c.state.t);
  });

  it("every row it publishes reads back unchanged through the normalizer, even for odd issuer data", async () => {
    const store = new MemoryStore();
    const weird = { ...NVDA_O, marketStatus: "" };
    const badSymbol = [
      rwaRow({ address: "0x00000000000000000000000000000000000000b1", symbol: "MU B", platform: "bstock", underlyingTicker: "MU" }),
      rwaRow({ address: "0x00000000000000000000000000000000000000b2", symbol: "MUon", platform: "ondo", underlyingTicker: "MU" }),
    ];
    await seedUniverse(store, [NVDA_B, weird, SPY_B, SPY_O, ...badSymbol]);
    const c = clock();
    const { limiter } = fakeLimiter(() => 18);
    const { quote } = scriptedQuote(c.now, (request) => (request.tokenOut === SPYON_A ? noRoute() : undefined));
    const result = await runStockCompare(store, new AbortController().signal, { ...OPTS, limiter, quote, now: c.now, sleep: c.sleep });
    assert.equal(result.tickersPlanned, 2, "a row whose symbol the store would not read back is not quoted");
    const raw = (await store.get<{ rows: Record<string, StockCompareRow> }>(STOCK_COMPARE_KEY))!.data;
    assert.deepEqual(normalizeStockCompare(raw), raw);
    assert.equal(raw.rows["NVDA"]!.versions[1]!.marketStatus, null);
  });

  it("no route (40465) skips the sell-back; other failures are quote_failed; a failed sell-back keeps the buy", async () => {
    const store = new MemoryStore();
    await seedUniverse(store, [NVDA_B, NVDA_O]);
    const c = clock();
    const { limiter } = fakeLimiter(() => 18);
    const { quote, calls } = scriptedQuote(c.now, (request) => {
      const buyingBstock = request.tokenOut === NVDAB_A;
      const sellingOndo = request.tokenIn === NVDAON_A;
      // bStock: 100 -> no route, 1000 -> other failure, 5000 -> fine
      if (buyingBstock && request.amountAtomic === (100n * 10n ** 18n).toString()) return noRoute();
      if (buyingBstock && request.amountAtomic === (1000n * 10n ** 18n).toString()) return new AdapterError("binance-rwa", "boom", 500);
      // Ondo sell-backs: no route at the first, a plain failure at the second
      if (sellingOndo && request.amountAtomic === (100n * 10n ** 18n / 100n).toString()) return noRoute();
      if (sellingOndo && request.amountAtomic === (1000n * 10n ** 18n / 100n).toString()) return new Error("timeout");
      return undefined;
    });
    await runStockCompare(store, new AbortController().signal, { ...OPTS, limiter, quote, now: c.now, sleep: c.sleep });
    const nvda = (await storedRows(store))["NVDA"]!;
    const [b100, b1000, b5000] = nvda.versions[0]!.sizes;
    assert.deepEqual([b100!.ok, b100!.code, b100!.shares, b100!.route, b100!.venues], [false, "no_route", null, null, []]);
    assert.deepEqual([b1000!.ok, b1000!.code], [false, "quote_failed"]);
    assert.equal(b5000!.ok, true);
    const [o100, o1000, o5000] = nvda.versions[1]!.sizes;
    assert.deepEqual([o100!.ok, o100!.code, o100!.roundTripBps], [true, "sell_no_route", null]);
    assert.deepEqual([o1000!.ok, o1000!.code, o1000!.roundTripBps], [true, "sell_failed", null]);
    assert.equal(o5000!.code, undefined);
    // 2 buys for the two failed bStock sizes, no sells for them: 2 + 4 bStock + 12 ondo
    assert.equal(calls.length, 2 + 2 * 1 + 6, "two failed bStock buys, one answered bStock size with its sell-back, six Ondo quotes");
  });

  it("an Ondo version whose session is closed stays in the row with its marketStatus", async () => {
    const store = new MemoryStore();
    const closed = { ...NVDA_O, openState: false, marketStatus: "overnight", reasonCode: "UNSUPPORTED" };
    await seedUniverse(store, [NVDA_B, closed]);
    const c = clock();
    const { limiter } = fakeLimiter(() => 18);
    const { quote } = scriptedQuote(c.now, (request) => (request.tokenOut === NVDAON_A ? new AdapterError("binance-rwa", "market closed", undefined, "40999") : undefined));
    await runStockCompare(store, new AbortController().signal, { ...OPTS, limiter, quote, now: c.now, sleep: c.sleep });
    const ondo = (await storedRows(store))["NVDA"]!.versions[1]!;
    assert.deepEqual([ondo.issuer, ondo.openState, ondo.marketStatus], ["ondo", false, "overnight"]);
    assert.ok(ondo.sizes.every((s) => !s.ok && s.code === "quote_failed"));
    const verdicts = computeVerdicts((await storedRows(store))["NVDA"]!);
    assert.ok(verdicts.every((v) => v.only === "bstock"));
  });

  describe("budget, live agents first", () => {
    it("never sends below the headroom, gives up after 30 s, and publishes nothing", async () => {
      const store = new MemoryStore();
      await seedUniverse(store, [NVDA_B, NVDA_O]);
      const c = clock();
      const { limiter, calls: lim } = fakeLimiter(() => 9);
      const { quote, calls } = scriptedQuote(c.now);
      const result = await runStockCompare(store, new AbortController().signal, { ...OPTS, limiter, quote, now: c.now, sleep: c.sleep });
      assert.equal(result.endedBy, "no_headroom");
      assert.equal(calls.length, 0);
      assert.equal(lim.acquire, 0);
      assert.equal(result.headroomWaits, 30);
      assert.equal(c.state.t - T0, 30_000);
      assert.equal(result.published, false);
      assert.equal(await store.get(STOCK_COMPARE_KEY), null, "a cycle that quoted nothing does not publish");
    });

    it("headroom exactly at the minimum is enough, one below is not", async () => {
      const store = new MemoryStore();
      await seedUniverse(store, [NVDA_B, NVDA_O]);
      const c = clock();
      const { quote, calls } = scriptedQuote(c.now);
      const at10 = await runStockCompare(store, new AbortController().signal, { ...OPTS, limiter: fakeLimiter(() => 10).limiter, quote, now: c.now, sleep: c.sleep });
      assert.equal(at10.endedBy, "complete");
      assert.ok(calls.length > 0);
    });

    it("waits for headroom to come back (re-checking every second) and then carries on", async () => {
      const store = new MemoryStore();
      await seedUniverse(store, [NVDA_B, NVDA_O]);
      const c = clock();
      let checks = 0;
      // 9 free for the first three checks, then plenty
      const { limiter } = fakeLimiter(() => (checks++ < 3 ? 9 : 18));
      const { quote, calls } = scriptedQuote(c.now);
      const result = await runStockCompare(store, new AbortController().signal, { ...OPTS, limiter, quote, now: c.now, sleep: c.sleep });
      assert.equal(result.endedBy, "complete");
      assert.equal(result.headroomWaits, 3);
      assert.equal(calls[0]!.at - T0, 3_000);
    });

    it("stays at or under its own pace: consecutive sends at least 500 ms apart at 2 rps", async () => {
      const store = new MemoryStore();
      await seedUniverse(store, [NVDA_B, NVDA_O]);
      const c = clock();
      const { limiter } = fakeLimiter(() => 18);
      const { quote, calls } = scriptedQuote(c.now);
      await runStockCompare(store, new AbortController().signal, { config: { minHeadroom: 10, rps: 2 }, limiter, quote, now: c.now, sleep: c.sleep });
      const gaps = calls.slice(1).map((call, i) => call.at - calls[i]!.at);
      assert.ok(gaps.length > 5);
      assert.ok(gaps.every((g) => g >= 500), `gaps: ${gaps.join(",")}`);
      assert.ok(gaps.every((g) => g <= 500), "and it does not idle longer than the pace needs");
    });

    it("HTTP 429 ends the cycle at once; the half-quoted ticker is not written, finished ones are", async () => {
      const store = new MemoryStore();
      await seedUniverse(store, [NVDA_B, NVDA_O, SPY_B, SPY_O]);
      const c = clock();
      const { limiter } = fakeLimiter(() => 18);
      // NVDA is 12 quotes; the 13th call is SPY's first
      const { quote, calls } = scriptedQuote(c.now, (_request, index) => (index === 16 ? new AdapterError("binance-rwa", "rate limited", 429) : undefined));
      const result = await runStockCompare(store, new AbortController().signal, { ...OPTS, limiter, quote, now: c.now, sleep: c.sleep });
      assert.equal(result.endedBy, "rate_limited");
      assert.equal(calls.length, 17, "no call after the 429");
      assert.equal(result.tickersQuoted, 1);
      assert.deepEqual(Object.keys(await storedRows(store)), ["NVDA"]);
    });

    it("a rate-budget error from the quote, or a limiter that cannot give a slot, ends the cycle", async () => {
      for (const scenario of ["quote", "limiter"] as const) {
        const store = new MemoryStore();
        await seedUniverse(store, [NVDA_B, NVDA_O]);
        const c = clock();
        const failing: RateLimiter = { available: () => 18, acquire: async () => { throw new Error("no slot in time"); } };
        const { limiter } = fakeLimiter(() => 18);
        const { quote, calls } = scriptedQuote(c.now, (_r, index) => (index === 3 ? new BinanceFlashRateBudgetError() : undefined));
        const result = await runStockCompare(store, new AbortController().signal, {
          ...OPTS, limiter: scenario === "limiter" ? failing : limiter, quote, now: c.now, sleep: c.sleep,
        });
        assert.equal(result.endedBy, "rate_budget", scenario);
        assert.equal(calls.length, scenario === "quote" ? 4 : 0, scenario);
        assert.equal(await store.get(STOCK_COMPARE_KEY), null, scenario);
      }
    });

    it("a rejected key (401) ends the cycle too", async () => {
      const store = new MemoryStore();
      await seedUniverse(store, [NVDA_B, NVDA_O]);
      const c = clock();
      const { limiter } = fakeLimiter(() => 18);
      const { quote, calls } = scriptedQuote(c.now, () => new AdapterError("binance-rwa", "authentication rejected", 401));
      const result = await runStockCompare(store, new AbortController().signal, { ...OPTS, limiter, quote, now: c.now, sleep: c.sleep });
      assert.equal(result.endedBy, "auth_rejected");
      assert.equal(calls.length, 1);
    });

    it("stops by itself before the scheduler timeout", async () => {
      const store = new MemoryStore();
      await seedUniverse(store, [NVDA_B, NVDA_O, SPY_B, SPY_O]);
      const c = clock();
      const { limiter } = fakeLimiter(() => 18);
      const { quote } = scriptedQuote(c.now, (_r, index) => {
        if (index === 12) c.state.t += STOCK_COMPARE_CYCLE_BUDGET_MS;
        return undefined;
      });
      const result = await runStockCompare(store, new AbortController().signal, { ...OPTS, limiter, quote, now: c.now, sleep: c.sleep });
      assert.equal(result.endedBy, "time_budget");
      assert.deepEqual(Object.keys(await storedRows(store)), ["NVDA"]);
    });

    it("an aborted run stops sending", async () => {
      const store = new MemoryStore();
      await seedUniverse(store, [NVDA_B, NVDA_O]);
      const c = clock();
      const controller = new AbortController();
      const { limiter } = fakeLimiter(() => 18);
      const { quote, calls } = scriptedQuote(c.now, (_r, index) => {
        if (index === 2) controller.abort();
        return undefined;
      });
      const result = await runStockCompare(store, controller.signal, { ...OPTS, limiter, quote, now: c.now, sleep: c.sleep });
      assert.equal(result.endedBy, "aborted");
      assert.equal(calls.length, 3);
    });
  });

  it("keeps the previous row of a ticker the cycle did not finish and refreshes the least recent first", async () => {
    const store = new MemoryStore();
    await seedUniverse(store, [NVDA_B, NVDA_O, SPY_B, SPY_O]);
    const c = clock();
    const oldSpy = row([version("bstock", [size(100, 1, 1)]), version("ondo", [size(100, 1, 1)])], T0 - 90 * MIN);
    oldSpy.ticker = "SPY";
    const recentNvda = row([version("bstock", [size(100, 1, 1)]), version("ondo", [size(100, 1, 1)])], T0 - 5 * MIN);
    await store.put(STOCK_COMPARE_KEY, { rows: { SPY: oldSpy, NVDA: recentNvda } }, TTL);
    const { limiter } = fakeLimiter(() => 18);
    // SPY (older) goes first and finishes; the 429 lands during NVDA
    const { quote, calls } = scriptedQuote(c.now, (_r, index) => (index === 14 ? new AdapterError("binance-rwa", "rate limited", 429) : undefined));
    const result = await runStockCompare(store, new AbortController().signal, { ...OPTS, limiter, quote, now: c.now, sleep: c.sleep });
    assert.equal(calls[0]!.request.tokenOut, SPYB_A);
    assert.equal(result.tickersQuoted, 1);
    const rows = await storedRows(store);
    assert.ok(rows["SPY"]!.quotedAt > T0 && rows["SPY"]!.quotedAt <= c.state.t);
    assert.deepEqual(rows["NVDA"], recentNvda, "the unfinished ticker keeps its previous row untouched");
  });

  it("drops rows older than 2 h when it publishes, and keeps an untouched ticker's row", async () => {
    const store = new MemoryStore();
    await seedUniverse(store, [NVDA_B, NVDA_O]);
    const c = clock();
    const filler = (ticker: string, quotedAt: number): StockCompareRow => ({ ticker, quotedAt, referencePriceUsd: 1, versions: [] });
    await store.put(STOCK_COMPARE_KEY, { rows: { OLD: filler("OLD", T0 - 121 * MIN), KEEP: filler("KEEP", T0 - 60 * MIN) } }, TTL);
    const { limiter } = fakeLimiter(() => 18);
    const { quote } = scriptedQuote(c.now);
    await runStockCompare(store, new AbortController().signal, { ...OPTS, limiter, quote, now: c.now, sleep: c.sleep });
    assert.deepEqual(Object.keys(await storedRows(store)), ["KEEP", "NVDA"]);
  });

  it("skips the cycle when universe:rwa is missing or not fresh", async () => {
    const c = clock();
    const { limiter } = fakeLimiter(() => 18);
    const { quote, calls } = scriptedQuote(c.now);

    const empty = new MemoryStore();
    assert.equal((await runStockCompare(empty, new AbortController().signal, { ...OPTS, limiter, quote, now: c.now, sleep: c.sleep })).endedBy, "universe_not_fresh");

    let wall = Date.now();
    const aging = new MemoryStore(() => wall);
    await aging.put(RWA_UNIVERSE_KEY, { rows: [NVDA_B, NVDA_O], byPlatform: {} }, { source: "t", freshForMs: 1_000, deadAfterMs: 10_000 });
    wall += 5_000;
    const result = await runStockCompare(aging, new AbortController().signal, { ...OPTS, limiter, quote, now: c.now, sleep: c.sleep });
    assert.equal(result.endedBy, "universe_not_fresh");
    assert.equal(calls.length, 0);
    assert.equal(await aging.get(STOCK_COMPARE_KEY), null);
  });
});

// ----------------------------------------------------- the real request path ----

describe("createFlashQuote (default path, fake fetch)", () => {
  const request: StockCompareQuoteRequest = { tokenIn: BINANCE_FLASH_USDT_ADDRESS, tokenOut: NVDAB_A, amountAtomic: "100000000000000000000" };
  const envelope = (routerResult: unknown) => jsonResponse({ code: 0, msg: "success", data: { executionMode: "SWAP", rfq: null, routerResult } });

  it("sends the signed quote-and-swap query the live route uses and reads only amount, decimals and legs", async () => {
    process.env["BINANCE_WEB3_API_KEY"] = "k";
    process.env["BINANCE_WEB3_SECRET_KEY"] = "s";
    const ff = fakeFetch(() => envelope({
      fromTokenAmount: request.amountAtomic,
      toTokenAmount: "421000000000000000",
      toToken: { decimal: "18", tokenContractAddress: NVDAB_A },
      dexRouterList: [{ dexProtocol: { dexName: "Rfq Neptunex", percent: "100.00" } }, { dexProtocol: { dexName: "Metric", percent: "5" } }],
      priceImpactPercent: "0.85",
    }));
    const raw = await createFlashQuote({ fetchFn: ff.fetch })(request, new AbortController().signal);
    assert.deepEqual(raw, { toTokenAmount: "421000000000000000", decimals: 18, legs: ["Rfq Neptunex", "Metric"] });
    const url = new URL(ff.calls[0]!.url);
    assert.equal(url.pathname, "/build/api/v1/dex/aggregator/quote-and-swap");
    assert.equal(url.searchParams.get("enableRFQ"), "true");
    assert.equal(url.searchParams.get("userWalletAddress"), STOCK_COMPARE_TAKER);
    assert.equal(url.searchParams.get("fromTokenAddress"), BINANCE_FLASH_USDT_ADDRESS);
    assert.equal(url.searchParams.get("toTokenAddress"), NVDAB_A);
    assert.equal(url.searchParams.get("amount"), request.amountAtomic);
    assert.equal(url.searchParams.get("vendor"), "LiquidMesh");
    assert.equal(ff.calls[0]!.method, "GET");
    assert.ok(ff.calls[0]!.headers["x-oc-sign"]);
  });

  it("maps the in-band no-route code and a 429 onto the errors the cycle acts on", async () => {
    process.env["BINANCE_WEB3_API_KEY"] = "k";
    process.env["BINANCE_WEB3_SECRET_KEY"] = "s";
    const noPath = fakeFetch(() => jsonResponse({ code: 40465, msg: "LiquidMesh EVM quoteAndSwap error: Path not found" }));
    await assert.rejects(
      createFlashQuote({ fetchFn: noPath.fetch })(request, new AbortController().signal),
      (e: unknown) => e instanceof AdapterError && e.upstreamCode === "40465",
    );
    const limited = fakeFetch(() => new Response("", { status: 429 }));
    await assert.rejects(
      createFlashQuote({ fetchFn: limited.fetch })(request, new AbortController().signal),
      (e: unknown) => e instanceof AdapterError && e.status === 429,
    );
    assert.equal(limited.calls.length, 1, "no retry on 429");
  });

  it("refuses a malformed or mismatched answer", () => {
    assert.throws(() => parseFlashRouterResult({}, request));
    assert.throws(() => parseFlashRouterResult({ routerResult: { toTokenAmount: "0" } }, request));
    assert.throws(() => parseFlashRouterResult({ routerResult: { toTokenAmount: "1.5" } }, request));
    assert.throws(() => parseFlashRouterResult({ routerResult: { toTokenAmount: "5", fromTokenAmount: "7" } }, request));
    assert.deepEqual(parseFlashRouterResult({ routerResult: { toTokenAmount: "5" } }, request), { toTokenAmount: "5", decimals: null, legs: [] });
  });

  it("never reads priceImpactPercent (a fraction, DEVEX PITFALL-35)", () => {
    for (const file of ["../src/jobs/stockCompare.ts", "../src/query/stockCompare.ts"]) {
      const code = readFileSync(new URL(file, import.meta.url), "utf8")
        .split(/\r?\n/u).filter((line) => !/^\s*(\*|\/\*|\/\/)/u.test(line)).join("\n");
      assert.ok(!code.includes("priceImpact"), file);
    }
  });
});

// ------------------------------------------------------------ config / flag ----

describe("configuration", () => {
  it("defaults to 10 free slots and 2 rps when the bucket allows it", () => {
    assert.deepEqual(readStockCompareConfig({ BINANCE_RWA_RPS: "18" }), { minHeadroom: 10, rps: 2 });
    assert.deepEqual(readStockCompareConfig({ BINANCE_RWA_RPS: "18", STOCK_COMPARE_MIN_HEADROOM: "12", STOCK_COMPARE_RPS: "3" }), { minHeadroom: 12, rps: 3 });
  });

  it("rejects malformed values and a headroom or pace the shared bucket could never meet", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "", " 3x"]) {
      assert.throws(() => readStockCompareConfig({ BINANCE_RWA_RPS: "18", STOCK_COMPARE_MIN_HEADROOM: bad }), /STOCK_COMPARE_MIN_HEADROOM/u, bad);
      assert.throws(() => readStockCompareConfig({ BINANCE_RWA_RPS: "18", STOCK_COMPARE_RPS: bad }), /STOCK_COMPARE_RPS/u, bad);
    }
    assert.throws(() => readStockCompareConfig({ BINANCE_RWA_RPS: "18", STOCK_COMPARE_MIN_HEADROOM: "19" }), /STOCK_COMPARE_MIN_HEADROOM/u);
    assert.throws(() => readStockCompareConfig({ BINANCE_RWA_RPS: "5" }), /STOCK_COMPARE_MIN_HEADROOM/u, "default headroom 10 exceeds an unset/5 bucket");
  });

  it("is registered only when STOCK_COMPARE_ENABLED is exactly true", () => {
    const store = new MemoryStore();
    for (const env of [{}, { STOCK_COMPARE_ENABLED: "false" }, { STOCK_COMPARE_ENABLED: "TRUE" }, { STOCK_COMPARE_ENABLED: "1" }]) {
      assert.equal(stockCompareJobIfEnabled(store, env), null, JSON.stringify(env));
    }
    const job = stockCompareJobIfEnabled(store, { STOCK_COMPARE_ENABLED: "true", BINANCE_RWA_RPS: "18" });
    assert.ok(job);
    assert.equal(job.name, "stock-compare");
    assert.equal(job.intervalMs, 15 * MIN);
    assert.equal(job.timeoutMs, 12 * MIN);
    assert.ok((job.jitterMs ?? 0) > 0);
  });
});

// -------------------------------------------------------------------- route ----

describe("GET /trading/stock-compare", () => {
  const build = () => {
    const store = new MemoryStore();
    return { store, app: createServer({ scheduler: createScheduler(store), store }) };
  };
  const seedRow = (store: MemoryStore, ticker: string, quotedAt: number, shares: [number, number] = [1, 1.01]): Promise<void> =>
    store.put(STOCK_COMPARE_KEY, {
      rows: {
        [ticker]: {
          ticker, quotedAt, referencePriceUsd: 100,
          versions: [version("bstock", [size(100, shares[0], 5)]), version("ondo", [size(100, shares[1], 5)])],
        },
      },
    }, TTL);

  it("is store-only: no upstream call is reachable from it", async () => {
    const { store, app } = build();
    await seedRow(store, "NVDA", Date.now());
    globalThis.fetch = (async () => { throw new Error("route reached an upstream"); }) as typeof fetch;
    process.env["BINANCE_WEB3_API_KEY"] = "k";
    process.env["BINANCE_WEB3_SECRET_KEY"] = "s";
    for (const path of ["/trading/stock-compare", "/trading/stock-compare?ticker=NVDA", "/trading/stock-compare?ticker=ZZZ"]) {
      const res = await app.request(path);
      assert.ok([200, 404].includes(res.status), path);
    }
  });

  it("returns the row plus verdicts for ?ticker=", async () => {
    const { store, app } = build();
    const quotedAt = Date.now() - 5 * MIN;
    await seedRow(store, "NVDA", quotedAt);
    const res = await app.request("/trading/stock-compare?ticker=NVDA");
    assert.equal(res.status, 200);
    const body = await res.json() as { data: StockCompareRow & { verdicts: unknown[] }; meta: Record<string, unknown>; error?: unknown };
    assert.equal(body.error, undefined);
    assert.equal(body.data.ticker, "NVDA");
    assert.equal(body.data.quotedAt, quotedAt);
    assert.equal(body.data.versions.length, 2);
    assert.deepEqual(body.data.verdicts, [{ usdt: 100, best: "ondo", edgeBps: 100, about_same: false, avoid: [], only: null }]);
    assert.equal(body.meta["staleness"], "fresh");
    assert.equal(body.meta["quotedAt"], quotedAt);
    assert.deepEqual(body.meta["sizesUsdt"], [100, 1000, 5000]);
    assert.equal(body.meta["aboutSameBps"], 20);
    assert.equal(body.meta["avoidCostBps"], 200);
  });

  it("staleness follows the row's own quotedAt: fresh, stale, dead", async () => {
    for (const [ageMin, expected] of [[29, "fresh"], [31, "stale"], [119, "stale"], [125, "dead"]] as const) {
      const { store, app } = build();
      await seedRow(store, "NVDA", Date.now() - ageMin * MIN);
      const body = await (await app.request("/trading/stock-compare?ticker=NVDA")).json() as { meta: { staleness: string } };
      assert.equal(body.meta.staleness, expected, `${ageMin} min`);
    }
  });

  it("without a ticker lists tickers with their quotedAt, no versions", async () => {
    const { store, app } = build();
    const at = Date.now() - MIN;
    await store.put(STOCK_COMPARE_KEY, {
      rows: {
        SPY: { ticker: "SPY", quotedAt: at, referencePriceUsd: 5, versions: [] },
        NVDA: { ticker: "NVDA", quotedAt: at - 10 * MIN, referencePriceUsd: 5, versions: [] },
      },
    }, TTL);
    const body = await (await app.request("/trading/stock-compare")).json() as { data: unknown[]; meta: Record<string, unknown> };
    assert.deepEqual(body.data, [{ ticker: "NVDA", quotedAt: at - 10 * MIN }, { ticker: "SPY", quotedAt: at }]);
    assert.equal(body.meta["count"], 2);
    assert.equal(body.meta["staleness"], "fresh");
    assert.equal(body.meta["newestQuotedAt"], at);
  });

  it("an empty store lists nothing and reads dead", async () => {
    const { app } = build();
    const body = await (await app.request("/trading/stock-compare")).json() as { data: unknown[]; meta: Record<string, unknown> };
    assert.deepEqual(body.data, []);
    assert.equal(body.meta["staleness"], "dead");
    assert.equal(body.meta["newestQuotedAt"], null);
  });

  it("an unknown ticker is 404 ticker_not_found; a malformed one is 400 invalid_ticker", async () => {
    const { store, app } = build();
    await seedRow(store, "NVDA", Date.now());
    const missing = await app.request("/trading/stock-compare?ticker=ZZZ");
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { data: null, error: { code: "ticker_not_found" } });
    for (const bad of ["nvda", "TOOLONGX", "NV1", "", "NVDA%20", "N-V"]) {
      const res = await app.request(`/trading/stock-compare?ticker=${bad}`);
      assert.equal(res.status, 400, bad);
      assert.deepEqual(await res.json(), { data: null, error: { code: "invalid_ticker" } }, bad);
    }
  });

  it("sits behind x-dp-token like every other route", async () => {
    process.env["DP_AUTH_TOKEN"] = "secret-token";
    const { store, app } = build();
    await seedRow(store, "NVDA", Date.now());
    assert.equal((await app.request("/trading/stock-compare")).status, 401);
    assert.equal((await app.request("/trading/stock-compare", { headers: { "x-dp-token": "secret-token" } })).status, 200);
  });
});

describe("store contract", () => {
  it("the snapshot is one jsonb value that survives the schema-aware Postgres fake", async () => {
    const pg = new FakePg();
    const store = await PostgresStore.create("postgres://unused", { client: pg });
    const snapshot = { rows: { NVDA: row([version("bstock", [size(100, 1, 1)]), version("ondo", [size(100, 1.01, 1)])]) } };
    await store.put(STOCK_COMPARE_KEY, snapshot, { source: "stock-compare", freshForMs: 30 * MIN, deadAfterMs: 120 * MIN });
    const back = await store.get<unknown>(STOCK_COMPARE_KEY);
    assert.deepEqual(normalizeStockCompare(back?.data), snapshot);
  });
});
