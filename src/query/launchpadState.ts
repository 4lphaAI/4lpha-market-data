/**
 * Launchpad state for tokens the meme board found outside Meme Rush.
 *
 * OKX's hot-token ranking says a token is trading but not where it is in its
 * life: no graduation flag, no curve progress, no quote token. The launchpads
 * answer all three on chain — the same two reads the eligibility gate makes
 * (Four.Meme's TokenManagerHelper3, Flap's Portal lens) — so a hot-only token is
 * classified on the launchpad's own facts rather than a guess.
 *
 * Read every cycle, not cached: graduation is the one fact here that changes.
 * A token a launchpad does not know is absent from the result, and so is every
 * token in a batch no endpoint could serve — the board skips it for one cycle
 * rather than labelling it on nothing.
 */

import { sanitizeMessage } from "../adapters/http.js";
import { FLAP_STATUS_DEX, FLAP_STATUS_TRADABLE, readFlapMarketStates, type FlapMarketState } from "../adapters/flap.js";
import { withBscClient, isContractLevelFailure } from "../chain/rpc.js";
import { FOURMEME_HELPER, helperAbi } from "./eligibility.js";
import type { MemeLaunchpad } from "../adapters/binanceWeb3.js";

const SOURCE = "launchpad-state";

export interface LaunchpadState {
  migrated: boolean;
  /** Bonding-curve progress, 0–100; 100 once migrated. */
  progress: number | null;
  /** Curve quote token, lowercased; the zero address means native BNB. */
  quote: string | null;
  /** Epoch ms of the launch, when the launchpad records it. */
  launchedAt: number | null;
  /**
   * Where a buy executes now — the same answer `/eligibility` gives. `null` when
   * the launchpad knows the token but will not trade it (a Flap status other
   * than Tradable or DEX). Optional so a state built by an older reader still types.
   */
  venue?: LaunchpadVenue | null;
  /** The graduated PancakeSwap V2 pair; `null` while on the curve, and for Four.Meme (the helper does not say). */
  pool?: string | null;
  /** Token tax per direction in bps (Flap lens); `null` for Four.Meme, whose helper does not report it. */
  tax?: { buyBps: number; sellBps: number } | null;
  /** Flap only: whether the Portal swaps BNB into a non-native quote for the buyer. */
  nativeToQuoteSwapEnabled?: boolean | null;
}

export type LaunchpadVenue = "flap-bonding" | "fourmeme-bonding" | "pancake-v2";

const ZERO = "0x0000000000000000000000000000000000000000";

export type LaunchpadStateReader = (
  items: readonly { address: string; launchpad: MemeLaunchpad }[],
  signal?: AbortSignal,
) => Promise<Map<string, LaunchpadState>>;

export const readLaunchpadStates: LaunchpadStateReader = async (items, signal) => {
  const out = new Map<string, LaunchpadState>();
  const flap = items.filter((item) => item.launchpad === "flap").map((item) => item.address);
  const fourmeme = items.filter((item) => item.launchpad === "fourmeme").map((item) => item.address);

  if (flap.length > 0) {
    try {
      for (const [address, state] of await readFlapMarketStates(flap, signal)) {
        out.set(address, fromFlapState(state));
      }
    } catch (error) {
      console.warn(`[${SOURCE}] flap read failed: ${sanitizeMessage(error)}`);
    }
  }

  if (fourmeme.length > 0) {
    try {
      const states = await withBscClient(
        async (client) => Promise.all(fourmeme.map((address) => readFourMemeState(client, address))),
        signal === undefined ? {} : { signal },
      );
      fourmeme.forEach((address, index) => {
        const state = states[index];
        if (state !== null && state !== undefined) out.set(address, state);
      });
    } catch (error) {
      console.warn(`[${SOURCE}] four.meme read failed: ${sanitizeMessage(error)}`);
    }
  }
  return out;
};

/** Exported for tests: one Flap lens answer as a launchpad state. Only Tradable (1) and DEX (4) have a venue. */
export function fromFlapState(state: FlapMarketState): LaunchpadState {
  const migrated = state.status === FLAP_STATUS_DEX;
  return {
    migrated,
    progress: migrated ? 100 : scaledPercent(state.progress),
    quote: state.quote,
    launchedAt: null,
    venue: migrated ? "pancake-v2" : state.status === FLAP_STATUS_TRADABLE ? "flap-bonding" : null,
    pool: state.pool === ZERO ? null : state.pool,
    tax: { buyBps: state.buyTaxBps, sellBps: state.sellTaxBps },
    nativeToQuoteSwapEnabled: state.nativeToQuoteSwapEnabled ?? null,
  };
}

type Client = Parameters<Parameters<typeof withBscClient>[0]>[0];

/** `null` when the helper does not know the token (`version == 0`, or a revert). */
async function readFourMemeState(client: Client, address: string): Promise<LaunchpadState | null> {
  try {
    const info = await client.readContract({
      address: FOURMEME_HELPER,
      abi: helperAbi,
      functionName: "getTokenInfo",
      args: [address as `0x${string}`],
    });
    if (Number(info[0]) === 0) return null;
    const migrated = info[11];
    const funds = info[9];
    const maxFunds = info[10];
    const launchTime = Number(info[6]);
    return {
      migrated,
      progress: migrated ? 100 : maxFunds > 0n ? Number((funds * 10_000n) / maxFunds) / 100 : null,
      quote: info[2].toLowerCase(),
      // `launchTime` is genuinely 0 for many fresh launches; 0 is "not recorded".
      launchedAt: launchTime > 0 ? launchTime * 1000 : null,
      venue: migrated ? "pancake-v2" : "fourmeme-bonding",
      pool: null,
      tax: null,
      nativeToQuoteSwapEnabled: null,
    };
  } catch (error) {
    if (isContractLevelFailure(error)) return null;
    throw error;
  }
}

/** A uint256 scaled to 1e18, as a 0–100 percentage. */
function scaledPercent(raw: string): number | null {
  try {
    return Number((BigInt(raw) * 10_000n) / 10n ** 18n) / 100;
  } catch {
    return null;
  }
}
