/**
 * Runs one real `meme-board` cycle against live upstreams (Binance Meme Rush,
 * OnchainOS, BSC RPC) into an in-memory store and prints what it classified.
 * Read-only. Usage: node --import tsx scripts/meme-board-check.ts
 */
import { loadDotEnv } from "../src/config/env.js";
import { MemoryStore } from "../src/core/store.js";
import { MEME_BOARD_KEY, runMemeBoard } from "../src/jobs/memeBoard.js";
import type { MemeBoardRow } from "../src/query/memeClassify.js";
loadDotEnv();

const store = new MemoryStore();
const t0 = performance.now();
const result = await runMemeBoard(store, AbortSignal.timeout(45_000));
console.log(`cycle ${Math.round(performance.now() - t0)} ms`, JSON.stringify(result));

const rows = ((await store.get<MemeBoardRow[]>(MEME_BOARD_KEY))?.data ?? []) as MemeBoardRow[];
const tally = (key: (row: MemeBoardRow) => string) =>
  rows.reduce<Record<string, number>>((acc, row) => ((acc[key(row)] = (acc[key(row)] ?? 0) + 1), acc), {});
console.log("stage × status", JSON.stringify(tally((row) => `${row.stage}/${row.status}`)));
console.log("launchpad", JSON.stringify(tally((row) => row.launchpad)), "quote", JSON.stringify(tally((row) => row.quote.kind ?? "unresolved")));
const flags: Record<string, number> = {};
for (const row of rows) for (const flag of row.flags) flags[flag] = (flags[flag] ?? 0) + 1;
console.log("flags", JSON.stringify(flags));
const ageMin = (row: MemeBoardRow) => ((Date.now() - row.createdAt) / 60_000).toFixed(0);
console.log("\nrunners:");
for (const row of rows.filter((r) => r.status === "runner").sort((a, b) => (b.activity?.txs5m ?? 0) - (a.activity?.txs5m ?? 0)).slice(0, 15)) {
  console.log(`  ${row.symbol.padEnd(14)} ${row.launchpad.padEnd(8)} ${row.stage.padEnd(10)} age ${ageMin(row)}m txs5m ${row.activity?.txs5m} txs1h ${row.activity?.txs1h} vol1h $${Math.round(row.activity?.volume1hUsd ?? 0)} chg1h ${row.activity?.priceChange1hPct}% mcap $${Math.round(row.market.marketCapUsd ?? 0)} quote ${row.quote.kind} [${row.flags.join(",")}]`);
}
