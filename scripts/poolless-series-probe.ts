/**
 * Read-only research for TRADFI-AGGREGATOR-HANDOFF-2 §C1: can Sintral serve
 * 15m/1h bars for bStocks that have no AMM venue, keyed by token address, and
 * what price does the series carry?
 *
 * For every bStock in the live `/universe?lane=bstocks` lane, pool-less meaning
 * no venue at or above the $10k floor the feature producer uses, plus three
 * pool controls: pulls Sintral 15min and 1h (limit 120, exactly what the
 * producer asks for) and counts real bars inside the trailing 120-bucket
 * feature window with the rev 3 cutoff rules. Then compares the last close
 * with the RWA issuer/reference price and, for controls, with the pool.
 *
 * Usage: node --import tsx scripts/poolless-series-probe.ts > out.json
 */
import { loadDotEnv } from "../src/config/env.js";
import { fetchSintralKlines } from "../src/adapters/binanceWeb3.js";
import { signedRequest } from "../src/adapters/binanceRwa.js";
import { FEATURE_HISTORY, PUBLICATION_LAG_MS } from "../src/query/tradingFeatures.js";
loadDotEnv();

const PLANE = process.env["DATA_PLANE_URL"] ?? "https://data-plane-production.up.railway.app";
const FLOOR_USD = 10_000;
const CONTROLS = ["NVDAB", "SPYB", "QQQB"];
const INTERVALS = [["15m", "15min", 900_000], ["1h", "1h", 3_600_000]] as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Entry {
  address: string; symbol: string; tokenPriceUsd: number | null; referencePriceUsd: number | null;
  venues?: Array<{ pool: string; liquidityUsd: number | null }>;
}

const res = await fetch(`${PLANE}/universe?lane=bstocks`, { headers: { "x-dp-token": process.env["DP_AUTH_TOKEN"]!.trim() } });
const entries = ((await res.json()) as { data: Entry[] }).data;
const deepest = (e: Entry) => Math.max(0, ...(e.venues ?? []).map((v) => v.liquidityUsd ?? 0));
const poolless = entries.filter((e) => deepest(e) < FLOOR_USD);
const controls = entries.filter((e) => CONTROLS.includes(e.symbol));
console.error(`bstocks ${entries.length}, pool-less ${poolless.length}: ${poolless.map((e) => e.symbol).join(" ")}`);

// Binance's own signed market candles, trade-derived per DEVEX QUIRK-17; tried once, shape recorded.
let marketCandles: unknown = null;
try {
  marketCandles = await signedRequest({ method: "GET", path: "/api/v1/dex/market/candles", query: [
    ["binanceChainId", "56"], ["tokenContractAddress", poolless[0]!.address], ["bar", "15m"], ["limit", "5"]] });
} catch (e) { marketCandles = { error: (e as Error).message }; }

const now = Date.now();
const rows: unknown[] = [];
for (const [kind, list] of [["poolless", poolless], ["control", controls]] as const) {
  for (const e of list) {
    const row: Record<string, unknown> = { kind, symbol: e.symbol, address: e.address, deepestPoolUsd: Math.round(deepest(e)),
      tokenPriceUsd: e.tokenPriceUsd, referencePriceUsd: e.referencePriceUsd };
    for (const [name, sintral, step] of INTERVALS) {
      const t0 = performance.now();
      try {
        const bars = await fetchSintralKlines({ address: e.address, interval: sintral, limit: FEATURE_HISTORY });
        const cutoff = Math.floor((now - PUBLICATION_LAG_MS) / step) * step;
        const start = cutoff - FEATURE_HISTORY * step;
        const inWindow = bars.filter((b) => b.timestamp % step === 0 && b.timestamp >= start && b.timestamp + step <= cutoff);
        const last = bars.at(-1);
        row[name] = {
          ms: Math.round(performance.now() - t0),
          returned: bars.length,
          realBarsInWindow: inWindow.length,
          // rev 3 fills from the first real bar forward; everything before it is simply absent.
          filledSpan: inWindow.length ? Math.round((cutoff - inWindow[0]!.timestamp) / step) : 0,
          rev3Admits: inWindow.length >= 30,
          volumeBars: inWindow.filter((b) => b.volume > 0).length,
          distinctCloses: new Set(inWindow.map((b) => b.close)).size,
          flatBars: inWindow.filter((b) => b.open === b.high && b.high === b.low && b.low === b.close).length,
          lastTs: last ? new Date(last.timestamp).toISOString() : null,
          lastAgeMin: last ? Math.round((now - last.timestamp) / 60_000) : null,
          lastClose: last?.close ?? null,
          vsReferenceBps: last && e.referencePriceUsd ? Math.round((last.close / e.referencePriceUsd - 1) * 10_000) : null,
          vsTokenPriceBps: last && e.tokenPriceUsd ? Math.round((last.close / e.tokenPriceUsd - 1) * 10_000) : null,
          volumeInWindow: Math.round(inWindow.reduce((s, b) => s + b.volume, 0)),
          hoursUtcWithBars: [...new Set(inWindow.map((b) => new Date(b.timestamp).getUTCHours()))].sort((a, b) => a - b),
        };
        // One snapshot depends on the hour it was taken. Slide the same
        // 120-bucket window over a deep pull, one position per hour, and
        // count how often it would clear rev 3's 30-real-bar floor.
        await sleep(150);
        const deep = (await fetchSintralKlines({ address: e.address, interval: sintral, limit: 1_000 }))
          .filter((b) => b.timestamp % step === 0 && b.timestamp + step <= cutoff);
        const times = new Set(deep.map((b) => b.timestamp));
        const earliest = deep[0]?.timestamp ?? cutoff;
        const counts: number[] = [];
        for (let end = cutoff; end - FEATURE_HISTORY * step >= earliest; end -= 3_600_000) {
          let n = 0;
          for (let t = end - FEATURE_HISTORY * step; t < end; t += step) if (times.has(t)) n++;
          counts.push(n);
        }
        counts.sort((a, b) => a - b);
        (row[name] as Record<string, unknown>)["rolling"] = {
          deepBars: deep.length,
          spanDays: Math.round((cutoff - earliest) / 86_400_000 * 10) / 10,
          windows: counts.length,
          admitPct: counts.length ? Math.round(counts.filter((n) => n >= 30).length / counts.length * 100) : null,
          p10: counts[Math.floor(counts.length * 0.1)] ?? null,
          median: counts[Math.floor(counts.length / 2)] ?? null,
          p90: counts[Math.floor(counts.length * 0.9)] ?? null,
        };
      } catch (err) {
        row[name] = { ms: Math.round(performance.now() - t0), error: (err as Error).message };
      }
      await sleep(150);
    }
    rows.push(row);
  }
}
console.log(JSON.stringify({ observedAt: new Date(now).toISOString(), marketCandles, rows }));
