/**
 * Read-through ERC-20 `decimals()` for one token.
 *
 * Decimals are the one token fact no market-data upstream carries and no
 * consumer can do without: a Uniswap-V3 tick is only a human price once both
 * legs' decimals are known, and a raw amount is only a size once one leg's are.
 * Consumers are not allowed their own RPC — this plane is the single source of
 * chain truth — so the answer has to come from here.
 *
 * The number is read from the contract and then cached, in the same shape and
 * for the same reason as the launchpad origins in {@link ../query/poolTier.js}:
 * an ERC-20's `decimals()` is fixed at deployment, so the answer is permanent
 * and one read per token buys it for the life of the deployment. The window is
 * finite only so a value written by a buggy build eventually ages out rather
 * than outliving the bug forever.
 *
 * Three outcomes, kept apart because they are three different facts:
 *
 * - **answered** — the contract returned a usable `uint8`. Cached for a month.
 * - **absent** — the call reverted, or the address holds no code answering it.
 *   A definite fact about the contract, but cached for a day rather than a
 *   month: a proxy can be upgraded into implementing the function, and
 *   re-asking a handful of such tokens daily is cheap.
 * - **unavailable** — no endpoint answered. Nothing is learned, so nothing is
 *   written; caching an outage into a 30-day window would make one bad minute
 *   a permanent property of the token.
 *
 * Never throws. A caller that cannot read decimals still has a price, and a
 * failed decimals read must not cost it that.
 */

import type { SnapshotStore } from "../core/store.js";
import { isEvmAddress, sanitizeMessage } from "../adapters/http.js";
// One definition of the ERC-20 metadata surface, not a second copy of it: this
// is the same ABI the Venus reader resolves underlying decimals with.
import { ERC20_METADATA_ABI } from "../adapters/venusAbis.js";
import { type BscClient, isContractLevelFailure, withBscClient } from "../chain/rpc.js";

const SOURCE = "decimals";

/** Store `source` recorded for every answer this module writes. */
const CHAIN_SOURCE = "bsc-rpc";

/** Immutable per token, so the window is wide. See the module note. */
export const DECIMALS_FRESH_FOR_MS = 30 * 24 * 60 * 60_000;
export const DECIMALS_DEAD_AFTER_MS = 365 * 24 * 60 * 60_000;

/** A definite "no usable `decimals()`" is re-asked daily; a proxy can gain one. */
export const ABSENT_DECIMALS_FRESH_FOR_MS = 24 * 60 * 60_000;
export const ABSENT_DECIMALS_DEAD_AFTER_MS = 7 * 24 * 60 * 60_000;

/**
 * Whole-rotation deadline for a cold read.
 *
 * {@link withBscClient} bounds each endpoint at the adapter timeout and then
 * tries the next, which is right for a worker and far too long for a request:
 * six endpoints could hold `/tokens/:address` open for over a minute. This
 * caps the rotation instead, and a request that runs out simply reports
 * `decimals: null` and re-asks on the next hit.
 */
export const DECIMALS_READ_TIMEOUT_MS = 5_000;

/**
 * Widest decimals worth accepting. `decimals()` returns a `uint8`, so 255 is
 * representable, but nothing above the mid-thirties is a real token — the same
 * bound the Pancake pool-token parser applies.
 */
const MAX_DECIMALS = 36;

/** Store key for one token's decimals. */
export function decimalsKey(address: string): string {
  return `decimals:${address.toLowerCase()}`;
}

/** Cached payload. `decimals: null` is the definite "contract has none". */
export interface TokenDecimals {
  address: string;
  decimals: number | null;
}

/** What one chain read established, if anything. */
export type DecimalsOutcome =
  | { kind: "answered"; decimals: number }
  | { kind: "absent" }
  | { kind: "unavailable" };

/** Injectable chain reader, so callers and tests can stay offline. */
export type DecimalsReader = (
  address: string,
  signal: AbortSignal | undefined,
) => Promise<DecimalsOutcome>;

export interface DecimalsResult {
  address: string;
  decimals: number | null;
  /**
   * Producer of the answer, or `null` when none is known — which is how a
   * caller tells "the chain says this contract has no decimals" from "nobody
   * could be asked".
   */
  source: string | null;
}

export interface GetTokenDecimalsParams {
  address: string;
  signal?: AbortSignal | undefined;
  readDecimals?: DecimalsReader | undefined;
}

/**
 * Serves decimals for one token, reading the chain only on a cache miss.
 *
 * Always resolves: a malformed address, a dead chain and a contract without the
 * function all answer `decimals: null`, and the two that are distinguishable
 * are distinguished by {@link DecimalsResult.source}.
 */
export async function getTokenDecimals(
  store: SnapshotStore,
  params: GetTokenDecimalsParams,
): Promise<DecimalsResult> {
  const address = params.address.toLowerCase();
  if (!isEvmAddress(address)) return { address, decimals: null, source: null };

  const key = decimalsKey(address);
  const cached = await store.get<TokenDecimals>(key);
  if (cached !== null && cached.staleness === "fresh") {
    return { address, decimals: parseDecimals(cached.data.decimals), source: cached.source };
  }

  const read = params.readDecimals ?? readErc20Decimals;

  let outcome: DecimalsOutcome;
  try {
    outcome = await read(address, params.signal);
  } catch (error) {
    // A reader is not trusted to keep its own promise not to throw; a decimals
    // failure must never become the caller's failure.
    console.warn(`[${SOURCE}] read failed for ${address}: ${sanitizeMessage(error)}`);
    outcome = { kind: "unavailable" };
  }

  if (outcome.kind === "unavailable") {
    if (cached === null) return { address, decimals: null, source: null };
    // Stale beats nothing, and for an immutable fact "stale" only means old.
    return { address, decimals: parseDecimals(cached.data.decimals), source: cached.source };
  }

  // Bounded here rather than in the reader, so the rule holds for every reader
  // there will ever be: an answer outside the usable range is as good as none,
  // and is cached as one — it will be the same answer on every endpoint.
  const decimals = outcome.kind === "answered" ? parseDecimals(outcome.decimals) : null;
  await store.put(
    key,
    { address, decimals } satisfies TokenDecimals,
    {
      source: CHAIN_SOURCE,
      freshForMs: decimals === null ? ABSENT_DECIMALS_FRESH_FOR_MS : DECIMALS_FRESH_FOR_MS,
      deadAfterMs: decimals === null ? ABSENT_DECIMALS_DEAD_AFTER_MS : DECIMALS_DEAD_AFTER_MS,
    },
  );
  return { address, decimals, source: CHAIN_SOURCE };
}

/**
 * Reads `decimals()` from the chain, bounded by {@link DECIMALS_READ_TIMEOUT_MS}.
 *
 * The revert/transport split is made inside the client callback, because
 * {@link withBscClient} wraps whatever escapes it in an `AdapterError` that no
 * longer carries viem's cause chain: classifying outside would read every
 * revert as an outage and rotate the whole endpoint list to learn nothing.
 */
export async function readErc20Decimals(
  address: string,
  signal: AbortSignal | undefined,
): Promise<DecimalsOutcome> {
  const deadline = AbortSignal.timeout(DECIMALS_READ_TIMEOUT_MS);
  const bounded = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);

  try {
    return await withBscClient((client) => readDecimalsOn(client, address), { signal: bounded });
  } catch (error) {
    console.warn(`[${SOURCE}] chain read failed for ${address}: ${sanitizeMessage(error)}`);
    return { kind: "unavailable" };
  }
}

/** One `decimals()` read on a client the caller already holds. */
async function readDecimalsOn(client: BscClient, address: string): Promise<DecimalsOutcome> {
  try {
    const decimals = await client.readContract({
      address: address as `0x${string}`,
      abi: ERC20_METADATA_ABI,
      functionName: "decimals",
    });
    return { kind: "answered", decimals };
  } catch (error) {
    // Returned, not rethrown: a revert is the same answer on every endpoint, so
    // rotating through the rest would only burn the caller's deadline.
    if (isContractLevelFailure(error)) return { kind: "absent" };
    throw error;
  }
}

/**
 * Narrows an unvalidated value to usable decimals. Applied to the cached
 * payload as well as the chain answer: a record written by an older build is
 * input like any other.
 */
function parseDecimals(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 0 || value > MAX_DECIMALS) return null;
  return value;
}
