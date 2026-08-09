/**
 * Shared write path for per-token snapshots.
 *
 * Every producer merges rather than replaces, so a source that only knows the
 * price cannot blank out the holder count a richer source already wrote.
 */

import { emptyTokenSnapshot, mergeTokenSnapshot, type TokenSnapshot } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";

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
