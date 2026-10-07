/**
 * Runs a few real `meme-board` cycles into one in-memory store and tallies the
 * Four.Meme tax on the board (FOURMEME-TAX-SPEC.md). Read-only.
 *
 *   node --import tsx scripts/fourmeme-tax-check.ts [cycles]
 */
import { loadDotEnv } from "../src/config/env.js";
import { MemoryStore } from "../src/core/store.js";
import { MEME_BOARD_KEY, runMemeBoard } from "../src/jobs/memeBoard.js";
import { MEME_VENUES_KEY, type CachedVenue } from "../src/jobs/memeVenues.js";
import { matchFourMemeTemplate } from "../src/query/fourmemeTax.js";
import type { MemeBoardRow } from "../src/query/memeClassify.js";
loadDotEnv();

const store = new MemoryStore();
const cycles = Number(process.argv[2] ?? 4);
for (let i = 0; i < cycles; i += 1) {
  const t0 = performance.now();
  const result = await runMemeBoard(store, AbortSignal.timeout(60_000));
  console.log(`cycle ${i + 1}: ${Math.round(performance.now() - t0)} ms rows ${result.rows} failures ${JSON.stringify(result.failures)}`);
}

const rows = ((await store.get<MemeBoardRow[]>(MEME_BOARD_KEY))?.data ?? []) as MemeBoardRow[];
const venues = ((await store.get<Record<string, CachedVenue>>(MEME_VENUES_KEY))?.data ?? {}) as Record<string, CachedVenue>;
const tally: Record<string, number> = {};
for (const row of rows.filter((r) => r.launchpad === "fourmeme")) {
  const code = venues[row.address]?.fourmemeCode;
  const template = code === undefined ? "unread" : (matchFourMemeTemplate(code)?.id ?? `UNRECOGNISED ${code.code} type ${code.creatorType}`);
  const tax = row.tax === null ? "null" : `${row.tax.buyBps}/${row.tax.sellBps}`;
  const key = `${row.venue} ${template} tax ${tax}`;
  tally[key] = (tally[key] ?? 0) + 1;
}
for (const [key, count] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(String(count).padStart(4), key);
for (const address of process.argv.slice(3)) {
  const row = rows.find((r) => r.address === address.toLowerCase());
  console.log(address, row === undefined ? "not on board" : JSON.stringify({ venue: row.venue, tax: row.tax, pool: row.pool, venueCheckedAt: row.venueCheckedAt }));
}
