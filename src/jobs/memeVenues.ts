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
 * read once per Flap token.
 *
 * Four.Meme's helper reports no tax, so a graduated Four.Meme token's tax and
 * pool are read from the token itself in the same cycle as its venue state
 * (`query/fourmemeTax.ts`, `FOURMEME-TAX-SPEC.md`), and `checkedAt` dates all
 * three. Its code identity and creator type never change, so they are read once
 * per token (at most `CODE_READS_PER_CYCLE` a cycle) and kept on the entry; a
 * failed identity read is never stored. Curve rows keep `tax: null`. A graduated
 * row whose tax is `null` for a reason that can clear (identity not read yet, a
 * rate read that failed) is due again next cycle rather than in 30 minutes. A read that fails leaves the cached answer in place
 * and the token due again next cycle; a token never answered stays `null`
 * (unknown), never a default.
 */

import { readFlapDividends, type FlapDividend } from "../adapters/flap.js";
import type { MemeLaunchpad } from "../adapters/binanceWeb3.js";
import { sanitizeMessage } from "../adapters/http.js";
import type { SnapshotStore } from "../core/store.js";
import {
  matchFourMemeTemplate,
  readFourMemeCodes,
  readFourMemeTaxes,
  type FourMemeCode,
  type FourMemeCodeReader,
  type FourMemeTaxRead,
  type FourMemeTaxReader,
} from "../query/fourmemeTax.js";
import type { LaunchpadState, LaunchpadStateReader } from "../query/launchpadState.js";
import type { MemeStatus, MemeVenueInfo } from "../query/memeClassify.js";

export const MEME_VENUES_KEY = "memes:venues";
const LIVE_REFRESH_MS = 0;
const IDLE_REFRESH_MS = 10 * 60_000;
const GRADUATED_REFRESH_MS = 30 * 60_000;
/** Ceiling on lens/helper reads per cycle, so a cold start spreads over a few cycles. */
export const VENUE_READS_PER_CYCLE = 400;
export const DIVIDEND_READS_PER_CYCLE = 200;
/** Ceiling on Four.Meme code-identity reads (one `eth_getCode` each) per cycle. */
export const CODE_READS_PER_CYCLE = 100;
/** Time box for the identity reads, so a slow RPC day cannot spend the whole board cycle on them. */
const CODE_PHASE_MS = 10_000;

export interface CachedVenue extends MemeVenueInfo {
  launchpad: MemeLaunchpad;
  /** When the dividend was answered; absent until then. Flap only. */
  dividendCheckedAt?: number;
  /** Four.Meme only: code identity and creator type, permanent once read; absent until then. */
  fourmemeCode?: FourMemeCode;
  /**
   * Four.Meme only: the `checkedAt` of the last cycle whose rate read answered
   * (even with a rate this plane will not publish). Equal to `checkedAt` means
   * a `null` tax is an answer, not a failed read, so it is not retried every cycle.
   */
  fourmemeTaxReadAt?: number;
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
  if (entry.venue === "pancake-v2") return fourMemeTaxPending(entry) ? LIVE_REFRESH_MS : GRADUATED_REFRESH_MS;
  if (status === "quiet" || status === "dead") return IDLE_REFRESH_MS;
  return LIVE_REFRESH_MS;
}

/**
 * A graduated Four.Meme entry whose missing tax can still be answered: its
 * identity is unread, or it is a recognised template whose rate read failed in
 * its last venue cycle. An unrecognised template, or one whose rates answered
 * out of range, is not retried every cycle.
 */
function fourMemeTaxPending(entry: CachedVenue): boolean {
  if (entry.launchpad !== "fourmeme" || entry.venue !== "pancake-v2" || entry.tax !== null) return false;
  if (entry.fourmemeCode === undefined) return true;
  return matchFourMemeTemplate(entry.fourmemeCode) !== null && entry.fourmemeTaxReadAt !== entry.checkedAt;
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
  options: {
    readStates: LaunchpadStateReader;
    readDividends: DividendReader;
    readFourMemeCodes: FourMemeCodeReader;
    readFourMemeTaxes: FourMemeTaxReader;
    now: number;
    signal: AbortSignal;
  },
): Promise<{ venues: Map<string, CachedVenue>; read: number; failures: string[] }> {
  const { now, signal } = options;
  const cache = await readVenueCache(store);
  const next = new Map<string, CachedVenue>();
  const failures: string[] = [];
  /** Entries whose venue state was read this cycle; only these get a Four.Meme tax read. */
  const readNow = new Set<string>();

  const due: VenueCandidate[] = [];
  for (const candidate of candidates) {
    const cached = cache.get(candidate.address);
    const state = known.get(candidate.address);
    if (state !== undefined) {
      next.set(candidate.address, { ...cached, ...venueFromState(state, now, cached), launchpad: candidate.launchpad });
      readNow.add(candidate.address);
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
      readNow.add(candidate.address);
    }
  }

  failures.push(...(await applyFourMemeTax(next, readNow, options)));

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

/**
 * Tax and pool for the graduated Four.Meme entries read this cycle, in place.
 * Every outcome other than a proven template with readable, in-range rates is
 * `tax: null` (`pool: null`), stamped with this cycle's `checkedAt` like the
 * venue it was read with.
 */
async function applyFourMemeTax(
  next: Map<string, CachedVenue>,
  readNow: ReadonlySet<string>,
  options: { readFourMemeCodes: FourMemeCodeReader; readFourMemeTaxes: FourMemeTaxReader; signal: AbortSignal },
): Promise<string[]> {
  const failures: string[] = [];
  const graduated = [...readNow].filter((address) => {
    const entry = next.get(address);
    return entry?.launchpad === "fourmeme" && entry.venue === "pancake-v2";
  });
  if (graduated.length === 0) return failures;

  const unread = graduated.filter((address) => next.get(address)!.fourmemeCode === undefined).slice(0, CODE_READS_PER_CYCLE);
  if (unread.length > 0) {
    try {
      const codes = await options.readFourMemeCodes(unread, AbortSignal.any([options.signal, AbortSignal.timeout(CODE_PHASE_MS)]));
      for (const address of unread) {
        const entry = next.get(address);
        const fourmemeCode = codes.get(address);
        if (entry !== undefined && fourmemeCode !== undefined) next.set(address, { ...entry, fourmemeCode });
      }
      if (codes.size < unread.length) failures.push(`fourmeme code: ${unread.length - codes.size} of ${unread.length} unread`);
    } catch (error) {
      failures.push(`fourmeme code: ${sanitizeMessage(error)}`);
    }
  }

  const items = graduated.flatMap((address) => {
    const code = next.get(address)!.fourmemeCode;
    const template = code === undefined ? null : matchFourMemeTemplate(code);
    return template === null ? [] : [{ address, template }];
  });
  let taxes = new Map<string, FourMemeTaxRead>();
  if (items.length > 0) {
    try {
      taxes = await options.readFourMemeTaxes(items, options.signal);
    } catch (error) {
      failures.push(`fourmeme tax: ${sanitizeMessage(error)}`);
    }
  }
  const unanswered = items.filter((item) => !taxes.has(item.address)).length;
  if (unanswered > 0 && unanswered < items.length) failures.push(`fourmeme tax: ${unanswered} of ${items.length} unread`);
  for (const address of graduated) {
    const entry = next.get(address)!;
    const read = taxes.get(address);
    if (read === undefined) {
      next.set(address, { ...entry, tax: null, pool: null });
      continue;
    }
    if (read.tax === null) failures.push(`fourmeme tax: rate out of range on ${address}`);
    next.set(address, { ...entry, tax: read.tax, pool: read.pool, fourmemeTaxReadAt: entry.checkedAt });
  }
  return failures;
}

/** The production Four.Meme readers, for callers that do not inject their own. */
export const fourMemeReadersOnchain = { readFourMemeCodes, readFourMemeTaxes };

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
      ...(isFourMemeCode(entry.fourmemeCode) ? { fourmemeCode: entry.fourmemeCode } : {}),
      ...(typeof entry.fourmemeTaxReadAt === "number" ? { fourmemeTaxReadAt: entry.fourmemeTaxReadAt } : {}),
    });
  }
  return out;
}

function isFourMemeCode(value: unknown): value is FourMemeCode {
  if (typeof value !== "object" || value === null) return false;
  const { code, creatorType } = value as Partial<FourMemeCode>;
  return typeof code === "string" && (creatorType === null || (typeof creatorType === "number" && Number.isInteger(creatorType)));
}
