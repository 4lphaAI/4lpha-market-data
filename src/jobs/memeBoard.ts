/**
 * `meme-board` job — the classified meme board behind `GET /memes`.
 *
 * Discovery has two sources because they see different tokens. Binance's keyless
 * Meme Rush (New / Finalizing / Migrated, bonding-curve tokens included) is the
 * launch lifecycle: six calls a cycle, one per stage per launchpad, because a
 * shared call caps both launchpads at 100 rows together and Flap crowds
 * Four.Meme out. OKX's hot-token ranking (most trades over 5m and 1h, per
 * launchpad — four calls) is what is trading now at any age: measured
 * 2026-10-04 it found 45 live Four.Meme charts where Meme Rush found 4, mostly
 * graduated tokens the lifecycle lists dropped long ago. Liveness is OnchainOS `price-info`
 * (windowed trade counts, 100 tokens a call) and the OKX smart-money/KOL/whale
 * signal feed — one more call. GMGN is deliberately not on this path: its per-IP
 * ban is host-wide (decided 2026-10-04).
 *
 * The board outlives the lists. Meme Rush's New list turns over in ~2.6 minutes,
 * so a token that starts running after it scrolled off would be lost if the board
 * were only the current lists. A token that leaves the lists is kept while it is
 * still alive (up to 24h), and dropped as soon as it is dead or, if OKX never
 * indexed it, once it is past the new-token grace period. Listed tokens dead for
 * 2h are dropped too — the board is for finding runners, not for an obituary.
 * When the cap binds, listed tokens come first and retained ones by last hour's
 * trades, so the slots go to tokens that are trading rather than to the newest.
 */

import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import {
  fetchMemeRush,
  fetchSmartMoneyInflow,
  type MemeLaunchpad,
  type MemeRushRow,
  type MemeRushStage,
  type SmartInflowRow,
} from "../adapters/binanceWeb3.js";
import { sanitizeMessage } from "../adapters/http.js";
import {
  fetchOnchainosActivity,
  fetchOnchainosHotTokens,
  fetchOnchainosSignals,
  type HotTimeframe,
  type HotToken,
  type SmartSignal,
  type TokenActivity,
} from "../adapters/onchainos.js";
import { readLaunchpadStates, type LaunchpadState, type LaunchpadStateReader } from "../query/launchpadState.js";
import { MEME_RULES, classifyMeme, findClones, type MemeBoardRow, type SmartInflow } from "../query/memeClassify.js";
import { resolveQuotes, type IssuerReader } from "../query/quoteKind.js";
import {
  fourMemeReadersOnchain,
  readDividendsOnchain,
  refreshVenues,
  type CachedVenue,
  type DividendReader,
} from "./memeVenues.js";
import type { FourMemeCodeReader, FourMemeTaxReader } from "../query/fourmemeTax.js";

export const MEME_BOARD_JOB = "meme-board";
/** Public board, served by `GET /memes`. */
export const MEME_BOARD_KEY = "memes:board";
/** Internal tracking state: the last Meme Rush row per token, and the signal window. */
export const MEME_STATE_KEY = "memes:state";

/**
 * Six Meme Rush lists return ~520 distinct tokens and the four hot rankings add
 * up to ~200 more; the cap leaves room for the ones still running off-list.
 */
export const MEME_BOARD_CAP = 800;
const TRACK_FOR_MS = 24 * 3_600_000;
const DROP_DEAD_AFTER_MS = 2 * 3_600_000;
const MAX_SIGNALS = 1_000;

const BOARD_FRESH_MS = 3 * 60_000;
const BOARD_DEAD_MS = 30 * 60_000;

/** Later lists win when a token is on two at once: migrated is more news than new. */
const STAGE_ORDER: MemeRushStage[] = ["new", "finalizing", "migrated"];
const LAUNCHPADS: MemeLaunchpad[] = ["flap", "fourmeme"];
/** 1h first, so a hot-only token is seeded from its 1h row. Both splits ride on the row (`flow1h`, `flow5m`). */
const HOT_TIMEFRAMES: HotTimeframe[] = ["1h", "5m"];
/** Smart-money net-inflow windows read every cycle (two keyless Binance calls). */
type InflowWindow = "5m" | "1h";
const INFLOW_WINDOWS: InflowWindow[] = ["5m", "1h"];

interface TrackedToken {
  /**
   * The token's facts. From Meme Rush when it was ever listed there; for a token
   * only OKX's hot ranking has carried, synthesised from that row plus the
   * launchpad's on-chain state (see {@link seedFromHot}).
   */
  rush: MemeRushRow;
  firstSeenAt: number;
  lastListedAt: number;
  deadSince: number | null;
}

interface MemeState {
  tracked: Record<string, TrackedToken>;
  signals: SmartSignal[];
}

export interface MemeBoardResult {
  rows: number;
  listed: number;
  byStatus: Record<string, number>;
  activityCovered: number;
  signals: number;
  failures: string[];
}

export interface RunMemeBoardOptions {
  fetchRush?:
    | ((stage: MemeRushStage, launchpad: MemeLaunchpad, signal: AbortSignal) => Promise<MemeRushRow[]>)
    | undefined;
  fetchActivity?: ((addresses: string[], signal: AbortSignal) => Promise<Map<string, TokenActivity>>) | undefined;
  fetchSignals?: ((signal: AbortSignal) => Promise<SmartSignal[]>) | undefined;
  fetchHot?:
    | ((launchpad: MemeLaunchpad, timeframe: HotTimeframe, signal: AbortSignal) => Promise<HotToken[]>)
    | undefined;
  fetchInflow?: ((window: InflowWindow, signal: AbortSignal) => Promise<SmartInflowRow[]>) | undefined;
  readStates?: LaunchpadStateReader | undefined;
  readDividends?: DividendReader | undefined;
  readFourMemeCodes?: FourMemeCodeReader | undefined;
  readFourMemeTaxes?: FourMemeTaxReader | undefined;
  readIssuer?: IssuerReader | undefined;
  now?: (() => number) | undefined;
}

export async function runMemeBoard(
  store: SnapshotStore,
  signal: AbortSignal,
  options: RunMemeBoardOptions = {},
): Promise<MemeBoardResult> {
  const now = (options.now ?? Date.now)();
  const fetchRush =
    options.fetchRush ?? ((stage, launchpad, s) => fetchMemeRush({ stage, launchpad, signal: s }));
  const fetchActivity =
    options.fetchActivity ?? ((addresses, s) => fetchOnchainosActivity({ addresses, signal: s }));
  const fetchSignals = options.fetchSignals ?? ((s) => fetchOnchainosSignals({ signal: s }));
  const fetchHot =
    options.fetchHot ?? ((launchpad, timeframe, s) => fetchOnchainosHotTokens({ launchpad, timeframe, signal: s }));
  const fetchInflow = options.fetchInflow ?? ((window, s) => fetchSmartMoneyInflow({ period: window, signal: s }));
  const readStates = options.readStates ?? readLaunchpadStates;
  const readDividends = options.readDividends ?? readDividendsOnchain;
  const readFourMemeCodes = options.readFourMemeCodes ?? fourMemeReadersOnchain.readFourMemeCodes;
  const readFourMemeTaxes = options.readFourMemeTaxes ?? fourMemeReadersOnchain.readFourMemeTaxes;
  const failures: string[] = [];

  // 1. Discovery, from two sources that see different tokens. Meme Rush is the
  // launch lifecycle (new, about to graduate, just graduated); OKX's hot ranking
  // is whatever is trading most right now, at any age. A partial cycle still
  // publishes; only a total failure throws, and then nothing is restamped.
  const listed = new Map<string, MemeRushRow>();
  const listedOn = new Map<string, string[]>();
  const tag = (address: string, label: string) => {
    const labels = listedOn.get(address) ?? [];
    if (!labels.includes(label)) labels.push(label);
    listedOn.set(address, labels);
  };
  for (const stage of STAGE_ORDER) {
    for (const launchpad of LAUNCHPADS) {
      try {
        for (const row of await fetchRush(stage, launchpad, signal)) {
          listed.set(row.address, row);
          tag(row.address, `meme-rush:${stage}`);
        }
      } catch (error) {
        failures.push(`rush:${launchpad}:${stage}: ${sanitizeMessage(error)}`);
      }
    }
  }
  const hot1h = new Map<string, HotToken>();
  const hot5m = new Map<string, HotToken>();
  const hotOnly = new Map<string, HotToken>();
  for (const launchpad of LAUNCHPADS) {
    for (const timeframe of HOT_TIMEFRAMES) {
      try {
        for (const row of await fetchHot(launchpad, timeframe, signal)) {
          tag(row.address, `okx-hot:${timeframe}`);
          (timeframe === "1h" ? hot1h : hot5m).set(row.address, row);
          if (!listed.has(row.address) && !hotOnly.has(row.address)) hotOnly.set(row.address, row);
        }
      } catch (error) {
        failures.push(`hot:${launchpad}:${timeframe}: ${sanitizeMessage(error)}`);
      }
    }
  }
  if (listed.size === 0 && hotOnly.size === 0) {
    throw new Error(`no discovery source available (${failures.join("; ")})`);
  }

  // 2. Merge into what is already tracked, then prune and cap. A hot-only token
  // is placed in its life cycle by the launchpad itself, read on chain every
  // cycle (graduation is the one fact that moves); one the launchpad does not
  // know, or a batch no endpoint served, is skipped rather than guessed.
  const state = await readState(store);
  const previousBoard = await readBoard(store);
  const states = await readStates(
    [...hotOnly.values()].map((row) => ({ address: row.address, launchpad: row.launchpad })),
    signal,
  );
  for (const [address, hot] of hotOnly) {
    const launchpadState = states.get(address);
    if (launchpadState === undefined) continue;
    listed.set(address, seedFromHot(hot, launchpadState, state.tracked[address]?.rush, now));
  }
  for (const [address, rush] of listed) {
    const previous = state.tracked[address];
    state.tracked[address] = {
      rush,
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastListedAt: now,
      deadSince: previous?.deadSince ?? null,
    };
  }
  const tracked = Object.values(state.tracked)
    .filter((token) => keepTracking(token, previousBoard.get(token.rush.address), now))
    .sort((a, b) => retentionOrder(a, b, previousBoard, now))
    .slice(0, MEME_BOARD_CAP);
  const addresses = tracked.map((token) => token.rush.address);

  // 2b. Venue, tax and dividend from the launchpads (cached; see memeVenues.ts).
  // If the refresh itself fails (the cache key could not be read or written),
  // each row keeps what the previous board said rather than reading as "never
  // read"; the board never fails for it (audit F2).
  let venues = new Map<string, CachedVenue>();
  try {
    const refreshed = await refreshVenues(
      store,
      tracked.map((token) => ({
        address: token.rush.address,
        launchpad: token.rush.launchpad,
        status: previousBoard.get(token.rush.address)?.status,
      })),
      states,
      { readStates, readDividends, readFourMemeCodes, readFourMemeTaxes, now, signal },
    );
    venues = refreshed.venues;
    failures.push(...refreshed.failures);
  } catch (error) {
    failures.push(`venues: ${sanitizeMessage(error)}`);
    for (const row of previousBoard.values()) {
      if (row.venueCheckedAt == null) continue;
      venues.set(row.address, {
        launchpad: row.launchpad,
        venue: row.venue ?? null,
        tax: row.tax ?? null,
        pool: row.pool ?? null,
        nativeToQuoteSwapEnabled: row.nativeToQuoteSwapEnabled ?? null,
        dividend: row.dividend ?? null,
        checkedAt: row.venueCheckedAt,
      });
    }
  }

  // 3. Liveness. An OKX failure falls back to each row's previous activity
  // rather than turning the whole board `unknown` — `observedAt` still dates it.
  let activity = new Map<string, TokenActivity>();
  try {
    activity = await fetchActivity(addresses, signal);
  } catch (error) {
    failures.push(`activity: ${sanitizeMessage(error)}`);
    for (const row of previousBoard.values()) {
      if (row.activity !== null) activity.set(row.address, { address: row.address, ...row.activity });
    }
  }

  // 4. Signals accumulate across cycles: one call returns ~41h on BSC today,
  // but a busier day would push older ones out of a single page.
  try {
    const fresh = await fetchSignals(signal);
    const byId = new Map(state.signals.map((s) => [s.id, s]));
    for (const s of fresh) byId.set(s.id, s);
    state.signals = [...byId.values()];
  } catch (error) {
    failures.push(`signals: ${sanitizeMessage(error)}`);
  }
  const signalSince = now - MEME_RULES.signalWindowHours * 3_600_000;
  state.signals = state.signals
    .filter((s) => s.at >= signalSince)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_SIGNALS);
  const signalsByToken = new Map<string, SmartSignal[]>();
  for (const s of state.signals) {
    const list = signalsByToken.get(s.address) ?? [];
    list.push(s);
    signalsByToken.set(s.address, list);
  }

  // 4b. Smart-money net inflow, ranked per window by Binance. A window that
  // cannot be read keeps last cycle's rank while it is younger than the board's
  // own freshness; past that the row says `null` (unknown) rather than carry an
  // old rank as current.
  const inflow: Record<InflowWindow, Map<string, SmartInflow>> = { "5m": new Map(), "1h": new Map() };
  for (const window of INFLOW_WINDOWS) {
    try {
      for (const row of await fetchInflow(window, signal)) {
        inflow[window].set(row.address, { netUsd: row.netInflowUsd, traders: row.traders, rank: row.rank, rankedAt: now });
      }
    } catch (error) {
      failures.push(`inflow:${window}: ${sanitizeMessage(error)}`);
      for (const row of previousBoard.values()) {
        const last = window === "5m" ? row.smartMoney?.inflow5m : row.smartMoney?.inflow1h;
        if (last != null && now - last.rankedAt < BOARD_FRESH_MS) inflow[window].set(row.address, last);
      }
    }
  }

  // 5. Quote kinds (cached forever) and clones (relative to what is tracked).
  const quotes = await resolveQuotes(
    store,
    tracked.flatMap((token) => (token.rush.quote === null ? [] : [token.rush.quote])),
    { signal, readIssuer: options.readIssuer },
  );
  const clones = findClones(tracked.map((token) => token.rush));

  // 6. Classify.
  const rows: MemeBoardRow[] = tracked.map((token) =>
    classifyMeme({
      rush: token.rush,
      activity: activity.get(token.rush.address) ?? null,
      signals: signalsByToken.get(token.rush.address) ?? [],
      quote: token.rush.quote === null ? null : (quotes.get(token.rush.quote) ?? null),
      cloneOf: clones.get(token.rush.address) ?? null,
      listedOn: listedOn.get(token.rush.address) ?? [],
      flow1h: flowOf(hot1h.get(token.rush.address)),
      flow5m: flowOf(hot5m.get(token.rush.address)),
      inflow5m: inflow["5m"].get(token.rush.address) ?? null,
      inflow1h: inflow["1h"].get(token.rush.address) ?? null,
      venue: venues.get(token.rush.address) ?? null,
      lastListedAt: token.lastListedAt,
      firstSeenAt: token.firstSeenAt,
      previousDeadSince: token.deadSince,
      now,
    }),
  );

  const nextTracked: Record<string, TrackedToken> = {};
  for (const [index, token] of tracked.entries()) {
    nextTracked[token.rush.address] = { ...token, deadSince: rows[index]?.deadSince ?? null };
  }
  state.tracked = nextTracked;

  await store.put(MEME_STATE_KEY, state, {
    source: MEME_BOARD_JOB,
    freshForMs: BOARD_FRESH_MS,
    deadAfterMs: TRACK_FOR_MS,
  });
  await store.put(MEME_BOARD_KEY, rows, {
    source: "binance-meme-rush+okx-hot+onchainos",
    freshForMs: BOARD_FRESH_MS,
    deadAfterMs: BOARD_DEAD_MS,
  });

  if (failures.length > 0) console.warn(`[${MEME_BOARD_JOB}] partial cycle: ${failures.join("; ")}`);

  const byStatus: Record<string, number> = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  return {
    rows: rows.length,
    listed: listed.size,
    byStatus,
    activityCovered: rows.filter((row) => row.activity !== null).length,
    signals: state.signals.length,
    failures,
  };
}

/**
 * A Meme Rush-shaped row for a token only the hot ranking carries. Lifecycle
 * facts come from the launchpad's own on-chain state; market and holder-mix
 * fields from the OKX row. Fields only Meme Rush supplies (tagged-holder
 * counts, dev-sold, wash tags, sniper share) keep what an earlier Meme Rush
 * listing said, else stay unknown — `null`, or `false` for the two booleans,
 * which is why a hot-only row cannot raise `dev_sold_all` or `wash_trading`.
 */
export function seedFromHot(
  hot: HotToken,
  launchpadState: LaunchpadState,
  previous: MemeRushRow | undefined,
  now: number,
): MemeRushRow {
  const base: MemeRushRow = previous ?? {
    address: hot.address,
    symbol: hot.symbol,
    name: null,
    launchpad: hot.launchpad,
    stage: "finalizing",
    createdAt: launchpadState.launchedAt ?? hot.firstTradeAt ?? now,
    progress: null,
    migrated: false,
    migratedAt: null,
    quote: null,
    priceUsd: null,
    marketCapUsd: null,
    liquidityUsd: null,
    volume24hUsd: null,
    priceChange24hPct: null,
    holders: null,
    count24h: null,
    buys24h: null,
    sells24h: null,
    netBuy24hUsd: null,
    top10Pct: null,
    devPct: null,
    sniperPct: null,
    insiderPct: null,
    bundlerPct: null,
    newWalletPct: null,
    smartMoneyHolders: null,
    kolHolders: null,
    devAddress: null,
    devSoldAll: false,
    devMigrateCount: null,
    washTrading: false,
    socials: { website: null, twitter: null, telegram: null },
  };
  return {
    ...base,
    stage: launchpadState.migrated ? "migrated" : base.stage,
    progress: launchpadState.progress,
    migrated: launchpadState.migrated,
    quote: launchpadState.quote ?? base.quote,
    marketCapUsd: hot.marketCapUsd ?? base.marketCapUsd,
    liquidityUsd: hot.liquidityUsd ?? base.liquidityUsd,
    holders: hot.holders ?? base.holders,
    top10Pct: hot.top10Pct ?? base.top10Pct,
    devPct: hot.devPct ?? base.devPct,
    insiderPct: hot.insiderPct ?? base.insiderPct,
    bundlerPct: hot.bundlerPct ?? base.bundlerPct,
  };
}

function flowOf(hot: HotToken | undefined): MemeBoardRow["flow1h"] {
  if (hot === undefined) return null;
  return { buys: hot.txsBuy, sells: hot.txsSell, uniqueTraders: hot.uniqueTraders, inflowUsd: hot.inflowUsd };
}

/** Whether a tracked token stays on the board this cycle. */
function keepTracking(token: TrackedToken, last: MemeBoardRow | undefined, now: number): boolean {
  if (now - token.lastListedAt > TRACK_FOR_MS) return false;
  if (token.deadSince !== null && now - token.deadSince > DROP_DEAD_AFTER_MS) return false;
  if (token.lastListedAt === now) return true;
  // Off every list: kept only while it is worth watching.
  if (last === undefined || last.status === "dead") return false;
  // Unindexed or barely-traded launches scroll off by the hundred; one that has
  // not woken up by the end of the grace period is not worth a slot.
  if (last.status === "unknown" || last.status === "quiet") {
    return now - token.rush.createdAt <= MEME_RULES.deadMinAgeMin * 60_000;
  }
  return true;
}

/** Listed first; then whoever traded most in the last hour. */
function retentionOrder(
  a: TrackedToken,
  b: TrackedToken,
  previous: Map<string, MemeBoardRow>,
  now: number,
): number {
  const listedA = a.lastListedAt === now ? 1 : 0;
  const listedB = b.lastListedAt === now ? 1 : 0;
  if (listedA !== listedB) return listedB - listedA;
  const txsA = previous.get(a.rush.address)?.activity?.txs1h ?? -1;
  const txsB = previous.get(b.rush.address)?.activity?.txs1h ?? -1;
  return txsB - txsA || b.rush.createdAt - a.rush.createdAt;
}

async function readState(store: SnapshotStore): Promise<MemeState> {
  const record = await store.get<unknown>(MEME_STATE_KEY);
  const data = record?.data;
  if (typeof data !== "object" || data === null) return { tracked: {}, signals: [] };
  const raw = data as { tracked?: unknown; signals?: unknown };
  const tracked: Record<string, TrackedToken> = {};
  if (typeof raw.tracked === "object" && raw.tracked !== null) {
    for (const [address, value] of Object.entries(raw.tracked as Record<string, unknown>)) {
      if (isTracked(value)) tracked[address] = value;
    }
  }
  const signals = Array.isArray(raw.signals) ? (raw.signals as SmartSignal[]).filter(isSignal) : [];
  return { tracked, signals };
}

/** The store outlives code versions: a row written by an older build is re-checked, not trusted. */
function isTracked(value: unknown): value is TrackedToken {
  if (typeof value !== "object" || value === null) return false;
  const token = value as Partial<TrackedToken>;
  return (
    typeof token.firstSeenAt === "number" &&
    typeof token.lastListedAt === "number" &&
    typeof token.rush === "object" &&
    token.rush !== null &&
    typeof token.rush.address === "string" &&
    typeof token.rush.createdAt === "number" &&
    typeof token.rush.symbol === "string"
  );
}

function isSignal(value: unknown): value is SmartSignal {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Partial<SmartSignal>;
  return typeof s.id === "string" && typeof s.address === "string" && typeof s.at === "number";
}

async function readBoard(store: SnapshotStore): Promise<Map<string, MemeBoardRow>> {
  const record = await store.get<unknown>(MEME_BOARD_KEY);
  const out = new Map<string, MemeBoardRow>();
  if (record === null || !Array.isArray(record.data)) return out;
  for (const row of record.data as MemeBoardRow[]) {
    if (typeof row === "object" && row !== null && typeof row.address === "string") out.set(row.address, row);
  }
  return out;
}

/** Job registration for the scheduler. */
export function memeBoardJob(store: SnapshotStore): JobSpec {
  return {
    name: MEME_BOARD_JOB,
    intervalMs: 60_000,
    jitterMs: 5_000,
    // Six Meme Rush lists, four hot rankings, up to eight 100-token price-info batches,
    // one signal call, two smart-money inflow ranks,
    // and at most one batched issuer read for quote tokens never seen before.
    timeoutMs: 45_000,
    run: async (signal) => {
      await runMemeBoard(store, signal);
    },
  };
}

