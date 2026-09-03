/**
 * Read-through, tiered token-security query layer.
 *
 * Two scanners, combined conservatively: OnchainOS token-scan is primary and
 * GMGN is secondary enrichment. The worse verdict wins and the flag sets are
 * unioned, so neither scanner can vouch for a token the other has flagged.
 *
 * The read path mirrors `query/klines.ts`: fresh from the store wins, a miss
 * fetches and writes back, and total failure falls back to a stale record rather
 * than nothing. Unlike klines, a total miss is still an answer — `unavailable`
 * is a legitimate verdict — so this function never returns `null` and never
 * throws for an upstream failure.
 *
 * TTLs are per lane because the underlying risk moves at different speeds: a
 * meme token can be rugged minutes after launch, while a tokenized equity's
 * contract is effectively static.
 */

import type { Lane } from "../core/models.js";
import { type TokenSecuritySummary, worstRiskLevel } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { Staleness } from "../core/types.js";
import { MissingCredentialsError, isEvmAddress } from "../adapters/http.js";
import { fetchOnchainosTokenScan } from "../adapters/onchainos.js";
import { fetchGmgnTokenSecurity } from "../adapters/gmgn.js";

/** How long a scan stays fresh, and when it stops being worth serving at all. */
export interface SecurityTtl {
  freshForMs: number;
  deadAfterMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const SECURITY_TTL: Record<Lane, SecurityTtl> = {
  meme: { freshForMs: 5 * MINUTE, deadAfterMs: 60 * MINUTE },
  coins: { freshForMs: 24 * HOUR, deadAfterMs: 7 * 24 * HOUR },
  bstocks: { freshForMs: 24 * HOUR, deadAfterMs: 7 * 24 * HOUR },
  // Required by the widened lane union (ALLOWLIST-PRICE-SPEC §2b item 5); a
  // frozen curated list changes as rarely as the other two curated lanes.
  allowlist: { freshForMs: 24 * HOUR, deadAfterMs: 7 * 24 * HOUR },
};

/** Store key for one token's merged scan. */
export function securityKey(address: string): string {
  return `security:${address.toLowerCase()}`;
}

/** What one scanner said, kept alongside the merged verdict for auditability. */
export interface SecuritySourceReport {
  source: string;
  riskLevel: TokenSecuritySummary["riskLevel"];
  flags: string[];
}

/** The stored payload: the merged verdict plus each scanner's own answer. */
export interface StoredSecurity {
  summary: TokenSecuritySummary;
  sources: SecuritySourceReport[];
}

export interface SecurityResult extends StoredSecurity {
  address: string;
  lane: Lane;
  /** Epoch milliseconds at which the served scan was captured. */
  asOf: number;
  staleness: Staleness;
}

export interface GetSecurityParams {
  address: string;
  lane: Lane;
  signal?: AbortSignal | undefined;
}

/**
 * Merges scanner verdicts. `unavailable` ranks below every real verdict, so a
 * silent scanner is ignored unless every scanner is silent.
 */
export function mergeSecurityReports(
  reports: SecuritySourceReport[],
  scannedAt: number,
): TokenSecuritySummary {
  if (reports.length === 0) {
    return { riskLevel: "unavailable", flags: [], scannedAt, source: "none" };
  }

  let riskLevel: TokenSecuritySummary["riskLevel"] = "unavailable";
  const flags = new Set<string>();
  for (const report of reports) {
    riskLevel = worstRiskLevel(riskLevel, report.riskLevel);
    // Flags from a scanner that could not answer would be empty anyway, but the
    // union is taken unconditionally so a partial answer is never discarded.
    for (const flag of report.flags) flags.add(flag);
  }

  return {
    riskLevel,
    flags: [...flags].sort(),
    scannedAt,
    source: reports.map((report) => report.source).join("+"),
  };
}

interface Scanner {
  name: string;
  scan: () => Promise<TokenSecuritySummary>;
}

/**
 * Serves the security verdict for one token.
 *
 * Never throws for an upstream problem: the worst case is an `unavailable`
 * verdict, which callers must handle anyway.
 */
export async function getSecurity(
  store: SnapshotStore,
  params: GetSecurityParams,
): Promise<SecurityResult> {
  const address = params.address.toLowerCase();
  const ttl = SECURITY_TTL[params.lane];
  const key = securityKey(address);
  const cached = isEvmAddress(address) ? await store.get<StoredSecurity>(key) : null;

  if (cached !== null && cached.staleness === "fresh" && isStoredSecurity(cached.data)) {
    return {
      address,
      lane: params.lane,
      summary: cached.data.summary,
      sources: cached.data.sources,
      asOf: cached.asOf,
      staleness: cached.staleness,
    };
  }

  if (!isEvmAddress(address)) {
    return unavailable(address, params.lane);
  }

  const scanners: Scanner[] = [
    {
      name: "onchainos",
      scan: () => fetchOnchainosTokenScan({ address, signal: params.signal }),
    },
    {
      name: "gmgn",
      scan: () => fetchGmgnTokenSecurity({ address, signal: params.signal }),
    },
  ];

  const reports: SecuritySourceReport[] = [];
  for (const scanner of scanners) {
    try {
      const summary = await scanner.scan();
      reports.push({ source: summary.source, riskLevel: summary.riskLevel, flags: summary.flags });
    } catch (error) {
      // An unconfigured scanner is not an outage; either way the tier moves on.
      if (!(error instanceof MissingCredentialsError)) {
        console.warn(`[security] scanner=${scanner.name} failed: ${describe(error)}`);
      }
    }
  }

  if (reports.length > 0) {
    const payload: StoredSecurity = {
      summary: mergeSecurityReports(reports, Date.now()),
      sources: reports,
    };
    await store.put(key, payload, {
      source: payload.summary.source,
      freshForMs: ttl.freshForMs,
      deadAfterMs: ttl.deadAfterMs,
    });
    const written = await store.get<StoredSecurity>(key);
    return {
      address,
      lane: params.lane,
      summary: payload.summary,
      sources: payload.sources,
      asOf: written?.asOf ?? payload.summary.scannedAt,
      staleness: written?.staleness ?? "fresh",
    };
  }

  // Every scanner is down. A stale verdict is still information about the token,
  // and `meta.staleness` tells the caller how much to trust it.
  if (cached !== null && isStoredSecurity(cached.data)) {
    return {
      address,
      lane: params.lane,
      summary: cached.data.summary,
      sources: cached.data.sources,
      asOf: cached.asOf,
      staleness: cached.staleness,
    };
  }

  return unavailable(address, params.lane);
}

function unavailable(address: string, lane: Lane): SecurityResult {
  const scannedAt = Date.now();
  return {
    address,
    lane,
    summary: { riskLevel: "unavailable", flags: [], scannedAt, source: "none" },
    sources: [],
    asOf: scannedAt,
    staleness: "dead",
  };
}

/**
 * Stored payloads are re-validated on read: the store outlives code versions, so
 * a shape written by an older build must not reach the API.
 */
function isStoredSecurity(value: unknown): value is StoredSecurity {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const summary = record["summary"];
  if (typeof summary !== "object" || summary === null) return false;
  return Array.isArray((summary as Record<string, unknown>)["flags"]) && Array.isArray(record["sources"]);
}

function describe(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "unknown error";
}
