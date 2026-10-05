/**
 * Measures `/memes/bars` lag the way the execution plane does —
 * `now - (lastClosedStartMs + 60 s)` at read time — with the real `meme-bars`
 * job on the real scheduler against live Sintral, on a board copied from the
 * deployed plane (DP_AUTH_TOKEN). Reads every 17 s (so samples fall at every phase of the minute) for the shortlisted tokens.
 * Read-only. Usage: node --import tsx scripts/meme-bars-latency-check.ts [minutes=6]
 */
import { loadDotEnv } from "../src/config/env.js";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import { MEME_BOARD_KEY } from "../src/jobs/memeBoard.js";
import { MEME_BARS_INDEX_KEY, memeBarsJob, readMemeBars, readTrackedSet, type BarsIndex } from "../src/jobs/memeBars.js";
import { RWA_UNIVERSE_KEY } from "../src/universe.js";
loadDotEnv();

const PROD = "https://data-plane-production.up.railway.app";
const token = process.env["DP_AUTH_TOKEN"];
if (token === undefined || token === "") throw new Error("DP_AUTH_TOKEN missing");
const get = async (path: string) =>
  (await (await fetch(`${PROD}${path}`, { headers: { "x-dp-token": token } })).json()) as { data: unknown };
const minutes = Number(process.argv[2] ?? "6");

const store = new MemoryStore();
const refreshBoard = async () => {
  await store.put(MEME_BOARD_KEY, (await get("/memes?status=runner,active,quiet,fading,dead,unknown&limit=800")).data, {
    source: "prod-copy", freshForMs: 3 * 60_000, deadAfterMs: 30 * 60_000,
  });
};
await refreshBoard();
await store.put(RWA_UNIVERSE_KEY, { rows: (await get("/universe?lane=bstocks")).data }, { source: "prod-copy", freshForMs: 60 * 60_000, deadAfterMs: 120 * 60_000 });
const shortlist = ((await get("/memes/shortlist?segment=memestock")).data as Array<{ address: string }>).map((r) => r.address);

const scheduler = createScheduler(store);
scheduler.register(memeBarsJob(store));
scheduler.start();
const boardTimer = setInterval(() => void refreshBoard().catch(() => {}), 60_000);

// Let the entry backfill land before measuring.
await new Promise((resolve) => setTimeout(resolve, 90_000));
const lags: number[] = [];
const calls: number[] = [];
const corrected: number[] = [];
let lastCycleAt = 0;
const end = Date.now() + minutes * 60_000;
while (Date.now() < end) {
  const tracked = await readTrackedSet(store);
  const now = Date.now();
  for (const address of shortlist) {
    const view = await readMemeBars(store, address, 60, tracked);
    if (view.lastClosedStartMs !== null && view.staleness === "fresh") lags.push((now - (view.lastClosedStartMs + 60_000)) / 1000);
  }
  const cycle = (await store.get<BarsIndex>(MEME_BARS_INDEX_KEY))?.data.lastCycle;
  if (cycle && cycle.at !== lastCycleAt) { calls.push(cycle.calls); corrected.push(cycle.corrected); lastCycleAt = cycle.at; }
  await new Promise((resolve) => setTimeout(resolve, 17_000));
}
clearInterval(boardTimer);
await scheduler.stop();

const sorted = [...lags].sort((a, b) => a - b);
const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!.toFixed(1);
console.log(`reads ${Math.round(lags.length / Math.max(1, shortlist.length))} x ${shortlist.length} shortlisted tokens = ${lags.length} samples`);
console.log(`lag s: p50 ${q(0.5)} p90 ${q(0.9)} max ${sorted.at(-1)?.toFixed(1)} min ${sorted[0]?.toFixed(1)}`);
console.log(`Sintral calls per cycle (one cycle per minute): ${JSON.stringify(calls)}`);
console.log(`closed bars corrected by the re-read, per cycle: ${JSON.stringify(corrected)}`);
