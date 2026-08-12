/**
 * Read-through social-links query layer.
 *
 * "Social" here is presence, not signal: the links a token's creator declared
 * on the launchpad (website / X / Telegram). Real social *signal* — mentions,
 * trend — has no keyless source and is out of scope by decision (2026-08-12).
 *
 * One upstream: Four.Meme's keyless detail endpoint (measured: the path says
 * `private` but answers a plain GET, and a token it does not know comes back
 * `code 0` with no `data` — a definite negative, not an error). A negative is
 * cached like a positive so unknown addresses do not turn into upstream load.
 * Fail-open: on upstream failure a stale record is served rather than nothing.
 */

import type { SnapshotStore } from "../core/store.js";
import type { Staleness } from "../core/types.js";
import { isEvmAddress } from "../adapters/http.js";
import { fetchFourMemeSocials, type TokenSocials } from "../adapters/fourmeme.js";

const SOURCE = "socials";

/**
 * Links change roughly never after launch, so the freshness window is wide;
 * 6h rather than wider only so a token that launches *after* being asked about
 * (and cached as link-less) picks its links up the same day.
 */
export const SOCIALS_FRESH_FOR_MS = 6 * 60 * 60_000;
export const SOCIALS_DEAD_AFTER_MS = 7 * 24 * 60 * 60_000;

/** Store key for one token's social links. */
export function socialsKey(address: string): string {
  return `socials:${address.toLowerCase()}`;
}

export interface SocialsResult {
  address: string;
  socials: TokenSocials;
  asOf: number;
  staleness: Staleness;
}

export interface GetSocialsParams {
  address: string;
  signal?: AbortSignal | undefined;
  /** Injectable upstream, so the fail-open paths are testable offline. */
  fetchSocials?:
    | ((address: string, signal: AbortSignal | undefined) => Promise<TokenSocials | null>)
    | undefined;
}

/** All-null links: what an unknown or link-less token answers. */
function emptySocials(address: string): TokenSocials {
  return { address, website: null, twitter: null, telegram: null, description: null };
}

/**
 * Serves social links for one token. Returns `null` only for a malformed
 * address, or when nothing is cached and the upstream could not be read.
 */
export async function getSocials(
  store: SnapshotStore,
  params: GetSocialsParams,
): Promise<SocialsResult | null> {
  const address = params.address.toLowerCase();
  if (!isEvmAddress(address)) return null;

  const key = socialsKey(address);
  const cached = await store.get<TokenSocials>(key);
  if (cached !== null && cached.staleness === "fresh") {
    return { address, socials: cached.data, asOf: cached.asOf, staleness: cached.staleness };
  }

  const fetch = params.fetchSocials ?? ((addr, signal) => fetchFourMemeSocials({ address: addr, signal }));

  let socials: TokenSocials | null;
  try {
    // `null` from the adapter means "Four.Meme does not know this token" — a
    // definite answer, stored as all-null links so it is not re-asked per hit.
    socials = (await fetch(address, params.signal)) ?? emptySocials(address);
  } catch (error) {
    console.warn(`[${SOURCE}] read failed for ${address}: ${describe(error)}`);
    socials = null;
  }

  if (socials !== null) {
    await store.put(key, socials, {
      source: "fourmeme",
      freshForMs: SOCIALS_FRESH_FOR_MS,
      deadAfterMs: SOCIALS_DEAD_AFTER_MS,
    });
    const written = await store.get<TokenSocials>(key);
    return {
      address,
      socials,
      asOf: written?.asOf ?? Date.now(),
      staleness: written?.staleness ?? "fresh",
    };
  }

  if (cached === null) return null;
  return { address, socials: cached.data, asOf: cached.asOf, staleness: cached.staleness };
}

function describe(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "unknown error";
}
