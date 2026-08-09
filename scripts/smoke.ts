/**
 * Live smoke test for the Phase 1 adapters.
 *
 * Diagnostic only: it talks to the real upstreams one at a time, times each
 * call, skips keyed sources whose credentials are absent, and always exits 0 —
 * a red row is information, not a build failure. No environment value is ever
 * printed.
 */

import { loadDotEnv } from "../src/config/env.js";
import { MemoryStore } from "../src/core/store.js";
import { fetchFourMemeRanking } from "../src/adapters/fourmeme.js";
import {
  fetchBinanceAlphaUniverse,
  fetchBinanceTokenMeta,
  fetchBinanceTokenQuote,
  fetchSintralKlines,
} from "../src/adapters/binanceWeb3.js";
import {
  fetchOnchainosKlines,
  fetchOnchainosPrice,
  hasOnchainosCredentials,
} from "../src/adapters/onchainos.js";
import { fetchBirdeyeKlines, hasBirdeyeApiKey } from "../src/adapters/birdeye.js";
import { getKlines } from "../src/query/klines.js";
import { bstockAddresses } from "../src/universe.js";

loadDotEnv();

type Status = "OK" | "FAIL" | "SKIP";

interface Row {
  check: string;
  status: Status;
  ms: number;
  detail: string;
}

const rows: Row[] = [];

/** A well-known BSC token used for the per-token probes. */
const PROBE_ADDRESS = bstockAddresses()[0] ?? "0x0000000000000000000000000000000000000000";

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    rows.push({ check: name, status: "OK", ms: Date.now() - startedAt, detail });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    rows.push({ check: name, status: "FAIL", ms: Date.now() - startedAt, detail });
  }
}

function skip(name: string, reason: string): void {
  rows.push({ check: name, status: "SKIP", ms: 0, detail: reason });
}

await check("fourmeme ranking NEW", async () => {
  const result = await fetchFourMemeRanking({ type: "NEW", pageSize: 20 });
  return `${result.entries.length} entries, ${result.snapshots.length} snapshots`;
});

await check("fourmeme ranking HOT", async () => {
  const result = await fetchFourMemeRanking({ type: "HOT", pageSize: 20 });
  return `${result.entries.length} entries`;
});

await check("binance alpha universe", async () => {
  const entries = await fetchBinanceAlphaUniverse();
  return `${entries.length} bsc entries`;
});

await check("binance dynamic quote", async () => {
  const snapshot = await fetchBinanceTokenQuote({ address: PROBE_ADDRESS });
  return `price=${snapshot.priceUsd === null ? "null" : snapshot.priceUsd.toPrecision(6)}`;
});

await check("binance token meta", async () => {
  const meta = await fetchBinanceTokenMeta({ address: PROBE_ADDRESS });
  return `symbol=${meta.symbol ?? "null"}`;
});

await check("sintral klines 15min", async () => {
  const candles = await fetchSintralKlines({
    address: PROBE_ADDRESS,
    interval: "15min",
    limit: 20,
  });
  return `${candles.length} candles`;
});

if (hasOnchainosCredentials()) {
  await check("onchainos klines 15m", async () => {
    const candles = await fetchOnchainosKlines({ address: PROBE_ADDRESS, bar: "15m", limit: 20 });
    return `${candles.length} candles`;
  });
  await check("onchainos price-info", async () => {
    const snapshot = await fetchOnchainosPrice({ address: PROBE_ADDRESS });
    return `price=${snapshot.priceUsd === null ? "null" : snapshot.priceUsd.toPrecision(6)}`;
  });
} else {
  skip("onchainos klines 15m", "OKX_* not configured");
  skip("onchainos price-info", "OKX_* not configured");
}

if (hasBirdeyeApiKey()) {
  await check("birdeye ohlcv 15m", async () => {
    const to = Math.floor(Date.now() / 1000);
    const candles = await fetchBirdeyeKlines({
      address: PROBE_ADDRESS,
      type: "15m",
      from: to - 900 * 21,
      to,
    });
    return `${candles.length} candles`;
  });
} else {
  skip("birdeye ohlcv 15m", "BIRDEYE_API_KEY not configured");
}

await check("kline read-through chain", async () => {
  const store = new MemoryStore();
  try {
    const result = await getKlines(store, { address: PROBE_ADDRESS, interval: "15m", limit: 20 });
    if (result === null) throw new Error("every source failed");
    return `source=${result.source}, ${result.candles.length} candles`;
  } finally {
    await store.close();
  }
});

printTable(rows);

const failures = rows.filter((row) => row.status === "FAIL").length;
console.log(
  `\n${rows.length} checks: ${rows.length - failures - rows.filter((r) => r.status === "SKIP").length} ok, ` +
    `${failures} failed, ${rows.filter((r) => r.status === "SKIP").length} skipped`,
);

function printTable(table: Row[]): void {
  const headers = ["CHECK", "STATUS", "MS", "DETAIL"];
  const cells = table.map((row) => [row.check, row.status, String(row.ms), truncate(row.detail, 60)]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...cells.map((row) => (row[index] ?? "").length)),
  );

  const line = (values: string[]): string =>
    values.map((value, index) => value.padEnd(widths[index] ?? 0)).join("  ");

  console.log(line(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of cells) console.log(line(row));
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
