/**
 * Token eligibility — the gate the execution plane asks before trading or LPing.
 *
 * Eligibility is a union of four rules that answer in completely different ways:
 *
 *   1. `data/eligible-tokens.json` — a frozen 222-token allowlist (BNB/WBNB/BTCB/
 *      USDT, the bStocks, and CMC top-200 with a BSC deployment). Enumerable
 *      because it changes only by an explicit regeneration.
 *   2. The Binance Alpha rule — membership in the `universe:coins` snapshot the
 *      `binance-universe` job maintains from the Alpha token list. Read from the
 *      store, never from the bapi endpoint directly: the gate must not put load
 *      on an undocumented upstream, and a store read keeps the fail-closed
 *      posture measurable — the rule only answers while the snapshot is *fresh*
 *      (12h window against a 6h job cadence), so a dead upstream degrades this
 *      rule to silent within a bounded time instead of trusting an old list.
 *   3. The Four.Meme factory rule — meme tokens launch continuously, so they can
 *      never be enumerated by a snapshot. A token is Four.Meme-launched iff
 *      TokenManagerHelper3 `getTokenInfo` reports `version == 2` for it.
 *   4. The Flap Portal rule — the same problem on a second launchpad. A token is
 *      Flap-launched iff the Portal lens `getTokenV8Safe` answers at all, and
 *      tradable iff the status it reports is Tradable (curve) or DEX (graduated).
 *
 * Rules 2 and 3 are also the routing answer. Four.Meme's `liquidityAdded` and
 * Flap's `status` are both graduation flags, so the same call that proves
 * eligibility says whether the trade belongs on a bonding curve or on
 * PancakeSwap V2.
 *
 * The two launchpad reads are shaped alike but answer a negative in opposite
 * ways, and both behaviours are measured rather than assumed (2026-08-11):
 * Four.Meme's helper zero-fills for a token it never heard of, while Flap's
 * Portal reverts with `TokenNotFound(address)` (selector `0xde6137d1`). So for
 * Four.Meme `version == 0` is the ordinary negative and a revert is the rare
 * transport-shaped one; for Flap the revert *is* the ordinary negative. Getting
 * that backwards would classify every non-Flap token as a failed read, and this
 * gate turns a failed read into a denial — every Four.Meme token would go with
 * it.
 *
 * **Fail-closed, deliberately.** Every other read path here degrades toward
 * serving something — `query/klines.ts` and `query/security.ts` both fall back
 * to a stale record rather than nothing. This one must not. An unreadable chain
 * or an unloadable allowlist means "not eligible", never "probably fine": the
 * consequence of a wrong `false` is a refused trade, and of a wrong `true` is
 * capital sent at an unvetted contract. Concretely that means a stale cache
 * entry is re-checked rather than served, and an RPC outage denies.
 *
 * This is where the port from `D:\4alpha` deviates from its source:
 * `shouldUseDexTradeRoute` there wraps the same read in `catch { return false }`,
 * which silently reads an RPC outage as "not graduated" and routes to the
 * bonding curve. Same call, opposite default — that swallow is safe when the
 * question is *which venue* and unsafe when it is *whether at all*.
 */

import { type Abi } from "viem";
import { isContractLevelFailure, type BscClient, withBscClient } from "../chain/rpc.js";
import {
  FLAP_PORTAL,
  FLAP_STATUS_DEX,
  flapPortalAbi,
  isFlapTradable,
} from "../adapters/flap.js";
import { isEvmAddress, normalizeAddress, sanitizeMessage } from "../adapters/http.js";
import type { SnapshotStore } from "../core/store.js";
import { COINS_UNIVERSE_KEY } from "../universe.js";
// The frozen-snapshot parser now lives in `src/allowlist.ts` so the price job
// and the universe lane share it; it is
// re-exported here because this module has always been its public home.
import { loadAllowlist, resetAllowlistCache } from "../allowlist.js";

export { loadAllowlist, resetAllowlistCache };

const SOURCE = "eligibility";

/**
 * Four.Meme TokenManagerHelper3 on BSC — the read-only helper that fronts both
 * TokenManager versions. Taken from the live `D:\4alpha` trade path
 * (`lib/fourmeme/dex.ts`), which routes real orders through it.
 */
export const FOURMEME_HELPER = "0xF251F83e40a78868FcfA3FA4599Dad6494E46034" as const;

/** Four.Meme TokenManager2 — the bonding-curve venue, and the `version == 2` this gate requires. */
export const FOURMEME_TOKEN_MANAGER2 = "0x5c952063c7fc8610FFDB798152D69F0B9550762b" as const;

/** PancakeSwap V2 router — where a graduated Four.Meme token trades instead. */
export const PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E" as const;

/**
 * The only TokenManager version this gate accepts. V1 tokens exist on chain but
 * the execution plane has no V1 trade path, so treating them as eligible would
 * promise an order it cannot place.
 */
const SUPPORTED_TOKEN_MANAGER_VERSION = 2;

/**
 * `getTokenInfo` returns a 12-field tuple. Only four fields are read, but the
 * whole shape is declared because viem decodes positionally — a short ABI would
 * silently misalign every field after the first omission.
 */
const helperAbi = [
  {
    name: "getTokenInfo",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "version", type: "uint256" },
      { name: "tokenManager", type: "address" },
      { name: "quote", type: "address" },
      { name: "lastPrice", type: "uint256" },
      { name: "tradingFeeRate", type: "uint256" },
      { name: "minTradingFee", type: "uint256" },
      { name: "launchTime", type: "uint256" },
      { name: "offers", type: "uint256" },
      { name: "maxOffers", type: "uint256" },
      { name: "funds", type: "uint256" },
      { name: "maxFunds", type: "uint256" },
      { name: "liquidityAdded", type: "bool" },
    ],
  },
] as const satisfies Abi;

/** Which rule admitted the token. */
export type EligibilitySource = "allowlist" | "binance-alpha" | "fourmeme" | "flap";

/**
 * A hit on one of the two enumerable lists, or none. The allowlist wins over
 * Alpha when a token is on both — the frozen snapshot is the stronger claim.
 */
export type ListHit = "allowlist" | "binance-alpha" | null;

/**
 * Where a trade in this token has to be routed.
 *
 * Both launchpads graduate onto the same `pancake-v2` venue. For Flap that is
 * measured, not inferred from the docs: all eight graduated tokens sampled on
 * 2026-08-11 carried a `pool` on the PancakeSwap V2 factory
 * (`0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73`), even though the lens also
 * reports a `lpFeeProfile`, which is a V3 concept.
 */
export type EligibilityVenue = "fourmeme-bonding" | "flap-bonding" | "pancake-v2";

/**
 * Why the gate answered as it did. Stable strings — the execution plane
 * branches on these, and a judge reads them off `/eligibility/:address`.
 */
export type EligibilityReason =
  /** Listed in the frozen snapshot. */
  | "allowlist"
  /** Listed in a fresh `universe:coins` snapshot of the Binance Alpha list. */
  | "binance_alpha"
  /** `getTokenInfo` reported a supported Four.Meme TokenManager version. */
  | "fourmeme_factory"
  /** The Flap Portal lens answered with a tradable status. */
  | "flap_portal"
  /** Not an EVM address. */
  | "invalid_address"
  /** Not in the snapshot, and neither launchpad claims it. */
  | "not_listed"
  /** Four.Meme-launched, but on a TokenManager version with no trade path. */
  | "unsupported_token_manager"
  /** Flap-launched, but staged, killed, or otherwise not currently tradable. */
  | "unsupported_flap_status"
  /** The chain could not be read. Fail-closed: unknown is not eligible. */
  | "chain_unavailable"
  /** The allowlist file could not be loaded. Fail-closed: nothing is eligible. */
  | "allowlist_unavailable";

/** The Four.Meme facts behind an eligible meme token, and its routing venue. */
export interface FourMemeState {
  version: number;
  tokenManager: string;
  /** Curve quote token. Non-native quotes need acquiring before a buy. */
  quote: string;
  /** Epoch seconds. The execution plane's anti-snipe delay keys off this. */
  launchTime: number;
  /** True once the curve has graduated and liquidity moved to PancakeSwap. */
  liquidityAdded: boolean;
}

/**
 * The Flap facts behind a Portal answer, eligible or not.
 *
 * Numeric fields are kept as `number`/`string` rather than `bigint` because this
 * whole record is JSON — it goes out over `/eligibility/:address` and into the
 * snapshot store, and `JSON.stringify` throws on a bigint. `progress` is a
 * uint256 scaled to 1e18, which overflows a safe integer, so it stays a decimal
 * string; the tax rates are basis points and the enums are small.
 */
export interface FlapState {
  /** `TokenStatus`: 1 Tradable (on the curve), 4 DEX (graduated). */
  status: number;
  /** `TokenVersion`: 4 TOKEN_TAXED, 6 TOKEN_TAXED_V3, 7 TOKEN_V3_PERMIT (non-tax). */
  tokenVersion: number;
  /**
   * Curve quote token; the zero address means native BNB. Non-native quotes are
   * routine on Flap, not an edge case — of the graduated tokens sampled, several
   * were quoted in bStocks (SPYB, QQQB, BABAB) rather than BNB.
   */
  quote: string;
  /** True when the Portal will swap native BNB into the quote token for a buy. */
  nativeToQuoteSwapEnabled: boolean;
  /**
   * The PancakeSwap V2 pair, once graduated; the zero address while on the curve.
   * After graduation the lens stops pricing the token — `price` and `reserve`
   * both read 0 — so this pool is the only price source it hands back.
   */
  pool: string;
  /** Progress toward graduation, 0 to 1e18, as a decimal string. */
  progress: string;
  /** Buy tax in basis points; 0 for a non-tax token. */
  buyTaxBps: number;
  /** Sell tax in basis points. Asymmetric on TOKEN_TAXED_V3. */
  sellTaxBps: number;
}

export interface EligibilityResult {
  address: string;
  eligible: boolean;
  reason: EligibilityReason;
  /** Null whenever `eligible` is false. */
  source: EligibilitySource | null;
  /** Set only for launchpad tokens; allowlisted tokens route by venue discovery. */
  venue: EligibilityVenue | null;
  /** Set only for Four.Meme tokens, eligible or not, when the helper answered. */
  fourmeme: FourMemeState | null;
  /** Set only for Flap tokens, eligible or not, when the Portal answered. */
  flap: FlapState | null;
  /** Epoch ms of the observation being served — not necessarily now. */
  checkedAt: number;
  /** True when this answer came from cache rather than a fresh chain read. */
  cached: boolean;
}

/**
 * Cache windows.
 *
 * A positive answer is short-lived because `liquidityAdded` flips at graduation
 * and the venue rides along with it — `D:\4alpha` caches the same read for 10s
 * for exactly this reason. 30s here is the looser bound the plane can afford
 * because it re-reads before every order anyway.
 *
 * A negative answer is cached at all only to stop unknown addresses from turning
 * into RPC load, and briefly, because an address that is not a contract today
 * can be a Four.Meme launch a minute from now.
 *
 * `deadAfterMs` equals `freshForMs` in both directions: past the window the
 * entry is not merely suspect, it is unusable. Nothing here ever serves stale.
 */
export const ELIGIBILITY_TTL = {
  eligible: { freshForMs: 30_000, deadAfterMs: 30_000 },
  ineligible: { freshForMs: 60_000, deadAfterMs: 60_000 },
} as const;

/** Store key for one token's eligibility verdict. */
export function eligibilityKey(address: string): string {
  return `eligibility:${address.toLowerCase()}`;
}

/**
 * Reads the Binance Alpha membership set out of the `universe:coins` snapshot.
 *
 * Fresh only, deliberately stricter than the universe lane (which serves the
 * snapshot until it is dead at 48h): a lane row carries its age for the reader
 * to judge, an eligibility verdict does not. With the `binance-universe` job on
 * a 6h cadence and a 12h freshness window, "not fresh" means the upstream has
 * been failing for at least two cycles — at which point this rule goes silent
 * and Alpha tokens fall through to the launchpad rules and `not_listed`, the
 * same denial they got before this rule existed.
 *
 * Returns null when there is nothing usable; never throws, because a failure
 * here must degrade to "rule contributes nothing", not take the gate down.
 */
async function readAlphaSet(store: SnapshotStore): Promise<ReadonlySet<string> | null> {
  try {
    const record = await store.get<unknown>(COINS_UNIVERSE_KEY);
    if (record === null || record.staleness !== "fresh") return null;
    if (!Array.isArray(record.data)) return null;

    const set = new Set<string>();
    for (const raw of record.data) {
      if (typeof raw !== "object" || raw === null) continue;
      const address = normalizeAddress((raw as Record<string, unknown>)["address"]);
      if (address !== null) set.add(address);
    }
    return set.size === 0 ? null : set;
  } catch (error) {
    console.warn(`[${SOURCE}] alpha snapshot read failed: ${sanitizeMessage(error)}`);
    return null;
  }
}

/** What one launchpad read can conclude. */
export type ChainOutcome<TState> =
  /** The contract answered. */
  | { kind: "answered"; state: TState }
  /** It reverted or the address holds no contract — definitively not this launchpad's. */
  | { kind: "absent" }
  /** No endpoint could be read. Says nothing about the token. */
  | { kind: "unavailable" };

export type HelperOutcome = ChainOutcome<FourMemeState>;
export type FlapOutcome = ChainOutcome<FlapState>;

/**
 * Both launchpad reads for one token.
 *
 * Kept as a pair rather than two independent calls because they are resolved
 * against the same endpoint at the same block — {@link withBscClient} replays
 * the whole callback on failure precisely so a read set is never half-answered
 * by two chains at two heights.
 */
export interface ChainOutcomes {
  fourmeme: HelperOutcome;
  flap: FlapOutcome;
}

/** Reads Four.Meme state for one token, folding a revert into a definite "absent". */
async function readFourMemeOn(client: BscClient, address: string): Promise<HelperOutcome> {
  try {
    const info = await client.readContract({
      address: FOURMEME_HELPER,
      abi: helperAbi,
      functionName: "getTokenInfo",
      args: [address as `0x${string}`],
    });
    return {
      kind: "answered",
      state: {
        version: Number(info[0]),
        tokenManager: info[1].toLowerCase(),
        quote: info[2].toLowerCase(),
        launchTime: Number(info[6]),
        liquidityAdded: info[11],
      },
    };
  } catch (error) {
    // Returned, not rethrown: a revert is the same answer on every endpoint, so
    // rotating through the rest would only burn the caller's deadline.
    if (isContractLevelFailure(error)) return { kind: "absent" };
    throw error;
  }
}

/**
 * Reads Flap Portal state for one token.
 *
 * Unlike the Four.Meme helper, the ordinary negative here *is* the revert: the
 * Portal answers `TokenNotFound(address)` for anything it did not launch, which
 * this folds into "absent" the same way. A plain BEP-20, a Four.Meme token and
 * an EOA all take that branch.
 */
async function readFlapOn(client: BscClient, address: string): Promise<FlapOutcome> {
  try {
    const state = await client.readContract({
      address: FLAP_PORTAL,
      abi: flapPortalAbi,
      functionName: "getTokenV8Safe",
      args: [address as `0x${string}`],
    });
    return {
      kind: "answered",
      state: {
        status: state.status,
        tokenVersion: state.tokenVersion,
        quote: state.quoteTokenAddress.toLowerCase(),
        nativeToQuoteSwapEnabled: state.nativeToQuoteSwapEnabled,
        pool: state.pool.toLowerCase(),
        progress: state.progress.toString(),
        buyTaxBps: Number(state.buyTaxRate),
        sellTaxBps: Number(state.sellTaxRate),
      },
    };
  } catch (error) {
    if (isContractLevelFailure(error)) return { kind: "absent" };
    throw error;
  }
}

/**
 * Asks both launchpads about one token.
 *
 * The two reads are issued in the same tick so viem's multicall batching folds
 * them into a single `eth_call`; adding a second launchpad therefore costs a
 * struct in the response, not a second round trip. If either read fails at the
 * transport level the pair is replayed on the next endpoint, and only when every
 * endpoint is exhausted does the gate see "unavailable" — which it denies on.
 */
async function readChainState(
  address: string,
  signal: AbortSignal | undefined,
): Promise<ChainOutcomes> {
  const read = async (client: BscClient): Promise<ChainOutcomes> => {
    const [fourmeme, flap] = await Promise.all([
      readFourMemeOn(client, address),
      readFlapOn(client, address),
    ]);
    return { fourmeme, flap };
  };

  try {
    return await withBscClient(read, signal === undefined ? {} : { signal });
  } catch (error) {
    console.warn(`[${SOURCE}] chain read failed for ${address}: ${sanitizeMessage(error)}`);
    return { fourmeme: { kind: "unavailable" }, flap: { kind: "unavailable" } };
  }
}

/** Which launchpad minted a token, or that neither did. */
export type LaunchpadOrigin = "fourmeme" | "flap" | "none";

/**
 * Resolves which launchpad each token came from, in batches.
 *
 * Not part of the gate — pool classification uses it — but it asks the two
 * launchpads exactly the same questions {@link readChainState} does, so there is
 * one definition of what "this token is a Four.Meme token" means.
 *
 * The answer is a permanent property: a launchpad mints new contracts, it never
 * adopts an existing one, so `none` is as final as `fourmeme`. That is what
 * makes caching it forever safe, and it is why this is affordable at all — the
 * cost is one resolution per token for the life of the deployment, not one per
 * cycle.
 *
 * All reads for a chunk are issued in the same tick so viem folds them into
 * Multicall3 batches. A revert is a definite answer and becomes `none`; a
 * transport failure is rethrown so {@link withBscClient} rotates endpoints, and
 * a chunk that no endpoint can serve is omitted from the result rather than
 * being recorded as `none`.
 */
export async function resolveLaunchpadOrigins(
  addresses: string[],
  options: { signal?: AbortSignal | undefined; rpcUrls?: string[] | undefined } = {},
): Promise<Map<string, LaunchpadOrigin>> {
  const tokens = [...new Set(addresses.map((address) => normalizeAddress(address)))].filter(
    (address): address is string => address !== null,
  );

  const resolved = new Map<string, LaunchpadOrigin>();
  for (let start = 0; start < tokens.length; start += ORIGIN_CHUNK) {
    const chunk = tokens.slice(start, start + ORIGIN_CHUNK);
    try {
      const outcomes = await withBscClient(
        async (client) =>
          Promise.all(chunk.map((address) => readChainStateOn(client, address))),
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.rpcUrls === undefined ? {} : { rpcUrls: options.rpcUrls }),
        },
      );
      chunk.forEach((address, index) => {
        const outcome = outcomes[index];
        if (outcome === undefined) return;
        const origin = classifyOutcome(outcome);
        if (origin !== null) resolved.set(address, origin);
      });
    } catch (error) {
      // Omitted, never recorded: writing `none` for an unreachable chunk would
      // cache an outage as a fact about the tokens, and this cache is forever.
      console.warn(`[${SOURCE}] origin resolution failed for a chunk: ${sanitizeMessage(error)}`);
    }
  }
  return resolved;
}

/** Tokens per batched round trip. Keeps one bad round from costing the lot. */
const ORIGIN_CHUNK = 100;

/** Both launchpad reads for one token, on a client the caller already holds. */
async function readChainStateOn(client: BscClient, address: string): Promise<ChainOutcomes> {
  const [fourmeme, flap] = await Promise.all([
    readFourMemeOn(client, address),
    readFlapOn(client, address),
  ]);
  return { fourmeme, flap };
}

/**
 * `null` when either launchpad failed to answer.
 *
 * A zero-filled Four.Meme struct (`version == 0`) is the helper's ordinary way
 * of saying it never heard of the token — measured on chain, an EOA and a plain
 * BEP-20 both come back that way — so it means `none`, not "Four.Meme". Flap
 * answers the same negative by reverting, which `readFlapOn` already folded into
 * `absent`.
 */
function classifyOutcome(outcome: ChainOutcomes): LaunchpadOrigin | null {
  if (outcome.fourmeme.kind === "unavailable" || outcome.flap.kind === "unavailable") return null;
  if (outcome.fourmeme.kind === "answered" && outcome.fourmeme.state.version > 0) return "fourmeme";
  if (outcome.flap.kind === "answered") return "flap";
  return "none";
}

/**
 * Decides eligibility from an allowlist hit and a chain read, without touching
 * either. Exported so the whole decision table is testable offline.
 */
export function decideEligibility(
  address: string,
  listed: ListHit,
  outcomes: ChainOutcomes | null,
): Omit<EligibilityResult, "checkedAt" | "cached"> {
  const base = { address, source: null, venue: null, fourmeme: null, flap: null } as const;

  if (!isEvmAddress(address)) {
    return { ...base, eligible: false, reason: "invalid_address" };
  }
  if (listed === "allowlist") {
    return { ...base, eligible: true, reason: "allowlist", source: "allowlist" };
  }
  if (listed === "binance-alpha") {
    // No venue, same as the allowlist: an Alpha token is an established BEP-20
    // that routes by ordinary pool discovery, not a launchpad curve.
    return { ...base, eligible: true, reason: "binance_alpha", source: "binance-alpha" };
  }
  if (outcomes === null) {
    return { ...base, eligible: false, reason: "allowlist_unavailable" };
  }

  const { fourmeme, flap } = outcomes;

  // Positives first, so one launchpad still answers while the other's read is
  // failing. A token belongs to at most one of them, so the order between these
  // two only settles a case that cannot occur.
  if (fourmeme.kind === "answered" && fourmeme.state.version === SUPPORTED_TOKEN_MANAGER_VERSION) {
    return {
      ...base,
      eligible: true,
      reason: "fourmeme_factory",
      source: "fourmeme",
      venue: fourmeme.state.liquidityAdded ? "pancake-v2" : "fourmeme-bonding",
      fourmeme: fourmeme.state,
    };
  }
  if (flap.kind === "answered" && isFlapTradable(flap.state.status)) {
    // `isFlapTradable` and FLAP_STATUS_DEX are the adapter's, so the gate and
    // the universe job cannot drift apart on what "tradable" means.
    return {
      ...base,
      eligible: true,
      reason: "flap_portal",
      source: "flap",
      venue: flap.state.status === FLAP_STATUS_DEX ? "pancake-v2" : "flap-bonding",
      flap: flap.state,
    };
  }

  // Before any negative: a launchpad that could not be read might have been the
  // one that would have admitted this token, so an outage on either side denies
  // with `chain_unavailable` rather than the flat `not_listed` it looks like.
  // That reason is also the one the gate refuses to cache.
  if (fourmeme.kind === "unavailable" || flap.kind === "unavailable") {
    return { ...base, eligible: false, reason: "chain_unavailable" };
  }

  // Measured against the live helper: it does not revert for a token it has
  // never heard of — an EOA and a plain BEP-20 both come back as a zero-filled
  // struct. So version 0 is the ordinary "not a Four.Meme token" answer, and the
  // "absent" branch is only the rarer transport-shaped version of it.
  if (fourmeme.kind === "answered" && fourmeme.state.version !== 0) {
    return {
      ...base,
      eligible: false,
      reason: "unsupported_token_manager",
      // Still reported, so an operator can see why it was refused.
      fourmeme: fourmeme.state,
    };
  }
  if (flap.kind === "answered") {
    return { ...base, eligible: false, reason: "unsupported_flap_status", flap: flap.state };
  }

  return { ...base, eligible: false, reason: "not_listed" };
}

export interface IsEligibleParams {
  address: string;
  signal?: AbortSignal | undefined;
  /**
   * Overrides the chain read. Injected the same way adapters take `fetchFn`, so
   * the fail-closed paths — outage denies, stale is never served — can be tested
   * without a chain.
   */
  readState?: ((address: string, signal: AbortSignal | undefined) => Promise<ChainOutcomes>) | undefined;
}

/**
 * Answers whether one token may be traded, and where.
 *
 * Never throws: every failure path resolves to `eligible: false` with a reason
 * naming what went wrong, because a gate that throws is a gate a caller can
 * accidentally catch into an allow.
 */
export async function isEligible(
  store: SnapshotStore,
  params: IsEligibleParams,
): Promise<EligibilityResult> {
  const address = params.address.toLowerCase();
  const now = Date.now();

  if (!isEvmAddress(address)) {
    return { ...decideEligibility(address, null, null), checkedAt: now, cached: false };
  }

  const allowlist = loadAllowlist();

  // Checked before the cache: a snapshot hit is a local map lookup, and it must
  // keep answering even while the chain is unreachable.
  if (allowlist !== null && allowlist.has(address)) {
    return { ...decideEligibility(address, "allowlist", null), checkedAt: now, cached: false };
  }

  // Also before the cache, so a token newly added to the Alpha list is admitted
  // immediately instead of waiting out a cached `not_listed`. A store read, not
  // an upstream call — and not cached as a verdict, because the snapshot it was
  // decided from can be replaced by the next job cycle at any moment.
  const alpha = await readAlphaSet(store);
  if (alpha !== null && alpha.has(address)) {
    return { ...decideEligibility(address, "binance-alpha", null), checkedAt: now, cached: false };
  }

  // Fresh only. A stale verdict is discarded rather than served — see the
  // fail-closed note at the top of this file.
  const cached = await store.get<EligibilityResult>(eligibilityKey(address));
  if (cached !== null && cached.staleness === "fresh" && isEligibilityResult(cached.data)) {
    return { ...cached.data, checkedAt: cached.asOf, cached: true };
  }

  const read = params.readState ?? readChainState;
  const outcomes = allowlist === null ? null : await read(address, params.signal);
  const decided = decideEligibility(address, null, outcomes);
  const result: EligibilityResult = { ...decided, checkedAt: Date.now(), cached: false };

  // Only a definite observation is cached. `chain_unavailable` and
  // `allowlist_unavailable` are statements about this service, not the token,
  // and caching them would keep denying after the outage cleared.
  if (result.reason !== "chain_unavailable" && result.reason !== "allowlist_unavailable") {
    const ttl = result.eligible ? ELIGIBILITY_TTL.eligible : ELIGIBILITY_TTL.ineligible;
    await store.put(eligibilityKey(address), result, { source: SOURCE, ...ttl });
  }

  return result;
}

/**
 * How many tokens of one batch may be on the chain at once.
 *
 * Allowlist and cache hits cost nothing, so this bounds only the worst case: a
 * batch of entirely unknown addresses. Unbounded `Promise.all` over a 50-address
 * batch would put 50 simultaneous `eth_call`s on a keyless public endpoint,
 * which rate-limits — and under this gate a rate-limit reads as a denial.
 */
const BATCH_CONCURRENCY = 8;

/**
 * Resolves a batch, preserving input order.
 *
 * Order matters to the caller: the execution plane zips the verdicts back
 * against the addresses it asked about.
 */
export async function isEligibleBatch(
  store: SnapshotStore,
  addresses: string[],
  options: Omit<IsEligibleParams, "address"> = {},
): Promise<EligibilityResult[]> {
  const results: EligibilityResult[] = new Array<EligibilityResult>(addresses.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const address = addresses[index];
      if (address === undefined) return;
      results[index] = await isEligible(store, { ...options, address });
    }
  };

  const workers = Math.min(BATCH_CONCURRENCY, addresses.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/**
 * Stored verdicts are re-validated on read: the store outlives code versions, so
 * a shape written by an older build must not be trusted into an allow.
 */
function isEligibilityResult(value: unknown): value is EligibilityResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["eligible"] === "boolean" && typeof record["reason"] === "string";
}
