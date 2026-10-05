/**
 * Recorder for the underlying reference price of the bStocks (agentic-rfq-stocks
 * R2.2, R3.1, R4.3, R4.4, R5.1.3).
 *
 * The Binance Web3 RWA API has no history of the underlying's price, so the
 * `binance-rwa` job records it: one observation per bStock per cycle (about
 * every 60 s), folded into 15m and 1h bars. Prices are per share, one endpoint
 * per series, no volume; a bucket with no observation stays missing and is
 * never filled.
 *
 * Nothing is held between cycles. The open bar of every token lives in one store
 * record, the closed bars in one record per token, and a lease keeps recording
 * cycles from overlapping, so any replica continues the same series from the
 * store alone.
 *
 * "Real bar" means a bucket in which the reference changed by at least 1 bp from
 * the value at the token's last counted change. A bucket that was observed but
 * never moved is stored (it is part of the time axis) and is not a real bar.
 */

import type { SnapshotStore } from "../core/store.js";

export type ReferenceEndpoint = "tokens" | "price";
export type ReferenceInterval = "15m" | "1h";

export const REFERENCE_BAR_STEPS_MS: Readonly<Record<ReferenceInterval, number>> = { "15m": 900_000, "1h": 3_600_000 };
export const REFERENCE_INTERVALS: readonly ReferenceInterval[] = ["15m", "1h"];

export const REFERENCE_BARS_LEASE = "rwa-reference-bars:v1:recorder";
/**
 * Longer than the `binance-rwa` job timeout (20 s) so a holder's cycle is over
 * before anyone else can take the lease, shorter than its 60 s interval so a
 * single live replica always re-takes it. Raise the two together (R5.6).
 */
export const REFERENCE_BARS_LEASE_TTL_MS = 30_000;
/** The recorder's own budget for the closed-bar appends (R5.3). */
export const RECORDER_DEADLINE_MS = 2_500;
export const REFERENCE_BAR_CAP = 121;
export const REFERENCE_RETENTION_MS = 30 * 86_400_000;
/** A change counts from this magnitude, in bps of the anchor (R4.4). */
export const REFERENCE_CHANGE_FLOOR_BPS = 1;

export const REFERENCE_BARS_OPEN_KEY = "rwa:reference-bars:v1:open";
export const referenceBarsKey = (token: string): string => `rwa:reference-bars:v1:${token.toLowerCase()}`;

const SOURCE = "binance-rwa";

export interface ReferenceBar {
  /** UTC bucket open, epoch ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  samples: number;
  changes: number;
}

/** Open state of one token: the bar being built per interval and the change anchor. */
export interface OpenEntry {
  endpoint: ReferenceEndpoint;
  /** The value at the token's last counted change (the first observation sets it). */
  anchor: number;
  lastObservedAt: number;
  open15m: ReferenceBar | null;
  open1h: ReferenceBar | null;
}

export interface OpenState {
  tokens: Record<string, OpenEntry>;
}

/** Closed bars of one token, newest last, at most {@link REFERENCE_BAR_CAP} per interval. */
export interface ReferenceBarRecord {
  token: string;
  underlyingTicker: string | null;
  endpoint: ReferenceEndpoint;
  basis: "usd_per_share";
  "15m": ReferenceBar[];
  "1h": ReferenceBar[];
}

export interface ReferenceObservation {
  token: string;
  underlyingTicker: string | null;
  endpoint: ReferenceEndpoint;
  /** Price of one share of the underlying; positive and finite. */
  value: number;
}

export interface RecorderResult {
  /** The open state was written this cycle. */
  recorded: boolean;
  reason: "ok" | "no_lease" | "lease_lost";
  /** Tokens whose bucket closed and were appended this cycle. */
  closes: number;
  /** Tokens whose 15m bucket closed (a 15m boundary cycle has at least one). */
  closes15m: number;
  /** Closes left for a later cycle because the recorder deadline fired. */
  deferred: number;
  deadlineFired: boolean;
  storeOps: number;
  ms: number;
}

export interface RecordReferenceBarsOptions {
  /** The cycle's observation time (right after the list call returned). */
  observedAt: number;
  /** This cycle's lease holder; the same value re-takes the lease before the open-state write. */
  holder: string;
  /** The job's own signal: aborted means no open-state write. */
  jobSignal: AbortSignal;
  /** The recorder's own deadline: bounds the closed appends only. */
  deadline: AbortSignal;
  clock?: (() => number) | undefined;
}

const isPositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

function normalizeBar(raw: unknown): ReferenceBar | null {
  if (typeof raw !== "object" || raw === null) return null;
  const bar = raw as Record<string, unknown>;
  if (typeof bar["t"] !== "number" || !Number.isSafeInteger(bar["t"]) || bar["t"] <= 0) return null;
  if (![bar["o"], bar["h"], bar["l"], bar["c"]].every(isPositive)) return null;
  if (!isCount(bar["samples"]) || !isCount(bar["changes"])) return null;
  return { t: bar["t"], o: bar["o"] as number, h: bar["h"] as number, l: bar["l"] as number, c: bar["c"] as number,
    samples: bar["samples"], changes: bar["changes"] };
}

function normalizeOpenBar(raw: unknown): ReferenceBar | null {
  return raw === null || raw === undefined ? null : normalizeBar(raw);
}

/** Re-validated on read: a malformed entry is dropped, which restarts that token's open bars. */
export function normalizeOpenState(data: unknown): OpenState {
  const out: OpenState = { tokens: {} };
  const tokens = typeof data === "object" && data !== null ? (data as Record<string, unknown>)["tokens"] : undefined;
  if (typeof tokens !== "object" || tokens === null) return out;
  for (const [token, raw] of Object.entries(tokens as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (entry["endpoint"] !== "tokens" && entry["endpoint"] !== "price") continue;
    if (!isPositive(entry["anchor"]) || typeof entry["lastObservedAt"] !== "number" || !Number.isFinite(entry["lastObservedAt"])) continue;
    out.tokens[token] = {
      endpoint: entry["endpoint"], anchor: entry["anchor"], lastObservedAt: entry["lastObservedAt"],
      open15m: normalizeOpenBar(entry["open15m"]), open1h: normalizeOpenBar(entry["open1h"]),
    };
  }
  return out;
}

/** `null` when the record is not a usable closed-bar record. */
export function normalizeBarRecord(data: unknown): ReferenceBarRecord | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record["token"] !== "string") return null;
  if (record["endpoint"] !== "tokens" && record["endpoint"] !== "price") return null;
  if (record["basis"] !== "usd_per_share") return null;
  const bars = (raw: unknown): ReferenceBar[] =>
    Array.isArray(raw) ? raw.map(normalizeBar).filter((bar): bar is ReferenceBar => bar !== null) : [];
  return {
    token: record["token"], underlyingTicker: typeof record["underlyingTicker"] === "string" ? record["underlyingTicker"] : null,
    endpoint: record["endpoint"], basis: "usd_per_share", "15m": bars(record["15m"]), "1h": bars(record["1h"]),
  };
}

const bucketOf = (at: number, interval: ReferenceInterval): number => {
  const step = REFERENCE_BAR_STEPS_MS[interval];
  return Math.floor(at / step) * step;
};

/** Folds one observation into the token's open state; pure, no store access. */
function applyObservation(entry: OpenEntry | undefined, obs: ReferenceObservation, observedAt: number): OpenEntry {
  const value = obs.value;
  // The first observation of a series sets the anchor and counts no change.
  const changed = entry !== undefined && Math.abs(value - entry.anchor) * 10_000 >= entry.anchor * REFERENCE_CHANGE_FLOOR_BPS;
  const next: OpenEntry = {
    endpoint: obs.endpoint,
    anchor: entry === undefined || changed ? value : entry.anchor,
    lastObservedAt: observedAt,
    open15m: null,
    open1h: null,
  };
  for (const interval of REFERENCE_INTERVALS) {
    const bucket = bucketOf(observedAt, interval);
    const open = interval === "15m" ? entry?.open15m ?? null : entry?.open1h ?? null;
    const bar: ReferenceBar = open !== null && open.t >= bucket
      ? { ...open, h: Math.max(open.h, value), l: Math.min(open.l, value), c: value, samples: open.samples + 1, changes: open.changes + (changed ? 1 : 0) }
      : { t: bucket, o: value, h: value, l: value, c: value, samples: 1, changes: changed ? 1 : 0 };
    if (interval === "15m") next.open15m = bar;
    else next.open1h = bar;
  }
  return next;
}

/** Which intervals of this token's open bars the observation's buckets have moved past. */
function closing(entry: OpenEntry | undefined, observedAt: number): Array<{ interval: ReferenceInterval; bar: ReferenceBar }> {
  if (entry === undefined) return [];
  const out: Array<{ interval: ReferenceInterval; bar: ReferenceBar }> = [];
  if (entry.open15m !== null && entry.open15m.t < bucketOf(observedAt, "15m")) out.push({ interval: "15m", bar: entry.open15m });
  if (entry.open1h !== null && entry.open1h.t < bucketOf(observedAt, "1h")) out.push({ interval: "1h", bar: entry.open1h });
  return out;
}

/**
 * Appends the closed bars to the token's record: one get and one put. Idempotent
 * by bucket open, so a close repeated after a crash adds nothing. A record of
 * another endpoint is replaced, never extended (one endpoint, one basis).
 */
async function appendClosed(
  store: SnapshotStore,
  obs: ReferenceObservation,
  endpoint: ReferenceEndpoint,
  closes: Array<{ interval: ReferenceInterval; bar: ReferenceBar }>,
): Promise<void> {
  const stored = await store.get<unknown>(referenceBarsKey(obs.token));
  const parsed = stored === null ? null : normalizeBarRecord(stored.data);
  const record: ReferenceBarRecord = parsed !== null && parsed.endpoint === endpoint
    ? parsed
    : { token: obs.token, underlyingTicker: obs.underlyingTicker, endpoint, basis: "usd_per_share", "15m": [], "1h": [] };
  record.underlyingTicker = obs.underlyingTicker;
  for (const { interval, bar } of closes) {
    const list = record[interval];
    if (!list.some((stored) => stored.t === bar.t)) list.push(bar);
    record[interval] = list.slice(-REFERENCE_BAR_CAP);
  }
  await store.put(referenceBarsKey(obs.token), record, { source: SOURCE, freshForMs: REFERENCE_RETENTION_MS, deadAfterMs: REFERENCE_RETENTION_MS });
}

/**
 * One recording cycle. Order is the safety argument: closed appends first
 * (idempotent), then a lease re-take by the same holder, then the single
 * open-state put. A cycle whose lease another replica has taken writes no open
 * state, so a late run cannot overwrite a newer one.
 *
 * The recorder's deadline bounds the closed appends only: when it fires the
 * remaining closes are deferred (their tokens keep their stored entry and
 * contribute no sample this cycle) and the open state is still written for the
 * rest. The pass starts at a rotating offset so no token is systematically the
 * one that gets cut. An aborted job signal writes nothing more.
 */
export async function recordReferenceBars(
  store: SnapshotStore,
  observations: readonly ReferenceObservation[],
  options: RecordReferenceBarsOptions,
): Promise<RecorderResult> {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const result: RecorderResult = { recorded: false, reason: "ok", closes: 0, closes15m: 0, deferred: 0, deadlineFired: false, storeOps: 0, ms: 0 };
  options.jobSignal.throwIfAborted();
  result.storeOps += 1;
  if (!await store.acquireSchedulerLease(REFERENCE_BARS_LEASE, options.holder, REFERENCE_BARS_LEASE_TTL_MS)) {
    return finish({ ...result, reason: "no_lease" });
  }

  result.storeOps += 1;
  const state = normalizeOpenState((await store.get<unknown>(REFERENCE_BARS_OPEN_KEY))?.data);
  const byToken = new Map<string, ReferenceObservation>();
  for (const obs of observations) if (isPositive(obs.value)) byToken.set(obs.token, obs);
  const tokens = [...byToken.keys()].sort();
  const offset = tokens.length === 0 ? 0 : Math.floor(options.observedAt / REFERENCE_BAR_STEPS_MS["15m"]) % tokens.length;

  for (let i = 0; i < tokens.length; i++) {
    options.jobSignal.throwIfAborted();
    const token = tokens[(offset + i) % tokens.length]!;
    const obs = byToken.get(token)!;
    // A series never changes endpoint: the old open bars are dropped with it, and the old closed record is replaced at the next close.
    const stored = state.tokens[token];
    const entry = stored !== undefined && stored.endpoint === obs.endpoint ? stored : undefined;
    const closes = closing(entry, options.observedAt);
    if (closes.length > 0) {
      if (options.deadline.aborted) {
        result.deferred += 1;
        continue;
      }
      result.storeOps += 2;
      await appendClosed(store, obs, obs.endpoint, closes);
      result.closes += 1;
      if (closes.some((close) => close.interval === "15m")) result.closes15m += 1;
    }
    state.tokens[token] = applyObservation(entry, obs, options.observedAt);
  }

  options.jobSignal.throwIfAborted();
  result.storeOps += 1;
  if (!await store.acquireSchedulerLease(REFERENCE_BARS_LEASE, options.holder, REFERENCE_BARS_LEASE_TTL_MS)) {
    return finish({ ...result, reason: "lease_lost" });
  }
  result.storeOps += 1;
  await store.put(REFERENCE_BARS_OPEN_KEY, state, { source: SOURCE, freshForMs: 300_000, deadAfterMs: REFERENCE_RETENTION_MS });
  result.recorded = true;
  return finish();

  function finish(next: RecorderResult = result): RecorderResult {
    return { ...next, deadlineFired: options.deadline.aborted, ms: clock() - started };
  }
}
