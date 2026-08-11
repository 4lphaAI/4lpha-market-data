/**
 * Live smoke test for the market-data adapters.
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
  fetchOnchainosTokenScan,
  hasOnchainosCredentials,
} from "../src/adapters/onchainos.js";
import {
  fetchGmgnSmartMoney,
  fetchGmgnTokenHolders,
  fetchGmgnTokenSecurity,
  hasGmgnCredentials,
} from "../src/adapters/gmgn.js";
import {
  fetchPancakePoolOnchain,
  fetchPancakePoolStats,
  seedPools,
} from "../src/adapters/pancake.js";
import { fetchVenusHealth } from "../src/adapters/venus.js";
import { withBscClient } from "../src/chain/rpc.js";
import { getKlines } from "../src/query/klines.js";
import { getSecurity } from "../src/query/security.js";
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

/** Spacing between probes of a rate-limited upstream. GMGN allows roughly 1/s. */
const PACE_MS = 2_500;

function pace(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, PACE_MS);
  });
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

if (hasOnchainosCredentials()) {
  await check("onchainos token-scan", async () => {
    const summary = await fetchOnchainosTokenScan({ address: PROBE_ADDRESS });
    return `risk=${summary.riskLevel}, flags=[${summary.flags.join(",")}]`;
  });
} else {
  skip("onchainos token-scan", "OKX_* not configured");
}

// Ahead of the raw GMGN probes: a 429 from any GMGN endpoint puts the whole
// adapter into cooldown, which would otherwise make this row look like a tiering
// bug rather than the rate limit it is.
await check("security read-through tier", async () => {
  const store = new MemoryStore();
  try {
    const result = await getSecurity(store, { address: PROBE_ADDRESS, lane: "bstocks" });
    const sources = result.sources.map((source) => source.source).join("+") || "none";
    return `risk=${result.summary.riskLevel}, sources=${sources}`;
  } finally {
    await store.close();
  }
});

if (hasGmgnCredentials()) {
  // GMGN's rate limit is tight enough that a handful of back-to-back calls trips
  // it, and repeated violations earn a temporary IP ban, so the probes are paced.
  // In the product these reads are on-demand and cached hard behind the store,
  // which is why GMGN has no polling job.
  await pace();
  await check("gmgn security", async () => {
    const summary = await fetchGmgnTokenSecurity({ address: PROBE_ADDRESS });
    return `risk=${summary.riskLevel}, flags=[${summary.flags.join(",")}]`;
  });
  await pace();
  await check("gmgn holders", async () => {
    const stats = await fetchGmgnTokenHolders({ address: PROBE_ADDRESS });
    return `holders=${stats.holders ?? "null"}, top10=${stats.top10Pct ?? "null"}%`;
  });
  await pace();
  await check("gmgn smart money", async () => {
    const stats = await fetchGmgnSmartMoney({ address: PROBE_ADDRESS });
    return `smartMoney=${stats.smartMoneyCount ?? "null"}`;
  });
} else {
  skip("gmgn security", "GMGN_API_KEY not configured");
  skip("gmgn holders", "GMGN_API_KEY not configured");
  skip("gmgn smart money", "GMGN_API_KEY not configured");
}

const PROBE_POOL = seedPools()[0] ?? "";

await check("pancake pool (explorer)", async () => {
  const stats = await fetchPancakePoolStats({ address: PROBE_POOL });
  return (
    `${stats.token0Symbol ?? "?"}/${stats.token1Symbol ?? "?"} fee=${stats.fee}, ` +
    `tvl=${stats.tvlUsd === null ? "null" : Math.round(stats.tvlUsd)}, apr=${stats.aprPct ?? "null"}%`
  );
});

await check("pancake pool (on-chain)", async () => {
  const stats = await fetchPancakePoolOnchain({ address: PROBE_POOL });
  return `${stats.token0Symbol ?? "?"}/${stats.token1Symbol ?? "?"} fee=${stats.fee}, tick=${stats.tick}`;
});

/**
 * Venus needs a real borrower, and there is no public "list borrowers" call, so
 * candidates are discovered from recent `Borrow` events on vUSDT.
 *
 * Topics are filtered client-side: several public BSC endpoints silently ignore
 * the `topics` argument to `eth_getLogs` and return the whole address's log set,
 * which would otherwise be mistaken for a wall of borrows.
 */
const VUSDT = "0xfD5840Cd36d94D7229439859C0112a4185BC0255";
const BORROW_TOPIC = "0x13ed6866d4e1ee6da46f845c46d7e54120883d75c5ea9a2dacc1c4ca8984ab80";
const SCAN_CHUNK = 2_000n;
// Borrows are sparse — roughly one per chunk — and public endpoints stop serving
// logs a few thousand blocks back, so the scan goes as deep as it is allowed to.
const SCAN_CHUNKS = 10;
const MAX_CANDIDATES = 6;

const candidates = await findVenusBorrowers();

if (candidates.length === 0) {
  skip("venus health", "no Borrow event in the scanned window");
} else {
  await check("venus health", async () => {
    // Emitting a Borrow event does not mean the position is still open — many
    // are repaid within minutes — so candidates are walked until one has a live
    // borrow, which is the only case that actually exercises the ratio.
    let last = await fetchVenusHealth({ owner: candidates[0] ?? "" });
    for (const owner of candidates) {
      last = await fetchVenusHealth({ owner });
      if (last.borrowValueUsd > 0) break;
    }
    return (
      `hf=${last.healthFactor === null ? "null" : last.healthFactor.toFixed(3)}, ` +
      `${last.tier}, collateral=$${Math.round(last.collateralValueUsd)}, ` +
      `borrow=$${Math.round(last.borrowValueUsd)}, ${last.assets.length} assets`
    );
  });
}

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

/**
 * Walks recent blocks backwards for vUSDT `Borrow` events and returns candidate
 * borrowers, largest reported balance first.
 *
 * An empty list is a quiet window, not a broken adapter, so the caller skips
 * rather than fails.
 */
async function findVenusBorrowers(): Promise<string[]> {
  try {
    return await withBscClient(async (client) => {
      const latest = await client.getBlockNumber();
      const seen = new Map<string, bigint>();
      let scanned = 0;

      for (let chunk = 0; chunk < SCAN_CHUNKS; chunk += 1) {
        const toBlock = latest - BigInt(chunk) * SCAN_CHUNK;
        let logs: Awaited<ReturnType<typeof client.getLogs>>;
        try {
          logs = await client.getLogs({
            address: VUSDT,
            fromBlock: toBlock - (SCAN_CHUNK - 1n),
            toBlock,
          });
        } catch (error) {
          // Failing on the very first chunk means this endpoint cannot serve
          // logs at all — several BSC endpoints cannot — so it is rethrown to
          // let `withBscClient` rotate. A later chunk failing is just the
          // archive cut-off, and whatever was already found is still usable.
          if (scanned === 0) throw error;
          break;
        }
        scanned += 1;

        for (const log of logs) {
          if (log.topics[0] !== BORROW_TOPIC) continue;
          // The event is fully non-indexed, so `data` is four packed 32-byte
          // words: borrower, borrowAmount, accountBorrows, totalBorrows.
          const owner = `0x${log.data.slice(26, 66)}`;
          const accountBorrows = BigInt(`0x${log.data.slice(130, 194)}`);
          const previous = seen.get(owner);
          if (previous === undefined || accountBorrows > previous) seen.set(owner, accountBorrows);
        }
        if (seen.size >= MAX_CANDIDATES) break;
      }

      return [...seen.entries()]
        .sort(([, a], [, b]) => (a === b ? 0 : a > b ? -1 : 1))
        .slice(0, MAX_CANDIDATES)
        .map(([owner]) => owner);
    });
  } catch {
    return [];
  }
}
