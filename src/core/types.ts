/**
 * Core domain types for the data plane.
 *
 * Everything here is transport-agnostic: the store, the scheduler and the HTTP
 * layer all speak these shapes.
 */

/** How usable a stored snapshot is, derived from its age at read time. */
export type Staleness = "fresh" | "stale" | "dead";

/** A snapshot read out of the store, annotated with provenance and freshness. */
export interface DataRecord<T> {
  data: T;
  /** Epoch milliseconds at which the payload was captured. */
  asOf: number;
  /** Identifier of the producer that wrote the payload. */
  source: string;
  staleness: Staleness;
}

/** Declaration of a recurring background job. */
export interface JobSpec {
  name: string;
  /** Base delay between runs, in milliseconds. */
  intervalMs: number;
  /** Optional upper bound of extra random delay added to each interval. */
  jitterMs?: number;
  /** Maximum wall-clock time a single run may take before it is failed. */
  timeoutMs: number;
  run: () => Promise<void>;
}

/** Rolling health of a registered job. */
export interface JobHealth {
  job: string;
  /** Epoch milliseconds of the last successful run, or null if none yet. */
  lastOkAt: number | null;
  /** Epoch milliseconds of the last failed run, or null if none yet. */
  lastErrorAt: number | null;
  /** Message of the last failure, trimmed for storage, or null if none yet. */
  lastError: string | null;
  /** Duration of the most recent run attempt, in milliseconds. */
  lastLatencyMs: number | null;
  /** Failures since the last success. Reset to 0 on every success. */
  consecutiveFailures: number;
}
