import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchSmartMoneyInflow,
  fetchSocialRush,
  normalizeSmartMoneyInflow,
  normalizeSocialRush,
  type MemeRushRow,
  type SmartInflowRow,
  type SocialTopic,
} from "../src/adapters/binanceWeb3.js";
import type { TokenActivity } from "../src/adapters/onchainos.js";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore, PostgresStore, type SnapshotStore } from "../src/core/store.js";
import { MEME_BOARD_KEY } from "../src/jobs/memeBoard.js";
import {
  MEME_MEASURE_LATEST_KEY,
  MEME_MEASURE_LEASE,
  MEME_MEASURE_SLOTS,
  MEME_MEASURE_SLOT_MS,
  expandCycle,
  isMemeMeasureEnabled,
  memeMeasureSlotKey,
  readMeasurePage,
  runMemeMeasure,
  sig,
  slotOf,
  type MeasureCycle,
  type RunMemeMeasureOptions,
} from "../src/jobs/memeMeasure.js";
import { classifyMeme, type ClassifyInput, type MemeBoardRow } from "../src/query/memeClassify.js";
import { createServer } from "../src/server.js";
import { RWA_UNIVERSE_KEY } from "../src/universe.js";
import { FakePg } from "./fakePg.js";
import { fakeFetch, jsonResponse } from "./helpers.js";

/** On a slot boundary, so `NOW + k * SLOT` is the start of slot `k` later. */
const NOW = 1_791_120_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const SLOT = MEME_MEASURE_SLOT_MS;
const BNB = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const TTL = { source: "test", freshForMs: 3 * MIN, deadAfterMs: 30 * MIN };

function addr(n: number): string {
  return `0x${n.toString(16).padStart(40, "0")}`;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function rush(overrides: Partial<MemeRushRow> = {}): MemeRushRow {
  return {
    address: addr(1), symbol: "MEME", name: "Meme", launchpad: "flap", stage: "finalizing", createdAt: NOW - 3 * HOUR,
    progress: 40, migrated: false, migratedAt: null, quote: BNB, priceUsd: 0.0001, marketCapUsd: 50_000,
    liquidityUsd: 10_000, volume24hUsd: 20_000, priceChange24hPct: 10, holders: 200, count24h: 500, buys24h: 300,
    sells24h: 200, netBuy24hUsd: 1_000, top10Pct: 20, devPct: 0, sniperPct: 5, insiderPct: 0, bundlerPct: 0,
    newWalletPct: 1, smartMoneyHolders: 0, kolHolders: 0, devAddress: addr(999), devSoldAll: false,
    devMigrateCount: 0, washTrading: false, socials: { website: null, twitter: null, telegram: null },
    ...overrides,
  };
}

function activity(overrides: Partial<TokenActivity> = {}): TokenActivity {
  return {
    address: addr(1), observedAt: NOW - 10_000, priceUsd: 0.0001, marketCapUsd: 50_000, liquidityUsd: 10_000,
    holders: 200, txs5m: 10, txs1h: 60, txs4h: 200, txs24h: 500, volume5mUsd: 200, volume1hUsd: 3_000,
    volume4hUsd: 9_000, volume24hUsd: 20_000, priceChange5mPct: 1, priceChange1hPct: 5, priceChange4hPct: 10,
    priceChange24hPct: 10,
    ...overrides,
  };
}

function classify(overrides: Partial<ClassifyInput>): MemeBoardRow {
  return classifyMeme({
    rush: rush(), activity: activity(), signals: [], quote: { kind: "bnb", symbol: "BNB" }, cloneOf: null,
    lastListedAt: NOW, firstSeenAt: NOW - HOUR, previousDeadSince: null, now: NOW,
    ...overrides,
  });
}

/** A live meme quoted in NVDAB that clears every memestock gate when NVDAB is open. */
function memeStock(n: number): MemeBoardRow {
  return classify({
    rush: rush({ address: addr(n), symbol: `M${n}`, quote: NVDAB, createdAt: NOW - HOUR }),
    activity: activity({ address: addr(n), txs5m: 10, txs1h: 60 }),
    quote: { kind: "bstock", symbol: "NVDAB" },
    flow1h: { buys: 120, sells: 80, uniqueTraders: 90, inflowUsd: 1_000 },
  });
}

/** A meme stock dead for an hour: still recorded. */
function deadMemeStock(n: number): MemeBoardRow {
  return {
    ...classify({
      rush: rush({ address: addr(n), symbol: `D${n}`, quote: NVDAB, createdAt: NOW - 5 * HOUR }),
      activity: activity({ address: addr(n), txs5m: 0, txs1h: 0, volume5mUsd: 0, volume1hUsd: 0 }),
      quote: { kind: "bstock", symbol: "NVDAB" },
    }),
  };
}

/** A BNB-quoted meme: not a meme stock, never recorded. */
function bnbMeme(n: number): MemeBoardRow {
  return classify({ rush: rush({ address: addr(n), symbol: `B${n}` }), activity: activity({ address: addr(n) }) });
}

function topic(n: number, tokens: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topicId: `topic-${n}`,
    chainId: "56",
    name: { topicNameEn: `Topic ${n}`, topicNameCn: `话题 ${n}` },
    type: "Culture",
    close: 0,
    topicLink: `https://x.com/someone/status/${n}`,
    createTime: NOW - n * MIN,
    risingTime: null,
    viralTime: null,
    tokenSize: tokens.length,
    progress: "97.0113",
    aiSummary: { aiSummaryEn: "SECRET-SUMMARY-TEXT", aiSummaryCn: "SECRET-SUMMARY-TEXT" },
    topicNetInflow: "167.33264362535587",
    topicNetInflow1h: "167.33264362535587",
    topicNetInflowAth: "200",
    deepAnalysisFlag: 0,
    topicTags: ["CN Culture", "Douyin"],
    tokenList: tokens.map((address) => ({
      chainId: "56",
      contractAddress: address,
      symbol: "TOK",
      icon: "/x.webp",
      createTime: NOW - n * MIN,
      previewLink: { x: ["https://x.com/someone/status/1?s=20"] },
      netInflow: "0.00145583120293",
      netInflow1h: "12.5",
      volume1hBuy: "20",
      volume1hSell: "7.5",
      marketCap: "4870.40036179455943470245261151",
      priceChange24h: "0",
      liquidity: "0.0026207873315151422006297532492",
      protocol: 2002,
      migrateStatus: 0,
      uniqueTrader5m: 0,
      uniqueTrader1h: 1,
      count5m: 0,
      count1h: 1,
      holders: 2,
      kolHolders: null,
      smartMoneyHolders: null,
    })),
    ...extra,
  };
}

function inflowRaw(address: string, inflow: number): Record<string, unknown> {
  return {
    tokenName: "旺柴",
    ca: address,
    price: "0.011012530028774861600222595465246199",
    marketCap: "11012530.0287",
    volume: "49412.16",
    holders: "4685",
    holdersTop10Percent: "17.971861196953482",
    liquidity: "407203.83",
    count: "478",
    countBuy: "214",
    countSell: "264",
    inflow,
    traders: 14,
    tokenRiskLevel: 0,
    tokenRiskCodes: [],
    aiNarrativeFlag: 1,
    launchTime: 1789686768700,
    link: [{ label: "x", link: "https://x.com/wangchaionbnb" }],
  };
}

const topicsLatest = (): SocialTopic[] =>
  normalizeSocialRush({ code: "000000", data: [topic(1, [addr(10), addr(99)]), topic(2, [])] });
const inflowRows = (): SmartInflowRow[] =>
  normalizeSmartMoneyInflow({ code: "000000", data: [inflowRaw(addr(11), -120.5), inflowRaw(addr(98), 40)] });

interface Harness {
  store: MemoryStore;
  clock: { now: number };
  calls: string[];
  options: RunMemeMeasureOptions;
}

/** A store holding a fresh board, an open NVDAB, and upstream fakes that count their calls. */
async function harness(board: MemeBoardRow[] = [memeStock(10), memeStock(11), deadMemeStock(12), bnbMeme(13)]): Promise<Harness> {
  const clock = { now: NOW };
  const store = new MemoryStore(() => clock.now);
  await store.put(MEME_BOARD_KEY, board, TTL);
  await store.put(RWA_UNIVERSE_KEY, { rows: [{ address: NVDAB, symbol: "NVDAB", underlyingTicker: "NVDA", tokenPriceUsd: 235, openState: true }] }, TTL);
  const calls: string[] = [];
  return {
    store,
    clock,
    calls,
    options: {
      now: () => clock.now,
      holder: "test-holder",
      fetchTopics: async (rank) => {
        calls.push(`topics:${rank}`);
        return topicsLatest();
      },
      fetchInflow: async (period) => {
        calls.push(`inflow:${period}`);
        return inflowRows();
      },
    },
  };
}

async function storedCycle(store: SnapshotStore, ts: number): Promise<MeasureCycle | null> {
  return (await store.get<MeasureCycle>(memeMeasureSlotKey(slotOf(ts))))?.data ?? null;
}

const signal = () => AbortSignal.timeout(5_000);

// ─── Adapters ────────────────────────────────────────────────────────────────

describe("normalizeSocialRush", () => {
  it("keeps the English name and the link and drops every other free-text field", () => {
    const [first] = normalizeSocialRush({ code: "000000", data: [topic(1, [addr(10)])] });
    assert.equal(first?.topicId, "topic-1");
    assert.equal(first?.nameEn, "Topic 1");
    assert.equal(first?.link, "https://x.com/someone/status/1");
    assert.deepEqual(first?.tags, ["CN Culture", "Douyin"]);
    assert.equal(first?.progress, 97.0113);
    assert.equal(first?.tokens[0]?.address, addr(10));
    assert.equal(first?.tokens[0]?.migrated, false);
    assert.equal(first?.tokens[0]?.smartMoneyHolders, null);
    const text = JSON.stringify(first);
    assert.equal(text.includes("SECRET-SUMMARY-TEXT"), false);
    assert.equal(text.includes("话题"), false, "the Chinese name is not kept either");
    assert.equal(text.includes("previewLink") || text.includes("icon"), false);
  });

  it("drops a non-http link, a topic without an id, and repeated topics and tokens", () => {
    const topics = normalizeSocialRush({
      code: "000000",
      data: [
        topic(1, [addr(10), addr(10).toUpperCase().replace("0X", "0x"), "not-an-address"], { topicLink: "javascript:alert(1)" }),
        topic(1, []),
        { ...topic(2, []), topicId: "" },
      ],
    });
    assert.equal(topics.length, 1);
    assert.equal(topics[0]?.link, null);
    assert.deepEqual(topics[0]?.tokens.map((t) => t.address), [addr(10)]);
  });

  it("throws on an unsuccessful envelope rather than reading it as an empty list", () => {
    assert.throws(() => normalizeSocialRush({ code: "100001", message: "busy" }), /busy/u);
  });

  it("asks for the requested rank with the documented sort", async () => {
    const fake = fakeFetch(() => jsonResponse({ code: "000000", data: [] }));
    await fetchSocialRush({ rank: "rising", fetchFn: fake.fetch });
    assert.match(fake.calls[0]!.url, /social-rush\/rank\/list\/ai\?chainId=56&rankType=20&sort=10&asc=false$/u);
    assert.equal(fake.calls[0]!.method, "GET");
  });
});

describe("normalizeSmartMoneyInflow", () => {
  it("keeps list position as rank, a signed inflow, and the upstream's market counts under their own names", () => {
    const rows = normalizeSmartMoneyInflow({
      code: "000000",
      data: [inflowRaw(addr(1), -1199.19), { tokenName: "broken" }, inflowRaw(addr(2), 39.04), inflowRaw(addr(1), 5)],
    });
    assert.deepEqual(rows.map((r) => [r.rank, r.address, r.netInflowUsd]), [[1, addr(1), -1199.19], [3, addr(2), 39.04]]);
    assert.equal(rows[0]?.traders, 14);
    assert.equal(rows[0]?.countBuy, 214);
    assert.equal(rows[0]?.aiNarrative, true);
    assert.equal(JSON.stringify(rows).includes("wangchaionbnb"), false, "links are not kept");
  });

  it("posts the period with tagType 2", async () => {
    const fake = fakeFetch(() => jsonResponse({ code: "000000", data: [] }));
    await fetchSmartMoneyInflow({ period: "5m", fetchFn: fake.fetch });
    assert.equal(fake.calls[0]!.method, "POST");
    assert.deepEqual(JSON.parse(fake.calls[0]!.body!), { chainId: "56", period: "5m", tagType: 2 });
  });
});

// ─── Recorder ────────────────────────────────────────────────────────────────

describe("runMemeMeasure", () => {
  it("records topics, both inflow windows and every meme-stock row, dead ones included", async () => {
    const h = await harness();
    const result = await runMemeMeasure(h.store, signal(), h.options);
    assert.equal(result.recorded, true);
    const cycle = (await storedCycle(h.store, NOW))!;
    assert.equal(cycle.slot, slotOf(NOW));
    assert.equal(cycle.ts, NOW);
    assert.deepEqual(cycle.failures, []);
    assert.deepEqual(cycle.topics?.lists, { latest: ["topic-1", "topic-2"], rising: "same" });
    assert.equal(cycle.topics?.topics.rows.length, 2, "an identical rising list is not stored twice");
    assert.equal(cycle.inflow["5m"]?.length, 2);
    assert.equal(cycle.inflow["1h"]?.length, 2);

    const expanded = expandCycle(cycle) as {
      topics: { tokens: Array<Record<string, unknown>> };
      board: { rows: Array<Record<string, unknown>> };
    };
    const board = expanded.board.rows;
    assert.deepEqual(board.map((r) => r["address"]), [addr(10), addr(11), addr(12)], "BNB-quoted memes are not recorded");
    assert.equal(board.find((r) => r["address"] === addr(12))?.["status"], "dead");
    assert.equal(board[0]?.["quoteSymbol"], "NVDAB");
    assert.equal(board[0]?.["activityAgeS"], 10);
    assert.equal(board[0]?.["buys1h"], 120);
    assert.ok(Array.isArray(board[0]?.["flags"]));
    assert.equal((board[0]?.["flags"] as string[]).includes("bstock_quote"), false);
    assert.equal(expanded.topics.tokens[0]?.["topicId"], "topic-1");
    assert.equal(expanded.topics.tokens[0]?.["netInflow1hUsd"], 12.5);

    if (!result.recorded) throw new Error("unreachable");
    assert.deepEqual(result.latest.counts, {
      topics: 2, topicTokens: 2, memeStocksInTopics: 1, inflow5m: 2, inflow1h: 2, memeStocksInInflow: 1, boardRows: 3,
    });
    assert.ok(result.latest.bytes > 0);
  });

  it("marks the rows the memestock shortlist would serve, with the route's own function", async () => {
    const h = await harness();
    await runMemeMeasure(h.store, signal(), h.options);
    const cycle = (await storedCycle(h.store, NOW))!;
    const rows = (expandCycle(cycle) as { board: { rows: Array<Record<string, unknown>> } }).board.rows;
    assert.deepEqual(rows.map((r) => [r["address"], r["onShortlist"]]), [[addr(10), true], [addr(11), true], [addr(12), false]]);
    assert.equal(cycle.board?.shortlistSize, 2);
  });

  it("never stores topic summaries or other free text", async () => {
    const h = await harness();
    await runMemeMeasure(h.store, signal(), h.options);
    const text = JSON.stringify(await storedCycle(h.store, NOW));
    assert.equal(text.includes("SECRET-SUMMARY-TEXT"), false);
    assert.equal(text.includes("wangchaionbnb"), false);
  });

  it("records once per slot: later ticks in the slot call no upstream", async () => {
    const h = await harness();
    await runMemeMeasure(h.store, signal(), h.options);
    assert.equal(h.calls.length, 4);
    h.clock.now = NOW + 2 * MIN;
    assert.deepEqual(await runMemeMeasure(h.store, signal(), h.options), { recorded: false, reason: "slot_recorded" });
    assert.equal(h.calls.length, 4);
    h.clock.now = NOW + SLOT + 30_000;
    await h.store.put(MEME_BOARD_KEY, [memeStock(10)], TTL);
    assert.equal((await runMemeMeasure(h.store, signal(), h.options)).recorded, true);
    assert.equal(h.calls.length, 8);
    assert.equal((await storedCycle(h.store, NOW + SLOT))?.slot, slotOf(NOW) + 1);
  });

  it("does not record while another replica holds the lease", async () => {
    const h = await harness();
    assert.equal(await h.store.acquireSchedulerLease(MEME_MEASURE_LEASE, "other-replica", 120_000), true);
    assert.deepEqual(await runMemeMeasure(h.store, signal(), h.options), { recorded: false, reason: "lease_held" });
    assert.equal(h.calls.length, 0);
    assert.equal(await storedCycle(h.store, NOW), null);
  });

  it("stores a rising list that differs, with its extra topics, once each", async () => {
    const h = await harness();
    h.options.fetchTopics = async (rank) =>
      rank === "latest"
        ? normalizeSocialRush({ data: [topic(1, []), topic(2, [])] })
        : normalizeSocialRush({ data: [topic(3, []), topic(1, [])] });
    await runMemeMeasure(h.store, signal(), h.options);
    const cycle = (await storedCycle(h.store, NOW))!;
    assert.deepEqual(cycle.topics?.lists, { latest: ["topic-1", "topic-2"], rising: ["topic-3", "topic-1"] });
    assert.deepEqual(cycle.topics?.topics.rows.map((r) => r[0]), ["topic-1", "topic-2", "topic-3"]);
  });

  it("records a partial cycle with the failure named, and leaves the board out when it is not fresh", async () => {
    const h = await harness();
    h.options.fetchInflow = async (period) => {
      if (period === "5m") throw new Error("upstream responded 429");
      return inflowRows();
    };
    h.clock.now = NOW + 4 * MIN; // the board record (written at NOW) is stale past 3 min
    await runMemeMeasure(h.store, signal(), h.options);
    const cycle = (await storedCycle(h.store, h.clock.now))!;
    assert.equal(cycle.inflow["5m"], null);
    assert.equal(cycle.inflow["1h"]?.length, 2);
    assert.equal(cycle.board, null);
    assert.ok(cycle.failures.some((f) => f.startsWith("inflow:5m:") && f.includes("429")));
    assert.ok(cycle.failures.includes("board: not fresh (stale)"));
  });

  it("throws and writes nothing when no source answered", async () => {
    const h = await harness();
    await h.store.put(MEME_BOARD_KEY, [], { source: "test", freshForMs: 1, deadAfterMs: 2 });
    h.clock.now = NOW + 10;
    h.options.fetchTopics = async () => { throw new Error("down"); };
    h.options.fetchInflow = async () => { throw new Error("down"); };
    await assert.rejects(runMemeMeasure(h.store, signal(), h.options), /no measurement source available/u);
    assert.equal(await storedCycle(h.store, h.clock.now), null);
    assert.equal(await h.store.get(MEME_MEASURE_LATEST_KEY), null);
  });

  it("never writes the board or any key a trading read uses", async () => {
    const h = await harness();
    const before = await h.store.get(MEME_BOARD_KEY);
    const writes: string[] = [];
    const watched: SnapshotStore = Object.create(h.store) as SnapshotStore;
    watched.put = async (key, payload, opts) => {
      writes.push(key);
      await h.store.put(key, payload, opts);
    };
    watched.get = (key) => h.store.get(key);
    watched.acquireSchedulerLease = (...args) => h.store.acquireSchedulerLease(...args);
    await runMemeMeasure(watched, signal(), h.options);
    assert.deepEqual(writes, [memeMeasureSlotKey(slotOf(NOW)), MEME_MEASURE_LATEST_KEY]);
    assert.deepEqual(await h.store.get(MEME_BOARD_KEY), before);
  });

  it("round-trips through Postgres (jsonb, bigint retention, unicode symbols)", async () => {
    const clock = { now: NOW };
    const store = await PostgresStore.create("postgres://unused", { client: new FakePg(), now: () => clock.now });
    await store.put(MEME_BOARD_KEY, [memeStock(10)], TTL);
    const options: RunMemeMeasureOptions = {
      now: () => clock.now,
      holder: "pg",
      fetchTopics: async () => topicsLatest(),
      fetchInflow: async () => inflowRows(),
    };
    assert.equal((await runMemeMeasure(store, signal(), options)).recorded, true);
    const cycle = await storedCycle(store, NOW);
    assert.equal(cycle?.slot, slotOf(NOW));
    assert.equal(cycle?.inflow["1h"]?.[0]?.[2], "旺柴");
    clock.now = NOW + 6 * 86_400_000;
    const page = await readMeasurePage(store, NOW, NOW + SLOT, 12, clock.now);
    assert.equal(page.cycles.length, 1, "still inside retention after six days");
  });
});

describe("measurement ring and paging", () => {
  it("rounds to significant digits, prices six and amounts four", () => {
    assert.equal(sig(0.000012345678901), 0.0000123457);
    assert.equal(sig(167.33264362535587, 4), 167.3);
    assert.equal(sig(null), null);
    assert.equal(sig(Number.NaN), null);
    assert.equal(sig(0), 0);
  });

  it("maps a slot and the slot a full ring later to the same key, and the reader tells them apart", async () => {
    assert.equal(memeMeasureSlotKey(5), memeMeasureSlotKey(5 + MEME_MEASURE_SLOTS));
    assert.ok(MEME_MEASURE_SLOTS * SLOT > 7 * 86_400_000, "the ring outlasts the retention");
    const h = await harness();
    await runMemeMeasure(h.store, signal(), h.options);
    // A reader asking for the slot one ring later must not get this week-old cycle.
    const later = NOW + MEME_MEASURE_SLOTS * SLOT;
    const page = await readMeasurePage(h.store, later, later + SLOT, 12, later + SLOT);
    assert.deepEqual(page.cycles, []);
    assert.equal(page.emptySlots, 1);
  });

  it("pages by slot with a next cursor, counts empty slots, and stops at now", async () => {
    const h = await harness();
    for (const k of [0, 1, 3]) {
      h.clock.now = NOW + k * SLOT + 1_000;
      await h.store.put(MEME_BOARD_KEY, [memeStock(10)], TTL);
      assert.equal((await runMemeMeasure(h.store, signal(), h.options)).recorded, true);
    }
    const now = NOW + 3 * SLOT + 2_000;
    const first = await readMeasurePage(h.store, NOW, NOW + HOUR, 2, now);
    assert.deepEqual(first.cycles.map((c) => c.slot - slotOf(NOW)), [0, 1]);
    assert.equal(first.next, NOW + 2 * SLOT);
    const second = await readMeasurePage(h.store, first.next!, NOW + HOUR, 2, now);
    assert.deepEqual(second.cycles.map((c) => c.slot - slotOf(NOW)), [3]);
    assert.equal(second.emptySlots, 1);
    assert.equal(second.next, null, "nothing to page past the current slot");
  });

  it("does not ask for slots older than the retention window", async () => {
    const h = await harness();
    await runMemeMeasure(h.store, signal(), h.options);
    const now = NOW + 8 * 86_400_000;
    const page = await readMeasurePage(h.store, NOW, NOW + SLOT, 12, now);
    assert.deepEqual(page.cycles, []);
    assert.equal(page.emptySlots, 0);
  });

  it("is on unless switched off explicitly", () => {
    assert.equal(isMemeMeasureEnabled({}), true);
    assert.equal(isMemeMeasureEnabled({ MEME_MEASURE_ENABLED: "true" }), true);
    assert.equal(isMemeMeasureEnabled({ MEME_MEASURE_ENABLED: "false" }), false);
  });
});

// ─── Route ───────────────────────────────────────────────────────────────────

describe("GET /memes/measure", () => {
  async function app(): Promise<{ request: (path: string) => Promise<Response> }> {
    const store = new MemoryStore();
    const now = Date.now();
    await store.put(MEME_BOARD_KEY, [memeStock(10)], TTL);
    await runMemeMeasure(store, signal(), {
      now: () => now,
      holder: "route",
      fetchTopics: async () => topicsLatest(),
      fetchInflow: async () => inflowRows(),
    });
    const server = createServer({ scheduler: createScheduler(store), store });
    return { request: async (path) => server.request(path) };
  }

  it("serves the last hour by default, expanded into objects, and is not taken for an address", async () => {
    const { request } = await app();
    const response = await request("/memes/measure");
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      data: { cycles: Array<{ board: { rows: Array<Record<string, unknown>> }; inflow: Record<string, unknown[]> }> };
      meta: { cycles: number; next: number | null; latest: { counts: { boardRows: number } }; use: string };
    };
    assert.equal(body.meta.cycles, 1);
    assert.equal(body.data.cycles[0]?.board.rows[0]?.["address"], addr(10));
    assert.equal(body.data.cycles[0]?.inflow["1h"]?.length, 2);
    assert.equal(body.meta.latest.counts.boardRows, 1);
    assert.equal(body.meta.next, null);
    assert.match(body.meta.use, /not a trading signal/u);
  });

  it("serves the stored tuples with format=compact", async () => {
    const { request } = await app();
    const body = (await (await request("/memes/measure?format=compact")).json()) as {
      data: { cycles: MeasureCycle[] };
    };
    assert.ok(Array.isArray(body.data.cycles[0]?.board?.rows[0]));
    assert.ok(body.data.cycles[0]?.board?.columns.includes("onShortlist"));
  });

  it("rejects malformed windows, page sizes and formats", async () => {
    const { request } = await app();
    for (const query of ["since=abc", "since=2000&until=1000", "limit=0", "limit=49", "limit=1.5", "format=csv"]) {
      assert.equal((await request(`/memes/measure?${query}`)).status, 400, query);
    }
    assert.equal((await request("/memes/measure?since=2026-10-05T00:00:00Z&limit=48")).status, 200);
  });
});
