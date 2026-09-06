/** Bounded producer: consumers cannot cause upstream calls or allocate keys. */
import { randomUUID } from "node:crypto";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import { normalizeAddress } from "../adapters/http.js";
import { PRICE_POOLS } from "./majorsPrices.js";
import { getPoolOhlcv, type OhlcvAttempt } from "../query/poolOhlcv.js";
import { calculateFeatures, FEATURE_INDEX_KEY, FEATURE_INDEX_KEY_V2, FEATURE_VERSION, FEATURE_VERSION_V2, FEATURE_STATE_KEY, FEATURE_INTERVALS, featureKey, poolFeatureInput,
  type FeatureAttempt, type FeatureInterval, type FeatureSnapshot } from "../query/tradingFeatures.js";

export const FEATURE_WATCHLIST_KEY = "trading:features:v1:watchlist";
export { FEATURE_STATE_KEY } from "../query/tradingFeatures.js";
const MAX_POOLS = 10;
const RETENTION = 30 * 86_400_000;
export interface FeatureSelection { pool: string; currency: "usd" | "token"; tokenAddress?: string }
export interface FeatureIndex {
  pools: FeatureSelection[]; intervals: FeatureInterval[]; maxPools: number;
  selection: "operator_watchlist" | "marketplace_reference_pools";
}
export function defaultFeatureSelection(): FeatureSelection[] {
  return [
    ...PRICE_POOLS.filter(p => p.base !== "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d")
      .map(p => ({pool: p.pool, currency: "token" as const, tokenAddress: p.base})),
    {pool: "0x8fb4243b553ac29ba088acf00b9b7da24bd6690c", currency: "token", tokenAddress: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436"},
    {pool: "0xb0f5e5400e8f0f7c242f2b7740c004f020579c41", currency: "token", tokenAddress: "0x5b1910eaad6450e50f816082aa078c41f10c292f"},
  ];
}
/** The operator store key is the only override; HTTP clients cannot mutate it. */
export async function featureSelection(store: SnapshotStore): Promise<FeatureIndex> {
  const configured = await store.get<unknown>(FEATURE_WATCHLIST_KEY);
  const raw = configured ? configured.data : defaultFeatureSelection();
  if (!Array.isArray(raw) || raw.length > MAX_POOLS) throw new Error("invalid trading feature watchlist (maximum 10 pools)");
  const pools: FeatureSelection[] = [];
  for (const value of raw) {
    if (typeof value !== "object" || value === null) throw new Error("invalid trading feature watchlist entry");
    const row = value as Record<string, unknown>;
    const pool = normalizeAddress(row["pool"]);
    const currency = row["currency"] ?? "usd";
    const tokenAddress = row["tokenAddress"] === undefined ? undefined : normalizeAddress(row["tokenAddress"]);
    if (!pool || (currency !== "usd" && currency !== "token") || pools.some((p) => p.pool === pool)) throw new Error("invalid trading feature watchlist identity");
    if (tokenAddress === null) throw new Error("invalid explicit feature token");
    pools.push({ pool, currency, ...(tokenAddress ? { tokenAddress } : {}) });
  }
  return { pools, intervals: Object.keys(FEATURE_INTERVALS) as FeatureInterval[], maxPools: MAX_POOLS,
    selection: configured ? "operator_watchlist" : "marketplace_reference_pools" };
}

export async function runTradingFeatures(store: SnapshotStore, signal: AbortSignal,
  deps: { now?: () => number; load?: typeof getPoolOhlcv } = {}) {
  const now = deps.now ?? Date.now;
  signal.throwIfAborted();
  if (!await store.acquireSchedulerLease("trading-features:v1:producer", randomUUID(), 60_000)) return { attempted: 0, updated: 0, failed: 0 };
  const index = await featureSelection(store);
  await store.put(FEATURE_INDEX_KEY, index, { source: "trading-features", freshForMs: 120_000, deadAfterMs: RETENTION });
  await store.put(FEATURE_INDEX_KEY_V2, index, { source: "trading-features", freshForMs: 120_000, deadAfterMs: RETENTION });
  const previous = (await store.get<Record<string, FeatureAttempt>>(FEATURE_STATE_KEY))?.data ?? {};
  const state: Record<string, FeatureAttempt> = {};
  const candidates = index.pools.flatMap((selection) => index.intervals.map((interval) => ({ ...selection, interval,
    key: featureKey(selection.pool, interval, selection.currency, selection.tokenAddress) })));
  // State is one bounded object, not one durable key per arbitrary input.
  for (const candidate of candidates) {
    const stateKey = `${candidate.key}:${candidate.currency}`;
    const saved = previous[stateKey];
    // Recompute v2 IDs once after canonical-hash rollout. Complete cached
    // candles are reused; this does not force upstream refreshes.
    state[stateKey] = saved?.revision === 2 ? saved : {revision: 2, attemptedAt: 0, nextAttempt: 0,
      state: "queued", reason: saved ? "recompute_version" : "not_attempted"};
  }
  const due = candidates.filter((c) => state[`${c.key}:${c.currency}`]!.nextAttempt <= now())
    .sort((a, b) => state[`${a.key}:${a.currency}`]!.attemptedAt - state[`${b.key}:${b.currency}`]!.attemptedAt || a.key.localeCompare(b.key)).slice(0, 4);
  // Persist admission before IO: an interrupted pass cannot starve other series.
  for (const c of due) state[`${c.key}:${c.currency}`] = {...state[`${c.key}:${c.currency}`]!, attemptedAt: now(), nextAttempt: now() + 60_000, state: "refreshing", reason: "refreshing", sources: []};
  await store.put(FEATURE_STATE_KEY, state, { source: "trading-features", freshForMs: 60_000, deadAfterMs: RETENTION });
  let updated = 0, failed = 0;
  const outcomes = await Promise.allSettled(due.map(async (c) => {
    const attempt = state[`${c.key}:${c.currency}`]!;
    const sources: OhlcvAttempt[] = [];
    const fail = (reason: string) => {
      failed++;
      attempt.consecutiveFailures = (attempt.consecutiveFailures ?? 0) + 1;
      Object.assign(attempt, {state: "unavailable", reason, sources, completedAt: now(),
        nextAttempt: now() + Math.min(300_000, 60_000 * 2 ** Math.min(3, attempt.consecutiveFailures - 1))});
    };
    try {
    signal.throwIfAborted();
    const chart = await (deps.load ?? getPoolOhlcv)(store, { poolAddress: c.pool, interval: c.interval, currency: c.currency, limit: 500, signal,
      qualityPolicy: "trading-v2", onAttempt: info => { if (sources.length < 4) sources.push(info); },
      ...(c.tokenAddress ? { tokenAddress: c.tokenAddress } : {}) });
    signal.throwIfAborted();
    if (!chart || chart.staleness !== "fresh") { fail(chart ? "stale_input" : sources.at(-1)?.reason ?? "provider_unavailable"); return; }
    const observation = poolFeatureInput(chart, c.interval);
    const snapshot = calculateFeatures(observation, now(), FEATURE_VERSION_V2);
    for (const version of [FEATURE_VERSION, FEATURE_VERSION_V2] as const) {
      const value = version === FEATURE_VERSION_V2 ? snapshot : calculateFeatures(observation, snapshot.calculatedAt, version);
      const key = featureKey(c.pool, c.interval, c.currency, c.tokenAddress, version);
      const old = await store.get<FeatureSnapshot>(key);
      if (old?.data.snapshotId !== value.snapshotId) {
        signal.throwIfAborted();
        await store.put(key, value, { source: "trading-features", freshForMs: Math.max(0, value.expiresAt - now()), deadAfterMs: RETENTION });
      }
    }
    updated++;
    const unavailable = Object.values(snapshot.metrics).filter(m => !m.available);
    Object.assign(attempt, {state: unavailable.length ? "partial" : "ready", reason: unavailable[0]?.reason ?? "ready", sources,
      completedAt: now(), lastSuccessAt: now(), consecutiveFailures: 0,
      nextAttempt: Math.max(now() + 60_000, snapshot.refreshAfter)});
    } catch { fail(signal.aborted ? "refresh_interrupted" : "refresh_error"); }
  }));
  for (const outcome of outcomes) if (outcome.status === "rejected") failed++;
  signal.throwIfAborted();
  await store.put(FEATURE_STATE_KEY, state, { source: "trading-features", freshForMs: 60_000, deadAfterMs: RETENTION });
  if (due.length > 0 && failed === due.length) throw new Error("trading feature inputs unavailable for every attempted series");
  return { attempted: due.length, updated, failed };
}
export function tradingFeaturesJob(store: SnapshotStore): JobSpec {
  return { name: "trading-features", intervalMs: 60_000, jitterMs: 2_000, timeoutMs: 30_000,
    run: async (signal) => { await runTradingFeatures(store, signal); } };
}
