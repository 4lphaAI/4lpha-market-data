import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStore } from "../src/core/store.js";
import {
  COINS_UNIVERSE_KEY,
  MEME_UNIVERSE_KEY,
  bstockAddresses,
  bstocksUniverse,
  buildUniverse,
} from "../src/universe.js";

const MEME_ONLY = "0xaa00000000000000000000000000000000000001";
const COIN_ONLY = "0xbb00000000000000000000000000000000000002";
/** AMDB — present in the static bStocks list. */
const SHARED = "0x75fd4cf6f8392e41e70391d60c90c0d5211603a1";

async function seed(store: MemoryStore): Promise<void> {
  await store.put(
    MEME_UNIVERSE_KEY,
    [
      { address: MEME_ONLY, symbol: "MEME", name: "Meme One", lane: "meme", source: "fourmeme" },
      { address: SHARED, symbol: "AMDB-MEME", lane: "meme", source: "fourmeme" },
      { address: COIN_ONLY, symbol: "COIN-MEME", lane: "meme", source: "fourmeme" },
    ],
    { source: "fourmeme", freshForMs: 60_000, deadAfterMs: 900_000 },
  );
  await store.put(
    COINS_UNIVERSE_KEY,
    [
      { address: COIN_ONLY, symbol: "COIN", lane: "coins", source: "binance" },
      { address: SHARED, symbol: "AMDB-ALPHA", lane: "coins", source: "binance" },
    ],
    { source: "binance", freshForMs: 43_200_000, deadAfterMs: 172_800_000 },
  );
}

describe("bstocksUniverse", () => {
  it("lists 25 unique lowercased BSC contracts tagged for US market hours", () => {
    const entries = bstocksUniverse();
    assert.equal(entries.length, 25);
    assert.equal(new Set(entries.map((entry) => entry.address)).size, 25);
    for (const entry of entries) {
      assert.match(entry.address, /^0x[0-9a-f]{40}$/u);
      assert.equal(entry.lane, "bstocks");
      assert.equal(entry.marketHours, "us-equities");
      assert.equal(entry.source, "static");
      assert.ok(entry.symbol.endsWith("B"));
    }
  });

  it("returns a fresh array so callers cannot corrupt the static list", () => {
    const first = bstocksUniverse();
    first.pop();
    assert.equal(bstocksUniverse().length, 25);
    assert.equal(bstockAddresses().length, 25);
  });
});

describe("buildUniverse", () => {
  it("returns only the static lane when no job has run", async () => {
    const store = new MemoryStore();
    const universe = await buildUniverse(store);

    assert.equal(universe.entries.length, 25);
    assert.deepEqual(universe.lanes.meme, {
      count: 0,
      staleness: null,
      asOf: null,
      source: "fourmeme",
    });
    assert.equal(universe.lanes.bstocks.count, 25);
    assert.equal(universe.lanes.bstocks.staleness, "fresh");
    await store.close();
  });

  it("dedups by address with bstocks > coins > meme precedence", async () => {
    const store = new MemoryStore();
    await seed(store);

    const universe = await buildUniverse(store);
    const byAddress = new Map(universe.entries.map((entry) => [entry.address, entry]));

    assert.equal(universe.entries.length, 27);
    assert.equal(byAddress.get(SHARED)?.lane, "bstocks");
    assert.equal(byAddress.get(SHARED)?.symbol, "AMDB");
    assert.equal(byAddress.get(COIN_ONLY)?.lane, "coins");
    assert.equal(byAddress.get(COIN_ONLY)?.symbol, "COIN");
    assert.equal(byAddress.get(MEME_ONLY)?.lane, "meme");
    await store.close();
  });

  it("reports per-lane counts and staleness", async () => {
    const store = new MemoryStore();
    await seed(store);

    const universe = await buildUniverse(store);
    assert.equal(universe.lanes.meme.count, 3);
    assert.equal(universe.lanes.meme.staleness, "fresh");
    assert.equal(typeof universe.lanes.meme.asOf, "number");
    assert.equal(universe.lanes.coins.count, 2);
    await store.close();
  });

  it("drops stored rows whose shape no longer validates", async () => {
    const store = new MemoryStore();
    await store.put(
      MEME_UNIVERSE_KEY,
      [null, "junk", { symbol: "no address" }, { address: "0xshort" }, { address: MEME_ONLY }],
      { source: "fourmeme", freshForMs: 60_000, deadAfterMs: 900_000 },
    );

    const universe = await buildUniverse(store);
    assert.equal(universe.lanes.meme.count, 1);
    assert.equal(universe.entries.find((entry) => entry.address === MEME_ONLY)?.symbol, "");
    await store.close();
  });

  it("ignores a stored payload that is not an array", async () => {
    const store = new MemoryStore();
    await store.put(COINS_UNIVERSE_KEY, { unexpected: true }, {
      source: "binance",
      freshForMs: 60_000,
      deadAfterMs: 900_000,
    });

    const universe = await buildUniverse(store);
    assert.equal(universe.lanes.coins.count, 0);
    assert.equal(universe.entries.length, 25);
    await store.close();
  });
});
