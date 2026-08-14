// `pg` is CommonJS and does not expose statically analysable named exports, so
// the runtime value comes from the default import while types come from `type`.
import pgPkg from "pg";
import type { QueryResultRow } from "pg";
import type { DataRecord, JobHealth, Staleness } from "./types.js";

const { Pool: PgPool } = pgPkg;

/** Retention policy applied to a single snapshot write. */
export interface PutOptions {
  /** Identifier of the producer writing the payload. */
  source: string;
  /** Age (ms) below which the snapshot is considered `fresh`. */
  freshForMs: number;
  /** Age (ms) at or above which the snapshot is considered `dead`. */
  deadAfterMs: number;
}

/**
 * Persistence boundary of the data plane. Implementations must be safe to call
 * concurrently and must never throw for a missing key (they return null).
 */
export interface SnapshotStore {
  put(key: string, payload: unknown, opts: PutOptions): Promise<void>;
  get<T>(key: string): Promise<DataRecord<T> | null>;
  putJobHealth(h: JobHealth): Promise<void>;
  getJobHealth(): Promise<JobHealth[]>;
  close(): Promise<void>;
}

/** Injectable time source; defaults to `Date.now` everywhere. */
export type Clock = () => number;

/**
 * Freshness is never stored, only derived: a snapshot ages into `stale` and then
 * `dead` purely as a function of how long ago it was captured.
 */
export function computeStaleness(
  asOf: number,
  now: number,
  freshForMs: number,
  deadAfterMs: number,
): Staleness {
  const ageMs = now - asOf;
  if (ageMs >= deadAfterMs) return "dead";
  if (ageMs >= freshForMs) return "stale";
  return "fresh";
}

const MAX_ERROR_CHARS = 300;

function toEpochMs(value: Date | null): number | null {
  return value === null ? null : value.getTime();
}

function toDate(value: number | null): Date | null {
  return value === null ? null : new Date(value);
}

interface MemoryEntry {
  payload: unknown;
  asOf: number;
  source: string;
  freshForMs: number;
  deadAfterMs: number;
}

/**
 * Process-local store. Used for local development and tests so neither needs a
 * live Postgres. State is lost on restart, by design.
 */
export class MemoryStore implements SnapshotStore {
  readonly #snapshots = new Map<string, MemoryEntry>();
  readonly #jobHealth = new Map<string, JobHealth>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  async put(key: string, payload: unknown, opts: PutOptions): Promise<void> {
    this.#snapshots.set(key, {
      payload: structuredClone(payload),
      asOf: this.#now(),
      source: opts.source,
      freshForMs: opts.freshForMs,
      deadAfterMs: opts.deadAfterMs,
    });
  }

  async get<T>(key: string): Promise<DataRecord<T> | null> {
    const entry = this.#snapshots.get(key);
    if (entry === undefined) return null;
    return {
      data: structuredClone(entry.payload) as T,
      asOf: entry.asOf,
      source: entry.source,
      staleness: computeStaleness(entry.asOf, this.#now(), entry.freshForMs, entry.deadAfterMs),
    };
  }

  async putJobHealth(h: JobHealth): Promise<void> {
    this.#jobHealth.set(h.job, { ...h, lastError: h.lastError?.slice(0, MAX_ERROR_CHARS) ?? null });
  }

  async getJobHealth(): Promise<JobHealth[]> {
    return [...this.#jobHealth.values()]
      .map((h) => ({ ...h }))
      .sort((a, b) => a.job.localeCompare(b.job));
  }

  async close(): Promise<void> {
    this.#snapshots.clear();
    this.#jobHealth.clear();
  }
}

interface SnapshotRow {
  payload: unknown;
  as_of: Date;
  source: string;
  /**
   * `bigint` on the wire, which `pg` hands back as a string rather than risk a
   * silent precision loss. Coerced at the one place it is read.
   */
  fresh_for_ms: number | string;
  dead_after_ms: number | string;
}

interface JobHealthRow {
  job: string;
  last_ok_at: Date | null;
  last_error_at: Date | null;
  last_error: string | null;
  last_latency_ms: number | null;
  consecutive_failures: number;
}

const SNAPSHOT_DDL = `
  create table if not exists dp_snapshots (
    key text primary key,
    payload jsonb not null,
    as_of timestamptz not null,
    source text not null,
    fresh_for_ms bigint not null,
    dead_after_ms bigint not null,
    updated_at timestamptz not null default now()
  )
`;

/**
 * Widens the retention columns on a table created before they were `bigint`.
 *
 * They were `int`, which caps a TTL at 24.8 days in milliseconds — and a caller
 * writing a longer one got a rejected insert rather than a clamped value. The
 * launchpad-origin cache, whose whole design is that a verdict is permanent, hit
 * exactly that: every write failed against Postgres while passing every test,
 * because the tests run on the in-memory store. Idempotent, and a no-op once the
 * columns are already wide.
 */
const SNAPSHOT_MIGRATION_DDL = `
  alter table dp_snapshots
    alter column fresh_for_ms type bigint,
    alter column dead_after_ms type bigint
`;

const JOB_HEALTH_DDL = `
  create table if not exists dp_job_health (
    job text primary key,
    last_ok_at timestamptz,
    last_error_at timestamptz,
    last_error text,
    last_latency_ms int,
    consecutive_failures int not null default 0,
    updated_at timestamptz not null default now()
  )
`;

/**
 * The slice of `pg.Pool` this store actually uses.
 *
 * Declared as its own interface so the store can be handed a stand-in. Every
 * other upstream in this codebase is injectable — adapters take `fetchFn`, chain
 * reads take `rpcUrls` — and Postgres was the one exception, which is precisely
 * why it was also the one path with no tests, and where a production-only bug
 * survived a green suite.
 */
export interface SqlClient {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

export interface PostgresStoreOptions {
  now?: Clock;
  /** Overrides the real connection pool. Tests supply a fake. */
  client?: SqlClient;
}

/**
 * Durable store backed by Postgres. Construct via {@link PostgresStore.create}
 * so the idempotent DDL runs before the instance is handed out.
 */
export class PostgresStore implements SnapshotStore {
  readonly #pool: SqlClient;
  readonly #now: Clock;

  private constructor(pool: SqlClient, now: Clock) {
    this.#pool = pool;
    this.#now = now;
  }

  static async create(
    connectionString: string,
    options: PostgresStoreOptions = {},
  ): Promise<PostgresStore> {
    const pool: SqlClient = options.client ?? new PgPool({ connectionString });
    try {
      await pool.query(SNAPSHOT_DDL);
      await pool.query(SNAPSHOT_MIGRATION_DDL);
      await pool.query(JOB_HEALTH_DDL);
    } catch (error) {
      // The pool is closed rather than left dangling: `create` is the only path
      // that owns it, so a caller that never receives the store cannot close it.
      await pool.end();
      throw error;
    }
    return new PostgresStore(pool, options.now ?? Date.now);
  }

  async put(key: string, payload: unknown, opts: PutOptions): Promise<void> {
    const json = JSON.stringify(payload ?? null) ?? "null";
    await this.#pool.query(
      `insert into dp_snapshots (key, payload, as_of, source, fresh_for_ms, dead_after_ms, updated_at)
       values ($1, $2::jsonb, $3, $4, $5, $6, now())
       on conflict (key) do update set
         payload = excluded.payload,
         as_of = excluded.as_of,
         source = excluded.source,
         fresh_for_ms = excluded.fresh_for_ms,
         dead_after_ms = excluded.dead_after_ms,
         updated_at = now()`,
      [key, json, new Date(this.#now()), opts.source, opts.freshForMs, opts.deadAfterMs],
    );
  }

  async get<T>(key: string): Promise<DataRecord<T> | null> {
    const result = await this.#pool.query<SnapshotRow>(
      `select payload, as_of, source, fresh_for_ms, dead_after_ms
       from dp_snapshots
       where key = $1`,
      [key],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const asOf = row.as_of.getTime();
    return {
      data: row.payload as T,
      asOf,
      source: row.source,
      staleness: computeStaleness(
        asOf,
        this.#now(),
        Number(row.fresh_for_ms),
        Number(row.dead_after_ms),
      ),
    };
  }

  async putJobHealth(h: JobHealth): Promise<void> {
    await this.#pool.query(
      `insert into dp_job_health
         (job, last_ok_at, last_error_at, last_error, last_latency_ms, consecutive_failures, updated_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (job) do update set
         last_ok_at = excluded.last_ok_at,
         last_error_at = excluded.last_error_at,
         last_error = excluded.last_error,
         last_latency_ms = excluded.last_latency_ms,
         consecutive_failures = excluded.consecutive_failures,
         updated_at = now()`,
      [
        h.job,
        toDate(h.lastOkAt),
        toDate(h.lastErrorAt),
        h.lastError?.slice(0, MAX_ERROR_CHARS) ?? null,
        h.lastLatencyMs,
        h.consecutiveFailures,
      ],
    );
  }

  async getJobHealth(): Promise<JobHealth[]> {
    const result = await this.#pool.query<JobHealthRow>(
      `select job, last_ok_at, last_error_at, last_error, last_latency_ms, consecutive_failures
       from dp_job_health
       order by job asc`,
    );
    return result.rows.map((row) => ({
      job: row.job,
      lastOkAt: toEpochMs(row.last_ok_at),
      lastErrorAt: toEpochMs(row.last_error_at),
      lastError: row.last_error,
      lastLatencyMs: row.last_latency_ms,
      consecutiveFailures: row.consecutive_failures,
    }));
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

/**
 * Picks the durable store when `DATABASE_URL` is configured, otherwise the
 * in-memory one. The connection string is never logged.
 */
export async function createStore(): Promise<SnapshotStore> {
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const store = await PostgresStore.create(connectionString);
    console.log("[store] backend=postgres");
    return store;
  }
  console.log("[store] backend=memory (DATABASE_URL not set)");
  return new MemoryStore();
}
