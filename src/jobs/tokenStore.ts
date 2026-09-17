/**
 * Shared write path for per-token snapshots.
 *
 * Every producer merges rather than replaces, so a source that only knows the
 * price cannot blank out the holder count a richer source already wrote.
 */

import { emptyTokenSnapshot, mergeTokenSnapshot, type RwaToken, type TokenSnapshot } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { DataRecord } from "../core/types.js";
import { normalizeAddress } from "../adapters/http.js";
import { RWA_UNIVERSE_KEY } from "../universe.js";

export const TOKEN_FRESH_FOR_MS = 60_000;
export const TOKEN_DEAD_AFTER_MS = 15 * 60_000;

/** Store key for one token's merged snapshot. */
export function tokenKey(address: string): string {
  return `token:${address.toLowerCase()}`;
}

/** Reads the stored snapshot for a token, or `null` when there is none. */
export async function readTokenSnapshot(
  store: SnapshotStore,
  address: string,
): Promise<TokenSnapshot | null> {
  const record = await store.get<TokenSnapshot>(tokenKey(address));
  return record === null ? null : record.data;
}

/**
 * Merges `incoming` over whatever is stored and writes the result back,
 * returning the merged snapshot.
 */
export async function mergeTokenIntoStore(
  store: SnapshotStore,
  source: string,
  incoming: TokenSnapshot,
): Promise<TokenSnapshot> {
  const address = incoming.address.toLowerCase();
  const existing = (await readTokenSnapshot(store, address)) ?? emptyTokenSnapshot(address);
  const merged = mergeTokenSnapshot(existing, incoming);
  await store.put(tokenKey(address), merged, {
    source,
    freshForMs: TOKEN_FRESH_FOR_MS,
    deadAfterMs: TOKEN_DEAD_AFTER_MS,
  });
  return merged;
}

/**
 * Reads token records for the `/tokens` surfaces, synthesising a row from the
 * RWA snapshot for any address that has no stored snapshot yet but is a
 * tokenized stock. The `binance-rwa` job writes the real record within a
 * minute of the snapshot, so this covers only that window and a restart — but
 * the execution plane aborts a whole cycle on a missing row, so the window
 * has to be closed. Nothing is written back. Staleness follows the snapshot.
 */
export async function readTokenRecords(
  store: SnapshotStore,
  addresses: string[],
): Promise<Map<string, DataRecord<TokenSnapshot>>> {
  const out = new Map<string, DataRecord<TokenSnapshot>>();
  const missing: string[] = [];
  // One fan-out, as the route always did; the batch is capped at 50 upstream.
  const records = await Promise.all(addresses.map((address) => store.get<TokenSnapshot>(tokenKey(address))));
  addresses.forEach((address, i) => {
    const record = records[i] ?? null;
    if (record === null) missing.push(address);
    else out.set(address, record);
  });
  if (missing.length === 0) return out;

  const rwa = await store.get<unknown>(RWA_UNIVERSE_KEY);
  if (rwa === null || typeof rwa.data !== "object" || rwa.data === null) return out;
  const rows = (rwa.data as Record<string, unknown>)["rows"];
  if (!Array.isArray(rows)) return out;
  const byAddress = new Map<string, RwaToken>();
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) continue;
    const address = normalizeAddress((raw as Record<string, unknown>)["address"]);
    if (address !== null) byAddress.set(address, raw as RwaToken);
  }
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  for (const address of missing) {
    const row = byAddress.get(address);
    if (row === undefined) continue;
    const data: TokenSnapshot = {
      address,
      priceUsd: num(row.tokenPriceUsd),
      marketCapUsd: num(row.underlyingMarketCapUsd),
      // On-chain volume comes from the venues sweep via the job's merge; a
      // synthesised row has none and never reports the underlying's.
      volume24hUsd: null,
      holders: null,
      priceChange24hPct: null,
      ...(typeof row.symbol === "string" ? { symbol: row.symbol } : {}),
      updatedFields: [],
    };
    out.set(address, { data, asOf: rwa.asOf, source: rwa.source, staleness: rwa.staleness });
  }
  return out;
}
