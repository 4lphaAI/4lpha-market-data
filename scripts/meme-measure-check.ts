/**
 * Runs one real `meme-measure` cycle against live upstreams (Binance social-rush
 * and smart-money inflow) into an in-memory store and prints what it recorded,
 * with the per-cycle size and the projected size per day. Read-only.
 *
 *   node --import tsx scripts/meme-measure-check.ts               # board from one local meme-board cycle
 *   node --import tsx scripts/meme-measure-check.ts --prod-board  # board copied from the deployed plane (DP_AUTH_TOKEN)
 *
 * A local board has no retention history (~520 listed rows), so `--prod-board`
 * is the one that sizes the record realistically (800 rows, all statuses).
 */
import { loadDotEnv } from "../src/config/env.js";
import { MemoryStore } from "../src/core/store.js";
import { MEME_BOARD_KEY, runMemeBoard } from "../src/jobs/memeBoard.js";
import {
  MEME_MEASURE_SLOT_MS,
  expandCycle,
  memeMeasureSlotKey,
  runMemeMeasure,
  slotOf,
  type MeasureCycle,
} from "../src/jobs/memeMeasure.js";
loadDotEnv();

const PROD = "https://data-plane-production.up.railway.app";
const store = new MemoryStore();

if (process.argv.includes("--prod-board")) {
  const token = process.env["DP_AUTH_TOKEN"];
  if (token === undefined || token === "") throw new Error("DP_AUTH_TOKEN missing");
  const response = await fetch(`${PROD}/memes?status=runner,active,quiet,fading,dead,unknown&limit=800`, {
    headers: { "x-dp-token": token },
  });
  const body = (await response.json()) as { data: unknown[]; meta: { asOf: number } };
  await store.put(MEME_BOARD_KEY, body.data, { source: "prod-copy", freshForMs: 3 * 60_000, deadAfterMs: 30 * 60_000 });
  console.log(`board copied from production: ${body.data.length} rows, asOf ${new Date(body.meta.asOf).toISOString()}`);
} else {
  const t0 = performance.now();
  const board = await runMemeBoard(store, AbortSignal.timeout(45_000));
  console.log(`local board cycle ${Math.round(performance.now() - t0)} ms: ${board.rows} rows`);
}

const t0 = performance.now();
const result = await runMemeMeasure(store, AbortSignal.timeout(45_000));
console.log(`measure cycle ${Math.round(performance.now() - t0)} ms`, JSON.stringify(result, null, 1));
if (!result.recorded) process.exit(0);

const cycle = (await store.get<MeasureCycle>(memeMeasureSlotKey(slotOf(result.latest.ts))))!.data;
const perDay = (86_400_000 / MEME_MEASURE_SLOT_MS) * result.latest.bytes;
const part = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
console.log(`bytes/cycle ${result.latest.bytes}  -> ${(perDay / 1e6).toFixed(1)} MB/day, ${((7 * perDay) / 1e6).toFixed(0)} MB over 7 days`);
console.log(`  topics ${part(cycle.topics?.topics)}  topic tokens ${part(cycle.topics?.tokens)}  inflow ${part(cycle.inflow)}  board ${part(cycle.board)}`);
console.log(`  rising: ${JSON.stringify(cycle.topics?.lists.rising).slice(0, 80)}`);

const expanded = expandCycle(cycle) as {
  topics: { topics: Array<Record<string, unknown>>; tokens: Array<Record<string, unknown>> } | null;
  inflow: Record<string, Array<Record<string, unknown>> | null>;
  board: { rows: Array<Record<string, unknown>> } | null;
};
const boardBy = new Map((expanded.board?.rows ?? []).map((row) => [row["address"] as string, row]));
console.log("\nmeme stocks in topics:");
for (const token of expanded.topics?.tokens ?? []) {
  const row = boardBy.get(token["address"] as string);
  if (row === undefined) continue;
  const topic = expanded.topics?.topics.find((t) => t["topicId"] === token["topicId"]);
  console.log(`  ${String(row["symbol"]).padEnd(12)} ${String(row["quoteSymbol"]).padEnd(7)} ${String(row["status"]).padEnd(7)} topic "${String(topic?.["nameEn"])}"`);
}
console.log("\nmeme stocks in smart inflow:");
for (const period of ["5m", "1h"]) {
  for (const inflow of expanded.inflow[period] ?? []) {
    const row = boardBy.get(inflow["address"] as string);
    if (row === undefined) continue;
    console.log(`  ${period} #${inflow["rank"]} ${String(row["symbol"]).padEnd(12)} ${String(row["quoteSymbol"]).padEnd(7)} ${String(row["status"]).padEnd(7)} net $${inflow["netInflowUsd"]} traders ${inflow["traders"]}`);
  }
}
console.log("\nsample board row:", JSON.stringify(expanded.board?.rows[0]));
