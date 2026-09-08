import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { MemoryStore } from "../src/core/store.js";
import { emptyTokenSnapshot } from "../src/core/models.js";
import { runFourMemeRanking } from "../src/jobs/fourmemeRanking.js";
import { runBinanceUniverse } from "../src/jobs/binanceUniverse.js";
import {
  PRICE_BATCH_SIZE,
  TRACKED_ADDRESSES_KEY,
  readTrackedAddresses,
  runBinancePrices,
} from "../src/jobs/binancePrices.js";
import { loadAllowlist } from "../src/allowlist.js";
import { tokenKey } from "../src/jobs/tokenStore.js";
import { COINS_UNIVERSE_KEY, MEME_UNIVERSE_KEY, bstockAddresses } from "../src/universe.js";
import type { TokenSnapshot, UniverseEntry } from "../src/core/models.js";

const TOKEN_A = "0xaa00000000000000000000000000000000000001";
const TOKEN_B = "0xbb00000000000000000000000000000000000002";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(handler: (url: URL) => Response): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(href);
    return handler(new URL(href));
  }) as typeof globalThis.fetch;
  return seen;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("fourmeme-ranking job", () => {
  it("writes the meme lane and per-token snapshots", async () => {
    const store = new MemoryStore();
    const seen = installFetch(() =>
      json({
        code: "0",
        data: {
          list: [
            {
              tokenAddress: TOKEN_A,
              shortName: "AAA",
              symbol: "USDT",
              price: "2",
              cap: "1000",
              day1Vol: "500",
              hold: 10,
            },
          ],
        },
      }),
    );

    const result = await runFourMemeRanking(store, AbortSignal.timeout(5_000));
    assert.equal(seen.length, 2, "NEW and HOT are both requested");
    assert.equal(result.entries, 1);

    const lane = await store.get<UniverseEntry[]>(MEME_UNIVERSE_KEY);
    assert.equal(lane?.data.length, 1);
    assert.equal(lane?.staleness, "fresh");

    const token = await store.get<TokenSnapshot>(tokenKey(TOKEN_A));
    assert.equal(token?.data.priceUsd, 2);
    assert.equal(token?.data.holders, 10);
    await store.close();
  });

  it("still publishes when only one ranking type succeeds", async () => {
    const store = new MemoryStore();
    let call = 0;
    installFetch(() => {
      call += 1;
      return call === 1
        ? json({}, 503)
        : json({ code: "0", data: { list: [{ tokenAddress: TOKEN_B, shortName: "BBB" }] } });
    });

    const result = await runFourMemeRanking(store, AbortSignal.timeout(5_000));
    assert.equal(result.entries, 1);
    await store.close();
  });

  it("fails the run rather than blanking the lane when both types fail", async () => {
    const store = new MemoryStore();
    await store.put(MEME_UNIVERSE_KEY, [{ address: TOKEN_A, symbol: "AAA" }], {
      source: "fourmeme",
      freshForMs: 60_000,
      deadAfterMs: 900_000,
    });
    installFetch(() => json({}, 503));

    await assert.rejects(() => runFourMemeRanking(store, AbortSignal.timeout(5_000)));
    const lane = await store.get<UniverseEntry[]>(MEME_UNIVERSE_KEY);
    assert.equal(lane?.data.length, 1, "previous lane snapshot survives");
    await store.close();
  });
});

describe("binance-universe job", () => {
  it("writes the coins lane with a long freshness window", async () => {
    const store = new MemoryStore();
    installFetch(() => json({ code: "000000", data: [{ contractAddress: TOKEN_A, symbol: "AAA" }] }));

    const result = await runBinanceUniverse(store, AbortSignal.timeout(5_000));
    assert.equal(result.entries, 1);

    const lane = await store.get<UniverseEntry[]>(COINS_UNIVERSE_KEY);
    assert.equal(lane?.data[0]?.lane, "coins");
    await store.close();
  });

  it("refuses to publish an empty lane", async () => {
    const store = new MemoryStore();
    installFetch(() => json({ code: "000000", data: [] }));

    await assert.rejects(() => runBinanceUniverse(store, AbortSignal.timeout(5_000)));
    assert.equal(await store.get(COINS_UNIVERSE_KEY), null);
    await store.close();
  });
});

describe("binance-prices job", () => {
  it("defaults the tracked set to the allowlist unioned with the bStocks list", async () => {
    const store = new MemoryStore();
    const tracked = await readTrackedAddresses(store);
    const allowlist = loadAllowlist();
    assert.notEqual(allowlist, null);

    // 221, not the snapshot's 222: the BNB row is the `"native"` sentinel and
    // carries no contract address. Every bStock is itself allowlisted, so the
    // union dedupes back to the allowlist.
    assert.equal(tracked.length, 221);
    assert.equal(new Set(tracked).size, tracked.length);
    for (const address of allowlist!.keys()) assert.ok(tracked.includes(address), address);
    for (const address of bstockAddresses()) assert.ok(tracked.includes(address), address);
    await store.close();
  });

  it("reads, lowercases and de-duplicates an operator-supplied set", async () => {
    const store = new MemoryStore();
    await store.put(TRACKED_ADDRESSES_KEY, [TOKEN_A.toUpperCase(), TOKEN_A, "junk", 7], {
      source: "operator",
      freshForMs: 60_000,
      deadAfterMs: 900_000,
    });
    assert.deepEqual(await readTrackedAddresses(store), [TOKEN_A]);
    await store.close();
  });

  it("merges plausible quotes into the token snapshot", async () => {
    const store = new MemoryStore();
    await store.put(TRACKED_ADDRESSES_KEY, [TOKEN_A], {
      source: "operator",
      freshForMs: 60_000,
      deadAfterMs: 900_000,
    });
    installFetch(() => json({ code: "000000", data: { price: "1.5", holders: 20 } }));

    const result = await runBinancePrices(store, AbortSignal.timeout(5_000));
    assert.deepEqual(result, { attempted: 1, updated: 1, rejected: 0, failed: 0 });

    const token = await store.get<TokenSnapshot>(tokenKey(TOKEN_A));
    assert.equal(token?.data.priceUsd, 1.5);
    await store.close();
  });

  it("drops a glitch price instead of merging it over a sane one", async () => {
    const store = new MemoryStore();
    await store.put(TRACKED_ADDRESSES_KEY, [TOKEN_A, TOKEN_B], {
      source: "operator",
      freshForMs: 60_000,
      deadAfterMs: 900_000,
    });
    for (const address of [TOKEN_A, TOKEN_B]) {
      await store.put(
        tokenKey(address),
        { ...emptyTokenSnapshot(address), priceUsd: 100 },
        { source: "binance", freshForMs: 60_000, deadAfterMs: 900_000 },
      );
    }
    installFetch((url) => {
      const address = url.searchParams.get("contractAddress");
      const price = address === TOKEN_A ? "1000000" : "110";
      return json({ code: "000000", data: { price } });
    });

    const result = await runBinancePrices(store, AbortSignal.timeout(5_000));
    assert.equal(result.rejected, 1);
    assert.equal(result.updated, 1);

    const glitched = await store.get<TokenSnapshot>(tokenKey(TOKEN_A));
    assert.equal(glitched?.data.priceUsd, 100, "the stored price is untouched");
    const moved = await store.get<TokenSnapshot>(tokenKey(TOKEN_B));
    assert.equal(moved?.data.priceUsd, 110);
    await store.close();
  });

  it("keeps quoting every other address when one bapi call misses", async () => {
    const store = new MemoryStore();
    // Two full batches and part of a third, so the miss also proves a later
    // batch still ran.
    assert.equal(PRICE_BATCH_SIZE, 25);
    const addresses = Array.from(
      { length: PRICE_BATCH_SIZE * 2 + 10 },
      (_value, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`,
    );
    const missing = addresses[7]!;
    const last = addresses.at(-1)!;
    await store.put(TRACKED_ADDRESSES_KEY, addresses, {
      source: "operator",
      freshForMs: 60_000,
      deadAfterMs: 900_000,
    });
    installFetch((url) =>
      url.searchParams.get("contractAddress") === missing
        ? json({}, 503)
        : json({ code: "000000", data: { price: "1.5" } }),
    );

    const result = await runBinancePrices(store, AbortSignal.timeout(5_000));
    assert.deepEqual(result, {
      attempted: addresses.length,
      updated: addresses.length - 1,
      rejected: 0,
      failed: 1,
    });
    assert.equal(await store.get<TokenSnapshot>(tokenKey(missing)), null);
    assert.equal((await store.get<TokenSnapshot>(tokenKey(last)))?.data.priceUsd, 1.5);
    await store.close();
  });

  it("fails the run when no tracked price could be updated", async () => {
    const store = new MemoryStore();
    await store.put(TRACKED_ADDRESSES_KEY, [TOKEN_A], {
      source: "operator",
      freshForMs: 60_000,
      deadAfterMs: 900_000,
    });
    installFetch(() => json({}, 503));

    await assert.rejects(() => runBinancePrices(store, AbortSignal.timeout(5_000)));
    await store.close();
  });
});
