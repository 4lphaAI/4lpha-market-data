/**
 * Regenerates `data/bstock-sectors.json` — the fixed sector labels on bStocks.
 *
 *   node --import tsx scripts/gen-bstock-sectors.ts
 *
 * The labels are a frozen file, not a job, by decision (2026-09-26): the
 * sector tabs are curated baskets that do not move day to day, so polling them
 * would spend the shared 5 rps key on answers that never change. Rerun this
 * when the allowlist changes or Binance reshuffles a basket. Only `trending`
 * moves, and the `bstock-trending` job owns it.
 *
 * A tab answers one row per *ticker* — the Ondo token when both issuers list
 * it (tab 21 is MSFTon, AAPLon, ... and `platformId=bstock` on top returns 0)
 * — so tabs are read as tickers and mapped onto bStocks by `underlyingTicker`.
 *
 * One signed call per tab plus one for the bStock list, spaced well under the
 * key's 5 rps.
 */

import { writeFileSync } from "node:fs";
import { loadDotEnv } from "../src/config/env.js";
import { SECTOR_TABS, MAX_SECTOR_ROWS } from "../src/query/bstockSectors.js";

loadDotEnv();
const { fetchRwaTokens } = await import("../src/adapters/binanceRwa.js");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const { tokens: allBstocks } = await fetchRwaTokens();
if (allBstocks.length === 0) throw new Error("bStock list came back empty");
const bstocksByTicker = new Map<string, typeof allBstocks>();
for (const token of allBstocks) {
  if (token.platform !== "bstock" || token.underlyingTicker === null) continue;
  const key = token.underlyingTicker.toUpperCase();
  bstocksByTicker.set(key, [...(bstocksByTicker.get(key) ?? []), token]);
}

const byAddress: Record<string, { symbol: string; sectors: string[] }> = {};
const counts: Record<string, number> = {};

for (const [sector, tab] of Object.entries(SECTOR_TABS)) {
  await sleep(400);
  const { tokens } = await fetchRwaTokens({ tabId: tab.tabId });
  // An unknown tab id answers with the whole list; refusing here keeps one
  // renumbered tab from labelling every stock.
  if (tokens.length === 0 || tokens.length > MAX_SECTOR_ROWS) {
    throw new Error(`tab ${tab.tabId} (${sector}) returned ${tokens.length} rows — id no longer a sector tab?`);
  }
  const tickers = new Set(tokens.flatMap((t) => (t.underlyingTicker === null ? [] : [t.underlyingTicker.toUpperCase()])));
  const bstocks = [...tickers].flatMap((ticker) => bstocksByTicker.get(ticker) ?? []);
  counts[sector] = bstocks.length;
  for (const token of bstocks) {
    const row = (byAddress[token.address] ??= { symbol: token.symbol, sectors: [] });
    row.sectors.push(sector);
  }
  console.log(`${sector.padEnd(14)} tab ${tab.tabId}: ${bstocks.length} bStocks — ${bstocks.map((t) => t.symbol).join(", ")}`);
}

const sorted = Object.fromEntries(Object.entries(byAddress).sort(([, a], [, b]) => a.symbol.localeCompare(b.symbol)));
const file = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: "binance-web3 /api/v1/dex/market/rwa/tokens?tabId=",
    note:
      "Labels are ours: the API filters by tabId but returns no tab names, so each name was inferred from the tickers in the tab. bStocks only. Regenerate with scripts/gen-bstock-sectors.ts.",
    tabs: SECTOR_TABS,
    counts,
  },
  byAddress: sorted,
};
writeFileSync(new URL("../data/bstock-sectors.json", import.meta.url), JSON.stringify(file, null, 2) + "\n");
console.log(`wrote ${Object.keys(sorted).length} bStocks`);
