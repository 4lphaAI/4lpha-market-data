/** Bounded producer: consumers cannot cause upstream calls or allocate keys. */
import { randomUUID } from "node:crypto";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import { normalizeAddress } from "../adapters/http.js";
import { readTrackedPools } from "./pancakePools.js";
import { getPoolOhlcv } from "../query/poolOhlcv.js";
import { calculateFeatures, FEATURE_INDEX_KEY, FEATURE_INTERVALS, featureKey, poolFeatureInput,
  type FeatureInterval, type FeatureSnapshot } from "../query/tradingFeatures.js";

export const FEATURE_WATCHLIST_KEY = "trading:features:v1:watchlist";
export const FEATURE_STATE_KEY = "trading:features:v1:producer";
const MAX_POOLS = 10;
const RETENTION = 30 * 86_400_000;
export interface FeatureSelection { pool: string; currency: "usd" | "token"; tokenAddress?: string }
interface Attempt { attemptedAt: number; nextAttempt: number }
export interface FeatureIndex {
  pools: FeatureSelection[]; intervals: FeatureInterval[]; maxPools: number;
  selection: "operator_watchlist" | "tracked_pool_seeds";
}
/** The operator store key is the only override; HTTP clients cannot mutate it. */
export async function featureSelection(store: SnapshotStore): Promise<FeatureIndex> {
  const configured = await store.get<unknown>(FEATURE_WATCHLIST_KEY);
  const raw = configured ? configured.data : (await readTrackedPools(store)).slice(0, MAX_POOLS).map((pool) => ({ pool, currency: "usd" }));
  if (!Array.isArray(raw) || raw.length > MAX_POOLS) throw new Error("invalid trading feature watchlist (maximum 10 pools)");
  const pools: FeatureSelection[] = [];
  for (const value of raw) {
    if (typeof value !== "object" || value === null) throw new Error("invalid trading feature watchlist entry");
    const row = value as Record<string, unknown>;
    const pool = normalizeAddress(row["pool"]);
    const currency = row["currency"] ?? "usd";
    const tokenAddress = row["tokenAddress"] === undefined ? undefined : normalizeAddress(row["tokenAddress"]);
    if (!pool || (currency !== "usd" && currency !== "token") || pools.some((p) => p.pool === pool)) throw new Error("invalid trading feature watchlist identity");
    if (tokenAddress === null || (tokenAddress !== undefined && currency !== "usd")) throw new Error("explicit feature token requires USD currency");
    pools.push({ pool, currency, ...(tokenAddress ? { tokenAddress } : {}) });
  }
  return { pools, intervals: Object.keys(FEATURE_INTERVALS) as FeatureInterval[], maxPools: MAX_POOLS,
    selection: configured ? "operator_watchlist" : "tracked_pool_seeds" };
}

export async function runTradingFeatures(store: SnapshotStore, signal: AbortSignal,
  deps: { now?: () => number; load?: typeof getPoolOhlcv } = {}) {
  const now = deps.now ?? Date.now;
  signal.throwIfAborted();
  if (!await store.acquireSchedulerLease("trading-features:v1:producer", randomUUID(), 60_000)) return { attempted: 0, updated: 0, failed: 0 };
  const index = await featureSelection(store);
  await store.put(FEATURE_INDEX_KEY, index, { source: "trading-features", freshForMs: 120_000, deadAfterMs: RETENTION });
  const previous = (await store.get<Record<string, Attempt>>(FEATURE_STATE_KEY))?.data ?? {};
  const state: Record<string, Attempt> = {};
  const candidates = index.pools.flatMap((selection) => index.intervals.map((interval) => ({ ...selection, interval,
    key: featureKey(selection.pool, interval, selection.currency, selection.tokenAddress) })));
  // State is one bounded object, not one durable key per arbitrary input.
  for (const candidate of candidates) {
    const stateKey = `${candidate.key}:${candidate.currency}`;
    state[stateKey] = previous[stateKey] ?? { attemptedAt: 0, nextAttempt: 0 };
  }
  const due = candidates.filter((c) => state[`${c.key}:${c.currency}`]!.nextAttempt <= now())
    .sort((a, b) => state[`${a.key}:${a.currency}`]!.attemptedAt - state[`${b.key}:${b.currency}`]!.attemptedAt || a.key.localeCompare(b.key)).slice(0, 4);
  // Persist admission before IO: an interrupted pass cannot starve other series.
  for (const c of due) state[`${c.key}:${c.currency}`] = { attemptedAt: now(), nextAttempt: now() + 60_000 };
  await store.put(FEATURE_STATE_KEY, state, { source: "trading-features", freshForMs: 60_000, deadAfterMs: RETENTION });
  let updated = 0, failed = 0;
  const outcomes = await Promise.allSettled(due.map(async (c) => {
    signal.throwIfAborted();
    const chart = await (deps.load ?? getPoolOhlcv)(store, { poolAddress: c.pool, interval: c.interval, currency: c.currency, limit: 500, signal,
      ...(c.tokenAddress ? { tokenAddress: c.tokenAddress } : {}) });
    signal.throwIfAborted();
    if (!chart || chart.staleness !== "fresh") { failed++; return; }
    const snapshot = calculateFeatures(poolFeatureInput(chart, c.interval), now());
    const old = await store.get<FeatureSnapshot>(c.key);
    if (old?.data.snapshotId !== snapshot.snapshotId) {
      signal.throwIfAborted();
      await store.put(c.key, snapshot, { source: "trading-features", freshForMs: Math.max(0, snapshot.expiresAt - now()), deadAfterMs: RETENTION });
      updated++;
    }
    state[`${c.key}:${c.currency}`]!.nextAttempt = Math.max(now() + 60_000, snapshot.refreshAfter);
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
