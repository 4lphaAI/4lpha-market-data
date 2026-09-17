/**
 * Live check of the tokenized-stock lanes: one real `binance-rwa` cycle, one
 * real `stock-venues` cycle, then the reads a consumer would make. Diagnostic
 * only — not part of the test suite. Numbers it prints are DevEx material.
 *
 *   node --import tsx scripts/rwa-check.ts            # one venues cycle (VENUES_PER_CYCLE tokens)
 *   node --import tsx scripts/rwa-check.ts --full     # sweep every token
 */

import { loadDotEnv } from "../src/config/env.js";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import { createServer } from "../src/server.js";
import { hasBinanceRwaCredentials } from "../src/adapters/binanceRwa.js";
import { runBinanceRwa } from "../src/jobs/binanceRwa.js";
import { VENUES_PER_CYCLE, runStockVenues } from "../src/jobs/stockVenues.js";
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

const cycles = full ? Math.ceil(500 / VENUES_PER_CYCLE) : 1;
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

// Rule 5 through the HTTP surface: a bStock, an Ondo row, an UNSUPPORTED Ondo row, a non-stock.
const rwaLane = (await (await app.request("/universe?lane=ondo", { headers })).json()) as { data: UniverseEntry[] };
const unsupported = rwaLane.data.find((r) => r.reasonCode === "UNSUPPORTED")?.address;
const open = rwaLane.data.find((r) => r.openState === true && (r.venues?.length ?? 0) > 0)?.address ?? rwaLane.data.find((r) => r.openState === true)?.address;
const sample = ["0x02fca66c1d1afb4e2a7884261eb00f63598a7436", open, unsupported, "0x55d398326f99059ff775485246999027b3197955"].filter((a): a is string => a !== undefined);
const elig = await app.request(`/eligibility?addresses=${sample.join(",")}`, { headers });
const verdicts = (await elig.json()) as { data: Array<{ address: string; eligible: boolean; reason: string; source: string | null }> };
console.log("\n/eligibility batch:");
for (const v of verdicts.data) {
  const row = [...rwaLane.data, ...((await (await app.request("/universe?lane=bstocks", { headers })).json()) as { data: UniverseEntry[] }).data].find((r) => r.address === v.address);
  console.log(`  ${(row?.symbol ?? "USDT").padEnd(8)} eligible=${v.eligible} reason=${v.reason} source=${v.source}`);
}
