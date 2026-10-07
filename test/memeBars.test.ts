import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeSintralMinuteBars, type MemeRushRow, type SintralMinuteBar } from "../src/adapters/binanceWeb3.js";
import { AdapterError } from "../src/adapters/http.js";
import type { TokenActivity } from "../src/adapters/onchainos.js";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore, PostgresStore } from "../src/core/store.js";
import { FakePg } from "./fakePg.js";
import { BOARD_PHASE_MS, MEME_BOARD_KEY, memeBoardJob, msUntilBoardRun } from "../src/jobs/memeBoard.js";
import { buildShortlist, parseShortlistQuery } from "../src/query/memeQuery.js";
import { loadStockInfo } from "../src/query/memeStocks.js";
import {
  LEAVE_AFTER_MS,
  MEME_BARS_CAP,
  MEME_BARS_INDEX_KEY,
  MEME_BARS_KEEP,
  MEME_BARS_LEASE,
  SETTLE_MS,
  SHORTLIST_RETRY_MS,
  BARS_DEAD_MS,
  UNKNOWN_RETRY_MS,
  backoffMs,
  countCorrections,
  fetchLimit,
  memeBarsJob,
  msUntilNextRun,
  lastClosedMinute,
  memeBarsKey,
  readMemeBars,
  readTrackedSet,
  rebuildSeries,
  runMemeBars,
  selectTracked,
  type BarSeries,
  type BarsIndex,
  type StoredBar,
} from "../src/jobs/memeBars.js";
import { classifyMeme, type ClassifyInput, type MemeBoardRow } from "../src/query/memeClassify.js";
import { createServer } from "../src/server.js";
import { RWA_UNIVERSE_KEY } from "../src/universe.js";

/** A minute boundary. */
const NOW = 1_791_120_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const BNB = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const TTL = { source: "test", freshForMs: 3 * MIN, deadAfterMs: 30 * MIN };

function addr(n: number): string {
  return `0x${n.toString(16).padStart(40, "0")}`;
}

function rush(overrides: Partial<MemeRushRow> = {}): MemeRushRow {
  return {
    address: addr(1), symbol: "MEME", name: "Meme", launchpad: "flap", stage: "finalizing", createdAt: NOW - HOUR,
    progress: 40, migrated: false, migratedAt: null, quote: NVDAB, priceUsd: 0.0001, marketCapUsd: 50_000,
    liquidityUsd: 10_000, volume24hUsd: 20_000, priceChange24hPct: 10, holders: 200, count24h: 500, buys24h: 300,
    sells24h: 200, netBuy24hUsd: 1_000, top10Pct: 20, devPct: 0, sniperPct: 5, insiderPct: 0, bundlerPct: 0,
    newWalletPct: 1, smartMoneyHolders: 0, kolHolders: 0, devAddress: addr(999), devSoldAll: false,
    devMigrateCount: 0, washTrading: false, socials: { website: null, twitter: null, telegram: null },
    ...overrides,
  };
}

function activity(overrides: Partial<TokenActivity> = {}): TokenActivity {
  return {
    address: addr(1), observedAt: NOW, priceUsd: 0.0001, marketCapUsd: 50_000, liquidityUsd: 10_000, holders: 200,
    txs5m: 10, txs1h: 60, txs4h: 200, txs24h: 500, volume5mUsd: 200, volume1hUsd: 3_000, volume4hUsd: 9_000,
    volume24hUsd: 20_000, priceChange5mPct: 1, priceChange1hPct: 5, priceChange4hPct: 10, priceChange24hPct: 10,
    ...overrides,
  };
}

function row(n: number, o: { quote?: "bstock" | "bnb"; txs5m?: number; txs1h?: number } = {}, now = NOW): MemeBoardRow {
  const input: ClassifyInput = {
    rush: rush({ address: addr(n), symbol: `M${n}`, quote: o.quote === "bnb" ? BNB : NVDAB, createdAt: now - HOUR }),
    activity: activity({ address: addr(n), txs5m: o.txs5m ?? 10, txs1h: o.txs1h ?? 60, observedAt: now }),
    signals: [],
    quote: o.quote === "bnb" ? { kind: "bnb", symbol: "BNB" } : { kind: "bstock", symbol: "NVDAB" },
    cloneOf: null,
    flow1h: { buys: 120, sells: 80, uniqueTraders: 90, inflowUsd: 1_000 },
    lastListedAt: now,
    firstSeenAt: now - HOUR,
    previousDeadSince: null,
    now,
  };
  return classifyMeme(input);
}

const dead = (n: number): MemeBoardRow => ({ ...row(n), status: "dead" });

function bar(startMs: number, close: number, trades = 5, volumeUsd = 100): SintralMinuteBar {
  return { startMs, open: close, high: close * 1.01, low: close * 0.99, close, volumeUsd, trades };
}

// ─── Adapter and arithmetic ──────────────────────────────────────────────────

describe("normalizeSintralMinuteBars", () => {
  it("keeps the trade count, drops broken or misaligned rows, and dedupes by minute", () => {
    const bars = normalizeSintralMinuteBars({
      data: [
        [0.0003, 0.0004, 0.00025, 0.00037, 24699.66, NOW + MIN, 97],
        [0.0003, 0.0004, 0.00025, 0.00031, 100, NOW, 4],
        [0.0003, 0.0004, 0.00025, "bad", 100, NOW - MIN, 4],
        [0.0003, 0.0004, 0.00025, 0.0003, 100, NOW - MIN + 5, 4],
        [0.0003, 0.0004, 0.00025, 0.00038, 50, NOW + MIN, 98],
        "junk",
      ],
      status: {},
    });
    assert.deepEqual(bars.map((b) => [b.startMs, b.close, b.trades]), [[NOW, 0.00031, 4], [NOW + MIN, 0.00038, 98]]);
  });

  it("closes a minute 20 s after its end", () => {
    assert.equal(lastClosedMinute(NOW + MIN + 20_000), NOW);
    assert.equal(lastClosedMinute(NOW + MIN + 19_999), NOW - MIN);
  });
});

describe("rebuildSeries", () => {
  it("zero-fills silent minutes at the previous close and leaves out the minute in progress", () => {
    const lastClosed = NOW + 4 * MIN;
    const { bars } = rebuildSeries(null, [bar(NOW, 1), bar(NOW + 2 * MIN, 2), bar(NOW + 5 * MIN, 9)], lastClosed);
    assert.deepEqual(bars.map((b) => [b[0] - NOW, b[4], b[5], b[6]]), [
      [0, 1, 100, 5],
      [MIN, 1, 0, 0],
      [2 * MIN, 2, 100, 5],
      [3 * MIN, 2, 0, 0],
      [4 * MIN, 2, 0, 0],
    ]);
    assert.deepEqual(bars[1]!.slice(1, 5), [1, 1, 1, 1], "a silent minute is flat at the previous close");
    assert.deepEqual(bars.map((b) => b[7]), [0, 1, 0, 1, 1], "fills are marked, not inferred");
  });

  it("corrects a zero-filled minute when a late trade arrives, and the flat minutes after it", () => {
    const first = rebuildSeries(null, [bar(NOW, 1)], NOW + 2 * MIN);
    assert.deepEqual(first.bars.map((b) => b[4]), [1, 1, 1]);
    const second = rebuildSeries(first, [bar(NOW + MIN, 3)], NOW + 3 * MIN);
    assert.deepEqual(second.bars.map((b) => [b[4], b[6]]), [[1, 5], [3, 5], [3, 0], [3, 0]]);
  });

  it("keeps the last 180 minutes and carries the last traded close into a silent window", () => {
    const lastClosed = NOW + 400 * MIN;
    const { bars, seed } = rebuildSeries(null, [bar(NOW, 7), bar(NOW + 10 * MIN, 8)], lastClosed);
    assert.equal(bars.length, MEME_BARS_KEEP);
    assert.equal(bars[0]![0], lastClosed - (MEME_BARS_KEEP - 1) * MIN);
    assert.ok(bars.every((b) => b[4] === 8 && b[6] === 0), "a dead chart is 180 flat, silent minutes");
    assert.equal(seed?.[4], 8);
    // Next minute, nothing new: the seed alone still carries the close.
    const next = rebuildSeries({ bars, seed }, [], lastClosed + MIN);
    assert.equal(next.bars.length, MEME_BARS_KEEP);
    assert.equal(next.bars.at(-1)?.[4], 8);
  });

  it("answers nothing for a token with no trade yet", () => {
    assert.deepEqual(rebuildSeries(null, [], NOW), { bars: [], seed: null });
  });

  it("backfills on entry and asks only for the gap plus the re-read tail after that", () => {
    // + 2: the two newest rows are the minute in progress and the one settling (audit F3).
    assert.equal(fetchLimit(null, NOW), MEME_BARS_KEEP + 2);
    const series = { lastClosedStartMs: NOW - MIN, bars: [[NOW - MIN, 1, 1, 1, 1, 0, 0, 1] as StoredBar] } as BarSeries;
    assert.equal(fetchLimit(series, NOW), 6);
    assert.equal(fetchLimit({ ...series, lastClosedStartMs: NOW - 500 * MIN }, NOW), MEME_BARS_KEEP + 2);
  });
});

// ─── Tracked set ─────────────────────────────────────────────────────────────

describe("selectTracked", () => {
  const empty: BarsIndex = { tokens: {}, departed: {}, backoff: null, closedThrough: null, lastCycle: null };

  it("tracks live meme stocks and shortlisted rows, nothing else", () => {
    const board = [row(1), row(2, { quote: "bnb" }), dead(3), row(4)];
    const { tokens } = selectTracked(empty, board, new Set(), NOW);
    assert.deepEqual(Object.keys(tokens).sort(), [addr(1), addr(4)]);
  });

  it("keeps a token 30 minutes after it was last live, then lets it go", () => {
    const index: BarsIndex = { tokens: { [addr(9)]: { symbol: "OLD", enteredAt: NOW - HOUR, lastLiveAt: NOW - LEAVE_AFTER_MS } }, departed: {}, backoff: null, closedThrough: null, lastCycle: null };
    assert.ok(addr(9) in selectTracked(index, [], new Set(), NOW).tokens);
    assert.equal(addr(9) in selectTracked(index, [], new Set(), NOW + 1).tokens, false);
  });

  it("caps the set, live and shortlisted first, then by 5-minute trades, and says so", () => {
    const board = Array.from({ length: MEME_BARS_CAP + 5 }, (_, i) => row(100 + i, { txs5m: i }));
    const index: BarsIndex = { tokens: { [addr(9)]: { symbol: "OLD", enteredAt: NOW - HOUR, lastLiveAt: NOW - MIN } }, departed: {}, backoff: null, closedThrough: null, lastCycle: null };
    const result = selectTracked(index, board, new Set([addr(100)]), NOW);
    assert.equal(result.capped, true);
    assert.equal(result.candidates, MEME_BARS_CAP + 6);
    assert.equal(Object.keys(result.tokens).length, MEME_BARS_CAP);
    assert.ok(addr(100) in result.tokens, "shortlisted, though it traded least");
    assert.equal(addr(9) in result.tokens, false, "no longer live: first to go");
    assert.equal(addr(101) in result.tokens, false);
  });
});

// ─── Job ─────────────────────────────────────────────────────────────────────

async function harness(board: MemeBoardRow[] = [row(1), row(2)]) {
  const clock = { now: NOW + MIN + 50_000 }; // lastClosed = NOW
  const store = new MemoryStore(() => clock.now);
  await store.put(MEME_BOARD_KEY, board, TTL);
  await store.put(RWA_UNIVERSE_KEY, { rows: [{ address: NVDAB, symbol: "NVDAB", underlyingTicker: "NVDA", tokenPriceUsd: 235, openState: true }] }, TTL);
  const asked: Array<[string, number]> = [];
  const upstream = new Map<string, SintralMinuteBar[]>([
    [addr(1), [bar(NOW - 2 * MIN, 1), bar(NOW, 2), bar(NOW + MIN, 3)]],
    [addr(2), [bar(NOW - MIN, 5)]],
  ]);
  let fail: ((address: string) => Error | null) | null = null;
  const fetchBars = async (address: string, limit: number) => {
    asked.push([address, limit]);
    const error = fail?.(address) ?? null;
    if (error !== null) throw error;
    return upstream.get(address) ?? [];
  };
  return {
    store, clock, asked, upstream,
    failWith: (f: (address: string) => Error | null) => { fail = f; },
    run: () => runMemeBars(store, AbortSignal.timeout(5_000), { now: () => clock.now, holder: "test", fetchBars }),
  };
}

async function series(store: MemoryStore, address: string): Promise<BarSeries | null> {
  return (await store.get<BarSeries>(memeBarsKey(address)))?.data ?? null;
}

/** The quote stock reads closed: its meme stocks stay live on the board but leave the memestock shortlist. */
async function closeQuote(store: MemoryStore): Promise<void> {
  await store.put(RWA_UNIVERSE_KEY, { rows: [{ address: NVDAB, symbol: "NVDAB", underlyingTicker: "NVDA", tokenPriceUsd: 235, openState: false }] }, TTL);
}

describe("runMemeBars", () => {
  it("backfills each live meme stock on entry, closed minutes only, then reads incrementally", async () => {
    const h = await harness();
    const first = await h.run();
    assert.deepEqual(first, { tracked: 2, candidates: 2, capped: false, calls: 2, failures: 0, throttled: false, corrected: 0 });
    assert.deepEqual(h.asked.map(([, limit]) => limit), [MEME_BARS_KEEP + 2, MEME_BARS_KEEP + 2]);
    const one = (await series(h.store, addr(1)))!;
    assert.equal(one.lastClosedStartMs, NOW);
    assert.deepEqual(one.bars.map((b) => [b[0] - NOW, b[4], b[6]]), [[-2 * MIN, 1, 5], [-MIN, 1, 0], [0, 2, 5]]);
    assert.equal(one.source, "sintral");
    assert.equal(one.unit, "usd");

    h.clock.now += MIN;
    h.upstream.set(addr(1), [bar(NOW + MIN, 3), bar(NOW + 2 * MIN, 4)]);
    await h.run();
    assert.deepEqual(h.asked.slice(2).map(([, limit]) => limit), [6, 6]);
    assert.deepEqual((await series(h.store, addr(1)))!.bars.map((b) => b[4]), [1, 1, 2, 3]);
    const index = (await h.store.get<BarsIndex>(MEME_BARS_INDEX_KEY))!.data;
    assert.equal(index.lastCycle?.calls, 2);
  });

  it("stops the cycle's remaining calls on a 429 and says it was throttled", async () => {
    const h = await harness([row(1), row(2), row(3), row(4), row(5), row(6)]);
    h.failWith(() => new AdapterError("binance", "upstream responded 429", 429));
    await assert.rejects(h.run(), /every bar read failed/u, "a fully throttled cycle shows on /status");
    const cycle = (await h.store.get<BarsIndex>(MEME_BARS_INDEX_KEY))!.data.lastCycle!;
    assert.equal(cycle.throttled, true);
    assert.ok(cycle.calls <= 4 && cycle.calls < 6, `at most one call per worker, got ${cycle.calls}`);
  });

  it("fails the run when every read failed, and records nothing for those tokens", async () => {
    const h = await harness();
    h.failWith(() => new AdapterError("binance", "upstream responded 500", 500));
    await assert.rejects(h.run(), /every bar read failed/u);
    assert.equal(await series(h.store, addr(1)), null);
  });

  it("does nothing while another replica holds the lease", async () => {
    const h = await harness();
    await h.store.acquireSchedulerLease(MEME_BARS_LEASE, "other", 90_000);
    assert.equal((await h.run()).skipped, "lease_held");
    assert.equal(h.asked.length, 0);
  });

  it("adds no one from a board that is not fresh, but keeps updating who it tracks", async () => {
    const h = await harness([row(1)]);
    await h.run();
    h.clock.now += 4 * MIN; // the board (written at NOW + 1m50s) is stale now
    await h.store.put(MEME_BOARD_KEY, [row(1), row(2)], { source: "test", freshForMs: 1, deadAfterMs: 30 * MIN });
    h.clock.now += 1;
    const result = await h.run();
    assert.equal(result.tracked, 1);
    assert.equal(h.asked.at(-1)?.[0], addr(1));
  });
});

// ─── Routes ──────────────────────────────────────────────────────────────────

describe("GET /memes/bars and /memes/:address/bars", () => {
  async function app() {
    const store = new MemoryStore();
    const now = Date.now();
    const lastClosed = lastClosedMinute(now);
    const stored: BarSeries = {
      address: addr(1), symbol: "M1", source: "sintral", unit: "usd", lastClosedStartMs: lastClosed, seed: null, checkedAt: now,
      bars: [[lastClosed - MIN, 1, 1.1, 0.9, 1, 50, 3, 0], [lastClosed, 1, 1, 1, 1, 0, 0, 1]],
    };
    await store.put(memeBarsKey(addr(1)), stored, { source: "sintral", freshForMs: 3 * MIN, deadAfterMs: 30 * MIN });
    const index: BarsIndex = { tokens: { [addr(1)]: { symbol: "M1", enteredAt: now, lastLiveAt: now } }, departed: {}, backoff: null, closedThrough: null, lastCycle: null };
    await store.put(MEME_BARS_INDEX_KEY, index, { source: "test", freshForMs: 3 * MIN, deadAfterMs: 30 * MIN });
    const server = createServer({ scheduler: createScheduler(store), store });
    return { request: (path: string) => server.request(path), lastClosed };
  }

  it("answers a batch in input order, with untracked tokens marked rather than dropped", async () => {
    const { request, lastClosed } = await app();
    const response = await request(`/memes/bars?addresses=${addr(2)},${addr(1).toUpperCase().replace("0X", "0x")}&limit=1`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Array<Record<string, unknown>>; meta: Record<string, unknown> };
    assert.equal(body.data[0]!["tracked"], false);
    assert.deepEqual(body.data[0]!["bars"], []);
    assert.equal(body.data[1]!["address"], addr(1));
    assert.equal(body.data[1]!["staleness"], "fresh");
    assert.equal(body.data[1]!["lastClosedStartMs"], lastClosed);
    assert.equal(body.data[1]!["tracked"], true);
    assert.deepEqual(body.data[1]!["bars"], [{ startMs: lastClosed, open: 1, high: 1, low: 1, close: 1, volume: 0, trades: 0, filled: true }]);
    assert.equal(body.meta["unit"], "usd");
  });

  it("serves one token, 404 when it is not tracked", async () => {
    const { request } = await app();
    const body = (await (await request(`/memes/${addr(1)}/bars`)).json()) as { data: { bars: unknown[] } };
    assert.equal(body.data.bars.length, 2);
    assert.equal((await request(`/memes/${addr(2)}/bars`)).status, 404);
    assert.equal((await request(`/memes/${addr(1)}`)).status, 404, "the board route is untouched");
  });

  it("rejects bad lists and limits", async () => {
    const { request } = await app();
    const many = Array.from({ length: 31 }, (_, i) => addr(i + 1)).join(",");
    for (const query of ["", "addresses=", `addresses=${many}`, "addresses=0x12", `addresses=${addr(1)}&limit=0`, `addresses=${addr(1)}&limit=181`]) {
      assert.equal((await request(`/memes/bars?${query}`)).status, 400, query);
    }
    assert.equal((await request("/memes/notanaddress/bars")).status, 400);
  });
});

describe("bars audit round", () => {
  it("normalizes away a glitch price and widens out-of-order extremes", () => {
    const bars = normalizeSintralMinuteBars({
      data: [
        [1, 1.2, 0, 1.1, 10, NOW, 3],
        [1, 0.9, 1.05, 1.1, 10, NOW + MIN, 3],
      ],
    });
    assert.deepEqual(bars.map((b) => [b.startMs, b.high, b.low]), [[NOW + MIN, 1.1, 1]]);
  });

  it("keeps a reported bar with no volume and no trades as reported", () => {
    const first = rebuildSeries(null, [{ startMs: NOW, open: 2, high: 3, low: 1, close: 2.5, volumeUsd: 0, trades: 0 }], NOW + MIN);
    const second = rebuildSeries(first, [], NOW + 2 * MIN);
    assert.deepEqual(second.bars[0]!.slice(1, 5), [2, 3, 1, 2.5]);
    assert.equal(second.bars[0]![7], 0);
  });

  it("backs off across cycles after a 429, longer each time, and resets once a cycle is clean", async () => {
    const h = await harness();
    h.failWith(() => new AdapterError("binance", "upstream responded 429", 429));
    await assert.rejects(h.run());
    let index = (await h.store.get<BarsIndex>(MEME_BARS_INDEX_KEY))!.data;
    assert.equal(index.backoff?.streak, 1);
    assert.equal(index.backoff?.until, h.clock.now + backoffMs(1));
    const asked = h.asked.length;
    h.clock.now += MIN;
    assert.equal((await h.run()).skipped, "backoff");
    assert.equal(h.asked.length, asked, "no call while backing off");
    h.clock.now += 2 * MIN;
    await assert.rejects(h.run());
    index = (await h.store.get<BarsIndex>(MEME_BARS_INDEX_KEY))!.data;
    assert.equal(index.backoff?.streak, 2);
    assert.equal(backoffMs(2), 4 * MIN);
    assert.equal(backoffMs(9), 10 * MIN);
    h.failWith(() => null);
    h.clock.now += 5 * MIN;
    await h.store.put(MEME_BOARD_KEY, [row(1), row(2)], TTL);
    await h.run();
    index = (await h.store.get<BarsIndex>(MEME_BARS_INDEX_KEY))!.data;
    assert.equal(index.backoff, null);
  });

  it("serves a departed token as not tracked for 30 minutes, then deletes its series", async () => {
    const h = await harness([row(1)]);
    await h.run();
    assert.ok((await series(h.store, addr(1))) !== null);
    h.clock.now += LEAVE_AFTER_MS + MIN;
    await h.store.put(MEME_BOARD_KEY, [], TTL);
    await h.run();
    const tracked = await readTrackedSet(h.store);
    const view = await readMemeBars(h.store, addr(1), 60, tracked);
    assert.equal(view.tracked, false);
    assert.ok(view.bars.length > 0, "still served while it ages");
    h.clock.now += BARS_DEAD_MS + MIN;
    await h.store.put(MEME_BOARD_KEY, [], TTL);
    await h.run();
    assert.equal(await series(h.store, addr(1)), null, "the key is gone");
  });

  it("asks Sintral about a token it does not know only every 10 minutes when it is not shortlisted", async () => {
    const h = await harness([row(7)]);
    await closeQuote(h.store); // live on the board, off the memestock shortlist
    await h.run();
    await h.run(); // same minute: up to date
    h.clock.now += MIN;
    await h.store.put(MEME_BOARD_KEY, [row(7)], TTL);
    await h.run();
    assert.equal(h.asked.length, 1);
    h.clock.now += UNKNOWN_RETRY_MS;
    await h.store.put(MEME_BOARD_KEY, [row(7)], TTL);
    await h.run();
    assert.equal(h.asked.length, 2);
  });

  it("does not call Sintral twice for a token already up to date this minute, and corrects a late trade through the job", async () => {
    const h = await harness([row(1)]);
    await h.run();
    await h.run();
    assert.equal(h.asked.length, 1);
    h.clock.now += MIN;
    await h.store.put(MEME_BOARD_KEY, [row(1)], TTL);
    // Sintral now also reports a trade in a minute that was zero-filled (NOW - MIN).
    h.upstream.set(addr(1), [bar(NOW - MIN, 7), bar(NOW, 2), bar(NOW + MIN, 3)]);
    await h.run();
    const bars = (await series(h.store, addr(1)))!.bars;
    assert.deepEqual(bars.map((b) => [b[0] - NOW, b[4], b[7]]), [[-2 * MIN, 1, 0], [-MIN, 7, 0], [0, 2, 0], [MIN, 3, 0]]);
  });

  it("round-trips a series through Postgres", async () => {
    const pgStore = await PostgresStore.create("postgres://unused", { client: new FakePg() });
    const stored: BarSeries = {
      address: addr(1), symbol: "币安", source: "sintral", unit: "usd", lastClosedStartMs: NOW, seed: null, checkedAt: NOW,
      bars: [[NOW, 1, 1, 1, 1, 0, null, 0], [NOW + MIN, 1, 1, 1, 1, 0, 0, 1]],
    };
    await pgStore.put(memeBarsKey(addr(1)), stored, { source: "sintral", freshForMs: 3 * MIN, deadAfterMs: 30 * MIN });
    assert.deepEqual((await pgStore.get<BarSeries>(memeBarsKey(addr(1))))?.data, stored);
    assert.equal(await pgStore.delete(memeBarsKey(addr(1))), true);
    assert.equal(await pgStore.get(memeBarsKey(addr(1))), null);
    assert.equal(await pgStore.delete(memeBarsKey(addr(1))), false);
  });
});

describe("bars latency (MEME-BARS-LATENCY-HANDOFF)", () => {
  it("schedules each run SETTLE_MS after the next minute end", () => {
    assert.equal(msUntilNextRun(NOW), SETTLE_MS);
    assert.equal(msUntilNextRun(NOW + 5_000), SETTLE_MS - 5_000);
    assert.equal(msUntilNextRun(NOW + SETTLE_MS), MIN, "a run that fired on time waits for the next minute");
    assert.equal(msUntilNextRun(NOW + SETTLE_MS - 200), MIN + 200, "a slightly early run does not refire at once");
    assert.equal(msUntilNextRun(NOW + 50_000), MIN - 50_000 + SETTLE_MS);
  });

  it("is registered to run on that schedule, not on a fixed interval", () => {
    const spec = memeBarsJob(new MemoryStore());
    assert.equal(spec.nextDelayMs, msUntilNextRun);
    assert.equal(spec.intervalMs, MIN);
  });

  it("reads each minute once, SETTLE_MS after it ends, with no idle runs", async () => {
    const h = await harness([row(1)]);
    let t = NOW + MIN + 3_000; // first run lands mid-minute: the entry backfill
    const runs: Array<{ at: number; closed: number | null; skipped: string | undefined }> = [];
    for (let i = 0; i < 6; i++) {
      h.clock.now = t;
      await h.store.put(MEME_BOARD_KEY, [row(1)], TTL);
      const result = await h.run();
      runs.push({ at: t, closed: (await series(h.store, addr(1)))?.lastClosedStartMs ?? null, skipped: result.skipped });
      t += msUntilNextRun(t);
    }
    assert.ok(runs.every((r) => r.skipped === undefined), "every scheduled run does work");
    for (const r of runs.slice(1)) assert.equal(r.at - (r.closed! + MIN), SETTLE_MS, "read exactly SETTLE_MS after the minute ends");
    assert.equal(h.asked.length, runs.length, "one Sintral call per token per closed minute");
  });

  it("skips a second run inside the same minute without a lease or a write (restart, second replica)", async () => {
    const h = await harness([row(1)]);
    await h.run();
    let leases = 0;
    let puts = 0;
    const lease = h.store.acquireSchedulerLease.bind(h.store);
    const put = h.store.put.bind(h.store);
    h.store.acquireSchedulerLease = async (...args) => { leases++; return lease(...args); };
    h.store.put = async (key, payload, opts) => { puts++; return put(key, payload, opts); };
    h.clock.now += 10_000;
    assert.equal((await h.run()).skipped, "up_to_date");
    assert.deepEqual([leases, puts, h.asked.length], [0, 0, 1]);
  });

  it("counts closed bars a re-read changed, and only those", () => {
    const first = rebuildSeries(null, [bar(NOW, 1)], NOW + 2 * MIN);
    const previous = { ...first, lastClosedStartMs: NOW + 2 * MIN };
    const later = rebuildSeries(first, [bar(NOW + MIN, 5)], NOW + 3 * MIN);
    // NOW+1m was a fill and is now traded; NOW+2m's fill carries the new close; NOW+3m is new.
    assert.equal(countCorrections(previous, later.bars), 2);
    assert.equal(countCorrections(previous, previous.bars), 0);
    assert.equal(countCorrections(null, later.bars), 0);
  });
});

describe("bars retry and board phase (2026-10-07)", () => {
  it("re-asks a shortlisted token every cycle while Sintral answers nothing, and serves its bars the minute they appear", async () => {
    const h = await harness([row(7)]); // shortlisted; Sintral knows nothing yet
    await h.run();
    assert.equal(h.asked.length, 1);
    assert.deepEqual((await series(h.store, addr(7)))!.bars, []);
    h.clock.now += MIN;
    await h.store.put(MEME_BOARD_KEY, [row(7)], TTL);
    await h.run();
    assert.equal(h.asked.length, 2, "asked again one minute later, not ten");
    h.upstream.set(addr(7), [bar(NOW, 2), bar(NOW + MIN, 3)]);
    h.clock.now += MIN;
    await h.store.put(MEME_BOARD_KEY, [row(7)], TTL);
    await h.run();
    assert.equal(h.asked.length, 3);
    assert.deepEqual((await series(h.store, addr(7)))!.bars.map((b) => [b[4], b[7]]), [[2, 0], [3, 0], [3, 1]]);
  });

  it("keeps re-asking for 15 minutes after the token leaves the shortlist, then falls back to every 10 minutes", async () => {
    const h = await harness([row(7)]);
    const shortlistedAt = h.clock.now;
    await h.run();
    await closeQuote(h.store); // still live on the board, off the shortlist from here on
    const minute = async () => {
      h.clock.now += MIN;
      await h.store.put(MEME_BOARD_KEY, [row(7)], TTL);
      await h.run();
    };
    while (h.clock.now - shortlistedAt < SHORTLIST_RETRY_MS) await minute();
    assert.equal(h.asked.length, 16, "every minute through the 15-minute tail");
    const index = (await h.store.get<BarsIndex>(MEME_BARS_INDEX_KEY))!.data;
    assert.equal(index.tokens[addr(7)]?.shortlistedAt, shortlistedAt, "the shortlist time survives the index round trip");
    for (let i = 0; i < 9; i++) await minute();
    assert.equal(h.asked.length, 16, "past the tail: the 10-minute retry");
    await minute();
    assert.equal(h.asked.length, 17);
  });

  it("still backs the whole job off when a re-asked shortlisted token hits a 429", async () => {
    const h = await harness([row(7)]);
    await h.run();
    h.clock.now += MIN;
    await h.store.put(MEME_BOARD_KEY, [row(7)], TTL);
    h.failWith(() => new AdapterError("binance", "upstream responded 429", 429));
    await assert.rejects(h.run());
    const index = (await h.store.get<BarsIndex>(MEME_BARS_INDEX_KEY))!.data;
    assert.equal(index.backoff?.streak, 1);
    const asked = h.asked.length;
    h.failWith(() => null);
    h.clock.now += MIN;
    await h.store.put(MEME_BOARD_KEY, [row(7)], TTL);
    assert.equal((await h.run()).skipped, "backoff");
    assert.equal(h.asked.length, asked, "no re-ask while backing off");
  });

  it("schedules the board so no write lands between the bars selection (:20) and the execution plane's read (:25)", () => {
    const spec = memeBoardJob(new MemoryStore());
    assert.equal(spec.nextDelayMs, msUntilBoardRun);
    const EXEC_READ_MS = 25_000;
    for (let at = NOW; at < NOW + 2 * MIN; at += 250) {
      const start = at + msUntilBoardRun(at);
      const offset = start % MIN;
      assert.equal(offset, BOARD_PHASE_MS);
      assert.ok(offset > EXEC_READ_MS, "starts after this minute's read");
      assert.ok(offset + spec.timeoutMs < MIN + SETTLE_MS, "a write, even at the timeout, lands before the next bars selection");
    }
  });

  it("serves bars by the next execution-plane read for a token that entered the board after the previous selection", async () => {
    const h = await harness([row(1)]);
    const minute = NOW + MIN;
    h.clock.now = minute + SETTLE_MS; // bars selection
    await h.run();
    assert.equal(await series(h.store, addr(1)) !== null, true);
    // The board admits addr(8) at the latest moment its phase allows (a run that used its whole timeout).
    h.clock.now = minute + BOARD_PHASE_MS + memeBoardJob(h.store).timeoutMs;
    await h.store.put(MEME_BOARD_KEY, [row(1), row(8)], TTL);
    h.upstream.set(addr(8), [bar(NOW + MIN, 4)]);
    h.clock.now = minute + MIN + SETTLE_MS; // next bars selection
    await h.run();
    h.clock.now = minute + MIN + 25_000; // the execution plane reads the shortlist, then the bars
    const board = (await h.store.get<MemeBoardRow[]>(MEME_BOARD_KEY))!.data;
    const shortlist = buildShortlist(board, parseShortlistQuery((name) => (name === "segment" ? "memestock" : undefined)), h.clock.now, await loadStockInfo(h.store));
    assert.ok(shortlist.rows.some((r) => r.address === addr(8)), "on the lane's shortlist");
    const view = await readMemeBars(h.store, addr(8), 60, await readTrackedSet(h.store));
    assert.equal(view.tracked, true);
    assert.equal(view.staleness, "fresh");
    assert.deepEqual(view.bars.map((b) => b.close), [4]);
  });
});
