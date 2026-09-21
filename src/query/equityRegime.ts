/**
 * The equity-market regime fact: one deterministic label over the SPYB and
 * QQQB pools' 1h revision-2 features that the producer already refreshes.
 * Store-only; nothing here reaches an upstream. The execution plane blends it
 * with CoinMarketCap's crypto-wide metrics; this route is the equity leg.
 *
 * Rule (replayable from the two feature payloads):
 *   risk_off  — both ETFs `emaSpreadPct < 0` and `roc10Pct < 0`, or either `gapPct ≤ −2.5`
 *   risk_on   — both `emaSpreadPct > 0` and `roc10Pct > 0`
 *   neutral   — otherwise
 *   unavailable — either ETF's 1h evidence is missing, stale, or lacks EMA/ROC
 * `gapPct` may be unavailable on its own (a weekend window holds no RTH close);
 * the gap clause then simply cannot fire and `reasons` says so.
 */
import type { SnapshotStore } from "../core/store.js";
import type { Staleness } from "../core/types.js";
import { EQUITY_REGIME_TOKENS, type FeatureIndex } from "../jobs/tradingFeatures.js";
import { FEATURE_INDEX_KEY_V2, FEATURE_VERSION_V2, readTradingFeatures, type Metric } from "./tradingFeatures.js";
import { SESSION_CLOCK, sessionAt, type SessionState } from "./sessionClock.js";

export const GAP_RISK_OFF_PCT = -2.5;
export type Regime = "risk_on" | "risk_off" | "neutral" | "unavailable";

export interface RegimeLeg {
  pool: string | null;
  interval: "1h";
  emaSpreadPct: number | null;
  roc10Pct: number | null;
  rsi14: number | null;
  macdHistogram: number | null;
  gapPct: number | null;
  /** EMA spread and ROC both present and fresh. */
  available: boolean;
  staleness: Staleness | "missing";
  reason: string | null;
}
export interface EquityRegime {
  asOf: number;
  sessionState: SessionState;
  nextBoundaryAt: number;
  sessionClock: typeof SESSION_CLOCK;
  spy: RegimeLeg;
  qqq: RegimeLeg;
  regime: Regime;
  reasons: string[];
  rule: { gapRiskOffPct: number; interval: "1h"; indicatorRevision: 2 };
}

const value = (m: Metric | undefined): number | null => m && m.available && m.value !== null ? m.value : null;

/** Pure: the label from two legs. Exported so the four cases are testable on fixtures. */
export function decideRegime(spy: RegimeLeg, qqq: RegimeLeg): { regime: Regime; reasons: string[] } {
  const reasons: string[] = [];
  for (const [name, leg] of [["spy", spy], ["qqq", qqq]] as const) {
    if (!leg.available) reasons.push(`${name}: ${leg.reason ?? "unavailable"}`);
    else if (leg.gapPct === null) reasons.push(`${name}: gapPct unavailable, gap clause not evaluated`);
  }
  if (!spy.available || !qqq.available) return { regime: "unavailable", reasons };
  const legs = [spy, qqq];
  const gapped = legs.filter((l) => l.gapPct !== null && l.gapPct <= GAP_RISK_OFF_PCT);
  if (gapped.length) return { regime: "risk_off", reasons: [...reasons, `gap ≤ ${GAP_RISK_OFF_PCT}% on ${gapped.length === 2 ? "both" : gapped[0] === spy ? "spy" : "qqq"}`] };
  if (legs.every((l) => l.emaSpreadPct! < 0 && l.roc10Pct! < 0)) return { regime: "risk_off", reasons: [...reasons, "both: emaSpreadPct < 0 and roc10Pct < 0 on 1h"] };
  if (legs.every((l) => l.emaSpreadPct! > 0 && l.roc10Pct! > 0)) return { regime: "risk_on", reasons: [...reasons, "both: emaSpreadPct > 0 and roc10Pct > 0 on 1h"] };
  return { regime: "neutral", reasons: [...reasons, "mixed or flat 1h trend"] };
}

async function readLeg(store: SnapshotStore, index: FeatureIndex | null, token: string, now: number): Promise<RegimeLeg> {
  const empty: RegimeLeg = { pool: null, interval: "1h", emaSpreadPct: null, roc10Pct: null, rsi14: null, macdHistogram: null, gapPct: null,
    available: false, staleness: "missing", reason: null };
  const selection = index?.pools.find((p) => p.tokenAddress === token);
  if (!selection) return { ...empty, reason: "not_in_feature_watchlist" };
  const features = await readTradingFeatures(store, selection.pool, "1h", now, selection.currency, selection.tokenAddress, FEATURE_VERSION_V2);
  if (!features) return { ...empty, pool: selection.pool, reason: "features_pending" };
  const m = features.metrics as Record<string, Metric>;
  const leg: RegimeLeg = { pool: selection.pool, interval: "1h", emaSpreadPct: value(m["emaSpreadPct"]), roc10Pct: value(m["roc10Pct"]),
    rsi14: value(m["rsi14"]), macdHistogram: value(m["histogram"]), gapPct: value(m["gapPct"]),
    available: false, staleness: features.staleness, reason: null };
  if (features.parameters.indicatorRevision !== 2) return { ...leg, reason: "indicator_revision_pending" };
  if (features.staleness !== "fresh") return { ...leg, reason: "stale_input" };
  if (leg.emaSpreadPct === null || leg.roc10Pct === null) return { ...leg, reason: m["emaSpreadPct"]?.reason ?? m["roc10Pct"]?.reason ?? "unavailable" };
  return { ...leg, available: true };
}

export async function readEquityRegime(store: SnapshotStore, now = Date.now()): Promise<EquityRegime> {
  const index = (await store.get<FeatureIndex>(FEATURE_INDEX_KEY_V2))?.data ?? null;
  const [spy, qqq] = await Promise.all([readLeg(store, index, EQUITY_REGIME_TOKENS.spy, now), readLeg(store, index, EQUITY_REGIME_TOKENS.qqq, now)]);
  const session = sessionAt(now);
  return { asOf: now, sessionState: session.state, nextBoundaryAt: session.nextBoundaryAt, sessionClock: SESSION_CLOCK, spy, qqq,
    ...decideRegime(spy, qqq), rule: { gapRiskOffPct: GAP_RISK_OFF_PCT, interval: "1h", indicatorRevision: 2 } };
}
