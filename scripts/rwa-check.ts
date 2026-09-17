/**
 * Live check of the tokenized-stock lanes: one real `binance-rwa` cycle, one
 * real `stock-venues` cycle, then the reads a consumer would make. Diagnostic
 * only — not part of the test suite. Numbers it prints are DevEx material.
 *
 *   node --import tsx scripts/rwa-check.ts            # one venues cycle (100 tokens)
 *   node --import tsx scripts/rwa-check.ts --full     # sweep every token (5 cycles)
 */

import { loadDotEnv } from "../src/config/env.js";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import { createServer } from "../src/server.js";
import { hasBinanceRwaCredentials } from "../src/adapters/binanceRwa.js";
import { runBinanceRwa } from "../src/jobs/binanceRwa.js";
import { runStockVenues } from "../src/jobs/stockVenues.js";
import type { UniverseEntry } from "../src/core/models.js";

loadDotEnv();

const store = new MemoryStore();
const app = createServer({ scheduler: createScheduler(store), store });
const full = process.argv.includes("--full");

if (!hasBinanceRwaCredentials()) {
  console.log("BINANCE_WEB3_API_KEY/SECRET_KEY not set — static bStocks only");
} else {
  const t0 = Date.now();
  const rwa = await runBinanceRwa(store, AbortSignal.timeout(20_000));
  console.log(`binance-rwa ${Date.now() - t0}ms`, rwa);
}

const cycles = full ? 5 : 1;
for (let i = 0; i < cycles; i++) {
  const t0 = Date.now();
  const venues = await runStockVenues(store, AbortSignal.timeout(45_000));
  console.log(`stock-venues cycle ${i + 1} ${Date.now() - t0}ms`, venues);
}

const headers: Record<string, string> = {};
const token = process.env["DP_AUTH_TOKEN"];
if (token !== undefined && token !== "") headers["x-dp-token"] = token;

for (const lane of ["bstocks", "ondo"]) {
  const res = await app.request(`/universe?lane=${lane}`, { headers });
  const body = (await res.json()) as { data: UniverseEntry[]; meta: { lanes: Record<string, unknown> } };
  const rows = body.data;
  const withVenues = rows.filter((r) => (r.venues?.length ?? 0) > 0);
  const open = rows.filter((r) => r.openState === true).length;
  console.log(`\n/universe?lane=${lane} → ${res.status}, ${rows.length} rows, ${open} open, ${withVenues.length} with venues; lane meta`, body.meta.lanes[lane]);
  const top = [...withVenues]
    .sort((a, b) => (b.venues![0]!.liquidityUsd ?? 0) - (a.venues![0]!.liquidityUsd ?? 0))
    .slice(0, 8);
  for (const r of top) {
    const v = r.venues!.map((x) => `${x.dex}/${x.version}${x.feeTier === null ? "" : `@${x.feeTier}`} $${((x.liquidityUsd ?? 0) / 1e3).toFixed(0)}k/${x.quote.symbol}`).join(" | ");
    console.log(`  ${r.symbol.padEnd(8)} prem ${String(r.premiumBps).padStart(5)}bps ${r.marketStatus ?? "24/7"}/${r.reasonCode}  ${v}`);
  }
}

const status = await app.request("/status", { headers });
const snapshots = ((await status.json()) as { data: { snapshots: Array<{ key: string; staleness?: string; missing?: boolean }> } }).data.snapshots;
console.log("\n/status snapshots:", snapshots.filter((s) => s.key.endsWith(":rwa")));
