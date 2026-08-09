import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { MemoryStore, computeStaleness, createStore } from "../src/core/store.js";
import type { JobHealth } from "../src/core/types.js";

/** Manually advanced clock so TTL transitions are deterministic. */
function fakeClock(start = 1_000_000) {
  let value = start;
  return {
    now: (): number => value,
    advance(ms: number): void {
      value += ms;
    },
  };
}

describe("computeStaleness", () => {
  it("classifies by age against the fresh/dead thresholds", () => {
    assert.equal(computeStaleness(0, 0, 100, 300), "fresh");
    assert.equal(computeStaleness(0, 99, 100, 300), "fresh");
    assert.equal(computeStaleness(0, 100, 100, 300), "stale");
    assert.equal(computeStaleness(0, 299, 100, 300), "stale");
    assert.equal(computeStaleness(0, 300, 100, 300), "dead");
    assert.equal(computeStaleness(0, 10_000, 100, 300), "dead");
  });
});

describe("MemoryStore snapshots", () => {
  it("transitions fresh -> stale -> dead as the clock advances", async () => {
    const clock = fakeClock();
    const store = new MemoryStore(clock.now);

    await store.put("token:0xabc", { price: 1.5 }, { source: "test", freshForMs: 100, deadAfterMs: 300 });

    const fresh = await store.get<{ price: number }>("token:0xabc");
    assert.ok(fresh);
    assert.equal(fresh.staleness, "fresh");
    assert.equal(fresh.data.price, 1.5);
    assert.equal(fresh.source, "test");
    assert.equal(fresh.asOf, 1_000_000);

    clock.advance(150);
    const stale = await store.get<{ price: number }>("token:0xabc");
    assert.ok(stale);
    assert.equal(stale.staleness, "stale");
    assert.equal(stale.asOf, 1_000_000, "asOf must reflect capture time, not read time");

    clock.advance(200);
    const dead = await store.get<{ price: number }>("token:0xabc");
    assert.ok(dead);
    assert.equal(dead.staleness, "dead");

    await store.close();
  });

  it("returns null for unknown keys", async () => {
    const store = new MemoryStore();
    assert.equal(await store.get("missing"), null);
    await store.close();
  });

  it("overwrites an existing key and resets its age", async () => {
    const clock = fakeClock();
    const store = new MemoryStore(clock.now);

    await store.put("k", { n: 1 }, { source: "a", freshForMs: 100, deadAfterMs: 300 });
    clock.advance(500);
    const dead = await store.get<{ n: number }>("k");
    assert.equal(dead?.staleness, "dead");

    await store.put("k", { n: 2 }, { source: "b", freshForMs: 100, deadAfterMs: 300 });
    const refreshed = await store.get<{ n: number }>("k");
    assert.equal(refreshed?.staleness, "fresh");
    assert.equal(refreshed?.data.n, 2);
    assert.equal(refreshed?.source, "b");

    await store.close();
  });

  it("does not alias the caller's payload", async () => {
    const store = new MemoryStore();
    const payload = { nested: { n: 1 } };
    await store.put("k", payload, { source: "test", freshForMs: 1_000, deadAfterMs: 2_000 });
    payload.nested.n = 99;

    const record = await store.get<{ nested: { n: number } }>("k");
    assert.equal(record?.data.nested.n, 1);
    await store.close();
  });
});

describe("MemoryStore job health", () => {
  it("upserts by job name and returns copies sorted by name", async () => {
    const store = new MemoryStore();
    const base: JobHealth = {
      job: "b-job",
      lastOkAt: 1,
      lastErrorAt: null,
      lastError: null,
      lastLatencyMs: 5,
      consecutiveFailures: 0,
    };

    await store.putJobHealth(base);
    await store.putJobHealth({ ...base, job: "a-job" });
    await store.putJobHealth({ ...base, lastOkAt: 2, lastLatencyMs: 7 });

    const health = await store.getJobHealth();
    assert.deepEqual(
      health.map((h) => h.job),
      ["a-job", "b-job"],
    );
    assert.equal(health[1]?.lastOkAt, 2);
    assert.equal(health[1]?.lastLatencyMs, 7);

    await store.close();
  });

  it("trims stored error messages to 300 characters", async () => {
    const store = new MemoryStore();
    await store.putJobHealth({
      job: "noisy",
      lastOkAt: null,
      lastErrorAt: 1,
      lastError: "x".repeat(1_000),
      lastLatencyMs: null,
      consecutiveFailures: 1,
    });

    const [health] = await store.getJobHealth();
    assert.equal(health?.lastError?.length, 300);
    await store.close();
  });
});

describe("createStore", () => {
  const previous = process.env["DATABASE_URL"];

  after(() => {
    if (previous === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previous;
  });

  it("falls back to the in-memory store when DATABASE_URL is absent", async () => {
    delete process.env["DATABASE_URL"];
    const store = await createStore();
    assert.ok(store instanceof MemoryStore);
    await store.close();
  });

  it("treats a blank DATABASE_URL as absent", async () => {
    process.env["DATABASE_URL"] = "   ";
    const store = await createStore();
    assert.ok(store instanceof MemoryStore);
    await store.close();
  });
});
