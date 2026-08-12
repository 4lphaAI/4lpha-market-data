import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  binanceInFlight,
  fetchBinanceAlphaUniverse,
  fetchBinanceTokenMeta,
  fetchBinanceTokenQuote,
  fetchSintralKlines,
  isPlausiblePrice,
  normalizeSintralKlines,
} from "../src/adapters/binanceWeb3.js";
import { AdapterError } from "../src/adapters/http.js";
import { fakeFetch, jsonResponse, throwingFetch } from "./helpers.js";

const ADDRESS = "0x75FD4CF6F8392E41E70391D60C90C0D5211603A1";
const LOWER = ADDRESS.toLowerCase();

describe("fetchBinanceAlphaUniverse", () => {
  it("keeps BSC rows and normalizes them into the coins lane", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({
        code: "000000",
        data: [
          { contractAddress: ADDRESS, chainId: "56", symbol: "AMDB", name: "AMD bStock" },
          { contractAddress: "0xbb00000000000000000000000000000000000002", chainId: "1", symbol: "ETHX" },
          { contractAddress: "0xcc00000000000000000000000000000000000003", chainName: "BSC", symbol: "CCC" },
        ],
      }),
    );

    const entries = await fetchBinanceAlphaUniverse({ fetchFn: fake.fetch });
    assert.deepEqual(
      entries.map((entry) => entry.address),
      [LOWER, "0xcc00000000000000000000000000000000000003"],
    );
    assert.equal(entries[0]?.lane, "coins");
    assert.equal(entries[0]?.source, "binance");
    assert.equal(entries[0]?.name, "AMD bStock");
  });

  it("keeps rows that carry no chain information at all", async () => {
    const fake = fakeFetch(() => jsonResponse({ data: [{ contractAddress: ADDRESS, symbol: "X" }] }));
    assert.equal((await fetchBinanceAlphaUniverse({ fetchFn: fake.fetch })).length, 1);
  });

  it("drops offline and fully-delisted rows, keeping only live listings", async () => {
    // Measured 2026-08-12: 82 of 486 BSC rows were fullyDelisted and another 90
    // offline. This list feeds the eligibility gate's Alpha rule, so a retired
    // listing must not survive into it. Only an explicit `true` drops a row.
    const fake = fakeFetch(() =>
      jsonResponse({
        data: [
          { contractAddress: ADDRESS, chainId: "56", symbol: "LIVE", offline: false, fullyDelisted: false },
          { contractAddress: "0xbb00000000000000000000000000000000000002", chainId: "56", symbol: "OFF", offline: true },
          { contractAddress: "0xcc00000000000000000000000000000000000003", chainId: "56", symbol: "DEAD", fullyDelisted: true },
          { contractAddress: "0xdd00000000000000000000000000000000000004", chainId: "56", symbol: "NOFLAG" },
        ],
      }),
    );
    const entries = await fetchBinanceAlphaUniverse({ fetchFn: fake.fetch });
    assert.deepEqual(
      entries.map((entry) => entry.symbol),
      ["LIVE", "NOFLAG"],
    );
  });

  it("drops malformed rows and de-duplicates addresses", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({
        data: [null, 7, { symbol: "no address" }, { contractAddress: ADDRESS }, { contractAddress: LOWER }],
      }),
    );
    const entries = await fetchBinanceAlphaUniverse({ fetchFn: fake.fetch });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.symbol, "");
  });

  it("surfaces a non-success envelope code as a sanitized error", async () => {
    const fake = fakeFetch(() => jsonResponse({ code: "100002", message: "invalid request" }));
    await assert.rejects(
      () => fetchBinanceAlphaUniverse({ fetchFn: fake.fetch }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterError);
        assert.equal(error.message, "binance: invalid request");
        return true;
      },
    );
  });

  it("bounds concurrency across simultaneous calls", async () => {
    let peak = 0;
    const fake = fakeFetch(async () => {
      peak = Math.max(peak, binanceInFlight());
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse({ data: [{ contractAddress: ADDRESS }] });
    });

    await Promise.all(
      Array.from({ length: 20 }, () => fetchBinanceAlphaUniverse({ fetchFn: fake.fetch })),
    );

    assert.ok(peak <= 6, `peak concurrency ${peak} exceeded the limit`);
    assert.equal(binanceInFlight(), 0);
  });
});

describe("fetchBinanceTokenQuote", () => {
  it("requests the BSC dynamic-info endpoint and reads price or aggPrice", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({
        code: "000000",
        data: { price: "1.25", marketCap: 900, volume24h: 0, holders: 33, percentChange24h: -4, symbol: "AMDB" },
      }),
    );

    const snapshot = await fetchBinanceTokenQuote({ address: ADDRESS, fetchFn: fake.fetch });
    const url = fake.calls[0]?.url ?? "";
    assert.ok(url.includes("chainId=56"));
    assert.ok(url.includes(`contractAddress=${LOWER}`));

    assert.equal(snapshot.address, LOWER);
    assert.equal(snapshot.priceUsd, 1.25);
    assert.equal(snapshot.marketCapUsd, 900);
    assert.equal(snapshot.volume24hUsd, 0);
    assert.equal(snapshot.holders, 33);
    assert.equal(snapshot.priceChange24hPct, -4);
    assert.equal(snapshot.symbol, "AMDB");
  });

  it("falls back to aggPrice and nulls unparseable fields", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({ code: "000000", data: { aggPrice: "0.5", marketCap: "n/a", holders: {} } }),
    );
    const snapshot = await fetchBinanceTokenQuote({ address: ADDRESS, fetchFn: fake.fetch });
    assert.equal(snapshot.priceUsd, 0.5);
    assert.equal(snapshot.marketCapUsd, null);
    assert.equal(snapshot.holders, null);
    assert.equal(snapshot.symbol, undefined);
  });

  it("returns an all-null snapshot when data is missing entirely", async () => {
    const fake = fakeFetch(() => jsonResponse({ code: "000000" }));
    const snapshot = await fetchBinanceTokenQuote({ address: ADDRESS, fetchFn: fake.fetch });
    assert.equal(snapshot.priceUsd, null);
    assert.equal(snapshot.address, LOWER);
  });

  it("sanitizes transport failures", async () => {
    const fetchFn = throwingFetch(new Error("socket hang up on https://web3.binance.com/bapi/defi"));
    await assert.rejects(
      () => fetchBinanceTokenQuote({ address: ADDRESS, fetchFn }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterError);
        assert.ok(!error.message.includes("binance.com"));
        return true;
      },
    );
  });
});

describe("fetchBinanceTokenMeta", () => {
  it("reads symbol and name, tolerating either naming", async () => {
    const fake = fakeFetch(() => jsonResponse({ code: "000000", data: { tokenSymbol: "AMDB", name: "AMD" } }));
    const meta = await fetchBinanceTokenMeta({ address: ADDRESS, fetchFn: fake.fetch });
    assert.deepEqual(meta, { address: LOWER, symbol: "AMDB", name: "AMD" });
  });

  it("returns nulls for an empty payload", async () => {
    const fake = fakeFetch(() => jsonResponse({ code: "000000", data: {} }));
    const meta = await fetchBinanceTokenMeta({ address: ADDRESS, fetchFn: fake.fetch });
    assert.deepEqual(meta, { address: LOWER, symbol: null, name: null });
  });
});

describe("fetchSintralKlines", () => {
  it("maps positional rows and sorts ascending by timestamp", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({
        data: [
          ["2", "3", "1", "2.5", "100", 1_700_000_060],
          ["1", "2", "0.5", "1.5", "50", 1_700_000_000],
        ],
      }),
    );

    const candles = await fetchSintralKlines({
      address: ADDRESS,
      interval: "1min",
      limit: 10,
      fetchFn: fake.fetch,
    });

    const url = fake.calls[0]?.url ?? "";
    assert.ok(url.includes("platform=bsc"));
    assert.ok(url.includes("interval=1min"));
    assert.ok(url.includes("limit=10"));

    assert.deepEqual(candles, [
      { timestamp: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 50 },
      { timestamp: 1_700_000_060_000, open: 2, high: 3, low: 1, close: 2.5, volume: 100 },
    ]);
  });

  it("drops rows without a usable timestamp and keeps the rest", () => {
    const candles = normalizeSintralKlines({
      data: [["1", "2", "0.5", "1.5", "50", "junk"], null, { o: 1 }, ["1", "2", "0.5", "1.5", "50", 1_700_000_000_000]],
    });
    assert.equal(candles.length, 1);
    assert.equal(candles[0]?.timestamp, 1_700_000_000_000);
  });

  it("returns an empty list for a shape it does not recognize", () => {
    assert.deepEqual(normalizeSintralKlines({ result: "none" }), []);
    assert.deepEqual(normalizeSintralKlines("nope"), []);
  });
});

describe("isPlausiblePrice", () => {
  it("accepts any positive price when there is no reference", () => {
    assert.equal(isPlausiblePrice(null, 0.0001), true);
    assert.equal(isPlausiblePrice(null, 1e9), true);
  });

  it("rejects non-positive and non-finite live prices", () => {
    assert.equal(isPlausiblePrice(10, 0), false);
    assert.equal(isPlausiblePrice(10, -1), false);
    assert.equal(isPlausiblePrice(10, Number.NaN), false);
  });

  it("accepts moves inside the 0.02x..50x band and rejects the rest", () => {
    assert.equal(isPlausiblePrice(100, 2), true);
    assert.equal(isPlausiblePrice(100, 5_000), true);
    assert.equal(isPlausiblePrice(100, 1.99), false);
    assert.equal(isPlausiblePrice(100, 5_001), false);
  });
});
