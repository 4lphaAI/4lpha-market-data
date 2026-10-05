/**
 * Producer of `underlying-features-v1` (agentic-rfq-stocks): indicators over the
 * underlying reference price the `binance-rwa` job records, for the bStocks that
 * have no pool series.
 *
 * Store in, store out. It reads the recorder's records and writes feature
 * snapshots; it never calls an upstream (no OnchainOS, Gecko, DexPaprika or
 * Sintral): there is no pool to ask, and a consumer's request cannot trigger
 * work. A token appears here only when it is not in the pool feature index, so
 * the two series of one token can never both exist and are never spliced.
 */
import { randomUUID } from "node:crypto";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import {
  FEATURE_INDEX_KEY_V2,
  MIN_REAL_BARS,
  UNDERLYING_FEATURE_INDEX_KEY,
  UNDERLYING_FEATURE_STATE_KEY,
  UNDERLYING_INTERVALS,
  calculateUnderlyingFeatures,
  underlyingFeatureKey,
  type FeatureAttempt,
  type UnderlyingFeatureIndex,
  type UnderlyingFeatureSnapshot,
  type UnderlyingInterval,
} from "../query/tradingFeatures.js";
import { buildUniverse } from "../universe.js";
import { loadReferenceSessions, type FeatureIndex } from "./tradingFeatures.js";
import { REFERENCE_BAR_STEPS_MS, REFERENCE_BARS_OPEN_KEY, normalizeBarRecord, normalizeOpenState, referenceBarsKey } from "./rwaReferenceBars.js";

export const UNDERLYING_FEATURES_JOB = "trading-underlying-features";
export const UNDERLYING_FEATURES_LEASE = "trading-underlying-features:v1:producer";
export const MAX_UNDERLYING_TOKENS = 64;
const RETENTION = 30 * 86_400_000;
const SOURCE = "trading-underlying-features";
/** Series refreshed per cycle: no upstream is involved, so the bound is the store round trips. */
const DUE_PER_CYCLE = 64;
const INTERVAL_PRIORITY: Record<UnderlyingInterval, number> = { "15m": 0, "1h": 1 };
/** Metrics that read volume: always unavailable for this source, so they never decide the producer reason. */
const VOLUME_METRICS: ReadonlySet<string> = new Set(["rvol20", "vwapSession", "vwapDistancePct"]);
const SLOW_FLOOR_MS = 300_000;
const FLOOR_MS = 60_000;

/**
 * Open and TRADING bStocks that the pool index does not carry, by address. `null`
 * when the pool index is missing or unreadable: disjointness cannot be shown, so
 * nothing is published (fail closed).
 */
export async function selectUnderlyingTokens(store: SnapshotStore): Promise<string[] | null> {
  const poolIndex = await store.get<FeatureIndex>(FEATURE_INDEX_KEY_V2);
  const pools = poolIndex?.data.pools;
  if (!Array.isArray(pools)) return null;
  const pooled = new Set<string>();
  for (const pool of pools) if (typeof pool?.tokenAddress === "string") pooled.add(pool.tokenAddress.toLowerCase());
  const universe = await buildUniverse(store);
  const selected = universe.entries
    .filter((entry) => entry.lane === "bstocks" && entry.openState === true && entry.reasonCode === "TRADING" && !pooled.has(entry.address))
    .map((entry) => entry.address)
    .sort();
  if (selected.length > MAX_UNDERLYING_TOKENS) {
    console.warn(`[${UNDERLYING_FEATURES_JOB}] ${selected.length} eligible tokens trimmed to the first ${MAX_UNDERLYING_TOKENS} by address; raise the ceiling rather than let this persist`);
    return selected.slice(0, MAX_UNDERLYING_TOKENS);
  }
  return selected;
}

export async function runTradingUnderlyingFeatures(store: SnapshotStore, signal: AbortSignal, deps: { now?: () => number } = {}) {
  const now = deps.now ?? Date.now;
  signal.throwIfAborted();
  if (!await store.acquireSchedulerLease(UNDERLYING_FEATURES_LEASE, randomUUID(), 60_000)) return { attempted: 0, updated: 0, failed: 0 };
  const selected = await selectUnderlyingTokens(store);
  if (selected === null) {
    console.warn(`[${UNDERLYING_FEATURES_JOB}] pool feature index unavailable; nothing published this cycle`);
    return { attempted: 0, updated: 0, failed: 0 };
  }
  const references = await loadReferenceSessions(store);
  const index: UnderlyingFeatureIndex = {
    tokens: selected.map((tokenAddress) => ({ tokenAddress, usEquity: references.has(tokenAddress) })),
    intervals: [...UNDERLYING_INTERVALS],
    maxTokens: MAX_UNDERLYING_TOKENS,
  };
  await store.put(UNDERLYING_FEATURE_INDEX_KEY, index, { source: SOURCE, freshForMs: 120_000, deadAfterMs: RETENTION });

  const previous = (await store.get<Record<string, FeatureAttempt>>(UNDERLYING_FEATURE_STATE_KEY))?.data ?? {};
  const state: Record<string, FeatureAttempt> = {};
  const candidates = index.tokens.flatMap(({ tokenAddress }) => index.intervals.map((interval) => ({
    token: tokenAddress, interval, key: underlyingFeatureKey(tokenAddress, interval),
  })));
  // State is one bounded object, not one durable key per arbitrary input.
  for (const candidate of candidates) {
    state[candidate.key] = previous[candidate.key] ?? { revision: 1, attemptedAt: 0, nextAttempt: 0, state: "queued", reason: "not_attempted" };
  }
  const due = candidates.filter((c) => state[c.key]!.nextAttempt <= now())
    .sort((a, b) => INTERVAL_PRIORITY[a.interval] - INTERVAL_PRIORITY[b.interval]
      || state[a.key]!.attemptedAt - state[b.key]!.attemptedAt || a.key.localeCompare(b.key))
    .slice(0, DUE_PER_CYCLE);
  // Persist admission before IO: an interrupted pass cannot starve other series.
  for (const c of due) state[c.key] = { ...state[c.key]!, attemptedAt: now(), nextAttempt: now() + FLOOR_MS, state: "refreshing", reason: "refreshing", sources: [] };
  await store.put(UNDERLYING_FEATURE_STATE_KEY, state, { source: SOURCE, freshForMs: 60_000, deadAfterMs: RETENTION });

  const open = normalizeOpenState((await store.get<unknown>(REFERENCE_BARS_OPEN_KEY))?.data);
  let updated = 0;
  let failed = 0;
  const stale: string[] = [];
  const outcomes = await Promise.allSettled(due.map(async (c) => {
    const attempt = state[c.key]!;
    const fail = (reason: string, floorMs: number, escalate: boolean) => {
      failed++;
      if (escalate) attempt.consecutiveFailures = (attempt.consecutiveFailures ?? 0) + 1;
      Object.assign(attempt, { state: "unavailable", reason, sources: [], completedAt: now(),
        nextAttempt: now() + (escalate ? Math.min(SLOW_FLOOR_MS, FLOOR_MS * 2 ** Math.min(3, attempt.consecutiveFailures! - 1)) : floorMs) });
    };
    try {
      signal.throwIfAborted();
      const entry = open.tokens[c.token];
      // A recorder that has not observed this token within one interval is dead for it: publish nothing, so the
      // previous snapshot ages out through its own expiresAt and a consumer's freshness check refuses it.
      if (entry === undefined || now() - entry.lastObservedAt > REFERENCE_BAR_STEPS_MS[c.interval]) {
        stale.push(c.token);
        fail("recorder_stale", SLOW_FLOOR_MS, false);
        return;
      }
      const stored = await store.get<unknown>(referenceBarsKey(c.token));
      const record = stored === null ? null : normalizeBarRecord(stored.data);
      const reference = references.get(c.token) ?? null;
      const snapshot = calculateUnderlyingFeatures({
        token: c.token, underlyingTicker: reference?.underlyingTicker ?? record?.underlyingTicker ?? null, interval: c.interval,
        endpoint: entry.endpoint, bars: record !== null && record.endpoint === entry.endpoint ? record[c.interval] : [],
        lastObservedAt: entry.lastObservedAt, referenceSession: reference,
      }, now());
      const old = await store.get<UnderlyingFeatureSnapshot>(c.key);
      if (old?.data.snapshotId !== snapshot.snapshotId) {
        signal.throwIfAborted();
        await store.put(c.key, snapshot, { source: SOURCE, freshForMs: Math.max(0, snapshot.expiresAt - now()), deadAfterMs: RETENTION });
      }
      updated++;
      const firstGap = Object.entries(snapshot.metrics).find(([name, metric]) => !VOLUME_METRICS.has(name) && !metric.available);
      const reason = snapshot.coverage.realBars < MIN_REAL_BARS ? "too_few_real_bars" : firstGap?.[1].reason ?? "ready";
      const floorMs = reason === "too_few_real_bars" ? SLOW_FLOOR_MS : FLOOR_MS;
      Object.assign(attempt, { state: firstGap ? "partial" : "ready", reason, sources: [],
        completedAt: now(), lastSuccessAt: now(), consecutiveFailures: 0, nextAttempt: Math.max(now() + floorMs, snapshot.refreshAfter) });
    } catch {
      fail(signal.aborted ? "refresh_interrupted" : "refresh_error", FLOOR_MS, true);
    }
  }));
  for (const outcome of outcomes) if (outcome.status === "rejected") failed++;
  signal.throwIfAborted();
  await store.put(UNDERLYING_FEATURE_STATE_KEY, state, { source: SOURCE, freshForMs: 60_000, deadAfterMs: RETENTION });
  if (stale.length > 0) {
    const tokens = [...new Set(stale)];
    console.warn(`[${UNDERLYING_FEATURES_JOB}] recorder_stale: ${stale.length} series (${tokens.slice(0, 10).join(", ")}${tokens.length > 10 ? `, +${tokens.length - 10} more` : ""})`);
  }
  return { attempted: due.length, updated, failed };
}

export function tradingUnderlyingFeaturesJob(store: SnapshotStore): JobSpec {
  return { name: UNDERLYING_FEATURES_JOB, intervalMs: 60_000, jitterMs: 2_000, timeoutMs: 30_000,
    run: async (signal) => { await runTradingUnderlyingFeatures(store, signal); } };
}
