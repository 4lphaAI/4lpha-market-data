import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeSintralMinuteBars, type MemeRushRow, type SintralMinuteBar } from "../src/adapters/binanceWeb3.js";
import { AdapterError } from "../src/adapters/http.js";
import type { TokenActivity } from "../src/adapters/onchainos.js";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import { MEME_BOARD_KEY } from "../src/jobs/memeBoard.js";
import {
  LEAVE_AFTER_MS,
  MEME_BARS_CAP,
  MEME_BARS_INDEX_KEY,
  MEME_BARS_KEEP,
  MEME_BARS_LEASE,
  fetchLimit,
  lastClosedMinute,
  memeBarsKey,
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

  it("closes a minute 45 s after its end", () => {
    assert.equal(lastClosedMinute(NOW + MIN + 45_000), NOW);
    assert.equal(lastClosedMinute(NOW + MIN + 44_999), NOW - MIN);
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
    assert.equal(fetchLimit(null, NOW), MEME_BARS_KEEP);
    const series = { lastClosedStartMs: NOW - MIN, bars: [[NOW - MIN, 1, 1, 1, 1, 0, 0] as StoredBar] } as BarSeries;
    assert.equal(fetchLimit(series, NOW), 6);
    assert.equal(fetchLimit({ ...series, lastClosedStartMs: NOW - 500 * MIN }, NOW), MEME_BARS_KEEP);
  });
});

// ─── Tracked set ─────────────────────────────────────────────────────────────

describe("selectTracked", () => {
  const empty: BarsIndex = { tokens: {}, lastCycle: null };

  it("tracks live meme stocks and shortlisted rows, nothing else", () => {
    const board = [row(1), row(2, { quote: "bnb" }), dead(3), row(4)];
    const { tokens } = selectTracked(empty, board, new Set(), NOW);
    assert.deepEqual(Object.keys(tokens).sort(), [addr(1), addr(4)]);
  });

  it("keeps a token 30 minutes after it was last live, then lets it go", () => {
    const index: BarsIndex = { tokens: { [addr(9)]: { symbol: "OLD", enteredAt: NOW - HOUR, lastLiveAt: NOW - LEAVE_AFTER_MS } }, lastCycle: null };
    assert.ok(addr(9) in selectTracked(index, [], new Set(), NOW).tokens);
    assert.equal(addr(9) in selectTracked(index, [], new Set(), NOW + 1).tokens, false);
  });

  it("caps the set, live and shortlisted first, then by 5-minute trades, and says so", () => {
    const board = Array.from({ length: MEME_BARS_CAP + 5 }, (_, i) => row(100 + i, { txs5m: i }));
    const index: BarsIndex = { tokens: { [addr(9)]: { symbol: "OLD", enteredAt: NOW - HOUR, lastLiveAt: NOW - MIN } }, lastCycle: null };
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

describe("runMemeBars", () => {
  it("backfills each live meme stock on entry, closed minutes only, then reads incrementally", async () => {
    const h = await harness();
    const first = await h.run();
    assert.deepEqual(first, { tracked: 2, candidates: 2, capped: false, calls: 2, failures: 0, throttled: false });
    assert.deepEqual(h.asked.map(([, limit]) => limit), [MEME_BARS_KEEP, MEME_BARS_KEEP]);
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
      address: addr(1), symbol: "M1", source: "sintral", unit: "usd", lastClosedStartMs: lastClosed, seed: null,
      bars: [[lastClosed - MIN, 1, 1.1, 0.9, 1, 50, 3], [lastClosed, 1, 1, 1, 1, 0, 0]],
    };
    await store.put(memeBarsKey(addr(1)), stored, { source: "sintral", freshForMs: 3 * MIN, deadAfterMs: 30 * MIN });
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
    assert.deepEqual(body.data[1]!["bars"], [{ startMs: lastClosed, open: 1, high: 1, low: 1, close: 1, volume: 0, trades: 0 }]);
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
