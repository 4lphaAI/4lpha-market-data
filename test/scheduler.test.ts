import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import type { JobHealth } from "../src/core/types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function healthOf(snapshot: JobHealth[], job: string): JobHealth {
  const found = snapshot.find((h) => h.job === job);
  assert.ok(found, `expected health for job ${job}`);
  return found;
}

describe("scheduler success path", () => {
  it("runs the job, records latency and persists health", async () => {
    const store = new MemoryStore();
    const scheduler = createScheduler(store);
    let runs = 0;

    scheduler.register({
      name: "ok-job",
      intervalMs: 20,
      timeoutMs: 500,
      run: async () => {
        runs += 1;
      },
    });

    scheduler.start();
    await sleep(70);
    await scheduler.stop();

    assert.ok(runs >= 2, `expected repeated runs, got ${runs}`);

    const health = healthOf(scheduler.healthSnapshot(), "ok-job");
    assert.equal(health.consecutiveFailures, 0);
    assert.equal(health.lastError, null);
    assert.ok(health.lastOkAt !== null);
    assert.ok(health.lastLatencyMs !== null && health.lastLatencyMs >= 0);

    const persisted = await store.getJobHealth();
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.job, "ok-job");
    assert.equal(persisted[0]?.consecutiveFailures, 0);

    await store.close();
  });

  it("returns copies from healthSnapshot", async () => {
    const store = new MemoryStore();
    const scheduler = createScheduler(store);
    scheduler.register({ name: "snap", intervalMs: 20, timeoutMs: 200, run: async () => {} });
    scheduler.start();
    await sleep(40);
    await scheduler.stop();

    const first = healthOf(scheduler.healthSnapshot(), "snap");
    first.consecutiveFailures = 999;
    assert.equal(healthOf(scheduler.healthSnapshot(), "snap").consecutiveFailures, 0);

    await store.close();
  });
});

describe("scheduler failure path", () => {
  it("counts consecutive failures and trims the error message", async () => {
    const store = new MemoryStore();
    const scheduler = createScheduler(store);

    scheduler.register({
      name: "bad-job",
      intervalMs: 20,
      timeoutMs: 500,
      run: async () => {
        throw new Error("boom".repeat(200));
      },
    });

    scheduler.start();
    await sleep(70);
    await scheduler.stop();

    const health = healthOf(scheduler.healthSnapshot(), "bad-job");
    assert.ok(health.consecutiveFailures >= 2, `expected >= 2 failures, got ${health.consecutiveFailures}`);
    assert.equal(health.lastOkAt, null);
    assert.ok(health.lastErrorAt !== null);
    assert.equal(health.lastError?.length, 300);

    await store.close();
  });

  it("resets consecutiveFailures after a success", async () => {
    const store = new MemoryStore();
    const scheduler = createScheduler(store);
    let attempt = 0;

    scheduler.register({
      name: "flaky",
      intervalMs: 20,
      timeoutMs: 500,
      run: async () => {
        attempt += 1;
        if (attempt <= 2) throw new Error("transient");
      },
    });

    scheduler.start();
    await sleep(120);
    await scheduler.stop();

    const health = healthOf(scheduler.healthSnapshot(), "flaky");
    assert.ok(attempt >= 3, `expected >= 3 attempts, got ${attempt}`);
    assert.equal(health.consecutiveFailures, 0);
    assert.ok(health.lastOkAt !== null);
    assert.equal(health.lastError, "transient", "history of the last error is retained");
  });

  it("keeps other jobs running when one job always fails", async () => {
    const store = new MemoryStore();
    const scheduler = createScheduler(store);
    let healthyRuns = 0;

    scheduler.register({
      name: "always-fails",
      intervalMs: 15,
      timeoutMs: 500,
      run: async () => {
        throw new Error("nope");
      },
    });
    scheduler.register({
      name: "healthy",
      intervalMs: 15,
      timeoutMs: 500,
      run: async () => {
        healthyRuns += 1;
      },
    });

    scheduler.start();
    await sleep(80);
    await scheduler.stop();

    assert.ok(healthyRuns >= 2, `expected healthy job to keep running, got ${healthyRuns}`);
    assert.ok(healthOf(scheduler.healthSnapshot(), "always-fails").consecutiveFailures >= 2);
    assert.equal(healthOf(scheduler.healthSnapshot(), "healthy").consecutiveFailures, 0);

    await store.close();
  });
});

describe("scheduler timeouts", () => {
  it("fails a run that exceeds timeoutMs and keeps scheduling", async () => {
    const store = new MemoryStore();
    const scheduler = createScheduler(store);
    let starts = 0;

    scheduler.register({
      name: "hangs",
      intervalMs: 30,
      timeoutMs: 20,
      run: () => {
        starts += 1;
        // Never settles: only the scheduler's timeout can end this run.
        return new Promise<void>(() => {});
      },
    });

    scheduler.start();
    await sleep(120);
    await scheduler.stop();

    const health = healthOf(scheduler.healthSnapshot(), "hangs");
    assert.ok(starts >= 2, `expected the job to be retried, got ${starts} starts`);
    assert.ok(health.consecutiveFailures >= 2);
    assert.match(health.lastError ?? "", /timed out after 20ms/);

    await store.close();
  });
});

describe("scheduler overlap protection", () => {
  it("skips a tick while the previous run is still in flight", async () => {
    const store = new MemoryStore();
    const scheduler = createScheduler(store);
    let concurrent = 0;
    let maxConcurrent = 0;
    let completed = 0;

    scheduler.register({
      name: "slow",
      intervalMs: 10,
      timeoutMs: 1_000,
      run: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(60);
        concurrent -= 1;
        completed += 1;
      },
    });

    scheduler.start();
    await sleep(150);
    await scheduler.stop();

    assert.equal(maxConcurrent, 1, "runs must never overlap");
    assert.ok(completed <= 3, `expected ticks to be skipped, got ${completed} completions`);
    assert.ok(completed >= 1);

    await store.close();
  });
});

describe("scheduler lifecycle", () => {
  it("stop() clears timers and waits for the in-flight run", async () => {
    const store = new MemoryStore();
    const scheduler = createScheduler(store);
    let finished = false;
    let starts = 0;

    scheduler.register({
      name: "inflight",
      intervalMs: 20,
      timeoutMs: 1_000,
      run: async () => {
        starts += 1;
        await sleep(50);
        finished = true;
      },
    });

    scheduler.start();
    await sleep(10);
    await scheduler.stop();

    assert.equal(finished, true, "stop() must await the in-flight run");
    const startsAtStop = starts;
    await sleep(60);
    assert.equal(starts, startsAtStop, "no further runs after stop()");

    await store.close();
  });

  it("rejects duplicate job names and invalid timings", () => {
    const store = new MemoryStore();
    const scheduler = createScheduler(store);
    const spec = { name: "dup", intervalMs: 10, timeoutMs: 10, run: async () => {} };

    scheduler.register(spec);
    assert.throws(() => {
      scheduler.register(spec);
    }, /already registered/);
    assert.throws(() => {
      scheduler.register({ ...spec, name: "bad-interval", intervalMs: 0 });
    }, /intervalMs/);
    assert.throws(() => {
      scheduler.register({ ...spec, name: "bad-timeout", timeoutMs: 0 });
    }, /timeoutMs/);
  });

  it("applies jitter within the configured bound", async () => {
    const store = new MemoryStore();
    const scheduler = createScheduler(store, { random: () => 0.5 });
    const startedAt = Date.now();
    let firstRunAt: number | null = null;

    scheduler.register({
      name: "jittered",
      intervalMs: 1_000,
      jitterMs: 40,
      timeoutMs: 500,
      run: async () => {
        firstRunAt ??= Date.now();
      },
    });

    scheduler.start();
    await sleep(120);
    await scheduler.stop();

    assert.ok(firstRunAt !== null, "first run should fire after jitter only");
    assert.ok(firstRunAt - startedAt >= 15, "jitter should delay the first run");

    await store.close();
  });
});
