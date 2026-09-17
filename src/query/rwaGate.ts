/**
 * The tokenized-stock half of the eligibility gate — rule 5.
 *
 * A stock is a different kind of token from everything else the gate admits:
 * its issuer can halt it, and the Ondo ones trade only in the sessions the
 * issuer supports for that asset (measured 2026-09-17: 177 of 442 Ondo tokens
 * answer `openState:false, reasonCode:UNSUPPORTED` overnight; bStocks are 24/7
 * with `marketStatus:null`). So membership in an RWA list is first a **veto**
 * — a stock that is not visibly open and trading right now is not eligible,
 * whatever the allowlist, the Alpha list or a cached verdict say — and only
 * then a positive rule for the stocks no other list carries.
 *
 * Membership outlives the snapshot on purpose. `rwa:members` (written by the
 * `binance-rwa` job, merged, never shrunk) plus the static bStocks list say
 * "this address is a stock" even when `universe:rwa` is absent; with the
 * snapshot not fresh every member answers `rwa_stale`. The alternative — a
 * stock silently regaining allowlist eligibility the moment Binance goes
 * quiet — is the wrong `true` the whole gate exists to prevent.
 *
 * Read entirely from the store, never from Binance, and never cached as a
 * verdict: the snapshot is replaced every minute and the answer must follow it.
 */

import type { RwaToken } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { Staleness } from "../core/types.js";
import { normalizeAddress, sanitizeMessage } from "../adapters/http.js";
import { RWA_MEMBERS_KEY, RWA_UNIVERSE_KEY, bstockAddresses } from "../universe.js";

const SOURCE = "eligibility";

/** Why a member is refused, or that it passed. */
export type RwaVeto = "rwa_stale" | "rwa_halted" | "rwa_unsupported" | null;

/**
 * The issuers the lanes serve. A row on any other platform — a third issuer
 * Binance adds, or a row that lost its `platformId` in a shape change — has no
 * lane row, no venues and no handoff decision behind it, so it cannot pass.
 */
const SERVED_PLATFORMS = new Set(["bstock", "ondo"]);

/**
 * Everything rule 5 needs, loaded once per call or once per batch. Fifty
 * addresses in one batch must not read a 488-row snapshot fifty times.
 */
export interface RwaGateContext {
  /** Fresh snapshot rows by address; `null` when the snapshot is absent, unreadable or not fresh. */
  rows: Map<string, RwaToken> | null;
  /** Staleness of the snapshot record, for diagnostics; `null` when absent. */
  snapshotStaleness: Staleness | null;
  /** Static bStocks ∪ `rwa:members` ∪ current snapshot rows. */
  members: Set<string>;
}

/**
 * Loads the context. Never throws: a store failure degrades to "snapshot not
 * fresh" (every member is then vetoed) and to the static membership only,
 * both of which are the fail-closed direction for the tokens they cover.
 */
export async function loadRwaGateContext(store: SnapshotStore): Promise<RwaGateContext> {
  const members = new Set<string>(bstockAddresses());
  let rows: Map<string, RwaToken> | null = null;
  let snapshotStaleness: Staleness | null = null;

  try {
    const record = await store.get<unknown>(RWA_UNIVERSE_KEY);
    if (record !== null) {
      snapshotStaleness = record.staleness;
      const parsed = parseRows(record.data);
      for (const address of parsed.keys()) members.add(address);
      if (record.staleness === "fresh") rows = parsed;
    }
  } catch (error) {
    console.warn(`[${SOURCE}] rwa snapshot read failed: ${sanitizeMessage(error)}`);
  }

  try {
    const record = await store.get<unknown>(RWA_MEMBERS_KEY);
    if (record !== null && typeof record.data === "object" && record.data !== null) {
      for (const raw of Object.keys(record.data as Record<string, unknown>)) {
        const address = normalizeAddress(raw);
        if (address !== null) members.add(address);
      }
    }
  } catch (error) {
    console.warn(`[${SOURCE}] rwa members read failed: ${sanitizeMessage(error)}`);
  }

  return { rows, snapshotStaleness, members };
}

/**
 * Only the fields the gate decides on are validated; the stored shape is
 * re-checked on every read because the store outlives code versions.
 */
function parseRows(data: unknown): Map<string, RwaToken> {
  const out = new Map<string, RwaToken>();
  if (typeof data !== "object" || data === null) return out;
  const rows = (data as Record<string, unknown>)["rows"];
  if (!Array.isArray(rows)) return out;
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const address = normalizeAddress(row["address"]);
    if (address === null) continue;
    out.set(address, {
      ...(row as unknown as RwaToken),
      address,
      platform: typeof row["platform"] === "string" ? row["platform"] : "unknown",
      openState: typeof row["openState"] === "boolean" ? row["openState"] : null,
      reasonCode: typeof row["reasonCode"] === "string" ? row["reasonCode"] : null,
    });
  }
  return out;
}

/** True when the address is a tokenized stock the gate knows about. */
export function isRwaMember(context: RwaGateContext, address: string): boolean {
  return context.members.has(address);
}

/**
 * The veto for one member. Exported so the decision table is testable offline.
 *
 *   snapshot not fresh / unreadable        → rwa_stale
 *   member missing from the fresh snapshot → rwa_stale   (delisted since last seen)
 *   platform not bstock / ondo             → rwa_unsupported (no lane serves it)
 *   reasonCode UNSUPPORTED                 → rwa_unsupported (not offered in this session)
 *   openState !== true or reasonCode !== TRADING → rwa_halted (ASSET_PAUSED, unknown codes, nulls)
 *   otherwise                              → null (passes)
 *
 * `ASSET_PAUSED` folds into `rwa_halted`: the contract names three reasons and
 * the execution plane's parser accepts exactly those.
 */
export function decideRwaVeto(context: RwaGateContext, address: string): RwaVeto {
  if (context.rows === null) return "rwa_stale";
  const row = context.rows.get(address);
  if (row === undefined) return "rwa_stale";
  if (!SERVED_PLATFORMS.has(row.platform)) return "rwa_unsupported";
  if (row.reasonCode === "UNSUPPORTED") return "rwa_unsupported";
  if (row.openState !== true || row.reasonCode !== "TRADING") return "rwa_halted";
  return null;
}
