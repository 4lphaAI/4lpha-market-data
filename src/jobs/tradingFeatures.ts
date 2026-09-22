/** Bounded producer: consumers cannot cause upstream calls or allocate keys. */
import { randomUUID } from "node:crypto";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import { normalizeAddress } from "../adapters/http.js";
import { PRICE_POOLS } from "./majorsPrices.js";
import { getPoolOhlcv, type OhlcvAttempt } from "../query/poolOhlcv.js";
import { calculateFeatures, FEATURE_INDEX_KEY, FEATURE_INDEX_KEY_V2, FEATURE_VERSION, FEATURE_VERSION_V2, FEATURE_STATE_KEY, FEATURE_INTERVALS, featureKey, poolFeatureInput,
  type FeatureAttempt, type FeatureInterval, type FeatureSnapshot, type ReferenceSession } from "../query/tradingFeatures.js";
import { RWA_UNIVERSE_KEY, buildUniverse } from "../universe.js";
import { SPREAD_MIN_LIQUIDITY_USD } from "./spreadHistory.js";
import { sanitizeMessage } from "../adapters/http.js";

export const FEATURE_WATCHLIST_KEY = "trading:features:v1:watchlist";
export { FEATURE_STATE_KEY } from "../query/tradingFeatures.js";
/**
 * Handoff §8 (2026-09-22): the operator watchlist stayed the override, but the
 * default must cover the whole TradFi pin so a score never starves on missing
 * evidence. Today that is the 25 static bStocks minus SPYB/QQQB (reserved
 * below) plus Ondo's rows plus the 4 legacy major pools plus the 2 equity
 * legs — comfortably under this ceiling, which is sized with headroom rather
 * than pinned to the exact current count so normal Ondo/venue growth doesn't
 * start throwing. `defaultRwaFeatureSelection` still drops the shallowest
 * (lowest-liquidity) rows first if the union ever does exceed it, rather than
 * throw and starve every series for one new admission.
 */
const MAX_POOLS = 40;
const RETENTION = 30 * 86_400_000;
/**
 * Handoff §10 follow-up (2026-09-22, operator directive after live 429s):
 * the marketplace default drops `5m` — the execution plane never reads it,
 * so at 36+ pools it was pure wasted demand competing for the same transport
 * budget as the interval that actually feeds the score.
 */
const DEFAULT_SELECTION_INTERVALS: FeatureInterval[] = ["15m", "1h"];
/**
 * Admissions per 60s cycle. History, because the right number kept moving
 * with the architecture underneath it:
 *
 * §8/§9 (2026-09-22) sized this to *burst* enough series through within the
 * read side's freshness grace, on a mistaken reading of that grace as ~90
 * seconds. It is not: `readTradingFeatures`'s staleness cutoff is `closeTime
 * + step + PUBLICATION_LAG_MS + SCHEDULING_GRACE_MS` (`query/tradingFeatures.ts`)
 * — a full *extra* bar period on top of the 90s, ~16.5 minutes of slack for a
 * 15m series. Chasing that wrong, tight deadline pushed admission to 22/cycle
 * and tripped real `geckoterminal` 429s at scale (§10).
 *
 * §10 follow-up corrected that to a deliberately low, paced 5/cycle (~3.3/min
 * steady-state demand for a ~40-pool default with `5m` dropped) — right for a
 * Gecko/DexPaprika-only world, where the ceiling worth respecting is
 * `BUDGETS` (`adapters/ohlcvTransport.ts`), not a target to hit.
 *
 * §11 changed the input to that calculation: most of these series now try
 * Sintral first (`query/poolOhlcv.ts`'s `refresh()`), gated only by
 * `withBinanceLimit`'s 6-concurrent in-process semaphore, not a per-minute
 * budget — measured 36 requests in 3s with no throttling. 5/cycle was
 * conservative for the old Gecko-bound world; it is needlessly slow now that
 * the dominant path for these series has that much more headroom.
 *
 * §12 (2026-09-22, measured live): 5/cycle rotating ~40 same-instant 15m
 * candidates took 15-19 minutes to cycle back to any one of them — readers
 * saw `stale_input` for most of that window even though the data existed,
 * because a full rotation is far slower than the bar recurs. Raised to 40 so
 * a same-instant 15m close can clear in about one cycle when Sintral is
 * healthy. A Sintral outage falling everything back to Gecko/DexPaprika at
 * once is not a new risk this creates — `budget_exhausted` is a
 * `SELF_THROTTLE_REASONS` case (flat retry, no backoff escalation, see
 * `fail` below), so a burst against that budget degrades to roughly the old
 * §10 pace rather than failing hard; it is the same ceiling as before, not a
 * higher one.
 */
const DUE_PER_CYCLE = 40;
/**
 * Handoff §12 (2026-09-22): `15m` gets *strict* priority over `1h` now, not a
 * tie. Tied (§9/§10), the age-fairness sort below still let `1h` win most
 * ties — refreshed a quarter as often, its `attemptedAt` is almost always
 * older — which is exactly backwards: `1h`'s own ~92-minute tolerance can
 * absorb a few cycles' delay for free, `15m`'s ~16.5-minute one cannot. This
 * is the direct fix for "recompute 15m the way 1h already effectively is."
 * `5m` stays last (§10): the execution plane never reads it.
 */
const INTERVAL_PRIORITY: Record<FeatureInterval, number> = { "15m": 0, "1h": 1, "5m": 2 };
export interface FeatureSelection { pool: string; currency: "usd" | "token"; tokenAddress?: string;
  /** indicatorRevision 2: the base token is a tokenized US equity, so the series carries session-anchored metrics. */
  usEquity?: boolean }
export interface FeatureIndex {
  pools: FeatureSelection[]; intervals: FeatureInterval[]; maxPools: number;
  selection: "operator_watchlist" | "marketplace_reference_pools";
}
/**
 * Every RWA token (bStock or Ondo) the allowlist admits with a venue at or
 * above the $10k depth floor (`SPREAD_MIN_LIQUIDITY_USD` — the same floor
 * `spread-history` already watches at, TRADFI-DATA-RESULT-2026-09-17.md) —
 * deepest venue wins when a token clears the floor on more than one pool.
 * Reads `buildUniverse`'s bstocks/ondo lanes rather than re-deriving
 * admission, so a new listing is covered the next time this runs with no
 * hand-enumeration. Sorted deepest-first so a caller trimming to a cap keeps
 * the tokens best supported by liquidity.
 */
async function defaultRwaFeatureSelection(store: SnapshotStore): Promise<(FeatureSelection & { liquidityUsd: number })[]> {
  const universe = await buildUniverse(store);
  const out: (FeatureSelection & { liquidityUsd: number })[] = [];
  for (const entry of universe.entries) {
    if (entry.lane !== "bstocks" && entry.lane !== "ondo") continue;
    let deepest: { pool: string; liquidityUsd: number } | null = null;
    for (const venue of entry.venues ?? []) {
      if (venue.liquidityUsd === null || venue.liquidityUsd < SPREAD_MIN_LIQUIDITY_USD) continue;
      if (deepest === null || venue.liquidityUsd > deepest.liquidityUsd) deepest = { pool: venue.pool, liquidityUsd: venue.liquidityUsd };
    }
    if (deepest === null) continue;
    // Handoff §11 (2026-09-22): usd, not token-ratio -- Sintral (the new
    // primary source for these, see poolOhlcv.ts's refresh()) has no on-chain
    // pair to price a ratio against, only Binance's own USD reference. The
    // Gecko/DexPaprika fallback then also runs in usd mode for the same
    // series, keeping one denomination across the whole chain rather than
    // switching currency depending on which source happened to answer.
    out.push({ pool: deepest.pool, currency: "usd", tokenAddress: entry.address, liquidityUsd: deepest.liquidityUsd });
  }
  out.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  return out;
}

export async function defaultFeatureSelection(store: SnapshotStore): Promise<FeatureSelection[]> {
  const majors = PRICE_POOLS.filter(p => p.base !== "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d")
    .map(p => ({pool: p.pool, currency: "token" as const, tokenAddress: p.base}));
  // SPYB/USDT 0.01% and QQQB/USDT 0.01% (PancakeSwap V3): the equity-regime
  // legs. Deepest venue of each on 2026-09-21 ($374k / $1.68M), both past the
  // $10k tier-A floor. Pinned explicitly rather than left to the sweep below
  // so `/trading/regime/us-equity` keeps a known-good pool even on a cycle
  // where the venue sweep hasn't run or disagrees on which pool is deepest.
  const equityLegs: FeatureSelection[] = [
    // usd, not token-ratio, for the same reason as the RWA sweep below (§11):
    // both are usEquity pools, so Sintral is tried first for them too.
    {pool: EQUITY_REGIME_POOLS.spy, currency: "usd", tokenAddress: EQUITY_REGIME_TOKENS.spy},
    {pool: EQUITY_REGIME_POOLS.qqq, currency: "usd", tokenAddress: EQUITY_REGIME_TOKENS.qqq},
  ];
  const reserved = new Set([...majors.map(p => p.tokenAddress), ...equityLegs.map(p => p.tokenAddress)]);
  const rwa = (await defaultRwaFeatureSelection(store)).filter(p => !reserved.has(p.tokenAddress));

  const budget = MAX_POOLS - majors.length - equityLegs.length;
  const admitted = rwa.length <= budget ? rwa : rwa.slice(0, Math.max(0, budget));
  if (admitted.length < rwa.length) {
    console.warn(`[trading-features] default RWA coverage trimmed ${rwa.length - admitted.length} of ${rwa.length} admitted pools to fit MAX_POOLS=${MAX_POOLS}; raise the ceiling rather than let this persist`);
  }
  return [...majors, ...admitted.map(({liquidityUsd: _liquidityUsd, ...p}) => p), ...equityLegs];
}
export const EQUITY_REGIME_TOKENS = { spy: "0x7138b48df7d98d7e3cc221bfe7192d0a178182d8", qqq: "0x205812cdbed920aff76c6580abd681a46d11efc7" } as const;
export const EQUITY_REGIME_POOLS = { spy: "0x7aa6d92fc369a8c1edc631a3aac44efb0808ddbf", qqq: "0xe531fcb1f5a195de7608b9f4f9518544c2cdb693" } as const;

/** Issuers whose underlying is a US-listed equity on the NYSE clock. */
const US_EQUITY_PLATFORMS = new Set(["bstock", "ondo"]);
/**
 * Reference sessions by base address, from the RWA snapshot at any staleness:
 * the underlying ticker is a permanent fact, and the record's own `asOf` is
 * carried so a consumer sees how old `marketStatus` / `openState` are. A
 * token outside the snapshot is not a US equity for this pass.
 */
export async function loadReferenceSessions(store: SnapshotStore): Promise<Map<string, ReferenceSession>> {
  const out = new Map<string, ReferenceSession>();
  try {
    const record = await store.get<{ rows?: unknown }>(RWA_UNIVERSE_KEY);
    const rows = Array.isArray(record?.data?.rows) ? record.data.rows : [];
    for (const raw of rows) {
      if (typeof raw !== "object" || raw === null) continue;
      const row = raw as Record<string, unknown>;
      const address = normalizeAddress(row["address"]);
      if (!address || typeof row["underlyingTicker"] !== "string" || !row["underlyingTicker"]
        || typeof row["platform"] !== "string" || !US_EQUITY_PLATFORMS.has(row["platform"])) continue;
      out.set(address, { underlyingTicker: row["underlyingTicker"],
        marketStatus: typeof row["marketStatus"] === "string" ? row["marketStatus"] : null,
        openState: typeof row["openState"] === "boolean" ? row["openState"] : null, asOf: record?.asOf ?? null });
    }
  } catch (error) { console.warn(`[trading-features] rwa snapshot read failed: ${sanitizeMessage(error)}`); }
  return out;
}
/** The operator store key is the only override; HTTP clients cannot mutate it. */
export async function featureSelection(store: SnapshotStore): Promise<FeatureIndex> {
  const configured = await store.get<unknown>(FEATURE_WATCHLIST_KEY);
  const raw = configured ? configured.data : await defaultFeatureSelection(store);
  if (!Array.isArray(raw) || raw.length > MAX_POOLS) throw new Error(`invalid trading feature watchlist (maximum ${MAX_POOLS} pools)`);
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
  // Handoff §10 follow-up (2026-09-22, operator directive): the execution
  // plane never reads 5m for the marketplace default set, so producing it
  // there is pure wasted demand on a budget that is already tight at 36+
  // pools. Scoped to the default only — an explicit operator watchlist still
  // gets all three intervals, since it may exist for a reason other than the
  // TradFi score.
  const intervals = (configured ? Object.keys(FEATURE_INTERVALS) : DEFAULT_SELECTION_INTERVALS) as FeatureInterval[];
  return { pools, intervals, maxPools: MAX_POOLS,
    selection: configured ? "operator_watchlist" : "marketplace_reference_pools" };
}

export async function runTradingFeatures(store: SnapshotStore, signal: AbortSignal,
  deps: { now?: () => number; load?: typeof getPoolOhlcv } = {}) {
  const now = deps.now ?? Date.now;
  signal.throwIfAborted();
  if (!await store.acquireSchedulerLease("trading-features:v1:producer", randomUUID(), 60_000)) return { attempted: 0, updated: 0, failed: 0 };
  const references = await loadReferenceSessions(store);
  const index = await featureSelection(store);
  index.pools = index.pools.map((p) => ({ ...p, usEquity: p.tokenAddress !== undefined && references.has(p.tokenAddress) }));
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
    .sort((a, b) => INTERVAL_PRIORITY[a.interval] - INTERVAL_PRIORITY[b.interval]
      || state[`${a.key}:${a.currency}`]!.attemptedAt - state[`${b.key}:${b.currency}`]!.attemptedAt || a.key.localeCompare(b.key))
    .slice(0, DUE_PER_CYCLE);
  // Persist admission before IO: an interrupted pass cannot starve other series.
  for (const c of due) state[`${c.key}:${c.currency}`] = {...state[`${c.key}:${c.currency}`]!, attemptedAt: now(), nextAttempt: now() + 60_000, state: "refreshing", reason: "refreshing", sources: []};
  await store.put(FEATURE_STATE_KEY, state, { source: "trading-features", freshForMs: 60_000, deadAfterMs: RETENTION });
  let updated = 0, failed = 0;
  const outcomes = await Promise.allSettled(due.map(async (c) => {
    const attempt = state[`${c.key}:${c.currency}`]!;
    const sources: OhlcvAttempt[] = [];
    const fail = (reason: string) => {
      failed++;
      // Self-imposed capacity denials (we never actually reached the
      // provider) are not evidence anything is broken; escalating backoff on
      // them just pushes a candidate further behind every time demand
      // exceeds a budget, which at 36+ pools is routine, not exceptional
      // (handoff §9, 2026-09-22). Retry next tick instead, same as
      // `refresh_lease` already did before this reason set existed.
      if (SELF_THROTTLE_REASONS.has(reason)) {
        Object.assign(attempt, {state: "unavailable", reason, sources, completedAt: now(), nextAttempt: now() + 60_000});
        return;
      }
      attempt.consecutiveFailures = (attempt.consecutiveFailures ?? 0) + 1;
      Object.assign(attempt, {state: "unavailable", reason, sources, completedAt: now(),
        nextAttempt: now() + Math.min(300_000, 60_000 * 2 ** Math.min(3, attempt.consecutiveFailures - 1))});
    };
    try {
    signal.throwIfAborted();
    const chart = await (deps.load ?? getPoolOhlcv)(store, { poolAddress: c.pool, interval: c.interval, currency: c.currency, limit: 500, signal,
      qualityPolicy: "trading-v2", onAttempt: info => { if (sources.length < 4) sources.push(info); }, usEquity: c.usEquity ?? false,
      ...(c.tokenAddress ? { tokenAddress: c.tokenAddress } : {}) });
    signal.throwIfAborted();
    if (!chart || chart.staleness !== "fresh") { fail(chart ? "stale_input" : sources.at(-1)?.reason ?? "provider_unavailable"); return; }
    const observation = { ...poolFeatureInput(chart, c.interval), referenceSession: references.get(chart.base.address.toLowerCase()) ?? null };
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
    const reason = unavailable[0]?.reason ?? "ready";
    // Handoff §12: a too_few_real_bars pool (a genuinely thin/dead Sintral
    // series, §11) had refreshAfter computed from a stale closeTime, so the
    // 60s floor below was the only thing setting its next attempt -- it was
    // retried every single minute for an outcome unlikely to change soon,
    // spending an admission slot every cycle that the ~40 other, live series
    // needed more. A few more real trades won't show up within a minute;
    // give it room without going as far as exponential backoff (this is not
    // a failure, `updated++`/`consecutiveFailures: 0` above still apply).
    const floorMs = reason === "too_few_real_bars" ? 300_000 : 60_000;
    Object.assign(attempt, {state: unavailable.length ? "partial" : "ready", reason, sources,
      completedAt: now(), lastSuccessAt: now(), consecutiveFailures: 0,
      nextAttempt: Math.max(now() + floorMs, snapshot.refreshAfter)});
    } catch { fail(signal.aborted ? "refresh_interrupted" : "refresh_error"); }
  }));
  for (const outcome of outcomes) if (outcome.status === "rejected") failed++;
  signal.throwIfAborted();
  await store.put(FEATURE_STATE_KEY, state, { source: "trading-features", freshForMs: 60_000, deadAfterMs: RETENTION });
  if (due.length > 0 && failed === due.length) {
    // A pass is a job failure only when no provider answered. A batch of one
    // bStock series outside US market hours fails with `stale_input` — the
    // provider answered, the market is just closed — and marking the job
    // failed for that put `lastError` on /status most of the day (66% of all
    // error lines over the first week in production, with 17/18 series ready).
    const reasons = due.map((c) => state[`${c.key}:${c.currency}`]!.reason ?? "unknown");
    const summary = summarizeReasons(reasons);
    if (reasons.every((reason) => QUIET_REASONS.has(reason))) {
      console.log(`[trading-features] no series advanced this pass; inputs quiet, not failed (${summary})`);
    } else {
      throw new Error(`trading feature inputs unavailable for every attempted series (${summary})`);
    }
  }
  return { attempted: due.length, updated, failed };
}
/**
 * Reasons meaning this attempt never reached the provider at all — our own
 * admission/rate control said "not this tick," not "the data is bad." Exempt
 * from backoff escalation (see `fail` above) and from counting as a job
 * failure below. `refresh_lease` already behaved this way for the job-failure
 * check; `admission_limit` and `budget_exhausted` are new as of handoff §9,
 * once they became the routine case rather than a rare collision.
 */
const SELF_THROTTLE_REASONS: ReadonlySet<string> = new Set(["admission_limit", "refresh_lease", "budget_exhausted"]);
/**
 * Reasons meaning the provider answered but had nothing new: not an outage.
 * Handoff §10: `rate_limited` (a real 429 from the upstream, not our own
 * budget denial) joins this set — it still backs a candidate off per-candidate
 * (see `fail`, unlike the `SELF_THROTTLE_REASONS` set above, since a genuine
 * 429 is real evidence something is wrong), but at 36+ pools it is now routine
 * enough that a pass landing entirely on it should not be reported as a job
 * failure ("no provider answered" reads as an outage; "the provider answered
 * with 429" is the provider telling us to slow down, already handled by the
 * per-candidate backoff and this job's own admission pacing above).
 */
const QUIET_REASONS: ReadonlySet<string> = new Set(["stale_input", "stale", "empty", "gap", "refresh_lease", "cache_hit", "admission_limit", "budget_exhausted", "rate_limited"]);
function summarizeReasons(reasons: string[]): string {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].map(([reason, n]) => (n > 1 ? `${reason}×${n}` : reason)).join(", ");
}
export function tradingFeaturesJob(store: SnapshotStore): JobSpec {
  return { name: "trading-features", intervalMs: 60_000, jitterMs: 2_000, timeoutMs: 30_000,
    run: async (signal) => { await runTradingFeatures(store, signal); } };
}
