import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import { createServer } from "../src/server.js";
import type { JobHealth } from "../src/core/types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows the `{ data }` envelope without resorting to `any`. */
function envelopeData(body: unknown): Record<string, unknown> {
  assert.ok(isRecord(body), "response body must be an object");
  const data = body["data"];
  assert.ok(isRecord(data), "response must carry a `data` object");
  return data;
}

describe("GET /health", () => {
  it("returns ok with uptime inside the data envelope", async () => {
    const store = new MemoryStore();
    const app = createServer({ scheduler: createScheduler(store), store });

    const res = await app.request("/health");
    assert.equal(res.status, 200);

    const data = envelopeData(await res.json());
    assert.equal(data["ok"], true);
    assert.equal(typeof data["uptimeSec"], "number");
    assert.ok((data["uptimeSec"] as number) >= 0);

    await store.close();
  });
});

describe("GET /status", () => {
  it("reports startedAt and an empty job list before anything runs", async () => {
    const store = new MemoryStore();
    const app = createServer({ scheduler: createScheduler(store), store });

    const res = await app.request("/status");
    assert.equal(res.status, 200);

    const data = envelopeData(await res.json());
    assert.deepEqual(data["jobs"], []);
    assert.equal(typeof data["startedAt"], "number");

    await store.close();
  });

  it("exposes job health once the scheduler has run", async () => {
    const store = new MemoryStore();
    const scheduler = createScheduler(store);
    scheduler.register({ name: "probe", intervalMs: 20, timeoutMs: 200, run: async () => {} });
    const app = createServer({ scheduler, store });

    scheduler.start();
    await sleep(40);
    await scheduler.stop();

    const data = envelopeData(await (await app.request("/status")).json());
    const jobs = data["jobs"];
    assert.ok(Array.isArray(jobs));
    assert.equal(jobs.length, 1);

    const [job] = jobs as JobHealth[];
    assert.equal(job?.job, "probe");
    assert.equal(job?.consecutiveFailures, 0);
    assert.ok(job?.lastOkAt !== null);

    await store.close();
  });
});

describe("unknown routes", () => {
  it("returns a 404 error envelope", async () => {
    const store = new MemoryStore();
    const app = createServer({ scheduler: createScheduler(store), store });

    const res = await app.request("/does-not-exist");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: { code: "not_found" } });

    await store.close();
  });

  it("returns a 404 envelope for an unsupported method on a known path", async () => {
    const store = new MemoryStore();
    const app = createServer({ scheduler: createScheduler(store), store });

    const res = await app.request("/health", { method: "POST" });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: { code: "not_found" } });

    await store.close();
  });
});
