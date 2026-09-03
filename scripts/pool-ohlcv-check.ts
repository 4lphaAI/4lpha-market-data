/** Opt-in live smoke. Memory-only: never connects to the configured database. */
import assert from "node:assert/strict";
import { loadDotEnv } from "../src/config/env.js";
import { MemoryStore } from "../src/core/store.js";
import { getPoolOhlcv, poolOhlcvDiagnostics } from "../src/query/poolOhlcv.js";

loadDotEnv();
const poolAddress = "0x172fcd41e0913e95784454622d1c3724f546f849"; // USDT/WBNB
const realFetch = globalThis.fetch;
const forceFallback = process.argv.includes("--fallback");
const compare = process.argv.includes("--compare");

try {
  if (process.argv.includes("--usage")) {
    const key = (process.env["DEXPAPRIKA_API_KEY"] ?? process.env["DexPaprika"])?.trim();
    const response = await realFetch("https://api.dexpaprika.com/usage", {
      headers: key ? { Authorization: key } : {}, signal: AbortSignal.timeout(10_000),
    });
    const usage = await response.json() as Record<string, unknown>;
    // Never print the raw response, headers, key, or user/account identifiers.
    console.log(JSON.stringify({ check: "usage", status: response.status, keyConfigured: Boolean(key),
      plan: typeof usage["plan"] === "string" ? usage["plan"] : "not reported" }));
  }

  const run = async (fallback: boolean) => {
    const store = new MemoryStore();
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      // The fault is local to this diagnostic, not a request sent to Gecko.
      if (fallback && url.hostname === "api.geckoterminal.com") return new Response(null, { status: 503 });
      return realFetch(input, init);
    };
    try {
      const started = performance.now();
      const result = await getPoolOhlcv(store, { poolAddress, interval: "1m", limit: 300, currency: "token" });
      assert.ok(result, "no usable chart returned");
      if (fallback) assert.equal(result.source, "dexpaprika");
      assert.equal(result.priceCurrency, "token");
      assert.equal(result.base.address, "0x55d398326f99059ff775485246999027b3197955");
      assert.equal(result.quote.address, "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c");
      const elapsedMs = Math.round(performance.now() - started);
      const requests = JSON.stringify(poolOhlcvDiagnostics(store).providers);
      await getPoolOhlcv(store, { poolAddress, interval: "1m", limit: 20, currency: "token" });
      assert.equal(JSON.stringify(poolOhlcvDiagnostics(store).providers), requests, "cache hit made HTTP calls");
      console.log(JSON.stringify({ check: fallback ? "forced-fallback" : "primary", source: result.source,
        elapsedMs, count: result.candles.length, latestClose: result.candles.at(-1)?.close,
        latestTimestamp: result.candles.at(-1)?.timestamp, staleness: result.staleness,
        volumeUnavailableReason: result.volumeUnavailableReason, diagnostics: poolOhlcvDiagnostics(store) }));
      return result;
    } finally { globalThis.fetch = realFetch; await store.close(); }
  };
  const first = await run(forceFallback);
  if (compare) {
    const second = await run(true);
    const byTime = new Map(first.candles.map((c) => [c.timestamp, c.close]));
    const deviations = second.candles.flatMap((c) => {
      const close = byTime.get(c.timestamp);
      return close === undefined ? [] : [Math.abs(c.close / close - 1) * 100];
    }).sort((a, b) => a - b);
    assert.ok(deviations.length > 0, "providers have no overlapping timestamps");
    console.log(JSON.stringify({ check: "comparison", overlappingBars: deviations.length,
      medianCloseDeviationPct: deviations[Math.floor(deviations.length / 2)], maxCloseDeviationPct: deviations.at(-1) }));
  }
} catch {
  // Adapter messages are already sanitized; do not print arbitrary fetch errors.
  console.error("[pool-ohlcv-check] failed; see sanitized diagnostic results above");
  process.exitCode = 1;
} finally { globalThis.fetch = realFetch; }
