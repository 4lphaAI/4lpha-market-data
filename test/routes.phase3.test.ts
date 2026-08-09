import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import { createServer } from "../src/server.js";
import { emptyTokenSnapshot } from "../src/core/models.js";
import { tokenKey } from "../src/jobs/tokenStore.js";
import { MEME_UNIVERSE_KEY } from "../src/universe.js";

const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const TSLAB = "0x5b1910eaad6450e50f816082aa078c41f10c292f";

function build(): { app: ReturnType<typeof createServer>; store: MemoryStore } {
  const store = new MemoryStore();
  const app = createServer({ scheduler: createScheduler(store), store });
  return { app, store };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function putToken(store: MemoryStore, address: string, priceUsd: number): Promise<void> {
  await store.put(
    tokenKey(address),
    { ...emptyTokenSnapshot(address), priceUsd },
    { source: "test", freshForMs: 60_000, deadAfterMs: 900_000 },
  );
}

describe("GET /tokens (batch)", () => {
  it("returns stored snapshots with staleness and counts the misses", async () => {
    const { app, store } = build();
    await putToken(store, NVDAB, 225);

    const res = await app.request(`/tokens?addresses=${NVDAB},${TSLAB}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as unknown;
    assert.ok(isRecord(body));
    const data = body["data"];
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 1);
    const first = data[0] as Record<string, unknown>;
    assert.equal(first["address"], NVDAB);
    assert.equal(first["priceUsd"], 225);
    assert.equal(first["staleness"], "fresh");
    assert.deepEqual(body["meta"], { requested: 2, found: 1, missing: 1 });
  });

  it("reports invalid addresses in meta without failing the batch", async () => {
    const { app, store } = build();
    await putToken(store, NVDAB, 225);

    const res = await app.request(`/tokens?addresses=${NVDAB},notanaddress`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as unknown;
    assert.ok(isRecord(body));
    const meta = body["meta"] as Record<string, unknown>;
    assert.deepEqual(meta["invalid"], ["notanaddress"]);
    assert.equal(meta["found"], 1);
  });

  it("deduplicates repeated addresses", async () => {
    const { app, store } = build();
    await putToken(store, NVDAB, 225);

    const res = await app.request(`/tokens?addresses=${NVDAB},${NVDAB.toUpperCase().replace("0X", "0x")}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as unknown;
    assert.ok(isRecord(body));
    assert.equal((body["data"] as unknown[]).length, 1);
    const meta = body["meta"] as Record<string, unknown>;
    assert.equal(meta["missing"], 0);
  });

  it("rejects a missing addresses parameter", async () => {
    const { app } = build();
    const res = await app.request("/tokens");
    assert.equal(res.status, 400);
    const body = (await res.json()) as unknown;
    assert.ok(isRecord(body));
    assert.equal((body["error"] as Record<string, unknown>)["code"], "missing_addresses");
  });

  it("rejects more than 50 addresses", async () => {
    const { app } = build();
    const many = Array.from({ length: 51 }, (_, i) =>
      `0x${String(i).padStart(2, "0")}${"0".repeat(38)}`,
    ).join(",");
    const res = await app.request(`/tokens?addresses=${many}`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as unknown;
    assert.ok(isRecord(body));
    assert.equal((body["error"] as Record<string, unknown>)["code"], "too_many_addresses");
  });
});

describe("GET /status snapshot summary", () => {
  it("lists known feed keys, marking absent ones as missing", async () => {
    const { app, store } = build();
    await store.put(MEME_UNIVERSE_KEY, [], {
      source: "fourmeme",
      freshForMs: 60_000,
      deadAfterMs: 900_000,
    });

    const res = await app.request("/status");
    assert.equal(res.status, 200);
    const body = (await res.json()) as unknown;
    assert.ok(isRecord(body));
    const data = body["data"] as Record<string, unknown>;
    const snapshots = data["snapshots"];
    assert.ok(Array.isArray(snapshots));

    const byKey = new Map(
      snapshots.map((entry) => {
        const record = entry as Record<string, unknown>;
        return [record["key"], record] as const;
      }),
    );
    const meme = byKey.get(MEME_UNIVERSE_KEY);
    assert.ok(meme !== undefined);
    assert.equal(meme["staleness"], "fresh");
    assert.equal(meme["source"], "fourmeme");

    const heartbeat = byKey.get("heartbeat");
    assert.ok(heartbeat !== undefined);
    assert.equal(heartbeat["missing"], true);
  });
});
