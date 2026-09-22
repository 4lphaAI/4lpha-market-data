import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateFeatures, FEATURE_VERSION, FEATURE_VERSION_V2, type FeatureInput, type FeatureSnapshot, type Metric } from "../src/query/tradingFeatures.js";

const POOL = "0x0000000000000000000000000000000000000010";
const BASE = "0x0000000000000000000000000000000000000001", QUOTE = "0x0000000000000000000000000000000000000002";
const STEP = 900_000; // 15m, the interval handoff §11 rules Sintral onto first

/** `count` logical 15m slots ending at the last closed bucket before `now`, real bars everywhere except `gapIndexes`. */
function sintralInput(now: number, count: number, gapIndexes: Set<number>, close: (i: number) => number, source = "sintral"): FeatureInput {
  const cutoff = Math.floor((now - 15_000) / STEP) * STEP;
  const candles = [];
  for (let i = 0; i < count; i++) {
    if (gapIndexes.has(i)) continue; // Sintral's own behavior: omit buckets with no trades
    const c = close(i);
    candles.push({ timestamp: cutoff - (count - i) * STEP, open: c, high: c + 1, low: c - 1, close: c, volume: 5 });
  }
  return { chainId: 56, poolAddress: POOL, baseAddress: BASE, quoteAddress: QUOTE, priceCurrency: "usd", volumeCurrency: "usd",
    volumeUnavailableReason: null, source, interval: "15m", observedAt: now, conflictingTimestamps: [], candles };
}
const calc = (input: FeatureInput, version: typeof FEATURE_VERSION | typeof FEATURE_VERSION_V2 = FEATURE_VERSION_V2, now = input.observedAt) => calculateFeatures(input, now, version);
const m = (s: FeatureSnapshot, name: string) => (s.metrics as Record<string, Metric>)[name]!;

describe("indicatorRevision 3 — Sintral forward-fill (handoff §11)", () => {
  it("fills gaps on the time axis, feeds EMA/RSI/MACD/BB/StochRSI, and reports indicatorRevision 3", () => {
    const now = Date.now();
    // 120 slots, 5 missing in the middle (indices 40..44) -> 115 real bars, comfortably over the 30-bar floor.
    const gaps = new Set([40, 41, 42, 43, 44]);
    // Mild sawtooth so RSI/StochRSI have a real range (a perfectly flat series
    // legitimately reports zero_range there, which would test the wrong thing).
    const s = calc(sintralInput(now, 120, gaps, (i) => 100 + (i % 3)));
    assert.equal(s.parameters.indicatorRevision, 3);
    assert.equal(s.coverage.realBars, 115);
    assert.equal(s.coverage.filledBars, 5);
    assert.equal(s.coverage.contiguousBars, 120); // the working (filled) series has no gap at all
    assert.equal(m(s, "ema12").available, true);
    assert.equal(m(s, "rsi14").available, true);
    assert.equal(m(s, "macd").available, true);
    assert.equal(m(s, "bbMiddle20").available, true);
    assert.equal(m(s, "stochRsi14").available, true);
    assert.equal(m(s, "atr14").available, true);
  });
  it("carries the previous real close forward into a filled bucket, not a synthetic value", () => {
    const now = Date.now();
    // Index 119 (the most recent slot) is missing; the last real bar (118) spikes to 500 while
    // everything else stays flat at 100. The filled bucket must read exactly 500 (carried
    // forward from the immediately preceding real close), not 100, not 0, not an interpolation.
    const gaps = new Set([119]);
    const s = calc(sintralInput(now, 120, gaps, (i) => (i === 118 ? 500 : 100)));
    assert.equal(s.coverage.filledBars, 1);
    // momentum10 = latest.close - bars.at(-11).close; bars.at(-11) is index 109, real, close 100.
    near(m(s, "momentum10").value!, 400, 1e-6);
  });
  it("never fills before the first real bar or the current unclosed bucket", () => {
    const now = Date.now();
    // Only the last 40 of 120 slots have any real data; the leading 80 stay gaps, never filled.
    const gaps = new Set(Array.from({ length: 80 }, (_, i) => i));
    const s = calc(sintralInput(now, 120, gaps, () => 100));
    assert.equal(s.coverage.realBars, 40);
    assert.equal(s.coverage.filledBars, 0); // no gaps *within* [firstReal, cutoff) in this fixture
    assert.equal(s.coverage.availableBars, 40); // the 80 leading gaps are not manufactured into filled bars
  });
  it("requires at least 30 real bars, even with plenty of filled ones", () => {
    const now = Date.now();
    // Real bars at every 4th slot starting from index 0 (0,4,8,...,112) = 29 real bars,
    // interspersed with 91 filled ones -- comfortably enough contiguity for every ordinary
    // metric, but the real-bar floor must still reject the whole snapshot.
    const realIndexes = new Set(Array.from({ length: 29 }, (_, i) => i * 4));
    const gaps = new Set(Array.from({ length: 120 }, (_, i) => i).filter((i) => !realIndexes.has(i)));
    const s = calc(sintralInput(now, 120, gaps, () => 100));
    assert.equal(s.coverage.realBars, 29);
    assert.equal(s.coverage.filledBars, 91);
    assert.equal(m(s, "ema12").reason, "too_few_real_bars");
    assert.equal(m(s, "rsi14").reason, "too_few_real_bars");
    assert.equal(m(s, "bbMiddle20").reason, "too_few_real_bars");
  });
  it("does not fill non-Sintral sources, and does not fill rev 1 at all", () => {
    const now = Date.now();
    // Gaps placed right before the latest bar so they land inside every metric's
    // required contiguity window -- otherwise a gap far from the end doesn't
    // actually block anything, and the comparison against filling proves nothing.
    const gaps = new Set([115, 116, 117]);
    const gecko = calc(sintralInput(now, 120, gaps, () => 100, "geckoterminal"));
    assert.equal(gecko.coverage.filledBars, 0);
    assert.equal(gecko.coverage.realBars, 117);
    assert.equal(gecko.parameters.indicatorRevision, 2); // gap present, but not Sintral-sourced -> ordinary rev 2 path
    assert.equal(m(gecko, "ema12").reason, "gap");
    const rev1 = calc(sintralInput(now, 120, gaps, () => 100), FEATURE_VERSION);
    assert.equal(rev1.coverage.filledBars, 0);
    assert.equal(rev1.parameters.indicatorRevision, undefined);
  });
  it("accepts sintral as a valid identity source", () => {
    const now = Date.now();
    const s = calc(sintralInput(now, 120, new Set(), () => 100));
    assert.notEqual(m(s, "ema12").reason, "invalid_identity");
    assert.equal(s.input.source, "sintral");
  });
});
function near(value: number | null, expected: number, eps: number) { assert.ok(value !== null && Math.abs(value - expected) < eps, `${value} != ${expected}`); }
