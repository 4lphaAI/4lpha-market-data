import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PostgresStore } from "../src/core/store.js";
import { FakePg, type FakePgOptions } from "./fakePg.js";

/** The window that broke production: 30 days in milliseconds. */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;
const ONE_YEAR_MS = 365 * 24 * 60 * 60_000;

const TTL = { source: "test", freshForMs: 60_000, deadAfterMs: 600_000 };

async function build(
  options: FakePgOptions & { now?: () => number } = {},
): Promise<{ store: PostgresStore; pg: FakePg }> {
  const pg = new FakePg(options.failOn === undefined ? {} : { failOn: options.failOn });
  const store = await PostgresStore.create("postgres://unused", {
    client: pg,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { store, pg };
}

describe("PostgresStore schema", () => {
  it("creates both tables and widens the retention columns", async () => {
    const { pg } = await build();
    assert.equal(pg.columnType("dp_snapshots", "fresh_for_ms"), "bigint");
    assert.equal(pg.columnType("dp_snapshots", "dead_after_ms"), "bigint");
    assert.equal(pg.columnType("dp_snapshots", "payload"), "jsonb");
    assert.equal(pg.columnType("dp_job_health", "consecutive_failures"), "int");
  });

  it("runs the migration before the store is handed out", async () => {
    const { pg } = await build();
    const create = pg.queries.findIndex((q) => q.startsWith("create table if not exists dp_snapshots"));
    const alter = pg.queries.findIndex((q) => q.startsWith("alter table dp_snapshots"));
    assert.ok(create >= 0 && alter > create, pg.queries.join(" | "));
  });

  it("stores a retention window no int column could have held", async () => {
    // The exact write Postgres rejected in production, with the exact message.
    const { store, pg } = await build();
    await store.put("origins:launchpad", { "0xabc": "fourmeme" }, {
      source: "pool-tier",
      freshForMs: THIRTY_DAYS_MS,
      deadAfterMs: ONE_YEAR_MS,
    });

    const record = await store.get<Record<string, string>>("origins:launchpad");
    assert.equal(record?.staleness, "fresh");
    assert.deepEqual(record?.data, { "0xabc": "fourmeme" });
    assert.equal(pg.rowCount("dp_snapshots"), 1);
  });

  it("would have caught the bug: an int column rejects the same window", async () => {
    // Proof the fake is load-bearing rather than permissive — with the columns
    // left as they were, the write fails the way the deployment did.
    const pg = new FakePg();
    await pg.query(
      "create table if not exists dp_snapshots (key text primary key, payload jsonb not null," +
        " as_of timestamptz not null, source text not null, fresh_for_ms int not null," +
        " dead_after_ms int not null, updated_at timestamptz not null default now())",
    );
    await assert.rejects(
      () =>
        pg.query(
          "insert into dp_snapshots (key, payload, as_of, source, fresh_for_ms, dead_after_ms," +
            " updated_at) values ($1, $2::jsonb, $3, $4, $5, $6, now())",
          ["k", "{}", new Date(), "s", THIRTY_DAYS_MS, ONE_YEAR_MS],
        ),
      /value "2592000000" is out of range for type integer/u,
    );
  });

  it("closes the pool when the schema cannot be prepared", async () => {
    const pg = new FakePg({
      failOn: (sql) => (sql.startsWith("alter table") ? new Error("permission denied") : null),
    });
    await assert.rejects(
      () => PostgresStore.create("postgres://unused", { client: pg }),
      /permission denied/u,
    );
    // A caller that never receives the store cannot close it, so `create` must.
    assert.equal(pg.ended, true);
  });
});

describe("PostgresStore snapshots", () => {
  it("round-trips a payload with its source and age", async () => {
    let now = 1_000_000;
    const { store } = await build({ now: () => now });
    await store.put("universe:pools", [{ pool: "0x1" }], TTL);

    now += 1_000;
    const record = await store.get<Array<{ pool: string }>>("universe:pools");
    assert.deepEqual(record?.data, [{ pool: "0x1" }]);
    assert.equal(record?.source, "test");
    assert.equal(record?.asOf, 1_000_000);
    assert.equal(record?.staleness, "fresh");
  });

  it("coerces the retention columns pg hands back as strings", async () => {
    // node-postgres returns bigint as a string to avoid losing precision past
    // 2^53. Compared as text, "600000" < "60000" is false and every record
    // would age wrongly — a conversion no MemoryStore test can exercise.
    let now = 1_000_000;
    const { store, pg } = await build({ now: () => now });
    await store.put("k", { v: 1 }, TTL);

    const raw = await pg.query<{ fresh_for_ms: unknown }>(
      "select fresh_for_ms from dp_snapshots where key = $1",
      ["k"],
    );
    assert.equal(typeof raw.rows[0]?.fresh_for_ms, "string");

    now += 120_000;
    assert.equal((await store.get("k"))?.staleness, "stale");
    now += 600_000;
    assert.equal((await store.get("k"))?.staleness, "dead");
  });

  it("overwrites a key instead of raising a duplicate", async () => {
    const { store, pg } = await build();
    await store.put("k", { v: 1 }, TTL);
    await store.put("k", { v: 2 }, TTL);
    assert.equal(pg.rowCount("dp_snapshots"), 1);
    assert.deepEqual((await store.get<{ v: number }>("k"))?.data, { v: 2 });
  });

  it("returns null for a key that was never written", async () => {
    const { store } = await build();
    assert.equal(await store.get("nothing"), null);
  });

  it("stores null as a payload rather than dropping the row", async () => {
    const { store } = await build();
    await store.put("k", null, TTL);
    const record = await store.get("k");
    assert.notEqual(record, null);
    assert.equal(record?.data, null);
  });
});

describe("PostgresStore job health", () => {
  const health = {
    job: "pancake-pools",
    lastOkAt: 1_700_000_000_000,
    lastErrorAt: null,
    lastError: null,
    lastLatencyMs: 1_750,
    consecutiveFailures: 0,
  };

  it("round-trips a job's health, sorted by name", async () => {
    const { store } = await build();
    await store.putJobHealth({ ...health, job: "venus-health" });
    await store.putJobHealth(health);

    const rows = await store.getJobHealth();
    assert.deepEqual(
      rows.map((r) => r.job),
      ["pancake-pools", "venus-health"],
    );
    assert.equal(rows[0]?.lastOkAt, 1_700_000_000_000);
    assert.equal(rows[0]?.lastLatencyMs, 1_750);
  });

  it("keeps an absent timestamp absent rather than turning it into an epoch", async () => {
    const { store } = await build();
    await store.putJobHealth({ ...health, lastOkAt: null });
    const [row] = await store.getJobHealth();
    assert.equal(row?.lastOkAt, null);
    assert.equal(row?.lastError, null);
  });

  it("trims a long error to what the column is meant to hold", async () => {
    const { store } = await build();
    await store.putJobHealth({ ...health, lastError: "x".repeat(500) });
    const [row] = await store.getJobHealth();
    assert.equal(row?.lastError?.length, 300);
  });

  it("upserts by job name", async () => {
    const { store, pg } = await build();
    await store.putJobHealth({ ...health, consecutiveFailures: 0 });
    await store.putJobHealth({ ...health, consecutiveFailures: 3 });
    assert.equal(pg.rowCount("dp_job_health"), 1);
    assert.equal((await store.getJobHealth())[0]?.consecutiveFailures, 3);
  });

  it("closes the pool on close", async () => {
    const { store, pg } = await build();
    await store.close();
    assert.equal(pg.ended, true);
  });
});

describe("PostgresStore tracking references and leases", () => {
  it("enforces the distinct-subject cap while allowing another reference", async () => {
    const { store } = await build();
    assert.deepEqual(await store.addTrackingReference("venus-core", "0x01", "agent-a", 1), {
      accepted: true,
      created: true,
      referenceCount: 1,
    });
    assert.deepEqual(await store.addTrackingReference("venus-core", "0x01", "agent-b", 1), {
      accepted: true,
      created: true,
      referenceCount: 2,
    });
    assert.deepEqual(await store.addTrackingReference("venus-core", "0x02", "agent-a", 1), {
      accepted: false,
      created: false,
      referenceCount: 0,
    });
    assert.deepEqual(await store.listTrackedSubjects("venus-core"), ["0x01"]);
  });

  it("removes only the named reference and drops the subject after the last", async () => {
    const { store } = await build();
    await store.addTrackingReference("venus-core", "0x01", "a", 10);
    await store.addTrackingReference("venus-core", "0x01", "b", 10);
    assert.deepEqual(await store.removeTrackingReference("venus-core", "0x01", "a"), {
      removed: true,
      referenceCount: 1,
    });
    assert.deepEqual(await store.removeTrackingReference("venus-core", "0x01", "b"), {
      removed: true,
      referenceCount: 0,
    });
    assert.deepEqual(await store.listTrackedSubjects("venus-core"), []);
  });

  it("holds a lease against another replica until it expires", async () => {
    let now = 1_000_000;
    const { store } = await build({ now: () => now });
    assert.equal(await store.acquireSchedulerLease("venus", "replica-a", 10_000), true);
    assert.equal(await store.acquireSchedulerLease("venus", "replica-b", 10_000), false);
    now += 10_001;
    assert.equal(await store.acquireSchedulerLease("venus", "replica-b", 10_000), true);
  });
});
