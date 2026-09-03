/**
 * The frozen `data/eligible-tokens.json` allowlist, loaded and indexed once.
 *
 * Extracted from `query/eligibility.ts` so the price-tracking job and the
 * universe lane read the snapshot through the same parser as the gate
 * (ALLOWLIST-PRICE-SPEC §2 item 1). Behaviour is unchanged: same file, same
 * validation, same memoization, same log line.
 */

import { readFileSync } from "node:fs";
import { isEvmAddress, sanitizeMessage } from "./adapters/http.js";

const SOURCE = "eligibility";

/** How the snapshot spells native BNB, which has no contract address. */
const NATIVE_SENTINEL = "native";

/** One entry of the frozen snapshot, narrowed to what the gate needs. */
export interface AllowlistEntry {
  address: string;
  symbol: string;
  /**
   * First element of the entry's `sources` array — `bstocks`, `cmc-top200-bsc`
   * or `static` — carried so the allowlist universe lane can report where a row
   * came from (ALLOWLIST-PRICE-SPEC §2b item 5).
   */
  source: string;
}

/** Reported for an entry whose `sources` array is missing or unusable. */
const UNKNOWN_SOURCE = "allowlist";

let allowlistCache: ReadonlyMap<string, AllowlistEntry> | null = null;
let allowlistError: string | null = null;

/**
 * Loads and indexes `data/eligible-tokens.json`, once per process.
 *
 * Returns null rather than throwing when the file is missing or malformed, so
 * the caller denies instead of 500-ing — but the failure is logged at load, not
 * per request, because a missing allowlist is an operator problem that would
 * otherwise scroll past in a flood of denials.
 *
 * Resolved relative to this module so it works identically from `src/` under
 * tsx and from `dist/` after a build: both are one directory below the root.
 */
export function loadAllowlist(): ReadonlyMap<string, AllowlistEntry> | null {
  if (allowlistCache !== null) return allowlistCache;
  if (allowlistError !== null) return null;

  try {
    const url = new URL("../data/eligible-tokens.json", import.meta.url);
    const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
    const tokens = (parsed as { tokens?: unknown })?.tokens;
    if (!Array.isArray(tokens)) throw new Error("snapshot has no tokens array");

    const index = new Map<string, AllowlistEntry>();
    for (const entry of tokens) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const address = typeof record["address"] === "string" ? record["address"].toLowerCase() : null;
      // The snapshot carries BNB as the sentinel `"native"` rather than an
      // address. Dropped on purpose, so the index is 221 of the snapshot's 222:
      // native BNB is the quote currency, never a token this gate is asked
      // about. Callers trading it pass WBNB, which is listed on its own.
      if (address === NATIVE_SENTINEL) continue;
      if (address === null || !isEvmAddress(address)) continue;
      const sources = record["sources"];
      const source =
        Array.isArray(sources) && typeof sources[0] === "string" && sources[0] !== ""
          ? sources[0]
          : UNKNOWN_SOURCE;
      index.set(address, {
        address,
        symbol: typeof record["symbol"] === "string" ? record["symbol"] : "",
        source,
      });
    }
    if (index.size === 0) throw new Error("snapshot has no usable entries");

    allowlistCache = index;
    return allowlistCache;
  } catch (error) {
    allowlistError = sanitizeMessage(error);
    console.error(`[${SOURCE}] allowlist load failed, denying every token: ${allowlistError}`);
    return null;
  }
}

/** Test seam: drops the memoized allowlist so the next load re-reads the file. */
export function resetAllowlistCache(): void {
  allowlistCache = null;
  allowlistError = null;
}
