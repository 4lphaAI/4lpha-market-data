import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import { createServer } from "../src/server.js";
import { MAX_UNDERLYING_TOKENS, runTradingUnderlyingFeatures, selectUnderlyingTokens, tradingUnderlyingFeaturesJob } from "../src/jobs/tradingUnderlyingFeatures.js";
import { recordReferenceBars, REFERENCE_BARS_OPEN_KEY, type ReferenceObservation } from "../src/jobs/rwaReferenceBars.js";
import type { PoolOhlcvResult } from "../src/query/poolOhlcv.js";
import {
  FEATURE_INDEX_KEY_V2,
  FEATURE_VERSION_V2,
  UNDERLYING_FEATURE_INDEX_KEY,
  UNDERLYING_FEATURE_STATE_KEY,
  UNDERLYING_FEATURE_VERSION,
  calculateFeatures,
  calculateUnderlyingFeatures,
  poolFeatureInput,
  readUnderlyingFeatures,
  underlyingFeatureKey,
  type FeatureAttempt,
  type Metric,
  type ReferenceSession,
  type UnderlyingBar,
  type UnderlyingFeatureIndex,
  type UnderlyingFeatureSnapshot,
  type UnderlyingInterval,
} from "../src/query/tradingFeatures.js";
import { RWA_UNIVERSE_KEY } from "../src/universe.js";

const TOKEN = "0x00000000000000000000000000000000000000a1";
// Wednesday 2026-10-07 16:00:20 UTC = 12:00 ET, regular session (EDT, UTC-4).
const NOW = Date.UTC(2026, 9, 7, 16, 0, 20);
const OBSERVED = NOW - 5_000;
const STEP = { "15m": 900_000, "1h": 3_600_000 } as const;
const REFERENCE: ReferenceSession = { underlyingTicker: "AMD", marketStatus: null, openState: true, asOf: NOW - 60_000 };

interface SeriesOptions {
  interval?: UnderlyingInterval;
  count?: number;
  /** Is bucket `i` (0 = oldest) a counted change? */
  changed: (i: number) => boolean;
  /** Buckets with no observation at all. */
  missing?: (i: number) => boolean;
  now?: number;
}

/** Bars ending at the last closed bucket before `now`, a zig-zag walk on changed buckets and flat bars between them. */
function series(options: SeriesOptions): UnderlyingBar[] {
  const interval = options.interval ?? "15m";
  const step = STEP[interval];
  const count = options.count ?? 120;
  const cutoff = Math.floor(((options.now ?? NOW) - 15_000) / step) * step;
  const bars: UnderlyingBar[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const changed = options.changed(i);
    const open = price;
    if (changed) price = price * (i % 2 === 0 ? 1.003 : 0.9975);
    if (options.missing?.(i)) continue;
    bars.push({ t: cutoff - (count - i) * step, o: open, h: Math.max(open, price) * (changed ? 1.0005 : 1), l: Math.min(open, price) * (changed ? 0.9995 : 1),
      c: price, samples: 15, changes: changed ? 1 : 0 });
  }
  return bars;
}

const calc = (bars: UnderlyingBar[], interval: UnderlyingInterval = "15m", reference: ReferenceSession | null = REFERENCE, now = NOW) =>
  calculateUnderlyingFeatures({ token: TOKEN, underlyingTicker: "AMD", interval, endpoint: "tokens", bars, lastObservedAt: OBSERVED, referenceSession: reference }, now);
const metric = (snapshot: UnderlyingFeatureSnapshot, name: string): Metric => (snapshot.metrics as Record<string, Metric>)[name]!;

describe("underlying features: the shared calculator over recorded bars", () => {
  it("publishes the version, identity, scope and the volume-free label", () => {
    const snapshot = calc(series({ changed: () => true }));
    assert.equal(snapshot.version, "underlying-features-v1");
    assert.equal(snapshot.version, UNDERLYING_FEATURE_VERSION);
    assert.deepEqual(snapshot.identity, {
      chainId: 56, tokenAddress: TOKEN, underlyingTicker: "AMD", endpoint: "tokens", interval: "15m", priceCurrency: "usd",
      priceBasis: "usd_per_share", source: "binance-rwa", observedAt: OBSERVED, referenceSession: REFERENCE,
    });
    assert.deepEqual(snapshot.lineage, {
      scope: "underlying", series: "binance-rwa-reference-usd", source: "binance-rwa", transformation: "sampled_60s",
      label: "underlying reference price, sampled every 60 s, no volume",
      correctionPolicy: "missing buckets stay missing; never filled; never spliced",
    });
    assert.equal(snapshot.parameters.indicatorRevision, 2, "no Sintral fill");
    assert.match(snapshot.snapshotId, /^[0-9a-f]{64}$/u);
    assert.match(snapshot.seriesId, /^[0-9a-f]{64}$/u);
    assert.ok(!JSON.stringify(snapshot).includes("poolAddress"), "no pool field is published");
    assert.ok(!JSON.stringify(snapshot).includes("quoteAddress"), "no quote field is published");
  });

  it("uses the shared rev-3 math: its metrics equal calculateFeatures on the same candles", () => {
    const bars = series({ changed: () => true });
    const snapshot = calc(bars);
    const direct = calculateFeatures({
      chainId: 56, poolAddress: TOKEN, baseAddress: TOKEN, quoteAddress: "0x55d398326f99059ff775485246999027b3197955", priceCurrency: "usd",
      volumeCurrency: "none", volumeUnavailableReason: "no_volume", source: "binance-rwa", interval: "15m", observedAt: OBSERVED,
      candles: bars.map((b) => ({ timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: null })), conflictingTimestamps: [],
      changedBuckets: bars.map((b) => b.t), referenceSession: REFERENCE }, NOW, FEATURE_VERSION_V2);
    assert.deepEqual(snapshot.metrics, direct.metrics);
    assert.equal(metric(snapshot, "rsi14").available, true);
    assert.equal(metric(snapshot, "macd").available, true);
  });

  it("29 changed buckets make every metric too_few_real_bars, 30 make the metrics with a satisfied warm-up available", () => {
    // The changed buckets are the newest ones; the older ones are stored flat bars.
    const at = (changed: number) => calc(series({ changed: (i) => i >= 120 - changed }));
    const few = at(29);
    assert.equal(few.coverage.realBars, 29);
    for (const [name, m] of Object.entries(few.metrics)) assert.equal(m.reason, "too_few_real_bars", name);
    const enough = at(30);
    assert.equal(enough.coverage.realBars, 30);
    assert.equal(metric(enough, "rsi14").available, true);
    assert.equal(metric(enough, "roc10Pct").available, true);
    assert.equal(metric(enough, "bbMiddle20").available, true);
    assert.equal(metric(enough, "ema12").available, true);
    // ema26 / macd read 52 buckets and need 32 of them changed: 30 is not enough, and that is not the series floor.
    assert.equal(metric(enough, "ema26").reason, "flat_input");
    assert.equal(metric(enough, "macd").reason, "flat_input");
  });

  it("counts changed buckets, not stored flat ones: 120 stored buckets with 10 changed are too few", () => {
    const snapshot = calc(series({ changed: (i) => i % 12 === 0 }));
    assert.equal(snapshot.coverage.availableBars, 120);
    assert.equal(snapshot.coverage.realBars, 10);
    assert.equal(metric(snapshot, "roc10Pct").reason, "too_few_real_bars");
  });

  it("never fills a missing bucket: the time axis breaks, coverage shows the hole, filledBars stays 0", () => {
    const snapshot = calc(series({ changed: () => true, missing: (i) => i === 100 }));
    assert.equal(snapshot.coverage.filledBars, 0);
    assert.equal(snapshot.coverage.missingBuckets, 1);
    assert.equal(snapshot.coverage.contiguousBars, 19, "the 19 buckets after the hole");
    assert.equal(snapshot.coverage.realBars, 119);
    assert.equal(metric(snapshot, "rsi14").reason, "gap", "a 29-bucket window spans the hole");
    assert.equal(metric(snapshot, "roc10Pct").available, true, "an 11-bucket window does not");
  });

  it("volume metrics are always unavailable: rvol20 and the VWAP pair answer unknown_volume_unit", () => {
    const snapshot = calc(series({ changed: () => true }));
    assert.equal(metric(snapshot, "rvol20").reason, "unknown_volume_unit");
    assert.equal(metric(snapshot, "vwapSession").reason, "unknown_volume_unit");
    assert.equal(metric(snapshot, "vwapDistancePct").reason, "unknown_volume_unit");
    assert.deepEqual(snapshot.volume, { baseline: null, latest: null, usableBaselineBars: 0 });
  });

  it("publishes coverage.changedBuckets as the ascending bucket opens inside the window that changed", () => {
    const bars = series({ changed: (i) => i % 4 !== 0 });
    const snapshot = calc(bars);
    const expected = bars.filter((b) => b.changes >= 1).map((b) => b.t);
    assert.deepEqual(snapshot.coverage.changedBuckets, expected);
    assert.equal(snapshot.coverage.realBars, expected.length);
    assert.ok(snapshot.coverage.changedBuckets!.length <= 120);
    // The window is the 120 buckets before the cutoff: an older changed bucket is not listed.
    const extra = [{ t: bars[0]!.t - 900_000, o: 1, h: 1, l: 1, c: 1, samples: 1, changes: 1 }, ...bars];
    assert.deepEqual(calc(extra).coverage.changedBuckets, expected);
  });

  it("the snapshot id covers the changed buckets and differs from the pool snapshot and between intervals", () => {
    const a = calc(series({ changed: (i) => i % 4 !== 0 }));
    const b = calc(series({ changed: (i) => i % 4 !== 1 }));
    assert.notEqual(a.snapshotId, b.snapshotId, "same candles shape, different changed buckets");
    const hourly = calc(series({ interval: "1h", changed: (i) => i % 4 !== 0 }), "1h");
    assert.notEqual(a.snapshotId, hourly.snapshotId);
    const bars = series({ changed: () => true });
    const pool = calculateFeatures({ chainId: 56, poolAddress: TOKEN, baseAddress: TOKEN, quoteAddress: "0x55d398326f99059ff775485246999027b3197955",
      priceCurrency: "usd", volumeCurrency: "none", volumeUnavailableReason: "no_volume", source: "sintral", interval: "15m", observedAt: OBSERVED,
      candles: bars.map((x) => ({ timestamp: x.t, open: x.o, high: x.h, low: x.l, close: x.c, volume: null })), conflictingTimestamps: [] }, NOW, FEATURE_VERSION_V2);
    assert.notEqual(calc(bars).snapshotId, pool.snapshotId);
    assert.notEqual(calc(bars).seriesId, pool.seriesId);
  });

  it("a pool input carries no changedBuckets key, not even an empty one, and keeps its source semantics", () => {
    const chart = { poolAddress: TOKEN, base: { address: TOKEN }, quote: { address: "0x55d398326f99059ff775485246999027b3197955" }, priceCurrency: "usd",
      volumeCurrency: "usd", volumeUnavailableReason: null, source: "sintral", asOf: OBSERVED, candles: [], quality: undefined } as unknown as PoolOhlcvResult;
    assert.equal(Object.hasOwn(poolFeatureInput(chart, "15m"), "changedBuckets"), false);
    // A changedBuckets list on a non-binance-rwa input changes nothing about the floor it applies: only binance-rwa reads it.
    const bars = series({ changed: () => false });
    const poolLike = calculateFeatures({ chainId: 56, poolAddress: TOKEN, baseAddress: TOKEN, quoteAddress: "0x55d398326f99059ff775485246999027b3197955",
      priceCurrency: "usd", volumeCurrency: "usd", volumeUnavailableReason: null, source: "geckoterminal", interval: "15m", observedAt: OBSERVED,
      candles: bars.map((x) => ({ timestamp: x.t, open: x.o, high: x.h, low: x.l, close: x.c, volume: 1 })), conflictingTimestamps: [], changedBuckets: [] }, NOW, FEATURE_VERSION_V2);
    assert.equal(poolLike.coverage.realBars, 120, "a geckoterminal series counts every bar");
    assert.equal(Object.hasOwn(poolLike.coverage, "changedBuckets"), false);
  });

  it("a series of stored flat bars with no change is entirely too_few_real_bars", () => {
    const snapshot = calc(series({ changed: () => false }));
    assert.equal(snapshot.coverage.realBars, 0);
    assert.equal(metric(snapshot, "gapPct").reason, "too_few_real_bars");
  });
});

describe("underlying features: the changed-fraction gate per metric (R3.3)", () => {
  /** Older buckets all changed (so the series floor holds); the newest `window` buckets have exactly `changed` changed. */
  function withWindowChanges(window: number, changed: number): UnderlyingBar[] {
    return series({ changed: (i) => (i < 120 - window ? true : i - (120 - window) < changed) });
  }
  const THRESHOLDS: Array<[string, number, number]> = [
    ["roc10Pct", 11, 7], ["momentum10", 11, 7],
    ["bbMiddle20", 20, 12], ["bbPosition20", 20, 12], ["bbWidthPct20", 20, 12],
    ["ema12", 24, 15],
    ["rsi14", 29, 18], ["atr14", 29, 18], ["atrPct", 29, 18],
    ["stochRsi14", 42, 26],
    ["ema26", 52, 32], ["emaSpreadPct", 52, 32], ["macd", 52, 32],
    ["signal9", 69, 42], ["histogram", 69, 42],
  ];
  for (const [name, window, needed] of THRESHOLDS) {
    it(`${name}: needs ${needed} of its ${window} buckets changed`, () => {
      assert.equal(Math.ceil(0.6 * window), needed, "the table is ceil(0.6 x r)");
      const below = metric(calc(withWindowChanges(window, needed - 1)), name);
      assert.equal(below.available, false);
      assert.equal(below.reason, "flat_input", `${needed - 1} changed`);
      const at = metric(calc(withWindowChanges(window, needed)), name);
      assert.equal(at.reason, null, `${needed} changed`);
      assert.equal(at.available, true);
    });
  }

  it("a 30-changed / 90-flat series whose last 29 buckets are flat does not publish rsi14", () => {
    const snapshot = calc(series({ changed: (i) => i < 30 }));
    assert.equal(snapshot.coverage.realBars, 30, "the series floor passes");
    assert.equal(metric(snapshot, "rsi14").reason, "flat_input");
    assert.equal(metric(snapshot, "bbPosition20").reason, "flat_input");
    assert.equal(metric(snapshot, "stochRsi14").reason, "flat_input");
  });

  it("17 changed of the last 29 -> rsi14 unavailable, 18 -> available", () => {
    assert.equal(metric(calc(series({ changed: (i) => i < 91 || i - 91 < 17 })), "rsi14").reason, "flat_input");
    assert.equal(metric(calc(series({ changed: (i) => i < 91 || i - 91 < 18 })), "rsi14").available, true);
  });

  it("the one-bucket metrics are exempt: gapPct answers on a flat newest window", () => {
    const snapshot = calc(series({ changed: (i) => i < 100 }));
    assert.equal(metric(snapshot, "rsi14").reason, "flat_input");
    assert.equal(metric(snapshot, "gapPct").available, true);
    assert.equal(metric(snapshot, "lastRthClose").available, true);
  });

  it("the opening range counts only if both ORB buckets changed, and is not the trailing two buckets", () => {
    // 13:30 and 13:45 UTC are the 09:30 and 09:45 ET buckets. Index of bucket T: 120 - (cutoff - T) / 15m.
    const cutoff = Math.floor((NOW - 15_000) / 900_000) * 900_000;
    const orbIndex = (hour: number, minute: number): number => 120 - (cutoff - Date.UTC(2026, 9, 7, hour, minute)) / 900_000;
    const first = orbIndex(13, 30);
    const second = orbIndex(13, 45);
    const both = calc(series({ changed: () => true }));
    assert.equal(metric(both, "orbBreakPct").available, true);
    assert.equal(metric(both, "orbHigh").available, true);
    for (const flatIndex of [first, second]) {
      const oneFlat = calc(series({ changed: (i) => i !== flatIndex }));
      for (const name of ["orbHigh", "orbLow", "orbBreakPct"]) assert.equal(metric(oneFlat, name).reason, "flat_input", `${name} with bucket ${flatIndex} flat`);
    }
    // The newest two buckets flat must not touch the opening range, which is earlier in the session.
    const trailingFlat = calc(series({ changed: (i) => i < 118 }));
    assert.equal(metric(trailingFlat, "orbBreakPct").available, true);
  });

  it("changed buckets without a stored bar are not counted", () => {
    const bars = series({ changed: () => false });
    const claimed = calculateUnderlyingFeatures({ token: TOKEN, underlyingTicker: "AMD", interval: "15m", endpoint: "tokens", lastObservedAt: OBSERVED,
      referenceSession: REFERENCE, bars: bars.map((b) => ({ ...b, changes: 0 })) }, NOW);
    assert.equal(claimed.coverage.realBars, 0);
  });
});

describe("underlying features: store-only read", () => {
  const key = underlyingFeatureKey(TOKEN, "15m");
  async function stored(now: number) {
    const store = new MemoryStore(() => now);
    const snapshot = calc(series({ changed: () => true }));
    await store.put(key, snapshot, { source: "t", freshForMs: Math.max(0, snapshot.expiresAt - now), deadAfterMs: 30 * 86_400_000 });
    return { store, snapshot };
  }

  it("serves the published record with staleness fresh before expiresAt", async () => {
    const { store, snapshot } = await stored(NOW);
    const read = (await readUnderlyingFeatures(store, TOKEN, "15m", NOW + 1_000))!;
    assert.equal(read.staleness, "fresh");
    assert.equal(read.snapshotId, snapshot.snapshotId);
    assert.equal(read.identity.tokenAddress, TOKEN);
    assert.equal((read.metrics as Record<string, Metric>)["rsi14"]?.available, true);
  });

  it("nulls every metric as stale_input from expiresAt on", async () => {
    const { store, snapshot } = await stored(NOW);
    const read = (await readUnderlyingFeatures(store, TOKEN, "15m", snapshot.expiresAt))!;
    assert.equal(read.staleness, "stale");
    for (const [name, m] of Object.entries(read.metrics as Record<string, Metric>)) {
      assert.equal(m.available, false, name);
      assert.equal(m.value, null, name);
      assert.equal(m.reason, "stale_input", name);
    }
  });

  it("nulls the metrics of a record from the future as observation_after_evaluation", async () => {
    const { store } = await stored(NOW);
    const read = (await readUnderlyingFeatures(store, TOKEN, "15m", NOW - 60_000))!;
    assert.equal(read.staleness, "stale");
    assert.equal((read.metrics as Record<string, Metric>)["rsi14"]?.reason, "observation_after_evaluation");
  });

  it("returns null for a missing key and for a record that is not this token or interval", async () => {
    const { store, snapshot } = await stored(NOW);
    assert.equal(await readUnderlyingFeatures(store, TOKEN, "1h", NOW), null);
    assert.equal(await readUnderlyingFeatures(store, "0x00000000000000000000000000000000000000b2", "15m", NOW), null);
    await store.put(underlyingFeatureKey("0x00000000000000000000000000000000000000b2", "15m"), snapshot, { source: "t", freshForMs: 1e9, deadAfterMs: 1e10 });
    assert.equal(await readUnderlyingFeatures(store, "0x00000000000000000000000000000000000000b2", "15m", NOW), null);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The producer job and the routes
// ---------------------------------------------------------------------------------------------------------------

describe("underlying features job and routes", () => {
  const MIN = 60_000;
  const clock = { t: 0 };
  const addr = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
  const TTL = { source: "test", freshForMs: 3_600_000, deadAfterMs: 86_400_000 };
  const POOLED = addr(0x501);
  const T1 = addr(0x601), T2 = addr(0x602), T3 = addr(0x603);
  const key = (token: string, interval: "15m" | "1h"): string => `trading:underlying-features:v1:${token}:${interval}`;

  const rwaRow = (address: string, over: { openState?: boolean | null; reasonCode?: string | null; platform?: string } = {}) => ({
    address, symbol: `S${address.slice(-3)}B`, name: null, platform: over.platform ?? "bstock", underlyingTicker: "AMD", underlyingName: null, decimals: 18,
    tokenToShareRatio: 1, tokenPriceUsd: 100, referencePriceUsd: 100, navPremiumBps: 0, underlyingMarketCapUsd: null, underlyingVolume24hUsd: null,
    openState: over.openState === undefined ? true : over.openState, marketStatus: null, reasonCode: over.reasonCode === undefined ? "TRADING" : over.reasonCode,
    nextOpenMs: null, nextCloseMs: null,
  });
  async function world(rows: ReturnType<typeof rwaRow>[], poolTokens: string[] = [POOLED], at = Date.UTC(2026, 9, 7, 16, 0, 20)): Promise<MemoryStore> {
    clock.t = at;
    const store = new MemoryStore(() => clock.t);
    await store.put(RWA_UNIVERSE_KEY, { rows, byPlatform: { bstock: rows.length } }, TTL);
    await store.put(FEATURE_INDEX_KEY_V2, { pools: poolTokens.map((tokenAddress) => ({ pool: addr(1), currency: "usd", tokenAddress })), intervals: ["15m", "1h"], maxPools: 40,
      selection: "marketplace_reference_pools" }, TTL);
    return store;
  }
  /** Records every token every 3 minutes from `from` to `to`, the reference changing by more than 1 bp each time. */
  async function recordSeries(store: MemoryStore, tokens: string[], from: number, to: number): Promise<number> {
    let last = from;
    for (let k = 0; from + k * 3 * MIN <= to; k++) {
      last = from + k * 3 * MIN;
      clock.t = last;
      const observations: ReferenceObservation[] = tokens.map((token, n) => ({ token, underlyingTicker: "AMD", endpoint: "tokens",
        value: (100 + n) * (1 + 0.004 * Math.sin(k * 0.9 + n) + 0.002 * Math.sin(k * 0.37)) }));
      await recordReferenceBars(store, observations, { observedAt: last, holder: `h${k}`, jobSignal: new AbortController().signal, deadline: new AbortController().signal });
    }
    return last;
  }
  const run = async (store: MemoryStore, now: number) => {
    clock.t = now;
    return runTradingUnderlyingFeatures(store, new AbortController().signal, { now: () => now });
  };
  async function quietly<T>(work: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };
    try {
      return { result: await work(), warnings };
    } finally {
      console.warn = original;
    }
  }
  const stateOf = async (store: MemoryStore) => (await store.get<Record<string, FeatureAttempt>>(UNDERLYING_FEATURE_STATE_KEY))!.data;

  it("selects open TRADING bStocks that the pool index does not carry, by address", async () => {
    const store = await world([rwaRow(T3), rwaRow(POOLED), rwaRow(T1), rwaRow(T2, { openState: false }), rwaRow(addr(0x604), { reasonCode: "UNSUPPORTED" }),
      rwaRow(addr(0x605), { platform: "ondo" })]);
    assert.deepEqual(await selectUnderlyingTokens(store), [T1, T3]);
  });

  it("keeps the two indexes disjoint: a token the pool index gains leaves the underlying index", async () => {
    const store = await world([rwaRow(T1), rwaRow(T2)], []);
    assert.deepEqual(await selectUnderlyingTokens(store), [T1, T2]);
    await store.put(FEATURE_INDEX_KEY_V2, { pools: [{ pool: addr(2), currency: "usd", tokenAddress: T1 }], intervals: ["15m"], maxPools: 40, selection: "x" }, TTL);
    assert.deepEqual(await selectUnderlyingTokens(store), [T2]);
  });

  it("trims 65 eligible tokens to the first 64 by address with one warning", async () => {
    const rows = Array.from({ length: 65 }, (_, i) => rwaRow(addr(0x700 + i)));
    const store = await world(rows);
    const { result, warnings } = await quietly(() => selectUnderlyingTokens(store));
    assert.equal(result!.length, MAX_UNDERLYING_TOKENS);
    assert.equal(result![63], addr(0x700 + 63));
    assert.ok(!result!.includes(addr(0x700 + 64)));
    assert.equal(warnings.length, 1);
  });

  it("fails closed when the pool index is missing: nothing is published", async () => {
    clock.t = Date.UTC(2026, 9, 7, 16, 0, 20);
    const store = new MemoryStore(() => clock.t);
    await store.put(RWA_UNIVERSE_KEY, { rows: [rwaRow(T1)], byPlatform: { bstock: 1 } }, TTL);
    assert.equal(await selectUnderlyingTokens(store), null);
    const { result } = await quietly(() => run(store, clock.t));
    assert.deepEqual(result, { attempted: 0, updated: 0, failed: 0 });
    assert.equal(await store.get(UNDERLYING_FEATURE_INDEX_KEY), null);
  });

  it("writes the index with usEquity per token, 15m and 1h, maxTokens 64", async () => {
    const store = await world([rwaRow(T1), rwaRow(T2)]);
    await run(store, clock.t);
    const index = (await store.get<UnderlyingFeatureIndex>(UNDERLYING_FEATURE_INDEX_KEY))!.data;
    assert.deepEqual(index, { tokens: [{ tokenAddress: T1, usEquity: true }, { tokenAddress: T2, usEquity: true }], intervals: ["15m", "1h"], maxTokens: 64 });
  });

  it("calls no upstream and imports no upstream adapter", async () => {
    const store = await world([rwaRow(T1)]);
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => { calls += 1; throw new Error("upstream call"); }) as typeof fetch;
    try {
      await quietly(() => run(store, clock.t));
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(calls, 0);
    const imports = readFileSync(new URL("../src/jobs/tradingUnderlyingFeatures.ts", import.meta.url), "utf8").split(/\r?\n/u)
      .filter((line) => /^import |^\} from /u.test(line)).join("\n").toLowerCase();
    for (const forbidden of ["adapters/", "poolohlcv", "onchainos", "geckoterminal", "dexpaprika", "sintral"]) {
      assert.ok(!imports.includes(forbidden), `imports ${forbidden}`);
    }
  });

  it("writes only its own key space: no pool feature key, index or state is touched", async () => {
    const store = await world([rwaRow(T1)]);
    const poolBefore = JSON.stringify((await store.get(FEATURE_INDEX_KEY_V2))?.data);
    const puts: string[] = [];
    const original = store.put.bind(store);
    store.put = async (k, payload, opts) => { puts.push(k); await original(k, payload, opts); };
    await quietly(() => run(store, clock.t));
    assert.ok(puts.length > 0);
    for (const k of puts) assert.ok(k.startsWith("trading:underlying-features:v1:"), k);
    assert.equal(JSON.stringify((await store.get(FEATURE_INDEX_KEY_V2))?.data), poolBefore);
  });

  it("takes its producer lease for 60 000 ms under the pinned name", async () => {
    const store = await world([rwaRow(T1)]);
    const calls: Array<[string, number]> = [];
    const original = store.acquireSchedulerLease.bind(store);
    store.acquireSchedulerLease = async (lease, holder, ttlMs) => { calls.push([lease, ttlMs]); return original(lease, holder, ttlMs); };
    await quietly(() => run(store, clock.t));
    assert.deepEqual(calls, [["trading-underlying-features:v1:producer", 60_000]]);
  });

  it("a second holder inside the lease window attempts nothing", async () => {
    const store = await world([rwaRow(T1)]);
    await quietly(() => run(store, clock.t));
    assert.deepEqual(await run(store, clock.t + 1_000), { attempted: 0, updated: 0, failed: 0 });
  });

  it("with no recorder entry for a token the series is recorder_stale and nothing is published", async () => {
    const store = await world([rwaRow(T1)]);
    const { result, warnings } = await quietly(() => run(store, clock.t));
    assert.equal(result.updated, 0);
    assert.equal((await stateOf(store))[key(T1, "15m")]?.reason, "recorder_stale");
    assert.equal(await store.get(key(T1, "15m")), null);
    assert.equal(warnings.filter((w) => w.includes("recorder_stale")).length, 1, "one line per cycle");
  });

  describe("after a recording", () => {
    const START = Date.UTC(2026, 9, 7, 6, 0, 0);
    const END = Date.UTC(2026, 9, 7, 16, 0, 0);

    it("publishes 15m and 1h snapshots, and reports warm-up honestly as too_few_real_bars with the 300 s floor", async () => {
      const store = await world([rwaRow(T1), rwaRow(T2)]);
      const last = await recordSeries(store, [T1, T2], START, END);
      const now = last + 20_000;
      const outcome = await run(store, now);
      assert.equal(outcome.updated, 4);
      const read15 = (await readUnderlyingFeatures(store, T1, "15m", now))!;
      assert.equal(read15.version, "underlying-features-v1");
      assert.equal(read15.staleness, "fresh");
      assert.equal(read15.identity.endpoint, "tokens");
      assert.ok(read15.coverage.realBars >= 30, "10 hours of moving reference is 40 real 15m buckets");
      assert.equal((read15.metrics as Record<string, Metric>)["rsi14"]?.available, true);
      assert.equal((read15.metrics as Record<string, Metric>)["rvol20"]?.reason, "unknown_volume_unit");
      const read1h = (await readUnderlyingFeatures(store, T1, "1h", now))!;
      assert.ok(read1h.coverage.realBars < 30);
      assert.equal((read1h.metrics as Record<string, Metric>)["roc10Pct"]?.reason, "too_few_real_bars");
      const state = await stateOf(store);
      const hourly = state[key(T1, "1h")]!;
      assert.equal(hourly.reason, "too_few_real_bars");
      assert.equal(hourly.state, "partial");
      assert.ok(hourly.nextAttempt >= now + 300_000);
      const quarter = state[key(T1, "15m")]!;
      assert.equal(quarter.state, "partial");
      assert.ok(!["too_few_real_bars", "unknown_volume_unit", "recorder_stale"].includes(quarter.reason!), `15m reason ${quarter.reason}`);
      assert.ok(quarter.nextAttempt >= now + 60_000);
    });

    it("a series whose only unavailable metrics read volume is ready", async () => {
      const store = await world([rwaRow(T1)]);
      const last = await recordSeries(store, [T1], Date.UTC(2026, 9, 6, 12, 0, 0), Date.UTC(2026, 9, 7, 16, 0, 0));
      const now = last + 20_000;
      await run(store, now);
      const read = (await readUnderlyingFeatures(store, T1, "15m", now))!;
      const unavailable = Object.entries(read.metrics as Record<string, Metric>).filter(([, m]) => !m.available).map(([name]) => name).sort();
      assert.deepEqual(unavailable, ["rvol20", "vwapDistancePct", "vwapSession"]);
      const attempt = (await stateOf(store))[key(T1, "15m")]!;
      assert.equal(attempt.state, "ready");
      assert.equal(attempt.reason, "ready");
    });

    it("a too_few_real_bars 15m series keeps the 300 s floor even a minute before its next close", async () => {
      const store = await world([rwaRow(T1)]);
      // 5 hours of recording: 20 real 15m buckets, below the 30 floor.
      await recordSeries(store, [T1], Date.UTC(2026, 9, 7, 11, 0, 0), END);
      const now = END + 14 * MIN + 30_000; // refreshAfter (16:15:15) is 45 s away; the recorder is 870 s old
      await run(store, now);
      const attempt = (await stateOf(store))[key(T1, "15m")]!;
      assert.equal(attempt.reason, "too_few_real_bars");
      assert.ok(attempt.nextAttempt - now >= 300_000, `nextAttempt is ${attempt.nextAttempt - now} ms away`);
    });

    it("writes a snapshot only when its id changed", async () => {
      const store = await world([rwaRow(T1)]);
      const last = await recordSeries(store, [T1], START, END);
      const puts: string[] = [];
      const original = store.put.bind(store);
      store.put = async (k, payload, opts) => { puts.push(k); await original(k, payload, opts); };
      const now = last + 20_000;
      await run(store, now);
      assert.equal(puts.filter((k) => k === key(T1, "15m")).length, 1);
      await run(store, now + 61_000);
      assert.equal(puts.filter((k) => k === key(T1, "15m")).length, 1, "same record, no rewrite");
    });

    it("lastObservedAt more than one interval old publishes nothing for that interval (901 000 ms), exactly one interval old still does", async () => {
      const store = await world([rwaRow(T1)]);
      const last = await recordSeries(store, [T1], START, END);
      const stale = await quietly(() => run(store, last + 901_000));
      assert.equal((await stateOf(store))[key(T1, "15m")]?.reason, "recorder_stale");
      assert.equal(await store.get(key(T1, "15m")), null, "no 15m snapshot written");
      assert.notEqual((await stateOf(store))[key(T1, "1h")]?.reason, "recorder_stale", "the 1h interval tolerates 3 600 000 ms");
      assert.ok(stale.warnings.some((w) => w.includes("recorder_stale")));
      const fresh = await world([rwaRow(T1)]);
      const lastFresh = await recordSeries(fresh, [T1], START, END);
      await run(fresh, lastFresh + 900_000);
      assert.notEqual((await stateOf(fresh))[key(T1, "15m")]?.reason, "recorder_stale");
      assert.ok(await fresh.get(key(T1, "15m")));
    });

    it("a recorder-stale series leaves the previous snapshot to age out through its own expiresAt", async () => {
      const store = await world([rwaRow(T1)]);
      const last = await recordSeries(store, [T1], START, END);
      await run(store, last + 20_000);
      const before = (await readUnderlyingFeatures(store, T1, "15m", last + 20_000))!;
      await quietly(() => run(store, last + 2 * 3_600_000));
      const after = (await readUnderlyingFeatures(store, T1, "15m", last + 2 * 3_600_000))!;
      assert.equal(after.snapshotId, before.snapshotId);
      assert.equal(after.staleness, "stale");
    });

    it("does not read the closed record of another endpoint", async () => {
      const store = await world([rwaRow(T1)]);
      const last = await recordSeries(store, [T1], START, END);
      // The open state now says "price": the stored "tokens" bars are a different series and must not be used.
      const open = (await store.get<{ tokens: Record<string, { endpoint: string }> }>(REFERENCE_BARS_OPEN_KEY))!.data;
      open.tokens[T1]!.endpoint = "price";
      await store.put(REFERENCE_BARS_OPEN_KEY, open, TTL);
      await run(store, last + 20_000);
      const read = (await readUnderlyingFeatures(store, T1, "15m", last + 20_000))!;
      assert.equal(read.identity.endpoint, "price");
      assert.equal(read.coverage.availableBars, 0);
    });
  });

  describe("routes", () => {
    async function served(): Promise<{ app: ReturnType<typeof createServer>; store: MemoryStore; now: number }> {
      const store = await world([rwaRow(T1), rwaRow(T2)]);
      const last = await recordSeries(store, [T1], Date.UTC(2026, 9, 7, 6, 0, 0), Date.UTC(2026, 9, 7, 16, 0, 0));
      const now = last + 20_000;
      await run(store, now);
      return { app: createServer({ scheduler: createScheduler(store), store }), store, now };
    }
    interface BatchEntry { data: { version: string; staleness: string; lineage: { scope: string } } | null; error?: { code: string; reason?: string }; meta?: { version: string; producer: { state: string } } }
    interface Batch { data: Record<string, BatchEntry>; meta: { version: string; interval: string; count: number } }

    it("GET /tokens lists the selection with a producer state per series", async () => {
      const { app } = await served();
      const response = await app.request("/trading/underlying-features/v1/tokens");
      assert.equal(response.status, 200);
      const body = await response.json() as { data: { tokens: Array<{ tokenAddress: string }>; intervals: string[]; maxTokens: number; series: Array<{ tokenAddress: string; interval: string; producer: { state: string } }> }; meta: { version: string; staleness: string } };
      assert.deepEqual(body.data.tokens.map((t) => t.tokenAddress), [T1, T2]);
      assert.equal(body.data.maxTokens, 64);
      assert.equal(body.data.series.length, 4);
      assert.equal(body.meta.version, "underlying-features-v1");
      assert.equal(body.meta.staleness, "fresh");
    });

    it("GET /tokens answers data null and staleness dead before the first cycle", async () => {
      const store = new MemoryStore();
      const response = await createServer({ scheduler: createScheduler(store), store }).request("/trading/underlying-features/v1/tokens");
      const body = await response.json() as { data: unknown; meta: { staleness: string } };
      assert.equal(body.data, null);
      assert.equal(body.meta.staleness, "dead");
    });

    it("GET batch returns the record for a published series and the closed error codes for the rest", async () => {
      const { app } = await served();
      const outsider = addr(0x999);
      const response = await app.request(`/trading/underlying-features/v1?tokens=${T1},${T2},${outsider}&interval=15m`);
      assert.equal(response.status, 200);
      const body = await response.json() as Batch;
      assert.equal(body.meta.count, 3);
      assert.equal(body.meta.interval, "15m");
      assert.equal(body.data[T1]?.data?.version, "underlying-features-v1");
      assert.equal(body.data[T1]?.data?.lineage.scope, "underlying");
      assert.equal(body.data[T1]?.meta?.version, "underlying-features-v1");
      assert.equal(body.data[T2]?.data, null);
      assert.equal(body.data[T2]?.error?.code, "features_unavailable", "recorder_stale is an unavailable producer");
      assert.equal(body.data[T2]?.error?.reason, "recorder_stale");
      assert.equal(body.data[outsider]?.data, null);
      assert.equal(body.data[outsider]?.error?.code, "outside_feature_watchlist");
    });

    it("a series the job has not attempted yet is features_pending", async () => {
      const store = await world([rwaRow(T1)]);
      await store.put(UNDERLYING_FEATURE_INDEX_KEY, { tokens: [{ tokenAddress: T1, usEquity: true }], intervals: ["15m", "1h"], maxTokens: 64 }, TTL);
      const body = await (await createServer({ scheduler: createScheduler(store), store }).request(`/trading/underlying-features/v1?tokens=${T1}&interval=1h`)).json() as Batch;
      assert.equal(body.data[T1]?.error?.code, "features_pending");
    });

    it("rejects 11 tokens, a bad address, another interval, a missing interval and any other query key with 400 invalid_request", async () => {
      const { app } = await served();
      const eleven = Array.from({ length: 11 }, (_, i) => addr(0x800 + i)).join(",");
      for (const query of [`tokens=${eleven}&interval=15m`, `tokens=0x123&interval=15m`, `tokens=${T1}&interval=5m`, `tokens=${T1}`, `tokens=${T1}&interval=15m&extra=1`, `interval=15m`, `tokens=&interval=15m`]) {
        const response = await app.request(`/trading/underlying-features/v1?${query}`);
        assert.equal(response.status, 400, query);
        assert.equal(((await response.json()) as { error: { code: string } }).error.code, "invalid_request", query);
      }
    });

    it("a request never starts producer or upstream work", async () => {
      const { app, store } = await served();
      const puts: string[] = [];
      const original = store.put.bind(store);
      store.put = async (k, payload, opts) => { puts.push(k); await original(k, payload, opts); };
      const realFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = (() => { calls += 1; throw new Error("upstream call"); }) as typeof fetch;
      try {
        await app.request(`/trading/underlying-features/v1?tokens=${T1},${T2}&interval=15m`);
        await app.request("/trading/underlying-features/v1/tokens");
      } finally {
        globalThis.fetch = realFetch;
      }
      assert.equal(calls, 0);
      assert.deepEqual(puts, []);
    });

    it("leaves the pool routes untouched: the pool index does not list these tokens", async () => {
      const { app } = await served();
      const pools = await (await app.request("/trading/features/v2/pools")).json() as { data: { pools: Array<{ tokenAddress?: string }> } | null };
      assert.ok(pools.data !== null);
      assert.ok(!pools.data.pools.some((p) => p.tokenAddress === T1));
      assert.ok(pools.data.pools.some((p) => p.tokenAddress === POOLED));
    });
  });

  it("is registered beside the pool job", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.match(source, /scheduler\.register\(tradingFeaturesJob\(store\)\);[\s\S]*scheduler\.register\(tradingUnderlyingFeaturesJob\(store\)\);/u);
    const job = tradingUnderlyingFeaturesJob(new MemoryStore());
    assert.deepEqual([job.name, job.intervalMs, job.jitterMs, job.timeoutMs], ["trading-underlying-features", 60_000, 2_000, 30_000]);
  });
});
