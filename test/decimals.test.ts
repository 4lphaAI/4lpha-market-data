import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStore } from "../src/core/store.js";
import {
  ABSENT_DECIMALS_DEAD_AFTER_MS,
  DECIMALS_DEAD_AFTER_MS,
  decimalsKey,
  getTokenDecimals,
  type DecimalsOutcome,
  type TokenDecimals,
} from "../src/query/decimals.js";

/** A Four.Meme token — the case the majors allowlist could never answer. */
const TOKEN = "0x5c85d6c6825ab4032337f11ee92a72df936b46f6";

describe("getTokenDecimals", () => {
  it("reads the chain once and serves every later hit from the cache", async () => {
    const store = new MemoryStore();
    let reads = 0;
    const readDecimals = async (): Promise<DecimalsOutcome> => {
      reads += 1;
      return { kind: "answered", decimals: 18 };
    };

    const first = await getTokenDecimals(store, { address: TOKEN, readDecimals });
    const second = await getTokenDecimals(store, { address: TOKEN.toUpperCase(), readDecimals });

    assert.equal(reads, 1);
    assert.deepEqual(first, { address: TOKEN, decimals: 18, source: "bsc-rpc" });
    assert.deepEqual(second, { address: TOKEN, decimals: 18, source: "bsc-rpc" });
  });

  it("keeps a non-18 answer, which is the whole reason for asking", async () => {
    const store = new MemoryStore();
    const result = await getTokenDecimals(store, {
      address: TOKEN,
      readDecimals: async () => ({ kind: "answered", decimals: 6 }),
    });
    assert.equal(result.decimals, 6);
  });

  it("caches a definite absence, but on the shorter window", async () => {
    const store = new MemoryStore();
    let reads = 0;
    const readDecimals = async (): Promise<DecimalsOutcome> => {
      reads += 1;
      return { kind: "absent" };
    };

    const result = await getTokenDecimals(store, { address: TOKEN, readDecimals });
    await getTokenDecimals(store, { address: TOKEN, readDecimals });

    assert.equal(reads, 1, "a contract with no decimals() is not re-asked per hit");
    // Null, but attributed: the chain answered, and it answered "there is none".
    assert.deepEqual(result, { address: TOKEN, decimals: null, source: "bsc-rpc" });
    assert.ok(ABSENT_DECIMALS_DEAD_AFTER_MS < DECIMALS_DEAD_AFTER_MS);
  });

  it("answers null and writes nothing when no endpoint could be reached", async () => {
    const store = new MemoryStore();
    const result = await getTokenDecimals(store, {
      address: TOKEN,
      readDecimals: async () => ({ kind: "unavailable" }),
    });

    assert.deepEqual(result, { address: TOKEN, decimals: null, source: null });
    // An outage must never age into a permanent fact about the token.
    assert.equal(await store.get<TokenDecimals>(decimalsKey(TOKEN)), null);
  });

  it("does not let a throwing reader become the caller's failure", async () => {
    const store = new MemoryStore();
    const result = await getTokenDecimals(store, {
      address: TOKEN,
      readDecimals: async () => {
        throw new Error("all rpc endpoints failed");
      },
    });
    assert.deepEqual(result, { address: TOKEN, decimals: null, source: null });
  });

  it("serves a stale cached answer rather than nothing", async () => {
    const store = new MemoryStore();
    await store.put(decimalsKey(TOKEN), { address: TOKEN, decimals: 8 } satisfies TokenDecimals, {
      source: "bsc-rpc",
      freshForMs: 0,
      deadAfterMs: DECIMALS_DEAD_AFTER_MS,
    });

    const result = await getTokenDecimals(store, {
      address: TOKEN,
      readDecimals: async () => ({ kind: "unavailable" }),
    });
    // Decimals do not change, so "stale" here only means "read a while ago".
    assert.deepEqual(result, { address: TOKEN, decimals: 8, source: "bsc-rpc" });
  });

  it("rejects an out-of-range answer instead of returning it", async () => {
    const store = new MemoryStore();
    const result = await getTokenDecimals(store, {
      address: TOKEN,
      readDecimals: async () => ({ kind: "answered", decimals: 250 }),
    });
    assert.equal(result.decimals, null);
  });

  it("distrusts a cached payload written by an older build", async () => {
    const store = new MemoryStore();
    await store.put(decimalsKey(TOKEN), { address: TOKEN, decimals: "18" }, {
      source: "bsc-rpc",
      freshForMs: DECIMALS_DEAD_AFTER_MS,
      deadAfterMs: DECIMALS_DEAD_AFTER_MS,
    });

    const result = await getTokenDecimals(store, {
      address: TOKEN,
      readDecimals: async () => {
        assert.fail("a fresh record must not be re-read");
      },
    });
    assert.equal(result.decimals, null);
  });

  it("returns null for a malformed address without reading anything", async () => {
    const result = await getTokenDecimals(new MemoryStore(), {
      address: "nonsense",
      readDecimals: async () => {
        assert.fail("must not read");
      },
    });
    assert.deepEqual(result, { address: "nonsense", decimals: null, source: null });
  });
});
