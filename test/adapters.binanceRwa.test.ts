import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import {
  RWA_PRICE_BATCH_MAX,
  createSignature,
  fetchRwaPlatforms,
  fetchRwaPrices,
  fetchRwaTokens,
  fetchRwaUnderlyingMarket,
  hasBinanceRwaCredentials,
  normalizeRwaTokens,
  premiumBps,
  signedRequest,
} from "../src/adapters/binanceRwa.js";
import { AdapterError, MissingCredentialsError } from "../src/adapters/http.js";
import { createRateLimiter } from "../src/adapters/rateLimiter.js";
import { fakeFetch, jsonResponse, textResponse } from "./helpers.js";
import { ARQQON_ROW, NVDAB_ROW } from "./rwaFixtures.js";

const SECRET = "unit-test-secret";
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const ARQQON = "0x1161989389a991532dce453d04d6346c2581c907";



function setCredentials(): void {
  process.env["BINANCE_WEB3_API_KEY"] = "unit-test-key";
  process.env["BINANCE_WEB3_SECRET_KEY"] = SECRET;
}
function clearCredentials(): void {
  delete process.env["BINANCE_WEB3_API_KEY"];
  delete process.env["BINANCE_WEB3_SECRET_KEY"];
}
afterEach(clearCredentials);

/** A limiter that never waits, so adapter tests do not depend on the process bucket. */
const openLimiter = () => createRateLimiter({ capacity: 1000, refillPerSecond: 1000 });
const noSleep = async () => undefined;

const ok = (data: unknown) => jsonResponse({ code: 0, msg: "success", data, timestamp: 1, success: true });

describe("credentials", () => {
  it("reports missing credentials without a network call", async () => {
    clearCredentials();
    assert.equal(hasBinanceRwaCredentials(), false);
    const fake = fakeFetch(() => ok([]));
    await assert.rejects(fetchRwaTokens({ fetchFn: fake.fetch }), MissingCredentialsError);
    assert.equal(fake.calls.length, 0);
  });

  it("needs both key and secret", () => {
    process.env["BINANCE_WEB3_API_KEY"] = "k";
    assert.equal(hasBinanceRwaCredentials(), false);
    process.env["BINANCE_WEB3_SECRET_KEY"] = "s";
    assert.equal(hasBinanceRwaCredentials(), true);
  });
});

describe("signing", () => {
  it("signs timestamp + METHOD + /build path with query, base64 HMAC-SHA256", () => {
    const timestamp = "2026-05-11T10:08:57.715Z";
    const requestPath = "/build/api/v1/dex/market/rwa/tokens?binanceChainId=56";
    const expected = createHmac("sha256", SECRET).update(`${timestamp}GET${requestPath}`).digest("base64");
    assert.equal(createSignature({ timestamp, method: "GET", requestPath, body: "", secretKey: SECRET }), expected);
  });

  it("sends the /build-prefixed path in the URL, signs the same bytes, and a fresh nonce each request", async () => {
    setCredentials();
    const fake = fakeFetch(() => ok([]));
    await fetchRwaTokens({ fetchFn: fake.fetch, platformId: "bstock" });
    await fetchRwaTokens({ fetchFn: fake.fetch, platformId: "bstock" });
    assert.equal(fake.calls.length, 2);
    const [a, b] = fake.calls as [typeof fake.calls[0], typeof fake.calls[0]];
    assert.equal(a.url, "https://web3.binance.com/build/api/v1/dex/market/rwa/tokens?binanceChainId=56&platformId=bstock");
    const requestPath = a.url.slice("https://web3.binance.com".length);
    assert.ok(requestPath.startsWith("/build/"), "signed path carries the /build prefix");
    assert.equal(a.headers["x-oc-apikey"], "unit-test-key");
    assert.equal(
      a.headers["x-oc-sign"],
      createSignature({ timestamp: a.headers["x-oc-timestamp"]!, method: "GET", requestPath, body: "", secretKey: SECRET }),
    );
    assert.match(a.headers["x-oc-nonce"]!, /^[0-9a-f-]{36}$/);
    assert.notEqual(a.headers["x-oc-nonce"], b.headers["x-oc-nonce"], "same path, different nonce");
  });
});

describe("normalizeRwaTokens", () => {
  it("parses string numerics, lowercases the address, derives premiumBps", () => {
    const { tokens, dropped } = normalizeRwaTokens([NVDAB_ROW, ARQQON_ROW]);
    assert.equal(dropped, 0);
    const [nvda, arqq] = tokens;
    assert.equal(nvda!.address, NVDAB);
    assert.equal(nvda!.platform, "bstock");
    assert.equal(nvda!.underlyingTicker, "NVDA");
    assert.equal(nvda!.decimals, 18);
    assert.equal(nvda!.tokenPriceUsd, 215.84);
    assert.equal(nvda!.referencePriceUsd, 215.62);
    assert.equal(nvda!.navPremiumBps, 10);
    assert.equal(nvda!.openState, true);
    assert.equal(nvda!.marketStatus, null);
    assert.equal(nvda!.nextOpenMs, null);
    assert.equal(nvda!.underlyingVolume24hUsd, 17362880000);
    assert.equal(arqq!.platform, "ondo");
    assert.equal(arqq!.openState, false);
    assert.equal(arqq!.marketStatus, "overnight");
    assert.equal(arqq!.reasonCode, "UNSUPPORTED");
    assert.equal(arqq!.nextOpenMs, 1789651860000);
    assert.equal(arqq!.navPremiumBps, 0);
  });

  it("drops rows without an address or symbol and counts them; keeps unknown platforms", () => {
    const { tokens, dropped } = normalizeRwaTokens([
      { ...NVDAB_ROW, tokenContractAddress: "not-an-address" },
      { ...NVDAB_ROW, tokenSymbol: "" },
      { ...NVDAB_ROW, platformId: "xstock" },
      "junk",
    ]);
    assert.equal(dropped, 3);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]!.platform, "xstock");
  });

  it("premiumBps is null unless both prices are positive", () => {
    assert.equal(premiumBps(null, 10), null);
    assert.equal(premiumBps(10, 0), null);
    assert.equal(premiumBps(0, 10), null);
    assert.equal(premiumBps(101, 100), 100);
    assert.equal(premiumBps(99, 100), -100);
  });
});

describe("error handling", () => {
  it("retries a 429 exactly once after Retry-After, then succeeds", async () => {
    setCredentials();
    const sleeps: number[] = [];
    let n = 0;
    const fake = fakeFetch(() =>
      n++ === 0
        ? new Response(JSON.stringify({ code: 42900, msg: "Rate limit exceeded" }), { status: 429, headers: { "retry-after": "2" } })
        : ok([NVDAB_ROW]),
    );
    const data = await signedRequest({
      method: "GET",
      path: "/api/v1/dex/market/rwa/tokens",
      fetchFn: fake.fetch,
      limiter: openLimiter(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(sleeps, [2000]);
    assert.ok(Array.isArray(data));
  });

  it("gives up after the second 429", async () => {
    setCredentials();
    const fake = fakeFetch(() => new Response("", { status: 429, headers: { "retry-after": "1" } }));
    await assert.rejects(
      signedRequest({ method: "GET", path: "/x", fetchFn: fake.fetch, limiter: openLimiter(), sleep: noSleep }),
      (error: AdapterError) => error instanceof AdapterError && error.status === 429,
    );
    assert.equal(fake.calls.length, 2);
  });

  it("surfaces the x-oc-blocked-by filter on a 401 so a replay reads differently from a bad key", async () => {
    setCredentials();
    const fake = fakeFetch(() =>
      new Response(JSON.stringify({ code: 40103, msg: "Duplicate request detected" }), {
        status: 401,
        headers: { "x-oc-blocked-by": "TimestampFilter/40103" },
      }),
    );
    await assert.rejects(
      signedRequest({ method: "GET", path: "/x", fetchFn: fake.fetch, limiter: openLimiter() }),
      (error: AdapterError) => error.status === 401 && /TimestampFilter\/40103/.test(error.message),
    );
  });

  it("maps a bare 414 to request too long, code != 0 to the sanitized msg, non-JSON to invalid JSON", async () => {
    setCredentials();
    const l = openLimiter();
    await assert.rejects(
      signedRequest({ method: "GET", path: "/x", fetchFn: fakeFetch(() => new Response("", { status: 414 })).fetch, limiter: l }),
      (e: AdapterError) => e.status === 414 && /request too long/.test(e.message),
    );
    await assert.rejects(
      signedRequest({ method: "GET", path: "/x", fetchFn: fakeFetch(() => jsonResponse({ code: 40004, msg: "param error" })).fetch, limiter: l }),
      (e: AdapterError) => e instanceof AdapterError && /param error/.test(e.message),
    );
    await assert.rejects(
      signedRequest({ method: "GET", path: "/x", fetchFn: fakeFetch(() => textResponse("<html>")).fetch, limiter: l }),
      (e: AdapterError) => /invalid JSON/.test(e.message),
    );
  });
});

describe("fetchRwaPrices", () => {
  it("chunks at 80 sequentially and keys results by the response address", async () => {
    setCredentials();
    const addresses = Array.from({ length: 200 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    let inFlight = 0;
    let overlapped = false;
    const fake = fakeFetch(async (call) => {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      const query = new URL(call.url).searchParams.get("tokenContractAddresses")!.split(",");
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      // Binance drops what it does not know: answer only every other address.
      return ok(
        query
          .filter((_, i) => i % 2 === 0)
          .map((address) => ({ tokenContractAddress: address, platformId: "ondo", tokenPrice: "1.5", referencePrice: "1", tokenPriceUpdatedAt: 5 })),
      );
    });
    const prices = await fetchRwaPrices({ addresses, fetchFn: fake.fetch });
    assert.equal(fake.calls.length, 3);
    const sizes = fake.calls.map((c) => new URL(c.url).searchParams.get("tokenContractAddresses")!.split(",").length);
    assert.deepEqual(sizes, [RWA_PRICE_BATCH_MAX, RWA_PRICE_BATCH_MAX, 40]);
    assert.equal(overlapped, false, "chunks are issued one at a time");
    assert.equal(prices.size, 100);
    assert.equal(prices.get(addresses[0]!)?.premiumBps, 5000);
    assert.equal(prices.has(addresses[1]!), false, "a dropped row stays absent, never shifted");
  });
});

describe("other RWA endpoints", () => {
  it("normalizes underlying-market and platforms", async () => {
    setCredentials();
    const fake = fakeFetch((call) => {
      if (call.url.includes("/underlying-market")) {
        return ok({
          binanceChainId: "56",
          tokenContractAddress: ARQQON,
          platformId: "ondo",
          statusInfo: { openState: true, marketStatus: "regular", reasonCode: "TRADING", nextOpenTime: 1, nextCloseTime: 2 },
          marketData: { referencePrice: "19.14", high52W: "62", low52W: "11.52", volumeShares24H: "117461.839667", avgDailyVolume1Y: "540708", totalShares: "17402411", marketCap: "333082147", peRatioTTM: null, dividendYield: null },
        });
      }
      return ok([
        { platformId: "ondo", tickerCount: 459, chainDistribution: [{ binanceChainId: "56", tokenCount: 458 }, { binanceChainId: "1", tokenCount: 457 }], website: "https://ondo.finance" },
        { platformId: "bstock", tickerCount: 77, chainDistribution: [{ binanceChainId: "56", tokenCount: 77 }] },
        { noPlatform: true },
      ]);
    });
    const market = await fetchRwaUnderlyingMarket({ address: ARQQON.toUpperCase(), fetchFn: fake.fetch });
    assert.equal(market.address, ARQQON);
    assert.equal(market.marketStatus, "regular");
    assert.equal(market.high52wUsd, 62);
    assert.equal(market.peRatioTtm, null);

    const platforms = await fetchRwaPlatforms({ fetchFn: fake.fetch });
    assert.equal(platforms.length, 2);
    assert.deepEqual(platforms[0]!.chainTokenCounts, { "56": 458, "1": 457 });
    assert.equal(platforms[1]!.website, null);
  });
});
