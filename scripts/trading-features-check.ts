/** Optional read-only live probe. No dotenv, durable store, worker or transactions. */
import { MemoryStore } from "../src/core/store.js";
import { getPoolOhlcv } from "../src/query/poolOhlcv.js";
import { calculateFeatures, poolFeatureInput, FEATURE_INTERVALS, type FeatureInterval } from "../src/query/tradingFeatures.js";
import { isEvmAddress } from "../src/adapters/http.js";

// Existing majors-price reference: BSC Pancake V3 USDT/WBNB 0.01%.
const pool = (process.argv[2] ?? "0x172fcd41e0913e95784454622d1c3724f546f849").toLowerCase();
if (!isEvmAddress(pool)) throw new Error("expected a BSC pool address");
const tokenAddress = process.argv[3]?.toLowerCase();
if (tokenAddress && !isEvmAddress(tokenAddress)) throw new Error("expected a BSC token address");
const currency = process.argv[4] ?? "usd";
if (currency !== "usd" && currency !== "token") throw new Error("expected usd or token currency");
const simulate429 = process.argv[5] === "--simulate-gecko-429";
if (simulate429 && currency !== "token") throw new Error("fallback probe requires token currency");
const originalFetch = globalThis.fetch;
if (simulate429) globalThis.fetch = async (request, init) => {
  const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
  return url.hostname === "api.geckoterminal.com" ? new Response("{}", {status:429}) : originalFetch(request, init);
};
const store = new MemoryStore();
try {
  for (const interval of Object.keys(FEATURE_INTERVALS) as FeatureInterval[]) {
    const chart = await getPoolOhlcv(store, { poolAddress: pool, interval, currency, limit: 500,
      ...(tokenAddress ? { tokenAddress } : {}) });
    if (!chart) { console.log(JSON.stringify({ pool, interval, available: false, reason: "provider_unavailable" })); continue; }
    const snapshot = calculateFeatures(poolFeatureInput(chart, interval), Date.now());
    console.log(JSON.stringify({ pool, interval, currency, simulatedGecko429: simulate429, source: chart.source, observedAt: chart.asOf,
      base: chart.base.address, quote: chart.quote.address, evaluationClose: snapshot.evaluationClose,
      snapshotId: snapshot.snapshotId, coverage: snapshot.coverage, metrics: snapshot.metrics }));
  }
} finally { globalThis.fetch = originalFetch; await store.close(); }
