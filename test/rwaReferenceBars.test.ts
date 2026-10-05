import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { MemoryStore, type PutOptions, type SnapshotStore } from "../src/core/store.js";
import type { DataRecord, JobHealth } from "../src/core/types.js";
import { binanceRwaJob, runBinanceRwa, type RwaUniverseSnapshot, type ShareFactsReader } from "../src/jobs/binanceRwa.js";
import {
  REFERENCE_BARS_LEASE,
  REFERENCE_BARS_LEASE_TTL_MS,
  REFERENCE_BARS_OPEN_KEY,
  REFERENCE_BAR_CAP,
  normalizeBarRecord,
  normalizeOpenState,
  recordReferenceBars,
  referenceBarsKey,
  type RecordReferenceBarsOptions,
  type ReferenceEndpoint,
  type ReferenceObservation,
} from "../src/jobs/rwaReferenceBars.js";
import { RWA_UNIVERSE_KEY } from "../src/universe.js";
import { fakeFetch, jsonResponse } from "./helpers.js";
import { NVDAB_ROW } from "./rwaFixtures.js";

const MIN = 60_000;
// Wednesday 2026-10-07 14:00:00 UTC, aligned to the 15m and the 1h edge.
const T0 = Date.UTC(2026, 9, 7, 14, 0, 0);
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";
const D = "0x00000000000000000000000000000000000000d4";

const clock = { t: T0 };
const obs = (token: string, value: number, endpoint: ReferenceEndpoint = "tokens"): ReferenceObservation =>
  ({ token, underlyingTicker: "TICK", endpoint, value });

class HookStore implements SnapshotStore {
  puts: string[] = [];
  leases: Array<{ lease: string; holder: string; ttlMs: number }> = [];
  beforePut: ((key: string) => Promise<void> | void) | undefined;
  afterPut: ((key: string) => Promise<void> | void) | undefined;
  constructor(readonly inner: MemoryStore) {}
  async put(key: string, payload: unknown, opts: PutOptions): Promise<void> {
    await this.beforePut?.(key);
    this.puts.push(key);
    await this.inner.put(key, payload, opts);
    await this.afterPut?.(key);
  }
  get<T>(key: string): Promise<DataRecord<T> | null> { return this.inner.get<T>(key); }
  delete(key: string): Promise<boolean> { return this.inner.delete(key); }
  putJobHealth(h: JobHealth): Promise<void> { return this.inner.putJobHealth(h); }
  getJobHealth(): Promise<JobHealth[]> { return this.inner.getJobHealth(); }
  addTrackingReference(...args: Parameters<SnapshotStore["addTrackingReference"]>): ReturnType<SnapshotStore["addTrackingReference"]> { return this.inner.addTrackingReference(...args); }
  removeTrackingReference(...args: Parameters<SnapshotStore["removeTrackingReference"]>): ReturnType<SnapshotStore["removeTrackingReference"]> { return this.inner.removeTrackingReference(...args); }
  listTrackedSubjects(namespace: string): Promise<string[]> { return this.inner.listTrackedSubjects(namespace); }
  acquireSchedulerLease(lease: string, holder: string, ttlMs: number): Promise<boolean> {
    this.leases.push({ lease, holder, ttlMs });
    return this.inner.acquireSchedulerLease(lease, holder, ttlMs);
  }
  close(): Promise<void> { return this.inner.close(); }
}

function freshStore(): HookStore {
  clock.t = T0;
  return new HookStore(new MemoryStore(() => clock.t));
}

async function cycle(
  store: SnapshotStore,
  observations: readonly ReferenceObservation[],
  at: number,
  holder: string = randomUUID(),
  extra: Partial<RecordReferenceBarsOptions> = {},
) {
  clock.t = at;
  return recordReferenceBars(store, observations, {
    observedAt: at, holder, jobSignal: new AbortController().signal, deadline: new AbortController().signal, ...extra,
  });
}

async function closedOf(store: SnapshotStore, token: string) {
  const record = await store.get<unknown>(referenceBarsKey(token));
  return record === null ? null : normalizeBarRecord(record.data);
}
async function openOf(store: SnapshotStore) {
  return normalizeOpenState((await store.get<unknown>(REFERENCE_BARS_OPEN_KEY))?.data);
}

describe("reference-price recorder: bars, samples and changes (R2.2, R3.1)", () => {
  it("opens a bar on the first observation, updates h/l/c/samples/changes, and writes the closed record only at the bucket close", async () => {
    const store = freshStore();
    const values = [100, 100, 100.02, 100.021, 99.9, 100.5];
    for (let i = 0; i < values.length; i++) await cycle(store, [obs(A, values[i]!)], T0 + i * MIN + 20_000);
    assert.equal(await closedOf(store, A), null, "nothing is written to the closed record while the bucket is open");
    const open = (await openOf(store)).tokens[A]!;
    assert.deepEqual(open.open15m, { t: T0, o: 100, h: 100.5, l: 99.9, c: 100.5, samples: 6, changes: 3 });
    // 100.02 is +2 bp from the anchor 100 (change, anchor moves), 100.021 is 0.1 bp from 100.02 (no change),
    // 99.9 is -10 bp (change), 100.5 is +50 bp (change).
    await cycle(store, [obs(A, 101)], T0 + 15 * MIN + 20_000);
    const record = (await closedOf(store, A))!;
    assert.equal(record["15m"].length, 1);
    assert.deepEqual(record["15m"][0], { t: T0, o: 100, h: 100.5, l: 99.9, c: 100.5, samples: 6, changes: 3 });
    assert.equal(record["1h"].length, 0, "the 1h bucket is still open");
    assert.equal(record.endpoint, "tokens");
    assert.equal(record.basis, "usd_per_share");
    assert.equal(record.underlyingTicker, "TICK");
  });

  it("stores a bucket whose reference never moved with changes 0 (a flat bucket is not a real bar)", async () => {
    const store = freshStore();
    for (let i = 0; i < 15; i++) await cycle(store, [obs(A, 250)], T0 + i * MIN + 20_000);
    await cycle(store, [obs(A, 250)], T0 + 15 * MIN + 20_000);
    const bar = (await closedOf(store, A))!["15m"][0]!;
    assert.equal(bar.samples, 15);
    assert.equal(bar.changes, 0);
  });

  it("the first observation of a series sets the anchor and counts no change", async () => {
    const store = freshStore();
    await cycle(store, [obs(A, 100)], T0 + 20_000);
    const open = (await openOf(store)).tokens[A]!;
    assert.equal(open.open15m?.changes, 0);
    assert.equal(open.anchor, 100);
  });

  it("a bucket with no observation stays missing and is never filled", async () => {
    const store = freshStore();
    await cycle(store, [obs(A, 100)], T0 + 5 * MIN);
    await cycle(store, [obs(A, 101)], T0 + 50 * MIN); // buckets 14:15 and 14:30 have no observation
    await cycle(store, [obs(A, 102)], T0 + 65 * MIN);
    const record = (await closedOf(store, A))!;
    assert.deepEqual(record["15m"].map((bar) => bar.t), [T0, T0 + 45 * MIN]);
    assert.deepEqual(record["1h"].map((bar) => bar.t), [T0]);
  });

  it("continues one series from the store alone: the open bar survives a restart, and a lost open state restarts the bar", async () => {
    const store = freshStore();
    await cycle(store, [obs(A, 100)], T0 + 20_000);
    await cycle(store, [obs(A, 100.5)], T0 + MIN + 20_000);
    assert.equal((await openOf(store)).tokens[A]?.open15m?.samples, 2);
    // A different "process" (new holder, nothing in memory) continues the same bar.
    await cycle(store, [obs(A, 100.6)], T0 + 2 * MIN + 20_000);
    assert.equal((await openOf(store)).tokens[A]?.open15m?.samples, 3);
    // Wiping the store's open state restarts the bar: nothing is carried in memory.
    await store.put(REFERENCE_BARS_OPEN_KEY, { tokens: {} }, { source: "test", freshForMs: 1, deadAfterMs: 2 });
    await cycle(store, [obs(A, 100.7)], T0 + 3 * MIN + 20_000);
    assert.equal((await openOf(store)).tokens[A]?.open15m?.samples, 1);
  });

  it("a restart compares against the stored anchor, so a change that straddles it still counts", async () => {
    const store = freshStore();
    await cycle(store, [obs(A, 100)], T0 + 20_000);
    await cycle(store, [obs(A, 100.5)], T0 + 15 * MIN + 20_000);
    assert.equal((await openOf(store)).tokens[A]?.open15m?.changes, 1);
  });

  it("keeps the newest 121 closed bars per interval, newest last", async () => {
    const store = freshStore();
    for (let i = 0; i < 130; i++) await cycle(store, [obs(A, 100 + (i % 3))], T0 + i * 15 * MIN + 20_000);
    const record = (await closedOf(store, A))!;
    assert.equal(record["15m"].length, REFERENCE_BAR_CAP);
    assert.equal(record["15m"].at(-1)?.t, T0 + 128 * 15 * MIN, "the newest closed bar is last");
    assert.equal(record["15m"][0]?.t, T0 + 8 * 15 * MIN, "the oldest were dropped");
  });

  it("an endpoint change starts a new series: the old open bars and the old closed record are discarded", async () => {
    const store = freshStore();
    await cycle(store, [obs(A, 100, "tokens")], T0 + 20_000);
    await cycle(store, [obs(A, 100.2, "tokens")], T0 + 16 * MIN);
    assert.deepEqual((await closedOf(store, A))!["15m"].map((bar) => bar.t), [T0]);
    await cycle(store, [obs(A, 99, "price")], T0 + 17 * MIN);
    const open = (await openOf(store)).tokens[A]!;
    assert.equal(open.endpoint, "price");
    assert.equal(open.open15m?.samples, 1, "the old bar is not extended");
    assert.equal(open.anchor, 99, "the anchor restarts with the series");
    await cycle(store, [obs(A, 99.1, "price")], T0 + 32 * MIN);
    const record = (await closedOf(store, A))!;
    assert.equal(record.endpoint, "price");
    assert.deepEqual(record["15m"].map((bar) => bar.t), [T0 + 15 * MIN], "only the new series is in the record");
  });

  it("ignores a non-positive or non-finite value instead of recording a zero bar", async () => {
    const store = freshStore();
    await cycle(store, [obs(A, 0), obs(B, Number.NaN), obs(C, -5), obs(D, 10)], T0 + 20_000);
    assert.deepEqual(Object.keys((await openOf(store)).tokens), [D]);
  });

  it("drops a malformed stored entry instead of trusting it", () => {
    const state = normalizeOpenState({ tokens: {
      [A]: { endpoint: "tokens", anchor: 1, lastObservedAt: 5, open15m: null, open1h: null },
      [B]: { endpoint: "other", anchor: 1, lastObservedAt: 5 },
      [C]: { endpoint: "price", anchor: -1, lastObservedAt: 5 },
      [D]: { endpoint: "price", anchor: 2, lastObservedAt: 5, open15m: { t: 1 } },
    } });
    assert.ok(state.tokens[A]);
    assert.equal(state.tokens[B], undefined);
    assert.equal(state.tokens[C], undefined);
    assert.equal(state.tokens[D]?.open15m, null, "a half-formed bar reads as no bar");
  });
});

describe("reference-price recorder: the 1 bp change floor and the anchor (R4.4)", () => {
  async function changesOf(values: number[]): Promise<number> {
    const store = freshStore();
    for (let i = 0; i < values.length; i++) await cycle(store, [obs(A, values[i]!)], T0 + i * MIN + 20_000);
    return (await openOf(store)).tokens[A]!.open15m!.changes;
  }
  it("moves below 1 bp never count", async () => {
    assert.equal(await changesOf([100, 100.005, 100, 100.0099, 99.9901]), 0);
  });
  it("a move of exactly 1 bp counts, an integer-exact vector so the boundary is inclusive", async () => {
    assert.equal(await changesOf([10000, 10001]), 1);
    assert.equal(await changesOf([10000, 10000.5]), 0);
  });
  it("a slow drift of 0.4 bp per sample counts on its third sample, then restarts from the new anchor", async () => {
    assert.equal(await changesOf([100, 100.004, 100.008]), 0);
    assert.equal(await changesOf([100, 100.004, 100.008, 100.012]), 1);
    assert.equal(await changesOf([100, 100.004, 100.008, 100.012, 100.016]), 1, "0.4 bp from the new anchor is not a change");
  });
  it("the anchor is the value at the last counted change, not the previous sample", async () => {
    const store = freshStore();
    for (let i = 0; i < 4; i++) await cycle(store, [obs(A, [100, 100.004, 100.008, 100.012][i]!)], T0 + i * MIN + 20_000);
    assert.equal((await openOf(store)).tokens[A]?.anchor, 100.012);
    await cycle(store, [obs(A, 100.013)], T0 + 4 * MIN + 20_000);
    assert.equal((await openOf(store)).tokens[A]?.anchor, 100.012, "an uncounted sample leaves the anchor");
  });
});

describe("reference-price recorder: lease, ordering and replicas (R3.1, R4.3, R4.11)", () => {
  it("takes no step without the lease", async () => {
    const store = freshStore();
    assert.equal((await cycle(store, [obs(A, 100)], T0, "holder-1")).recorded, true);
    store.puts.length = 0;
    const second = await cycle(store, [obs(A, 100)], T0 + 5_000, "holder-2"); // holder-1's 30 s lease is still live
    assert.equal(second.recorded, false);
    assert.equal(second.reason, "no_lease");
    assert.deepEqual(store.puts, []);
  });

  it("pins the lease name and the 30 000 ms TTL at both calls, with one holder per cycle", async () => {
    const store = freshStore();
    await cycle(store, [obs(A, 100)], T0, "holder-1");
    assert.deepEqual(store.leases, [
      { lease: "rwa-reference-bars:v1:recorder", holder: "holder-1", ttlMs: 30_000 },
      { lease: "rwa-reference-bars:v1:recorder", holder: "holder-1", ttlMs: 30_000 },
    ]);
    assert.equal(REFERENCE_BARS_LEASE, "rwa-reference-bars:v1:recorder");
    assert.equal(REFERENCE_BARS_LEASE_TTL_MS, 30_000);
  });

  it("keeps the lease TTL above the job timeout and below its interval (R5.6)", () => {
    const job = binanceRwaJob(new MemoryStore());
    assert.ok(REFERENCE_BARS_LEASE_TTL_MS > job.timeoutMs, "a holder's cycle is over before anyone else can take the lease");
    assert.ok(REFERENCE_BARS_LEASE_TTL_MS < job.intervalMs, "a single live replica re-takes it every cycle");
  });

  it("two replicas alternating cycle by cycle record the same series as one replica", async () => {
    const values = (i: number) => 100 + Math.sin(i) * 0.3;
    const minutes = 20 * 60;
    const single = freshStore();
    for (let i = 0; i < minutes; i += 7) await cycle(single, [obs(A, values(i)), obs(B, values(i + 1))], T0 + i * MIN + 20_000, "solo");
    const pair = freshStore();
    for (let i = 0, n = 0; i < minutes; i += 7, n++) await cycle(pair, [obs(A, values(i)), obs(B, values(i + 1))], T0 + i * MIN + 20_000, n % 2 === 0 ? "replica-1" : "replica-2");
    for (const token of [A, B]) assert.deepEqual(await closedOf(pair, token), await closedOf(single, token));
    assert.deepEqual(await openOf(pair), await openOf(single));
  });

  it("a crash after the closed append and before the open-state write leaves exactly one bar after the retry", async () => {
    const store = freshStore();
    await cycle(store, [obs(A, 100)], T0 + 20_000);
    store.beforePut = (key) => { if (key === REFERENCE_BARS_OPEN_KEY) throw new Error("crash"); };
    await assert.rejects(cycle(store, [obs(A, 101)], T0 + 15 * MIN + 20_000), /crash/);
    assert.deepEqual((await closedOf(store, A))!["15m"].map((bar) => bar.t), [T0], "the close was appended");
    assert.equal((await openOf(store)).tokens[A]?.open15m?.t, T0, "the open state did not move");
    store.beforePut = undefined;
    await cycle(store, [obs(A, 101)], T0 + 16 * MIN + 20_000);
    assert.deepEqual((await closedOf(store, A))!["15m"].map((bar) => bar.t), [T0], "the repeated close added nothing");
    assert.equal((await openOf(store)).tokens[A]?.open15m?.t, T0 + 15 * MIN);
  });

  it("a cycle whose lease another replica took writes no open state and the other replica's state survives", async () => {
    const store = freshStore();
    await cycle(store, [obs(A, 100)], T0 + 20_000, "slow");
    let ran = false;
    store.beforePut = async (key) => {
      if (key !== referenceBarsKey(A) || ran) return;
      ran = true;
      // The slow cycle overruns its lease; another replica takes it and records a newer observation.
      clock.t = T0 + 15 * MIN + 20_000 + REFERENCE_BARS_LEASE_TTL_MS + 1_000;
      const inner = store.inner;
      const winner = await recordReferenceBars(inner, [obs(A, 105)], {
        observedAt: clock.t, holder: "winner", jobSignal: new AbortController().signal, deadline: new AbortController().signal,
      });
      assert.equal(winner.recorded, true);
    };
    const late = await cycle(store, [obs(A, 101)], T0 + 15 * MIN + 20_000, "slow");
    assert.equal(late.recorded, false);
    assert.equal(late.reason, "lease_lost");
    assert.ok(!store.puts.includes(REFERENCE_BARS_OPEN_KEY) || store.puts.filter((key) => key === REFERENCE_BARS_OPEN_KEY).length === 1, "the slow cycle never put the open state");
    assert.equal((await openOf(store)).tokens[A]?.anchor, 105, "the winner's state survives");
  });

  it("writes the open state last: closed appends first, the lease re-take just before the single open-state put", async () => {
    const store = freshStore();
    await cycle(store, [obs(A, 100), obs(B, 100)], T0 + 20_000);
    store.puts.length = 0;
    store.leases.length = 0;
    await cycle(store, [obs(A, 101), obs(B, 101)], T0 + 15 * MIN + 20_000, "h");
    assert.deepEqual([...store.puts.slice(0, 2)].sort(), [referenceBarsKey(A), referenceBarsKey(B)].sort());
    assert.equal(store.puts.at(-1), REFERENCE_BARS_OPEN_KEY);
    assert.equal(store.puts.filter((key) => key === REFERENCE_BARS_OPEN_KEY).length, 1);
    assert.equal(store.leases.length, 2);
  });

  it("an aborted job signal writes nothing more", async () => {
    const store = freshStore();
    const job = new AbortController();
    store.afterPut = (key) => { if (key === referenceBarsKey(A)) job.abort(new Error("job timeout")); };
    await cycle(store, [obs(A, 100)], T0 + 20_000);
    store.puts.length = 0;
    await assert.rejects(cycle(store, [obs(A, 101), obs(B, 101)], T0 + 15 * MIN + 20_000, "h", { jobSignal: job.signal }), /job timeout/);
    assert.ok(!store.puts.includes(REFERENCE_BARS_OPEN_KEY));
  });
});

describe("reference-price recorder: the deadline bounds the closed appends only (R5.1.3)", () => {
  const TOKENS = [A, B, C, D];
  async function boundary(store: HookStore, at: number, budget: number, holder = randomUUID()) {
    const deadline = new AbortController();
    let appended = 0;
    store.afterPut = (key) => {
      if (key === REFERENCE_BARS_OPEN_KEY) return;
      appended += 1;
      if (appended >= budget) deadline.abort(new Error("recorder deadline"));
    };
    const result = await cycle(store, TOKENS.map((t) => obs(t, 100 + at / 1e9)), at, holder, { deadline: deadline.signal });
    store.afterPut = undefined;
    return result;
  }
  async function seeded() {
    const store = freshStore();
    await cycle(store, TOKENS.map((t) => obs(t, 100)), T0 + 20_000);
    return store;
  }

  it("a boundary cycle whose store stalls after k closes still writes the open state, with the k rolled and the others unchanged", async () => {
    const store = await seeded();
    const before = await openOf(store);
    const at = T0 + 15 * MIN + 20_000;
    const result = await boundary(store, at, 2);
    assert.equal(result.recorded, true);
    assert.equal(result.deadlineFired, true);
    assert.equal(result.closes, 2);
    assert.equal(result.deferred, 2);
    const after = await openOf(store);
    let rolled = 0;
    let kept = 0;
    for (const token of TOKENS) {
      if (after.tokens[token]!.open15m!.t === T0 + 15 * MIN) {
        rolled += 1;
        assert.equal(after.tokens[token]!.lastObservedAt, at);
        assert.equal((await closedOf(store, token))!["15m"].length, 1);
      } else {
        kept += 1;
        assert.deepEqual(after.tokens[token], before.tokens[token], "a deferred token keeps its stored entry exactly");
        assert.equal(after.tokens[token]!.lastObservedAt, before.tokens[token]!.lastObservedAt, "its lastObservedAt does not advance");
        assert.equal(await closedOf(store, token), null);
      }
    }
    assert.deepEqual([rolled, kept], [2, 2]);
  });

  it("the next cycle closes each deferred token exactly once", async () => {
    const store = await seeded();
    await boundary(store, T0 + 15 * MIN + 20_000, 2);
    const next = await cycle(store, TOKENS.map((t) => obs(t, 100.5)), T0 + 16 * MIN + 20_000);
    assert.equal(next.closes, 2);
    assert.equal(next.deferred, 0);
    for (const token of TOKENS) assert.deepEqual((await closedOf(store, token))!["15m"].map((bar) => bar.t), [T0], token);
    const again = await cycle(store, TOKENS.map((t) => obs(t, 100.5)), T0 + 17 * MIN + 20_000);
    assert.equal(again.closes, 0);
  });

  it("two consecutive boundary cycles with the same budget defer different tokens", async () => {
    const store = await seeded();
    const deferredAt = async (at: number): Promise<string[]> => {
      const before = await openOf(store);
      await boundary(store, at, 2);
      const after = await openOf(store);
      return TOKENS.filter((t) => after.tokens[t]!.lastObservedAt === before.tokens[t]!.lastObservedAt);
    };
    const first = await deferredAt(T0 + 15 * MIN + 20_000);
    // Close every token's 15m bar before the next boundary so both boundaries face a full set of closes.
    await cycle(store, TOKENS.map((t) => obs(t, 100.2)), T0 + 16 * MIN + 20_000);
    const second = await deferredAt(T0 + 30 * MIN + 20_000);
    assert.equal(first.length, 2);
    assert.equal(second.length, 2);
    assert.notDeepEqual([...first].sort(), [...second].sort(), "the cut set rotates");
  });

  it("the deadline never skips the lease re-take or the open-state write", async () => {
    const store = await seeded();
    store.leases.length = 0;
    const result = await boundary(store, T0 + 15 * MIN + 20_000, 1);
    assert.equal(result.recorded, true);
    assert.equal(store.leases.length, 2);
    assert.equal(store.puts.at(-1), REFERENCE_BARS_OPEN_KEY);
  });
});

describe("reference-price recorder inside the binance-rwa job (R3.2, R5.3)", () => {
  const SECRET = "unit-test-secret";
  const ok = (data: unknown) => jsonResponse({ code: 0, msg: "success", data, timestamp: 1, success: true });
  const PYPLB = "0x2806a561fc1f9259b2d54a281796bde0d92762ae";
  const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
  const ONDO_ROW = { ...NVDAB_ROW, tokenContractAddress: "0x1161989389a991532dce453d04d6346c2581c907", platformId: "ondo", tokenSymbol: "ARQQon", underlyingTicker: "ARQQ" };
  function setCredentials(): void {
    process.env["BINANCE_WEB3_API_KEY"] = "unit-test-key";
    process.env["BINANCE_WEB3_SECRET_KEY"] = SECRET;
  }
  afterEach(() => {
    delete process.env["BINANCE_WEB3_API_KEY"];
    delete process.env["BINANCE_WEB3_SECRET_KEY"];
  });
  function upstream(): ReturnType<typeof fakeFetch> {
    return fakeFetch((call) => {
      if (call.url.includes("/rwa/tokens")) return ok([NVDAB_ROW, ONDO_ROW]);
      if (call.url.includes("/rwa/price")) return ok([{ tokenContractAddress: PYPLB, platformId: "bstock", tokenPrice: "53.11", referencePrice: "53.016067" }]);
      if (call.url.includes("/rwa/underlying-market") && call.url.includes(PYPLB)) {
        return ok({ tokenContractAddress: PYPLB, platformId: "bstock", statusInfo: { openState: true, reasonCode: "TRADING" }, marketData: {} });
      }
      return jsonResponse({ code: 500, msg: "down", data: null }, 500);
    });
  }

  it("records one observation per bStock row (listed from tokens, per-address from price), never an Ondo row or a row without a price", async () => {
    setCredentials();
    const store = new MemoryStore();
    await runBinanceRwa(store, new AbortController().signal, { fetchFn: upstream().fetch, now: () => T0 + 20_000 });
    const open = await openOf(store);
    assert.deepEqual(Object.keys(open.tokens).sort(), [NVDAB, PYPLB].sort());
    assert.equal(open.tokens[NVDAB]?.endpoint, "tokens");
    assert.equal(open.tokens[NVDAB]?.anchor, 215.62, "the list's referencePrice, per share");
    assert.equal(open.tokens[PYPLB]?.endpoint, "price");
    assert.equal(open.tokens[PYPLB]?.anchor, 53.11, "the per-address row's per-share price");
    assert.equal(open.tokens[NVDAB]?.lastObservedAt, T0 + 20_000, "the injected clock is the observation time");
  });

  it("runs after both snapshot puts", async () => {
    setCredentials();
    const store = new HookStore(new MemoryStore());
    await runBinanceRwa(store, new AbortController().signal, { fetchFn: upstream().fetch });
    const open = store.puts.indexOf(REFERENCE_BARS_OPEN_KEY);
    assert.ok(open > store.puts.indexOf(RWA_UNIVERSE_KEY));
    assert.ok(open > store.puts.indexOf("rwa:members"));
  });

  it("a recorder that throws leaves the snapshot and the job result unchanged", async () => {
    setCredentials();
    const baseStore = new MemoryStore();
    const base = await runBinanceRwa(baseStore, new AbortController().signal, { fetchFn: upstream().fetch });
    const store = new HookStore(new MemoryStore());
    store.beforePut = (key) => { if (key === REFERENCE_BARS_OPEN_KEY) throw new Error("store write failed"); };
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };
    let result;
    try {
      result = await runBinanceRwa(store, new AbortController().signal, { fetchFn: upstream().fetch });
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(result, base);
    assert.equal(warnings.filter((line) => line.includes("recorder failed")).length, 1, "logged once");
    const published = (await store.get<RwaUniverseSnapshot>(RWA_UNIVERSE_KEY))!.data;
    assert.deepEqual(published, (await baseStore.get<RwaUniverseSnapshot>(RWA_UNIVERSE_KEY))!.data);
  });

  it("a chain read that never resolves still records an observation and writes the open state in the same cycle", async () => {
    setCredentials();
    clock.t = T0 + 20_000;
    const store = new MemoryStore(() => clock.t);
    const never: ShareFactsReader = () => new Promise(() => {});
    await runBinanceRwa(store, new AbortController().signal, { fetchFn: upstream().fetch, now: () => T0 + 20_000 });
    // The next cycle is a 15m boundary, and its chain read hangs for the whole 2.5 s budget: the recorder has its own
    // budget, so it still closes both bars and writes the open state.
    clock.t = T0 + 15 * MIN + 20_000;
    await runBinanceRwa(store, new AbortController().signal, { fetchFn: upstream().fetch, readShareFacts: never, now: () => T0 + 15 * MIN + 20_000 });
    const open = await openOf(store);
    assert.equal(open.tokens[NVDAB]?.lastObservedAt, T0 + 15 * MIN + 20_000);
    assert.equal(open.tokens[PYPLB]?.anchor, 53.11, "the per-address observation does not depend on the chain ratio");
    assert.equal((await closedOf(store, NVDAB))?.["15m"].length, 1, "the close was not deferred by the chain read's deadline");
    assert.equal((await closedOf(store, PYPLB))?.["15m"].length, 1);
  });

  it("logs one boundary line on a 15m boundary cycle", async () => {
    setCredentials();
    clock.t = T0 + 20_000;
    const store = new MemoryStore(() => clock.t);
    await runBinanceRwa(store, new AbortController().signal, { fetchFn: upstream().fetch, now: () => T0 + 20_000 });
    clock.t = T0 + 15 * MIN + 20_000;
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => { lines.push(String(message)); };
    try {
      await runBinanceRwa(store, new AbortController().signal, { fetchFn: upstream().fetch, now: () => T0 + 15 * MIN + 20_000 });
    } finally {
      console.log = originalLog;
    }
    assert.ok(lines.some((line) => /recorder boundary: 2 closes, \d+ store ops, \d+ ms/.test(line)), lines.join("\n"));
  });
});

describe("source pins", () => {
  it("the recorder keeps no module-level state and imports no upstream adapter", () => {
    const source = readFileSync(new URL("../src/jobs/rwaReferenceBars.ts", import.meta.url), "utf8");
    assert.ok(!/^(?:let|var)\s/mu.test(source), "no module-level mutable binding");
    assert.ok(!/new Map\(|new Set\(/u.test(source.split("export async function recordReferenceBars")[0]!), "no module-level cache");
    assert.ok(!/adapters\//u.test(source));
  });
});
