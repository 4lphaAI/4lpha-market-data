/**
 * Live check of the pool lane: runs one real cycle, then queries it the way a
 * consumer would. Diagnostic only — not part of the test suite.
 */

import { loadDotEnv } from "../src/config/env.js";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import { createServer } from "../src/server.js";
import { readPoolsLane, runPancakePools } from "../src/jobs/pancakePools.js";

loadDotEnv();

const store = new MemoryStore();
const app = createServer({ scheduler: createScheduler(store), store });

const started = Date.now();
const result = await runPancakePools(store, AbortSignal.timeout(60_000));
console.log(`cycle ${Date.now() - started}ms`, result);

const lane = await readPoolsLane(store);
const priced = lane?.pools.filter((pool) => pool.combinedApr !== null).length ?? 0;
const farmed = lane?.pools.filter((pool) => (pool.cakeFarmApr ?? 0) > 0).length ?? 0;
console.log(`lane ${lane?.pools.length ?? 0} pools, ${priced} with a combined APR, ${farmed} farmed`);

const tiers = new Map<string, number>();
for (const pool of lane?.pools ?? []) tiers.set(pool.tier, (tiers.get(pool.tier) ?? 0) + 1);
console.log("tiers", Object.fromEntries(tiers));

const token = process.env["DP_AUTH_TOKEN"];
const headers = token === undefined ? {} : { "x-dp-token": token };

async function show(label: string, query: string): Promise<void> {
  const res = await app.request(`/pools/top${query}`, { headers });
  const body = (await res.json()) as {
    data?: Array<Record<string, unknown>>;
    meta?: Record<string, unknown>;
    error?: unknown;
  };
  if (body.data === undefined || body.meta === undefined) {
    console.log(`\n${label}  [${res.status}] ${JSON.stringify(body)}`);
    return;
  }
  console.log(`\n${label}  [${res.status}] matched=${String(body.meta["matched"])}`);
  for (const row of body.data.slice(0, 5)) {
    const origins = row["tokenOrigin"] as { token0: string; token1: string };
    console.log(
      `  ${String(row["token0Symbol"])}/${String(row["token1Symbol"])} ` +
        `fee=${String(row["fee"])} tvl=$${Math.round(Number(row["tvlUsd"] ?? 0)).toLocaleString()} ` +
        `lpFee=${String(row["lpFeeApr24h"])}% cake=${String(row["cakeFarmApr"])}% ` +
        `combined=${String(row["combinedApr"])}% ` +
        `[${String(row["tier"])}: ${origins.token0}/${origins.token1}]`,
    );
  }
}

await show("top by combined APR, unfiltered", "?limit=5");
await show("core tier only", "?tier=core&limit=5");
await show("degen tier only", "?tier=degen&limit=5");
await show("min $1m TVL, APR >= 10%", "?minTvlUsd=1000000&minAprPct=10&limit=5");
await show("TVL >= $500k, sorted by CAKE APR", "?orderBy=cakeFarmApr&minTvlUsd=500000&limit=5");
await show("USDT pools, no wash trading", "?token=0x55d398326f99059ff775485246999027b3197955&maxVolTvlRatio=20&limit=5");
