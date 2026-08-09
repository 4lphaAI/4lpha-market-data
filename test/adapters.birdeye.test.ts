import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fetchBirdeyeKlines, hasBirdeyeApiKey, normalizeOhlcv } from "../src/adapters/birdeye.js";
import { AdapterError, MissingCredentialsError } from "../src/adapters/http.js";
import { fakeFetch, jsonResponse, textResponse, throwingFetch } from "./helpers.js";

const ADDRESS = "0x75FD4CF6F8392E41E70391D60C90C0D5211603A1";
const LOWER = ADDRESS.toLowerCase();
const API_KEY = "birdeye-unit-test-key";

function setKey(): void {
  process.env["BIRDEYE_API_KEY"] = API_KEY;
}

afterEach(() => {
  delete process.env["BIRDEYE_API_KEY"];
});

describe("hasBirdeyeApiKey", () => {
  it("is false when the key is absent or blank", () => {
    delete process.env["BIRDEYE_API_KEY"];
    assert.equal(hasBirdeyeApiKey(), false);
    process.env["BIRDEYE_API_KEY"] = "   ";
    assert.equal(hasBirdeyeApiKey(), false);
    setKey();
    assert.equal(hasBirdeyeApiKey(), true);
  });
});

describe("fetchBirdeyeKlines", () => {
  it("sends the keyed BSC request and normalizes OHLCV items", async () => {
    setKey();
    const fake = fakeFetch(() =>
      jsonResponse({
        success: true,
        data: {
          items: [
            { unixTime: 1_700_000_060, o: 2, h: 3, l: 1, c: 2.5, v: 100 },
            { unixTime: 1_700_000_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 50 },
          ],
        },
      }),
    );

    const candles = await fetchBirdeyeKlines({
      address: ADDRESS,
      type: "15m",
      from: 1_700_000_000,
      to: 1_700_000_600,
      fetchFn: fake.fetch,
    });

    const call = fake.calls[0];
    assert.ok(call !== undefined);
    const url = new URL(call.url);
    assert.equal(url.pathname, "/defi/ohlcv");
    assert.equal(url.searchParams.get("address"), LOWER);
    assert.equal(url.searchParams.get("type"), "15m");
    assert.equal(url.searchParams.get("currency"), "usd");
    assert.equal(call.headers["x-api-key"], API_KEY);
    assert.equal(call.headers["x-chain"], "bsc");

    assert.deepEqual(candles, [
      { timestamp: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 50 },
      { timestamp: 1_700_000_060_000, open: 2, high: 3, low: 1, close: 2.5, volume: 100 },
    ]);
  });

  it("throws MissingCredentialsError without touching the network", async () => {
    delete process.env["BIRDEYE_API_KEY"];
    const fake = fakeFetch(() => jsonResponse({}));
    await assert.rejects(
      () => fetchBirdeyeKlines({ address: ADDRESS, type: "1m", from: 0, to: 1, fetchFn: fake.fetch }),
      (error: unknown) => {
        assert.ok(error instanceof MissingCredentialsError);
        return true;
      },
    );
    assert.equal(fake.calls.length, 0);
  });

  it("tolerates malformed items and an unexpected envelope", () => {
    assert.deepEqual(normalizeOhlcv({ data: { items: [null, "x", { o: 1 }] } }), []);
    assert.deepEqual(normalizeOhlcv({ data: [{ unixTime: 1_700_000_000, o: "1" }] }), [
      { timestamp: 1_700_000_000_000, open: 1, high: 0, low: 0, close: 0, volume: 0 },
    ]);
    assert.deepEqual(normalizeOhlcv("nope"), []);
  });

  it("maps auth, rate-limit and generic HTTP failures", async () => {
    setKey();
    for (const [status, expected] of [
      [403, /authentication rejected/u],
      [429, /rate limited/u],
      [502, /upstream responded 502/u],
    ] as const) {
      const fake = fakeFetch(() => jsonResponse({}, status));
      await assert.rejects(
        () => fetchBirdeyeKlines({ address: ADDRESS, type: "1m", from: 0, to: 1, fetchFn: fake.fetch }),
        expected,
      );
    }
  });

  it("treats success:false as a sanitized failure", async () => {
    setKey();
    const fake = fakeFetch(() => jsonResponse({ success: false, message: "address not supported" }));
    await assert.rejects(
      () => fetchBirdeyeKlines({ address: ADDRESS, type: "1m", from: 0, to: 1, fetchFn: fake.fetch }),
      /address not supported/u,
    );
  });

  it("rejects a non-JSON body", async () => {
    setKey();
    const fake = fakeFetch(() => textResponse("nginx"));
    await assert.rejects(
      () => fetchBirdeyeKlines({ address: ADDRESS, type: "1m", from: 0, to: 1, fetchFn: fake.fetch }),
      /invalid JSON in response/u,
    );
  });

  it("never echoes the API key or the URL in an error", async () => {
    setKey();
    const fetchFn = throwingFetch(
      new Error(`ENOTFOUND https://public-api.birdeye.so/defi/ohlcv?k=${API_KEY}${API_KEY}`),
    );
    await assert.rejects(
      () => fetchBirdeyeKlines({ address: ADDRESS, type: "1m", from: 0, to: 1, fetchFn }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterError);
        assert.ok(!error.message.includes(API_KEY));
        assert.ok(!error.message.includes("birdeye.so"));
        return true;
      },
    );
  });
});
