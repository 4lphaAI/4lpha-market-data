/**
 * Runs `meme-bars` against live Sintral into an in-memory store, on a board
 * copied from the deployed plane (DP_AUTH_TOKEN), and prints coverage, cost and
 * a sample series. Read-only. Usage: node --import tsx scripts/meme-bars-check.ts [cycles]
 */
import { loadDotEnv } from "../src/config/env.js";
import { MemoryStore } from "../src/core/store.js";
import { MEME_BOARD_KEY } from "../src/jobs/memeBoard.js";
import { RWA_UNIVERSE_KEY } from "../src/universe.js";
import { MEME_BARS_INDEX_KEY, readMemeBars, readTrackedSet, runMemeBars, type BarsIndex } from "../src/jobs/memeBars.js";
loadDotEnv();

const PROD = "https://data-plane-production.up.railway.app";
const token = process.env["DP_AUTH_TOKEN"];
if (token === undefined || token === "") throw new Error("DP_AUTH_TOKEN missing");
const get = async (path: string) => (await (await fetch(`${PROD}${path}`, { headers: { "x-dp-token": token } })).json()) as { data: unknown; meta: Record<string, unknown> };

const store = new MemoryStore();
const board = await get("/memes?status=runner,active,quiet,fading,dead,unknown&limit=800");
await store.put(MEME_BOARD_KEY, board.data, { source: "prod-copy", freshForMs: 3 * 60_000, deadAfterMs: 30 * 60_000 });
const rwa = await get("/universe?lane=bstocks");
await store.put(RWA_UNIVERSE_KEY, { rows: rwa.data }, { source: "prod-copy", freshForMs: 3 * 60_000, deadAfterMs: 30 * 60_000 });

const cycles = Number(process.argv[2] ?? "2");
for (let i = 0; i < cycles; i++) {
  if (i > 0) await new Promise((resolve) => setTimeout(resolve, 61_000));
  const t0 = performance.now();
  const result = await runMemeBars(store, AbortSignal.timeout(45_000), { holder: "check" });
  console.log(`cycle ${i}: ${Math.round(performance.now() - t0)} ms`, JSON.stringify(result));
}
const index = (await store.get<BarsIndex>(MEME_BARS_INDEX_KEY))!.data;
const tracked = await readTrackedSet(store);
const views = await Promise.all(Object.keys(index.tokens).map((address) => readMemeBars(store, address, 180, tracked)));
const lengths = views.map((v) => v.bars.length).sort((a, b) => a - b);
const silent = views.map((v) => v.bars.filter((b) => b.trades === 0).length / Math.max(1, v.bars.length));
console.log(`tracked ${views.length}; with bars ${views.filter((v) => v.bars.length > 0).length}; bars/token min ${lengths[0]} median ${lengths[Math.floor(lengths.length / 2)]} max ${lengths.at(-1)}`);
console.log(`zero-filled share median ${silent.sort((a, b) => a - b)[Math.floor(silent.length / 2)]?.toFixed(2)}`);
const sample = views.sort((a, b) => b.bars.length - a.bars.length)[0];
console.log(sample?.symbol, sample?.lastClosedStartMs && new Date(sample.lastClosedStartMs).toISOString(), JSON.stringify(sample?.bars.slice(-4)));
