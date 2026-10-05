/**
 * Venue, tax and dividend for the tokens on the meme board (handoff 2026-10-05
 * item 4).
 *
 * The facts come from the launchpads on chain — the same reads `/eligibility`
 * makes (Flap's Portal lens, Four.Meme's helper) plus Flap's TaxTokenHelper for
 * the dividend — and are cached in one internal key, because the board tracks up
 * to 800 tokens a minute and the plane runs on public RPC. What is re-read, and
 * how often, follows what can change:
 *
 * - a token never read is read this cycle;
 * - a token on its curve that is still trading (runner, active, fading, unknown)
 *   is re-read every cycle, because graduation moves its venue;
 * - one on its curve that is quiet or dead, every 10 minutes;
 * - a graduated token every 30 minutes: its venue and pool are final, but a
 *   Flap tax runs for a `taxDuration` set at launch, so the rate can drop to 0.
 *
 * The dividend (`dividendToken`, `dividendBps`) is fixed at launch, so it is
 * read once per Flap token. A read that fails leaves the cached answer in place
 * and the token due again next cycle; a token never answered stays `null`
 * (unknown), never a default.
 */

import { readFlapDividends, type FlapDividend } from "../adapters/flap.js";
import type { MemeLaunchpad } from "../adapters/binanceWeb3.js";
import { sanitizeMessage } from "../adapters/http.js";
import type { SnapshotStore } from "../core/store.js";
import type { LaunchpadState, LaunchpadStateReader } from "../query/launchpadState.js";
import type { MemeStatus, MemeVenueInfo } from "../query/memeClassify.js";

export const MEME_VENUES_KEY = "memes:venues";
const LIVE_REFRESH_MS = 0;
const IDLE_REFRESH_MS = 10 * 60_000;
const GRADUATED_REFRESH_MS = 30 * 60_000;
/** Ceiling on lens/helper reads per cycle, so a cold start spreads over a few cycles. */
export const VENUE_READS_PER_CYCLE = 400;
export const DIVIDEND_READS_PER_CYCLE = 200;

export interface CachedVenue extends MemeVenueInfo {
  launchpad: MemeLaunchpad;
  /** When the dividend was answered; absent until then. Flap only. */
  dividendCheckedAt?: number;
}

export type DividendReader = (addresses: readonly string[], signal?: AbortSignal) => Promise<Map<string, FlapDividend>>;

export interface VenueCandidate {
  address: string;
  launchpad: MemeLaunchpad;
  /** Status on the previous board, `undefined` for a token not on it yet. */
  status: MemeStatus | undefined;
}

/** Exported for tests: how long a cached entry stays good for a token in this state. */
export function refreshAfterMs(entry: CachedVenue, status: MemeStatus | undefined): number {
  if (entry.venue === "pancake-v2") return GRADUATED_REFRESH_MS;
  if (status === "quiet" || status === "dead") return IDLE_REFRESH_MS;
  return LIVE_REFRESH_MS;
}

export function venueFromState(state: LaunchpadState, now: number, previous: CachedVenue | undefined): MemeVenueInfo {
  return {
    venue: state.venue ?? null,
    tax: state.tax ?? null,
    pool: state.pool ?? null,
    nativeToQuoteSwapEnabled: state.nativeToQuoteSwapEnabled ?? null,
    dividend: previous?.dividend ?? null,
    checkedAt: now,
  };
}

/**
 * Brings the cache up to date for the tracked tokens and returns it. `known`
 * holds launchpad states already read this cycle (the hot-only seeding read), so
 * those tokens cost nothing more.
 */
export async function refreshVenues(
  store: SnapshotStore,
  candidates: readonly VenueCandidate[],
  known: ReadonlyMap<string, LaunchpadState>,
  options: { readStates: LaunchpadStateReader; readDividends: DividendReader; now: number; signal: AbortSignal },
): Promise<{ venues: Map<string, CachedVenue>; read: number; failures: string[] }> {
  const { now, signal } = options;
  const cache = await readVenueCache(store);
  const next = new Map<string, CachedVenue>();
  const failures: string[] = [];

  const due: VenueCandidate[] = [];
  for (const candidate of candidates) {
    const cached = cache.get(candidate.address);
    const state = known.get(candidate.address);
    if (state !== undefined) {
      next.set(candidate.address, { ...cached, ...venueFromState(state, now, cached), launchpad: candidate.launchpad });
      continue;
    }
    if (cached !== undefined) next.set(candidate.address, cached);
    if (cached === undefined || now - cached.checkedAt >= refreshAfterMs(cached, candidate.status)) due.push(candidate);
  }
  // Never-read tokens first, then the ones whose venue can move.
  due.sort((a, b) => Number(next.has(a.address)) - Number(next.has(b.address)));
  const batch = due.slice(0, VENUE_READS_PER_CYCLE);
  if (batch.length > 0) {
    const states = await options.readStates(batch.map(({ address, launchpad }) => ({ address, launchpad })), signal);
    for (const candidate of batch) {
      const state = states.get(candidate.address);
      if (state === undefined) continue; // unread or unknown to the launchpad: keep what was cached
      const cached = next.get(candidate.address);
      next.set(candidate.address, { ...cached, ...venueFromState(state, now, cached), launchpad: candidate.launchpad });
    }
  }

  const needDividend = [...next.entries()]
    .filter(([, entry]) => entry.launchpad === "flap" && entry.dividendCheckedAt === undefined)
    .map(([address]) => address)
    .slice(0, DIVIDEND_READS_PER_CYCLE);
  if (needDividend.length > 0) {
    try {
      const dividends = await options.readDividends(needDividend, signal);
      for (const address of needDividend) {
        const entry = next.get(address);
        const dividend = dividends.get(address);
        if (entry === undefined || dividend === undefined) continue;
        next.set(address, { ...entry, dividend, dividendCheckedAt: now });
      }
    } catch (error) {
      failures.push(`dividend: ${sanitizeMessage(error)}`);
    }
  }

  await store.put(MEME_VENUES_KEY, Object.fromEntries(next), {
    source: "launchpad-state",
    freshForMs: 3 * 60_000,
    deadAfterMs: 24 * 3_600_000,
  });
  return { venues: next, read: batch.length, failures };
}

export const readDividendsOnchain: DividendReader = (addresses, signal) => readFlapDividends(addresses, signal);

async function readVenueCache(store: SnapshotStore): Promise<Map<string, CachedVenue>> {
  const out = new Map<string, CachedVenue>();
  const data = (await store.get<unknown>(MEME_VENUES_KEY))?.data;
  if (typeof data !== "object" || data === null) return out;
  for (const [address, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Partial<CachedVenue>;
    if (typeof entry.checkedAt !== "number" || (entry.launchpad !== "flap" && entry.launchpad !== "fourmeme")) continue;
    out.set(address, {
      launchpad: entry.launchpad,
      venue: entry.venue ?? null,
      tax: entry.tax ?? null,
      pool: entry.pool ?? null,
      nativeToQuoteSwapEnabled: entry.nativeToQuoteSwapEnabled ?? null,
      dividend: entry.dividend ?? null,
      checkedAt: entry.checkedAt,
      ...(typeof entry.dividendCheckedAt === "number" ? { dividendCheckedAt: entry.dividendCheckedAt } : {}),
    });
  }
  return out;
}
