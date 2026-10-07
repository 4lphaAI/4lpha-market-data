/**
 * `meme-measure` job — the social / smart-inflow measurement recorder
 * (MEME-SIGNALS-HANDOFF-2026-10-05 item 5; operator ruling 2026-10-05).
 *
 * Social was opened narrowly, measure first: every five minutes this records
 * Binance's keyless social-rush topics with their associated tokens, Binance's
 * smart-money net-inflow rank (5m and 1h, every ranked row), and a compact
 * snapshot of every meme-stock row on the board, dead ones included. The
 * analysis — overlap, lead time of a topic against runner status, forward
 * returns — is done on the execution side from `GET /memes/measure`. **Nothing
 * here reaches the board, the shortlist or any trading read**, and nothing
 * reads these keys but that export route.
 *
 * Storage is a ring of five-minute slots, one store key per slot, sized to the
 * 7-day retention plus an hour. A slot is overwritten when the ring comes back
 * round, so retention needs no delete and the row count is bounded. Every
 * record carries its absolute slot number, and a read that finds a different
 * one in the key (a slot the ring passed without a cycle landing in it) treats
 * the slot as empty rather than serving week-old data as current.
 *
 * The job ticks every minute and records at most once per slot, so samples sit
 * on the wall-clock five-minute grid and the scheduler's jitter cannot drift a
 * cycle past a slot boundary. A lease keeps two replicas from recording the same
 * slot.
 *
 * Rows are written as positional tuples with their column names in the record
 * (about a third of the object form), numbers rounded to six significant
 * digits. Topic dedupe is done at the source: the AI summary and every other
 * free-text field are dropped by the adapter, which is most of the ~72 KB a raw
 * topic list weighs.
 *
 * Jev text features (JEV-TEXT-FEATURES-HANDOFF-2026-10-07), behind
 * `MEME_JEV_ENABLED` and `TYPESAFE_API_KEY`, both needed: a meme-stock row gets
 * a TypeSafe Jev Score of how strongly the meme is themed on its quote stock,
 * and a topic-token row a Noul (is the topic about the token) and a Choice (the
 * topic's tone). The inputs are symbols, names, the topic name, type and tags,
 * never post text. Each answer is asked once and cached forever, one store key
 * per token or pair, written only after a valid answer. A failed, rate-limited
 * or malformed answer leaves the columns `null` for that slot and is asked
 * again next cycle; it never fails the cycle. Off, nothing is sent and the
 * columns are `null`.
 */

import { randomUUID } from "node:crypto";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import {
  fetchSmartMoneyInflow,
  fetchSocialRush,
  type SmartInflowPeriod,
  type SmartInflowRow,
  type SocialRushRank,
  type SocialTopic,
} from "../adapters/binanceWeb3.js";
import { AdapterError, isRecord, sanitizeMessage, type FetchFn } from "../adapters/http.js";
import {
  askJev,
  parseChoiceAnswer,
  parseNoulAnswer,
  parseScoreAnswer,
  type JevChoice,
  type JevNoul,
  type JevQuestion,
  type JevScore,
} from "../adapters/typesafe.js";
import { MEME_FLAGS, type MemeBoardRow, type MemeFlag } from "../query/memeClassify.js";
import { buildShortlist, parseShortlistQuery } from "../query/memeQuery.js";
import { loadStockInfo, rwaRowsByAddress } from "../query/memeStocks.js";
import { RWA_UNIVERSE_KEY } from "../universe.js";
import { MEME_BOARD_KEY } from "./memeBoard.js";

export const MEME_MEASURE_JOB = "meme-measure";
export const MEME_MEASURE_SOURCE = "binance-social-rush+smart-inflow+meme-board";
/** One recorded cycle per slot. */
export const MEME_MEASURE_SLOT_MS = 5 * 60_000;
export const MEME_MEASURE_RETENTION_MS = 7 * 86_400_000;
/** Retention plus one hour, so the oldest slot inside the window is never the one being overwritten. */
export const MEME_MEASURE_SLOTS = MEME_MEASURE_RETENTION_MS / MEME_MEASURE_SLOT_MS + 12;
export const MEME_MEASURE_LATEST_KEY = "memes:measure:v1:latest";
export const MEME_MEASURE_LEASE = "memes:measure:v1:recorder";
/** Longer than the gap between two ticks of the holder (60 s + jitter), so it keeps the lease. */
export const MEME_MEASURE_LEASE_TTL_MS = 120_000;
const TICK_MS = 60_000;

/** The ring key of an absolute slot number. */
export function memeMeasureSlotKey(slot: number): string {
  return `memes:measure:v1:slot:${((slot % MEME_MEASURE_SLOTS) + MEME_MEASURE_SLOTS) % MEME_MEASURE_SLOTS}`;
}

export function slotOf(ts: number): number {
  return Math.floor(ts / MEME_MEASURE_SLOT_MS);
}

type Cell = string | number | boolean | null;
type Tuple = Cell[];

export const TOPIC_COLUMNS = [
  "topicId", "nameEn", "type", "tags", "link", "createdAt", "risingAt", "viralAt", "progress",
  "netInflowUsd", "netInflow1hUsd", "netInflowAthUsd",
] as const;
export const TOPIC_TOKEN_COLUMNS = [
  "topic", "address", "symbol", "protocol", "migrated", "createdAt", "netInflowUsd", "netInflow1hUsd",
  "volume1hBuyUsd", "volume1hSellUsd", "marketCapUsd", "liquidityUsd", "priceChange24hPct",
  "uniqueTraders5m", "uniqueTraders1h", "count5m", "count1h", "holders", "smartMoneyHolders", "kolHolders",
  "jevAboutToken", "jevTone", "jevToneProbabilities", "jevModel",
] as const;
export const INFLOW_COLUMNS = [
  "rank", "address", "name", "netInflowUsd", "traders", "count", "countBuy", "countSell", "volumeUsd",
  "priceUsd", "marketCapUsd", "liquidityUsd", "holders", "top10Pct", "riskLevel", "riskCodes", "aiNarrative",
  "launchedAt",
] as const;
export const BOARD_COLUMNS = [
  "address", "symbol", "launchpad", "stage", "status", "category", "quoteSymbol", "flags", "createdAt",
  "priceUsd", "liquidityUsd", "marketCapUsd", "txs5m", "txs1h", "volume5mUsd", "volume1hUsd",
  "priceChange5mPct", "priceChange1hPct", "activityAgeS", "buys1h", "sells1h", "inflow1hUsd", "uniqueTraders1h",
  "smHolders", "kolHolders", "smSignals", "kolSignals", "whaleSignals", "onShortlist",
  "jevStockScore", "jevStockProbabilities", "jevModel",
] as const;

export interface MeasureSection {
  columns: readonly string[];
  rows: Tuple[];
}

/** One recorded cycle, as stored. */
export interface MeasureCycle {
  v: 1;
  slot: number;
  /** When the cycle started, epoch ms. */
  ts: number;
  durationMs: number;
  /** Sanitized per-source failures; a failed source is `null` below. */
  failures: string[];
  topics: {
    /** Topic ids in list order. `rising` is `"same"` when it matched `latest`, `null` when unread. */
    lists: { latest: string[]; rising: string[] | "same" | null };
    topics: MeasureSection;
    tokens: MeasureSection;
  } | null;
  inflow: { columns: readonly string[]; "5m": Tuple[] | null; "1h": Tuple[] | null };
  /**
   * Every meme-stock row on the board (`quote.kind == "bstock"`, any status).
   * `null` when the board record was not fresh: a stale board recorded as if
   * current would put old prices into forward-return analysis.
   */
  board: (MeasureSection & {
    asOf: number;
    shortlistSize: number;
    flagBits: readonly string[];
    /** Columns stored as an index into `dict` (a few distinct values over hundreds of rows). */
    dictColumns: readonly string[];
    dict: string[];
  }) | null;
}

/** Low-cardinality board columns, stored as indexes into the record's own `dict`. */
export const BOARD_DICT_COLUMNS = ["launchpad", "stage", "status", "category", "quoteSymbol"] as const;

/** Replaces string cells of `dictColumns` with their index in a per-record dictionary; `null` stays `null`. */
export function dictEncode(
  rows: readonly Tuple[],
  columns: readonly string[],
  dictColumns: readonly string[],
): { dict: string[]; rows: Tuple[] } {
  const dict: string[] = [];
  const index = new Map<string, number>();
  const at = dictColumns.map((column) => columns.indexOf(column)).filter((i) => i >= 0);
  const out = rows.map((row) => {
    const copy = [...row];
    for (const i of at) {
      const cell = copy[i];
      if (typeof cell !== "string") continue;
      let n = index.get(cell);
      if (n === undefined) {
        n = dict.length;
        dict.push(cell);
        index.set(cell, n);
      }
      copy[i] = n;
    }
    return copy;
  });
  return { dict, rows: out };
}

function dictDecode(rows: readonly Tuple[], columns: readonly string[], dictColumns: readonly string[], dict: readonly string[]): Tuple[] {
  const at = dictColumns.map((column) => columns.indexOf(column)).filter((i) => i >= 0);
  return rows.map((row) => {
    const copy = [...row];
    for (const i of at) {
      const cell = copy[i];
      if (typeof cell === "number") copy[i] = dict[cell] ?? null;
    }
    return copy;
  });
}

/**
 * Bit `i` of a board row's `flags` is `flagBits[i]`. The legend is written into
 * every record, so a flag added to the classifier later cannot shift the
 * meaning of a bit in records already stored.
 */
export const BOARD_FLAG_BITS: readonly MemeFlag[] = MEME_FLAGS.filter((flag) => flag !== "bstock_quote");

function flagMask(flags: readonly MemeFlag[]): number {
  let mask = 0;
  for (const flag of flags) {
    const bit = BOARD_FLAG_BITS.indexOf(flag);
    if (bit >= 0) mask |= 1 << bit;
  }
  return mask;
}

function flagNames(mask: unknown, legend: readonly string[]): string[] | null {
  if (typeof mask !== "number") return null;
  return legend.filter((_, bit) => (mask & (1 << bit)) !== 0);
}

/** Summary of the last recorded cycle; also where `/status` and the export read progress. */
export interface MeasureLatest {
  slot: number;
  ts: number;
  bytes: number;
  durationMs: number;
  failures: string[];
  counts: {
    topics: number;
    topicTokens: number;
    memeStocksInTopics: number;
    inflow5m: number | null;
    inflow1h: number | null;
    memeStocksInInflow: number;
    boardRows: number | null;
  };
}

export interface RunMemeMeasureOptions {
  fetchTopics?: ((rank: SocialRushRank, signal: AbortSignal) => Promise<SocialTopic[]>) | undefined;
  fetchInflow?: ((period: SmartInflowPeriod, signal: AbortSignal) => Promise<SmartInflowRow[]>) | undefined;
  now?: (() => number) | undefined;
  /** Lease holder; one per process. */
  holder?: string | undefined;
  /** TypeSafe key, set only when Jev is enabled ({@link memeJevApiKey}); absent = no request, Jev columns `null`. */
  jevApiKey?: string | null | undefined;
  jevFetch?: FetchFn | undefined;
}

export type MemeMeasureResult =
  | { recorded: true; latest: MeasureLatest }
  | { recorded: false; reason: "slot_recorded" | "lease_held" };

/**
 * Rounds to significant digits. Prices keep six (they span 1e-9 to 1e3, and
 * forward returns are computed from them); USD amounts and percentages keep
 * four, which is 0.1% and well inside what the upstreams themselves agree on.
 */
export function sig(value: number | null | undefined, digits = 6): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value === 0 ? 0 : Number(value.toPrecision(digits));
}

const usd = (value: number | null | undefined): number | null => sig(value, 4);
const pct = usd;

function topicTuple(topic: SocialTopic): Tuple {
  return [
    topic.topicId, topic.nameEn, topic.type, topic.tags.join("|"), topic.link, topic.createdAt, topic.risingAt,
    topic.viralAt, pct(topic.progress), usd(topic.netInflowUsd), usd(topic.netInflow1hUsd), usd(topic.netInflowAthUsd),
  ];
}

/** Probabilities in the given key order, `|`-joined (the cell form of `tags`). */
function probabilityCell(probabilities: Readonly<Record<string, number>>, keys: readonly string[]): string {
  return keys.map((key) => sig(probabilities[key], 4)).join("|");
}

/** `topic` is the index of the token's topic in the same cycle's `topics.rows`. */
function topicTokenTuples(topic: SocialTopic, index: number, jev: ReadonlyMap<string, JevTopicEntry>): Tuple[] {
  return topic.tokens.map((t) => {
    const j = jev.get(jevTopicKey(topic.topicId, t.address));
    return [
      index, t.address, t.symbol, t.protocol, t.migrated, t.createdAt, usd(t.netInflowUsd),
      usd(t.netInflow1hUsd), usd(t.volume1hBuyUsd), usd(t.volume1hSellUsd), usd(t.marketCapUsd), usd(t.liquidityUsd),
      pct(t.priceChange24hPct), t.uniqueTraders5m, t.uniqueTraders1h, t.count5m, t.count1h, t.holders,
      t.smartMoneyHolders, t.kolHolders,
      j === undefined ? null : sig(j.about.noul, 4), j?.tone.choice ?? null,
      j === undefined ? null : probabilityCell(j.tone.probabilities, JEV_TONES), j?.model ?? null,
    ];
  });
}

function inflowTuple(row: SmartInflowRow): Tuple {
  return [
    row.rank, row.address, row.name, usd(row.netInflowUsd), row.traders, row.count, row.countBuy, row.countSell,
    usd(row.volumeUsd), sig(row.priceUsd), usd(row.marketCapUsd), usd(row.liquidityUsd), row.holders,
    pct(row.top10Pct), row.riskLevel, row.riskCodes.join("|"), row.aiNarrative, row.launchedAt,
  ];
}

/**
 * Exported for tests. `bstock_quote` is dropped from `flags`: every recorded row
 * carries it by construction. `activityAgeS` is how old OKX's activity reading
 * was at the cycle (it is reused from the previous board cycle when OKX fails).
 */
export function boardTuple(row: MemeBoardRow, onShortlist: boolean, cycleTs: number, jev?: JevStockEntry): Tuple {
  const a = row.activity;
  const f = row.flow1h;
  const sm = row.smartMoney;
  const observedAt = a?.observedAt ?? null;
  return [
    row.address, row.symbol.slice(0, 40), row.launchpad, row.stage, row.status, row.category, row.quote.symbol,
    flagMask(row.flags), row.createdAt,
    sig(row.market.priceUsd), usd(row.market.liquidityUsd), usd(row.market.marketCapUsd),
    a?.txs5m ?? null, a?.txs1h ?? null, usd(a?.volume5mUsd), usd(a?.volume1hUsd),
    pct(a?.priceChange5mPct), pct(a?.priceChange1hPct),
    observedAt === null ? null : Math.round((cycleTs - observedAt) / 1000),
    f?.buys ?? null, f?.sells ?? null, usd(f?.inflowUsd), f?.uniqueTraders ?? null,
    sm.holders, sm.kolHolders, sm.signals.smart_money ?? 0, sm.signals.kol ?? 0, sm.signals.whale ?? 0,
    onShortlist,
    jev === undefined ? null : sig(jev.answer.score, 4),
    jev === undefined ? null : probabilityCell(jev.answer.probabilities, JEV_STOCK_LEVEL_KEYS),
    jev?.model ?? null,
  ];
}

/** True when `rising` lists the same topics in the same order as `latest`. */
function sameOrder(a: readonly SocialTopic[], b: readonly SocialTopic[]): boolean {
  return a.length === b.length && a.every((topic, i) => topic.topicId === b[i]?.topicId);
}

/** Runs one tick. Exported so tests and scripts can drive it directly. */
export async function runMemeMeasure(
  store: SnapshotStore,
  signal: AbortSignal,
  options: RunMemeMeasureOptions = {},
): Promise<MemeMeasureResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const slot = slotOf(started);

  // Cheap check first: most ticks find this slot already recorded. Monotonic,
  // not equality: a replica whose clock runs behind must not go back and
  // re-record a slot another replica has already moved past (audit F1).
  const last = await store.get<MeasureLatest>(MEME_MEASURE_LATEST_KEY);
  if (last !== null && typeof last.data?.slot === "number" && last.data.slot >= slot) {
    return { recorded: false, reason: "slot_recorded" };
  }
  if (!await store.acquireSchedulerLease(MEME_MEASURE_LEASE, options.holder ?? HOLDER, MEME_MEASURE_LEASE_TTL_MS)) {
    return { recorded: false, reason: "lease_held" };
  }

  const fetchTopics = options.fetchTopics ?? ((rank, s) => fetchSocialRush({ rank, signal: s }));
  const fetchInflow = options.fetchInflow ?? ((period, s) => fetchSmartMoneyInflow({ period, signal: s }));
  const failures: string[] = [];

  // Four keyless calls, all through the shared Binance-host semaphore.
  const [latest, rising, inflow5m, inflow1h] = await Promise.allSettled([
    fetchTopics("latest", signal),
    fetchTopics("rising", signal),
    fetchInflow("5m", signal),
    fetchInflow("1h", signal),
  ]);
  const settled = <T>(name: string, result: PromiseSettledResult<T>): T | null => {
    if (result.status === "fulfilled") return result.value;
    failures.push(`${name}: ${sanitizeMessage(result.reason)}`);
    return null;
  };
  const latestTopics = settled("topics:latest", latest);
  const risingTopics = settled("topics:rising", rising);
  const rows5m = settled("inflow:5m", inflow5m);
  const rows1h = settled("inflow:1h", inflow1h);

  let allTopics: SocialTopic[] = [];
  let risingIds: string[] | "same" | null = null;
  if (latestTopics !== null) {
    allTopics = [...latestTopics];
    if (risingTopics !== null) {
      if (sameOrder(latestTopics, risingTopics)) risingIds = "same";
      else {
        risingIds = risingTopics.map((topic) => topic.topicId);
        const known = new Set(allTopics.map((topic) => topic.topicId));
        for (const topic of risingTopics) if (!known.has(topic.topicId)) allTopics.push(topic);
      }
    }
  }

  // The board as it stands. Only a fresh record is recorded, and the shortlist
  // flag is computed by the same function `/memes/shortlist?segment=memestock` uses.
  let fresh: { asOf: number; memeStocks: MemeBoardRow[]; onShortlist: Set<string>; shortlistSize: number } | null = null;
  const boardRecord = await store.get<unknown>(MEME_BOARD_KEY);
  if (boardRecord === null || boardRecord.staleness !== "fresh" || !Array.isArray(boardRecord.data)) {
    failures.push(`board: ${boardRecord === null ? "missing" : `not fresh (${boardRecord.staleness})`}`);
  } else {
    const rows = boardRecord.data as MemeBoardRow[];
    const stocks = await loadStockInfo(store);
    const shortlist = buildShortlist(
      rows,
      parseShortlistQuery((name) => (name === "segment" ? "memestock" : undefined)),
      started,
      stocks,
    );
    fresh = {
      asOf: boardRecord.asOf,
      memeStocks: rows.filter((row) => row.quote?.kind === "bstock"),
      onShortlist: new Set(shortlist.rows.map((row) => row.address)),
      shortlistSize: shortlist.rows.length,
    };
  }

  // Jev answers, cached or asked now. A failure here is a note, never a failed cycle.
  let jev: JevAnswers = { stock: new Map(), topic: new Map() };
  if (options.jevApiKey) {
    try {
      jev = await memeJev(store, signal, fresh?.memeStocks ?? [], allTopics, options.jevApiKey, options.jevFetch, failures);
    } catch (error) {
      failures.push(`jev: ${sanitizeMessage(error)}`);
    }
  }

  const topics: MeasureCycle["topics"] = latestTopics === null
    ? null
    : {
        lists: { latest: latestTopics.map((topic) => topic.topicId), rising: risingIds },
        topics: { columns: TOPIC_COLUMNS, rows: allTopics.map(topicTuple) },
        tokens: {
          columns: TOPIC_TOKEN_COLUMNS,
          rows: allTopics.flatMap((topic, index) => topicTokenTuples(topic, index, jev.topic)),
        },
      };

  let board: MeasureCycle["board"] = null;
  if (fresh !== null) {
    const { onShortlist } = fresh;
    const encoded = dictEncode(
      fresh.memeStocks.map((row) => boardTuple(row, onShortlist.has(row.address), started, jev.stock.get(row.address))),
      BOARD_COLUMNS,
      BOARD_DICT_COLUMNS,
    );
    board = {
      asOf: fresh.asOf,
      shortlistSize: fresh.shortlistSize,
      flagBits: BOARD_FLAG_BITS,
      dictColumns: BOARD_DICT_COLUMNS,
      dict: encoded.dict,
      columns: BOARD_COLUMNS,
      rows: encoded.rows,
    };
  }

  if (topics === null && rows5m === null && rows1h === null && board === null) {
    throw new Error(`no measurement source available (${failures.join("; ")})`);
  }

  const cycle: MeasureCycle = {
    v: 1,
    slot,
    ts: started,
    durationMs: now() - started,
    failures,
    topics,
    inflow: {
      columns: INFLOW_COLUMNS,
      "5m": rows5m === null ? null : rows5m.map(inflowTuple),
      "1h": rows1h === null ? null : rows1h.map(inflowTuple),
    },
    board,
  };
  const bytes = Buffer.byteLength(JSON.stringify(cycle));
  // `put` does not take the signal: a run aborted after this point still
  // completes both writes. If `latest` were lost, the next tick re-records the
  // same slot with fresh reads, which is harmless (audit F5).
  // History, not a reading: the record stays readable for the whole retention.
  await store.put(memeMeasureSlotKey(slot), cycle, {
    source: MEME_MEASURE_SOURCE,
    freshForMs: MEME_MEASURE_SLOT_MS * 2,
    deadAfterMs: MEME_MEASURE_RETENTION_MS,
  });

  const memeStockSet = new Set((board?.rows ?? []).map((row) => row[0] as string));
  const topicTokenSet = new Set((topics?.tokens.rows ?? []).map((row) => row[1] as string));
  const inflowSet = new Set([...(rows5m ?? []), ...(rows1h ?? [])].map((row) => row.address));
  const summary: MeasureLatest = {
    slot,
    ts: started,
    bytes,
    durationMs: cycle.durationMs,
    failures,
    counts: {
      topics: topics?.topics.rows.length ?? 0,
      topicTokens: topicTokenSet.size,
      memeStocksInTopics: [...topicTokenSet].filter((address) => memeStockSet.has(address)).length,
      inflow5m: rows5m?.length ?? null,
      inflow1h: rows1h?.length ?? null,
      memeStocksInInflow: [...inflowSet].filter((address) => memeStockSet.has(address)).length,
      boardRows: board?.rows.length ?? null,
    },
  };
  await store.put(MEME_MEASURE_LATEST_KEY, summary, {
    source: MEME_MEASURE_SOURCE,
    freshForMs: MEME_MEASURE_SLOT_MS * 2,
    deadAfterMs: MEME_MEASURE_SLOT_MS * 6,
  });
  if (failures.length > 0) console.warn(`[${MEME_MEASURE_JOB}] partial cycle: ${failures.join("; ")}`);
  return { recorded: true, latest: summary };
}

// ─── Jev text features ───────────────────────────────────────────────────────

/** Cache key prefixes; one key per meme-stock token and per (topicId, token) pair. */
export const JEV_STOCK_KEY_PREFIX = "memes:jev:v1:stock:";
export const JEV_TOPIC_KEY_PREFIX = "memes:jev:v1:topic:";
const JEV_SOURCE = "typesafe-jev";
/** The inputs never change, so an answer is kept for good (same horizon as `quotes:kind`). */
const JEV_FOREVER_MS = 100 * 365 * 24 * 3_600_000;
/**
 * Requests per cycle. A cold start (a few hundred meme stocks and pairs) is
 * worked off over a few cycles; a warm cycle asks only for new arrivals.
 */
export const JEV_MAX_REQUESTS = 60;
/** Requests in flight at once, far under TypeSafe's 80 requests/s. */
const JEV_CONCURRENCY = 6;
/** The whole Jev step's deadline inside the 45 s job timeout. */
const JEV_BOX_MS = 10_000;

/** Score levels of the meme-to-stock relevance; the stored probabilities follow this order. */
const JEV_STOCK_LEVELS = [
  "Unrelated: nothing in the meme's symbol or name refers to this company, its people or its products",
  "Loosely related: a generic finance, stock-market or trading joke that is not specific to this company",
  "Clearly about this company, its people (founders, executives) or its products",
] as const;
const JEV_STOCK_LEVEL_KEYS = JEV_STOCK_LEVELS.map((_, i) => String(i));
/** Topic tones; the stored probabilities follow this order. */
export const JEV_TONES = ["hype", "neutral", "warning"] as const;
type JevTone = (typeof JEV_TONES)[number];

/** Idea 3, asked over `{ meme: { symbol, name? }, stock: { symbol, company? } }`. */
export const JEV_STOCK_QUESTIONS: Record<string, JevQuestion> = {
  relevance: {
    type: "score",
    instructions:
      "How strongly is the meme token `meme` themed on the stock `stock`? `stock.symbol` is a tokenized stock: " +
      "the company's ticker followed by B (for example NVDAB is NVIDIA).",
    criteria: JEV_STOCK_LEVELS,
  },
};

/** Idea 4, asked over `{ topic: { name, type, tags }, token: { symbol } }`. */
export const JEV_TOPIC_QUESTIONS: Record<string, JevQuestion> = {
  about: {
    type: "noul",
    instructions:
      "Is the social-media topic `topic` actually about the token `token.symbol` (its name, meme, community or launch), " +
      "rather than about something else the token is only listed beside?",
    criteria: {
      true: "The topic is about this token",
      false: "The topic is about something else; the token is only associated with it",
    },
  },
  tone: {
    type: "choice",
    instructions: "What is the tone of the social-media topic `topic`?",
    criteria: {
      hype: "Excitement, promotion or a push to buy",
      neutral: "Plain news or description with no push either way",
      warning: "A warning: scam, rug pull, exploit, dump or another risk",
    },
  },
};

interface JevStockEntry { model: string; answer: JevScore }
interface JevTopicEntry { model: string; about: JevNoul; tone: JevChoice<JevTone> }
interface JevAnswers { stock: Map<string, JevStockEntry>; topic: Map<string, JevTopicEntry> }

function jevTopicKey(topicId: string, address: string): string {
  return `${topicId}:${address}`;
}

/** A cached entry is re-checked with the answer parsers, never trusted. */
function cachedStock(value: unknown): JevStockEntry | null {
  if (!isRecord(value) || typeof value["model"] !== "string" || value["model"] === "") return null;
  const answer = parseScoreAnswer(value["answer"], JEV_STOCK_LEVELS.length);
  return answer === null ? null : { model: value["model"], answer };
}

function cachedTopic(value: unknown): JevTopicEntry | null {
  if (!isRecord(value) || typeof value["model"] !== "string" || value["model"] === "") return null;
  const about = parseNoulAnswer(value["about"]);
  const tone = parseChoiceAnswer(value["tone"], JEV_TONES);
  return about === null || tone === null ? null : { model: value["model"], about, tone };
}

/**
 * Looks up every meme-stock token and topic pair of the cycle, asks Jev for
 * the unanswered ones (at most {@link JEV_MAX_REQUESTS}, one request per token
 * or pair), and caches each valid answer. Failed requests are summed into one
 * `failures` line; a 429 stops the rest of the cycle's requests.
 */
async function memeJev(
  store: SnapshotStore,
  signal: AbortSignal,
  memeStocks: readonly MemeBoardRow[],
  topics: readonly SocialTopic[],
  apiKey: string,
  fetchFn: FetchFn | undefined,
  failures: string[],
): Promise<JevAnswers> {
  const out: JevAnswers = { stock: new Map(), topic: new Map() };
  const pairs = topics.flatMap((topic) => topic.tokens.map((token) => ({ topic, token })));
  if (memeStocks.length === 0 && pairs.length === 0) return out;

  const [stockRecords, topicRecords, rwa] = await Promise.all([
    Promise.all(memeStocks.map((row) => store.get<unknown>(JEV_STOCK_KEY_PREFIX + row.address))),
    Promise.all(pairs.map(({ topic, token }) => store.get<unknown>(JEV_TOPIC_KEY_PREFIX + jevTopicKey(topic.topicId, token.address)))),
    store.get<unknown>(RWA_UNIVERSE_KEY),
  ]);
  const rwaRows = rwaRowsByAddress(rwa?.data);
  const box = AbortSignal.any([signal, AbortSignal.timeout(JEV_BOX_MS)]);
  const asks: Array<() => Promise<void>> = [];

  memeStocks.forEach((row, i) => {
    const cached = cachedStock(stockRecords[i]?.data);
    if (cached !== null) {
      out.stock.set(row.address, cached);
      return;
    }
    if (row.quote.symbol === null) return;
    const company = row.quote.address === null ? null : (rwaRows.get(row.quote.address)?.underlyingName ?? null);
    const state = {
      meme: row.name === null ? { symbol: row.symbol } : { symbol: row.symbol, name: row.name },
      stock: company === null ? { symbol: row.quote.symbol } : { symbol: row.quote.symbol, company },
    };
    asks.push(async () => {
      const response = await askJev({ apiKey, state, questions: JEV_STOCK_QUESTIONS, fetchFn, signal: box });
      const answer = parseScoreAnswer(response.answers["relevance"], JEV_STOCK_LEVELS.length);
      if (answer === null) throw new Error("invalid answer");
      const entry: JevStockEntry = { model: response.model, answer };
      out.stock.set(row.address, entry);
      await store.put(JEV_STOCK_KEY_PREFIX + row.address, entry, { source: JEV_SOURCE, freshForMs: JEV_FOREVER_MS, deadAfterMs: JEV_FOREVER_MS });
    });
  });

  pairs.forEach(({ topic, token }, i) => {
    const key = jevTopicKey(topic.topicId, token.address);
    const cached = cachedTopic(topicRecords[i]?.data);
    if (cached !== null) {
      out.topic.set(key, cached);
      return;
    }
    if (topic.nameEn === null || token.symbol === null) return;
    const state = { topic: { name: topic.nameEn, type: topic.type, tags: topic.tags }, token: { symbol: token.symbol } };
    asks.push(async () => {
      const response = await askJev({ apiKey, state, questions: JEV_TOPIC_QUESTIONS, fetchFn, signal: box });
      const about = parseNoulAnswer(response.answers["about"]);
      const tone = parseChoiceAnswer(response.answers["tone"], JEV_TONES);
      if (about === null || tone === null) throw new Error("invalid answer");
      const entry: JevTopicEntry = { model: response.model, about, tone };
      out.topic.set(key, entry);
      await store.put(JEV_TOPIC_KEY_PREFIX + key, entry, { source: JEV_SOURCE, freshForMs: JEV_FOREVER_MS, deadAfterMs: JEV_FOREVER_MS });
    });
  });

  const queue = asks.slice(0, JEV_MAX_REQUESTS);
  const failed: string[] = [];
  let asked = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped) {
      const ask = queue.shift();
      if (ask === undefined) return;
      asked += 1;
      try {
        await ask();
      } catch (error) {
        // The key is scrubbed by value too: `sanitizeMessage` only redacts long opaque tokens.
        failed.push(sanitizeMessage(error).split(apiKey).join("[redacted]"));
        if (error instanceof AdapterError && error.status === 429) stopped = true;
      }
    }
  };
  await Promise.all(Array.from({ length: JEV_CONCURRENCY }, worker));
  if (failed.length > 0) {
    failures.push(`jev: ${failed.length} of ${asked} requests failed${stopped ? ", rest stopped after 429" : ""} (${failed[0]})`);
  }
  return out;
}

/**
 * The TypeSafe key when Jev is on: `MEME_JEV_ENABLED=true` and a non-empty
 * `TYPESAFE_API_KEY`. Anything else is `null`: no request, Jev columns `null`.
 */
export function memeJevApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env["MEME_JEV_ENABLED"] !== "true") return null;
  const key = env["TYPESAFE_API_KEY"]?.trim();
  return key === undefined || key === "" ? null : key;
}

// ─── Read side ───────────────────────────────────────────────────────────────

/** Expands one section's tuples back into objects, using the column names the record was written with. */
export function expandRows(columns: readonly string[], rows: readonly Tuple[]): Array<Record<string, Cell>> {
  return rows.map((row) => Object.fromEntries(columns.map((column, i) => [column, row[i] ?? null])));
}

/** A stored cycle in object form, for the export route. */
export function expandCycle(cycle: MeasureCycle): Record<string, unknown> {
  return {
    slot: cycle.slot,
    ts: cycle.ts,
    durationMs: cycle.durationMs,
    failures: cycle.failures,
    topics: cycle.topics === null
      ? null
      : {
          lists: cycle.topics.lists,
          topics: expandRows(cycle.topics.topics.columns, cycle.topics.topics.rows),
          // The stored `topic` index resolved to the topic's id, so a page can be read row by row.
          tokens: expandRows(cycle.topics.tokens.columns, cycle.topics.tokens.rows).map((token) => ({
            topicId: typeof token["topic"] === "number" ? (cycle.topics?.topics.rows[token["topic"]]?.[0] ?? null) : null,
            ...token,
          })),
        },
    inflow: {
      "5m": cycle.inflow["5m"] === null ? null : expandRows(cycle.inflow.columns, cycle.inflow["5m"]),
      "1h": cycle.inflow["1h"] === null ? null : expandRows(cycle.inflow.columns, cycle.inflow["1h"]),
    },
    board: cycle.board === null
      ? null
      : {
          asOf: cycle.board.asOf,
          shortlistSize: cycle.board.shortlistSize,
          rows: expandRows(
            cycle.board.columns,
            dictDecode(cycle.board.rows, cycle.board.columns, cycle.board.dictColumns, cycle.board.dict),
          ).map((row) => ({
            ...row,
            flags: flagNames(row["flags"], cycle.board?.flagBits ?? []),
          })),
        },
  };
}

function isCycle(value: unknown, slot: number): value is MeasureCycle {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<MeasureCycle>;
  return c.v === 1 && c.slot === slot && typeof c.ts === "number" && typeof c.inflow === "object" && c.inflow !== null;
}

export interface MeasurePage {
  cycles: MeasureCycle[];
  /** Slots in the page with no cycle (never recorded, or overwritten by the ring). */
  emptySlots: number;
  /** Start of the next page, or `null` when the window is exhausted. */
  next: number | null;
}

/**
 * Reads the cycles of the closed slots overlapping `[since, until)`, at most `maxSlots`
 * slots per page. Bounded by slots, not by cycles found, so a page over an empty
 * stretch costs the same as a full one. Anything before the retention window is
 * not asked for.
 */
export async function readMeasurePage(
  store: SnapshotStore,
  since: number,
  until: number,
  maxSlots: number,
  now: number,
): Promise<MeasurePage> {
  const firstSlot = Math.max(slotOf(since), slotOf(now - MEME_MEASURE_RETENTION_MS) + 1);
  // Closed slots only: the slot in progress may not be recorded yet (its cycle
  // lands in its first minute), and a reader walking `next` to the end would
  // otherwise take it as empty for good (audit F3).
  const endSlot = Math.min(slotOf(until - 1) + 1, slotOf(now));
  const lastSlot = Math.min(endSlot, firstSlot + maxSlots);
  const slots: number[] = [];
  for (let slot = firstSlot; slot < lastSlot; slot++) slots.push(slot);
  const records = await Promise.all(slots.map((slot) => store.get<unknown>(memeMeasureSlotKey(slot))));
  const cycles: MeasureCycle[] = [];
  records.forEach((record, i) => {
    const slot = slots[i]!;
    if (record !== null && isCycle(record.data, slot)) cycles.push(record.data);
  });
  return {
    cycles,
    emptySlots: slots.length - cycles.length,
    next: lastSlot < endSlot ? lastSlot * MEME_MEASURE_SLOT_MS : null,
  };
}

/**
 * On unless the operator turns it off (`MEME_MEASURE_ENABLED=false`). The
 * measurement was ordered on 2026-10-05 for one to two days of data; the switch
 * is there for when the operator has ruled.
 */
export function isMemeMeasureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["MEME_MEASURE_ENABLED"] !== "false";
}

const HOLDER = randomUUID();

/** Job registration for the scheduler. */
export function memeMeasureJob(store: SnapshotStore): JobSpec {
  const enabled = isMemeMeasureEnabled();
  const jevApiKey = memeJevApiKey();
  return {
    name: MEME_MEASURE_JOB,
    intervalMs: enabled ? TICK_MS : 60 * TICK_MS,
    jitterMs: 5_000,
    // Four Binance calls behind the shared semaphore, two store reads, two writes;
    // with Jev on, at most JEV_BOX_MS more of TypeSafe requests.
    timeoutMs: 45_000,
    run: async (signal) => {
      if (!enabled) return;
      await runMemeMeasure(store, signal, { jevApiKey });
    },
  };
}
