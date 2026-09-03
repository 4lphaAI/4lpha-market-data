import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import { emptyTokenSnapshot, type TokenSnapshot } from "../src/core/models.js";
import { createServer } from "../src/server.js";
import { tokenKey, TOKEN_DEAD_AFTER_MS, TOKEN_FRESH_FOR_MS } from "../src/jobs/tokenStore.js";
import type { DecimalsOutcome } from "../src/query/decimals.js";
import {
  MAJOR_TOKENS,
  MAJORS_PRICE_SOURCE,
  PRICE_POOLS,
  PRICE_SCALE,
  USD_ANCHOR,
  priceFromSqrtPriceX96,
  runMajorsPrices,
  scaledToNumber,
  type PoolSlot0,
  type PricePool,
  type ReadPoolSlot0s,
} from "../src/jobs/majorsPrices.js";

const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const USDC = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";
const BTCB = "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c";
const ETH = "0x2170ed0880ac9a755fd29b2688956bd959f933f8";
const CAKE = "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82";

/**
 * `slot0` as read on chain 2026-09-02 (block ~117.5M). The USD prices they
 * imply were checked against the market that day: BNB ≈ $687, BTC ≈ $77.5k,
 * ETH ≈ $2.41k, CAKE ≈ $1.84, USDC ≈ $1.00.
 */
const OBSERVED: Record<string, { sqrtPriceX96: bigint; tick: number }> = {
  // WBNB/USDT 0.01% — token0 USDT, token1 WBNB
  "0x172fcd41e0913e95784454622d1c3724f546f849": {
    sqrtPriceX96: 3022236803119838170924189035n,
    tick: -65330,
  },
  // USDC/USDT 0.01% — token0 USDT, token1 USDC
  "0x92b7807bf19b7dddf89b706143896d05228f3121": {
    sqrtPriceX96: 79213629912409613979694576620n,
    tick: -4,
  },
  // BTCB/USDT 0.05% — token0 USDT, token1 BTCB
  "0x46cf1cf8c69595804ba91dfdd8d6b960c9b0a7c4": {
    sqrtPriceX96: 284659830322365289107829049n,
    tick: -112582,
  },
  // ETH/USDT 0.05% — token0 ETH, token1 USDT
  "0xbe141893e4c6ad9272e8c04bab7e6a10604501a5": {
    sqrtPriceX96: 3893000293316809744281161809166n,
    tick: 77895,
  },
  // CAKE/USDT 0.25% — token0 CAKE, token1 USDT
  "0x7f51c8aaa6b0599abd16674e2b17fec7a9f674a1": {
    sqrtPriceX96: 107503056026568913673046427360n,
    tick: 6104,
  },
};

const EXPECTED_USD: Record<string, number> = {
  [USDT]: 1,
  [WBNB]: 687.2301234739207,
  [USDC]: 1.0003669554078691,
  [BTCB]: 77465.22652524729,
  [ETH]: 2414.402684972759,
  [CAKE]: 1.8411215147112299,
};

/** Answers from the observed table, in the pool's pinned ordering. */
function fakeReader(
  overrides: { drop?: string[]; swapOrdering?: string[] } = {},
): { read: ReadPoolSlot0s; calls: number } {
  const state = { calls: 0 };
  const read: ReadPoolSlot0s = async (pools) => {
    state.calls += 1;
    const out: PoolSlot0[] = [];
    for (const entry of pools) {
      if (overrides.drop?.includes(entry.pool)) continue;
      const observed = OBSERVED[entry.pool];
      if (observed === undefined) continue;
      const swapped = overrides.swapOrdering?.includes(entry.pool) === true;
      out.push({
        pool: entry.pool,
        token0: swapped ? entry.token1 : entry.token0,
        token1: swapped ? entry.token0 : entry.token1,
        ...observed,
      });
    }
    return out;
  };
  return {
    read,
    get calls() {
      return state.calls;
    },
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("majors: pinned constants", () => {
  it("every major is 18-decimal on BSC (read on chain 2026-09-02, pinned here)", () => {
    for (const token of MAJOR_TOKENS) assert.equal(token.decimals, 18, token.symbol);
  });

  it("USDT is the anchor and every pool quotes in a token priced before it", () => {
    assert.equal(USD_ANCHOR.address, USDT);
    const priced = new Set([USD_ANCHOR.address]);
    for (const pool of PRICE_POOLS) {
      assert.ok(priced.has(pool.quote), `${pool.pool} quotes in an unpriced token`);
      assert.ok([pool.token0, pool.token1].includes(pool.base));
      assert.ok([pool.token0, pool.token1].includes(pool.quote));
      priced.add(pool.base);
    }
    for (const token of MAJOR_TOKENS) assert.ok(priced.has(token.address), token.symbol);
  });
});

describe("majors: sqrtPriceX96 math", () => {
  it("WBNB/USDT golden vector, both orderings, exact to the scale", () => {
    const sqrtPriceX96 = 3022236803119838170924189035n;
    const wbnbInUsdt = priceFromSqrtPriceX96({ sqrtPriceX96, decimals0: 18, decimals1: 18, wanted: "token1" });
    const usdtInWbnb = priceFromSqrtPriceX96({ sqrtPriceX96, decimals0: 18, decimals1: 18, wanted: "token0" });
    assert.equal(wbnbInUsdt, 687230123473920734507n);
    assert.equal(usdtInWbnb, 1455116657205071n);
    assert.equal(scaledToNumber(wbnbInUsdt), 687.2301234739207);
    // The two orderings are reciprocals to within the scale's last digit.
    const product = (wbnbInUsdt * usdtInWbnb) / PRICE_SCALE;
    assert.ok(product >= PRICE_SCALE - 1000n && product <= PRICE_SCALE + 1000n, String(product));
  });

  it("decimal adjustment on an 18/6 pair, with inversion", () => {
    // sqrtPriceX96 = 2^96 means one raw token0 unit = one raw token1 unit, so a
    // whole 18-decimal token0 is worth 10^12 whole 6-decimal token1.
    const sqrtPriceX96 = 79228162514264337593543950336n; // 2^96 written out
    assert.equal(
      priceFromSqrtPriceX96({ sqrtPriceX96, decimals0: 18, decimals1: 6, wanted: "token0" }),
      10n ** 12n * PRICE_SCALE,
    );
    assert.equal(
      priceFromSqrtPriceX96({ sqrtPriceX96, decimals0: 18, decimals1: 6, wanted: "token1" }),
      PRICE_SCALE / 10n ** 12n,
    );
    // Reversed pair: token0 has 6 decimals, token1 has 18.
    assert.equal(
      priceFromSqrtPriceX96({ sqrtPriceX96, decimals0: 6, decimals1: 18, wanted: "token0" }),
      PRICE_SCALE / 10n ** 12n,
    );
    // 2^97 → raw ratio 4.
    assert.equal(
      priceFromSqrtPriceX96({ sqrtPriceX96: sqrtPriceX96 * 2n, decimals0: 18, decimals1: 18, wanted: "token0" }),
      4n * PRICE_SCALE,
    );
  });

  it("rejects an uninitialised pool and converts scaled values without float drift", () => {
    assert.throws(() => priceFromSqrtPriceX96({ sqrtPriceX96: 0n, decimals0: 18, decimals1: 18, wanted: "token0" }));
    assert.equal(scaledToNumber(PRICE_SCALE), 1);
    assert.equal(scaledToNumber(1n), 1e-18);
    assert.equal(scaledToNumber(77465226525247290407621n), 77465.22652524729);
  });
});

describe("majors: job", () => {
  it("writes all six snapshots with the expected key, source, TTLs and prices", async () => {
    const store = new MemoryStore();
    const puts: Array<{ key: string; freshForMs: number; deadAfterMs: number }> = [];
    const originalPut = store.put.bind(store);
    store.put = async (key, payload, opts) => {
      puts.push({ key, freshForMs: opts.freshForMs, deadAfterMs: opts.deadAfterMs });
      await originalPut(key, payload, opts);
    };
    const reader = fakeReader();
    const result = await runMajorsPrices(store, signal(), { readSlot0s: reader.read });

    assert.equal(reader.calls, 1, "one chain read per tick");
    assert.deepEqual(result.skipped, {});
    assert.equal(result.written.length, 6);

    for (const token of MAJOR_TOKENS) {
      const record = await store.get<TokenSnapshot>(tokenKey(token.address));
      assert.ok(record, token.symbol);
      assert.equal(record.source, MAJORS_PRICE_SOURCE);
      const put = puts.find((p) => p.key === tokenKey(token.address));
      assert.ok(put, `${token.symbol} was written`);
      assert.equal(put.freshForMs, TOKEN_FRESH_FOR_MS);
      assert.equal(put.deadAfterMs, TOKEN_DEAD_AFTER_MS);
      assert.equal(record.staleness, "fresh");
      assert.equal(record.data.priceUsd, EXPECTED_USD[token.address]);
      assert.equal(record.data.symbol, token.symbol);
      assert.deepEqual(record.data.updatedFields, ["priceUsd", "symbol"]);
    }
  });

  it("merges into a richer snapshot instead of replacing it", async () => {
    const store = new MemoryStore();
    await store.put(
      tokenKey(CAKE),
      {
        ...emptyTokenSnapshot(CAKE),
        priceUsd: 1.5,
        marketCapUsd: 500_000_000,
        volume24hUsd: 12_345,
        holders: 1_800_000,
        priceChange24hPct: -2.5,
        symbol: "Cake",
      } satisfies TokenSnapshot,
      { source: "binance", freshForMs: 60_000, deadAfterMs: 900_000 },
    );

    await runMajorsPrices(store, signal(), { readSlot0s: fakeReader().read });

    const record = await store.get<TokenSnapshot>(tokenKey(CAKE));
    assert.ok(record);
    assert.equal(record.data.priceUsd, EXPECTED_USD[CAKE]);
    assert.equal(record.data.marketCapUsd, 500_000_000);
    assert.equal(record.data.volume24hUsd, 12_345);
    assert.equal(record.data.holders, 1_800_000);
    assert.equal(record.data.priceChange24hPct, -2.5);
    assert.equal(record.data.symbol, "CAKE");
    assert.equal(record.source, MAJORS_PRICE_SOURCE);
  });

  it("skips a token whose pool did not answer and leaves its record untouched", async () => {
    const store = new MemoryStore();
    const btcbPool = PRICE_POOLS.find((p) => p.base === BTCB)!.pool;
    await store.put(tokenKey(BTCB), { ...emptyTokenSnapshot(BTCB), priceUsd: 70_000 }, {
      source: "older",
      freshForMs: 1,
      deadAfterMs: 2,
    });

    const result = await runMajorsPrices(store, signal(), {
      readSlot0s: fakeReader({ drop: [btcbPool] }).read,
    });

    assert.equal(result.skipped[BTCB], "pool unreadable");
    assert.equal(result.written.length, 5);
    const record = await store.get<TokenSnapshot>(tokenKey(BTCB));
    assert.ok(record);
    assert.equal(record.source, "older", "the stale record is not restamped");
    assert.equal(record.data.priceUsd, 70_000);
  });

  it("refuses a pool whose on-chain ordering differs from the pin", async () => {
    const store = new MemoryStore();
    const ethPool = PRICE_POOLS.find((p) => p.base === ETH)!.pool;
    const result = await runMajorsPrices(store, signal(), {
      readSlot0s: fakeReader({ swapOrdering: [ethPool] }).read,
    });
    assert.equal(result.skipped[ETH], "pool token ordering differs from pin");
    assert.equal(await store.get(tokenKey(ETH)), null);
  });

  it("composes through an intermediate quote and skips downstream of a missing one", async () => {
    const store = new MemoryStore();
    const wbnbPool = PRICE_POOLS[0]!;
    // A synthetic BTCB/WBNB pool at 2^96 with equal decimals: 1 BTCB = 1 WBNB.
    const viaWbnb: PricePool = {
      pool: "0x00000000000000000000000000000000000000aa",
      token0: BTCB,
      token1: WBNB,
      base: BTCB,
      quote: WBNB,
    };
    const read: ReadPoolSlot0s = async (pools) =>
      pools.flatMap((entry): PoolSlot0[] => {
        if (entry.pool === wbnbPool.pool) {
          return [{ pool: entry.pool, token0: entry.token0, token1: entry.token1, ...OBSERVED[entry.pool]! }];
        }
        if (entry.pool === viaWbnb.pool) {
          return [{ pool: entry.pool, token0: BTCB, token1: WBNB, sqrtPriceX96: 79228162514264337593543950336n, tick: 0 }];
        }
        return [];
      });

    const composed = await runMajorsPrices(store, signal(), {
      readSlot0s: read,
      pools: [wbnbPool, viaWbnb],
      tokens: MAJOR_TOKENS,
    });
    assert.equal(composed.prices[BTCB], EXPECTED_USD[WBNB]);

    const dropped = await runMajorsPrices(new MemoryStore(), signal(), {
      readSlot0s: async (pools, s) => (await read(pools, s)).filter((row) => row.pool !== wbnbPool.pool),
      pools: [wbnbPool, viaWbnb],
      tokens: MAJOR_TOKENS,
    }).catch((error: unknown) => error);
    assert.ok(dropped instanceof Error);
    assert.match(dropped.message, /WBNB unpriced: pool unreadable/);
  });

  it("fails the run when the chain read itself fails, writing nothing", async () => {
    const store = new MemoryStore();
    await assert.rejects(
      runMajorsPrices(store, signal(), {
        readSlot0s: async () => {
          throw new Error("all rpc endpoints failed");
        },
      }),
      /pool read failed/,
    );
    assert.equal(await store.get(tokenKey(WBNB)), null);
  });
});

describe("majors: routes", () => {
  function build(): { app: ReturnType<typeof createServer>; store: MemoryStore } {
    const store = new MemoryStore();
    // The token route reads `decimals()` through on a cache miss; this keeps
    // these price assertions off the chain.
    const readTokenDecimals = async (): Promise<DecimalsOutcome> => ({ kind: "unavailable" });
    return {
      app: createServer({ scheduler: createScheduler(store), store, readTokenDecimals }),
      store,
    };
  }

  it("GET /tokens/<WBNB> serves the price after the job ran", async () => {
    const { app, store } = build();
    await runMajorsPrices(store, signal(), { readSlot0s: fakeReader().read });

    const res = await app.request(`/tokens/${WBNB}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: TokenSnapshot; meta: Record<string, unknown> };
    assert.equal(body.data.priceUsd, EXPECTED_USD[WBNB]);
    assert.equal(body.data.symbol, "WBNB");
    assert.equal(body.meta["source"], MAJORS_PRICE_SOURCE);
    assert.equal(body.meta["staleness"], "fresh");
  });

  it("batch GET /tokens?addresses= includes both majors; unknown address still 404", async () => {
    const { app, store } = build();
    await runMajorsPrices(store, signal(), { readSlot0s: fakeReader().read });

    const batch = await app.request(`/tokens?addresses=${WBNB},${USDT}`);
    assert.equal(batch.status, 200);
    const body = (await batch.json()) as { data: TokenSnapshot[]; meta: { found: number } };
    assert.equal(body.meta.found, 2);
    const prices = Object.fromEntries(body.data.map((row) => [row.address, row.priceUsd]));
    assert.equal(prices[WBNB], EXPECTED_USD[WBNB]);
    assert.equal(prices[USDT], 1);

    const unknown = await app.request("/tokens/0x00000000000000000000000000000000000000ff");
    assert.equal(unknown.status, 404);
  });
});
