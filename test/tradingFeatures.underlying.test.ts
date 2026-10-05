import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStore } from "../src/core/store.js";
import {
  UNDERLYING_FEATURE_VERSION,
  calculateFeatures,
  calculateUnderlyingFeatures,
  readUnderlyingFeatures,
  underlyingFeatureKey,
  FEATURE_VERSION_V2,
  type Metric,
  type ReferenceSession,
  type UnderlyingBar,
  type UnderlyingFeatureSnapshot,
  type UnderlyingInterval,
} from "../src/query/tradingFeatures.js";

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
