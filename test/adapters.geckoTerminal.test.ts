import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchGeckoPoolOhlcv,
  normalizeGeckoPoolOhlcv,
} from "../src/adapters/geckoTerminal.js";

const POOL = "0xcc2bffaec373a6004bb6ccc8a62cdd66061f7c6a";

describe("normalizeGeckoPoolOhlcv", () => {
  it("converts seconds to milliseconds, drops broken bars and sorts ascending", () => {
    const result = normalizeGeckoPoolOhlcv({
      data: {
        attributes: {
          ohlcv_list: [
            [1_700_000_060, 2, 4, 1, 3, 20],
            [1_700_000_000, 1, 3, 0.5, 2, 10],
            [1_700_000_120, 2, 1, 0.5, 2, 5],
          ],
        },
      },
      meta: {
        base: { address: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", name: "NVIDIA", symbol: "NVDAB" },
        quote: { address: "0x55d398326f99059ff775485246999027b3197955", name: "Tether", symbol: "USDT" },
      },
    });

    assert.deepEqual(result.candles.map((row) => row.timestamp), [1_700_000_000_000, 1_700_000_060_000]);
    assert.equal(result.base?.symbol, "NVDAB");
    assert.equal(result.quote?.symbol, "USDT");
  });
});

describe("fetchGeckoPoolOhlcv", () => {
  it("maps the exact pool, timeframe, aggregate and limit into one public request", async () => {
    let observedHref = "";
    const fetchFn: typeof fetch = async (input) => {
      observedHref = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [] } }, meta: {} }));
    };

    await fetchGeckoPoolOhlcv({
      poolAddress: POOL,
      timeframe: "minute",
      aggregate: 15,
      limit: 300,
      fetchFn,
    });

    assert.notEqual(observedHref, "");
    const observed = new URL(observedHref);
    assert.equal(observed.hostname, "api.geckoterminal.com");
    assert.ok(observed.pathname.endsWith(`/networks/bsc/pools/${POOL}/ohlcv/minute`));
    assert.equal(observed.searchParams.get("aggregate"), "15");
    assert.equal(observed.searchParams.get("limit"), "300");
    assert.equal(observed.searchParams.get("token"), "base");
  });
});
