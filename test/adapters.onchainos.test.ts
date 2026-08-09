import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import {
  createSignature,
  fetchOnchainosKlines,
  fetchOnchainosPrice,
  hasOnchainosCredentials,
  normalizeKlines,
} from "../src/adapters/onchainos.js";
import { AdapterError, MissingCredentialsError } from "../src/adapters/http.js";
import { fakeFetch, jsonResponse, textResponse, throwingFetch } from "./helpers.js";

const ADDRESS = "0x75FD4CF6F8392E41E70391D60C90C0D5211603A1";
const LOWER = ADDRESS.toLowerCase();
const SECRET = "unit-test-secret";

function setCredentials(withProject = true): void {
  process.env["OKX_API_KEY"] = "unit-test-key";
  process.env["OKX_SECRET_KEY"] = SECRET;
  process.env["OKX_PASSPHRASE"] = "unit-test-passphrase";
  if (withProject) process.env["OKX_PROJECT_ID"] = "unit-test-project";
  else delete process.env["OKX_PROJECT_ID"];
}

function clearCredentials(): void {
  delete process.env["OKX_API_KEY"];
  delete process.env["OKX_SECRET_KEY"];
  delete process.env["OKX_PASSPHRASE"];
  delete process.env["OKX_PROJECT_ID"];
}

afterEach(() => {
  clearCredentials();
});

describe("credential handling", () => {
  it("reports missing credentials instead of throwing at import time", () => {
    clearCredentials();
    assert.equal(hasOnchainosCredentials(), false);
  });

  it("requires api key, secret and passphrase together", () => {
    clearCredentials();
    process.env["OKX_API_KEY"] = "only-a-key";
    assert.equal(hasOnchainosCredentials(), false);
    setCredentials();
    assert.equal(hasOnchainosCredentials(), true);
  });

  it("throws MissingCredentialsError, not AdapterError, when unconfigured", async () => {
    clearCredentials();
    const fake = fakeFetch(() => jsonResponse({ code: "0", data: [] }));
    await assert.rejects(
      () => fetchOnchainosKlines({ address: ADDRESS, bar: "1m", fetchFn: fake.fetch }),
      (error: unknown) => {
        assert.ok(error instanceof MissingCredentialsError);
        return true;
      },
    );
    assert.equal(fake.calls.length, 0);
  });
});

describe("createSignature", () => {
  it("hashes timestamp + method + requestPath + body with HMAC-SHA256", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const requestPath = "/api/v6/dex/market/price-info";
    const body = '[{"chainIndex":"56"}]';
    const expected = createHmac("sha256", SECRET)
      .update(`${timestamp}POST${requestPath}${body}`)
      .digest("base64");

    assert.equal(
      createSignature({ timestamp, method: "POST", requestPath, body, secretKey: SECRET }),
      expected,
    );
  });
});

describe("fetchOnchainosKlines", () => {
  it("signs the exact request path it sends and normalizes candles", async () => {
    setCredentials();
    const fake = fakeFetch(() =>
      jsonResponse({
        code: "0",
        data: [
          ["1700000060000", "2", "3", "1", "2.5", "100", "250", "1"],
          ["1700000000000", "1", "2", "0.5", "1.5", "50", "75", "1"],
        ],
      }),
    );

    const candles = await fetchOnchainosKlines({
      address: ADDRESS,
      bar: "15m",
      limit: 20,
      fetchFn: fake.fetch,
    });

    const call = fake.calls[0];
    assert.ok(call !== undefined);
    const url = new URL(call.url);
    assert.equal(url.host, "web3.okx.com");
    assert.equal(url.pathname, "/api/v6/dex/market/historical-candles");
    assert.equal(url.searchParams.get("chainIndex"), "56");
    assert.equal(url.searchParams.get("tokenContractAddress"), LOWER);
    assert.equal(url.searchParams.get("bar"), "15m");

    const timestamp = call.headers["ok-access-timestamp"] ?? "";
    const expected = createHmac("sha256", SECRET)
      .update(`${timestamp}GET${url.pathname}${url.search}`)
      .digest("base64");
    assert.equal(call.headers["ok-access-sign"], expected);
    assert.equal(call.headers["ok-access-project"], "unit-test-project");

    assert.deepEqual(candles, [
      { timestamp: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 50 },
      { timestamp: 1_700_000_060_000, open: 2, high: 3, low: 1, close: 2.5, volume: 100 },
    ]);
  });

  it("omits the project header when OKX_PROJECT_ID is unset", async () => {
    setCredentials(false);
    const fake = fakeFetch(() => jsonResponse({ code: "0", data: [] }));
    await fetchOnchainosKlines({ address: ADDRESS, bar: "1m", fetchFn: fake.fetch });
    assert.equal(fake.calls[0]?.headers["ok-access-project"], undefined);
  });

  it("accepts object-shaped candles and drops broken ones", () => {
    const candles = normalizeKlines([
      { ts: "1700000000000", o: "1", h: "2", l: "0.5", c: "1.5", vol: "9" },
      { ts: "nope" },
      null,
      ["not-a-timestamp", "1"],
    ]);
    assert.equal(candles.length, 1);
    assert.equal(candles[0]?.volume, 9);
  });

  it("returns an empty list for a non-array data field", () => {
    assert.deepEqual(normalizeKlines({ unexpected: true }), []);
    assert.deepEqual(normalizeKlines(null), []);
  });

  it("maps auth, rate-limit and generic HTTP failures to sanitized errors", async () => {
    setCredentials();
    for (const [status, expected] of [
      [401, /authentication rejected/u],
      [429, /rate limited/u],
      [500, /upstream responded 500/u],
    ] as const) {
      const fake = fakeFetch(() => jsonResponse({}, status));
      await assert.rejects(
        () => fetchOnchainosKlines({ address: ADDRESS, bar: "1m", fetchFn: fake.fetch }),
        expected,
      );
    }
  });

  it("never echoes the secret or the URL in an error message", async () => {
    setCredentials();
    const fetchFn = throwingFetch(
      new Error(`TLS error contacting https://web3.okx.com/api/v6?sign=${SECRET}${SECRET}${SECRET}`),
    );
    await assert.rejects(
      () => fetchOnchainosKlines({ address: ADDRESS, bar: "1m", fetchFn }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterError);
        assert.ok(!error.message.includes(SECRET));
        assert.ok(!error.message.includes("web3.okx.com"));
        return true;
      },
    );
  });

  it("rejects a non-JSON body", async () => {
    setCredentials();
    const fake = fakeFetch(() => textResponse("gateway timeout"));
    await assert.rejects(
      () => fetchOnchainosKlines({ address: ADDRESS, bar: "1m", fetchFn: fake.fetch }),
      /invalid JSON in response/u,
    );
  });

  it("rejects a non-zero envelope code with the upstream message", async () => {
    setCredentials();
    const fake = fakeFetch(() => jsonResponse({ code: "50011", msg: "too many requests" }));
    await assert.rejects(
      () => fetchOnchainosKlines({ address: ADDRESS, bar: "1m", fetchFn: fake.fetch }),
      /too many requests/u,
    );
  });
});

describe("fetchOnchainosPrice", () => {
  it("posts the batch body and normalizes the first row", async () => {
    setCredentials();
    const fake = fakeFetch(() =>
      jsonResponse({
        code: "0",
        data: [
          {
            price: "1.5",
            marketCap: "1000000",
            volume24H: "250000",
            holders: "4200",
            priceChange24H: "-3.25",
          },
        ],
      }),
    );

    const snapshot = await fetchOnchainosPrice({ address: ADDRESS, fetchFn: fake.fetch });
    const call = fake.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.method, "POST");
    assert.deepEqual(JSON.parse(call.body ?? "null"), [
      { chainIndex: "56", tokenContractAddress: LOWER },
    ]);

    assert.equal(snapshot.address, LOWER);
    assert.equal(snapshot.priceUsd, 1.5);
    assert.equal(snapshot.marketCapUsd, 1_000_000);
    assert.equal(snapshot.volume24hUsd, 250_000);
    assert.equal(snapshot.holders, 4_200);
    assert.equal(snapshot.priceChange24hPct, -3.25);
  });

  it("returns an all-null snapshot for an empty batch response", async () => {
    setCredentials();
    const fake = fakeFetch(() => jsonResponse({ code: "0", data: [] }));
    const snapshot = await fetchOnchainosPrice({ address: ADDRESS, fetchFn: fake.fetch });
    assert.equal(snapshot.priceUsd, null);
    assert.equal(snapshot.holders, null);
  });
});
