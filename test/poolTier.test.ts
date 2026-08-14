import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStore } from "../src/core/store.js";
import type { PoolStats, PoolTier } from "../src/core/models.js";
import {
  LAUNCHPAD_ORIGINS_KEY,
  PANCAKE_TOKEN_LIST_KEY,
  type OriginIndex,
  classifyPool,
  labelPools,
  loadOriginIndex,
  resolveOrigin,
} from "../src/query/poolTier.js";
import type { LaunchpadOrigin } from "../src/query/eligibility.js";
import { COINS_UNIVERSE_KEY } from "../src/universe.js";
import { fakeFetch, jsonResponse, textResponse } from "./helpers.js";

const USDT = "0x55d398326f99059ff775485246999027b3197955";
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const MEME = "0x1111111111111111111111111111111111111111";
const FLAPPED = "0x2222222222222222222222222222222222222222";
const LISTED = "0x3333333333333333333333333333333333333333";
const STRANGER = "0x4444444444444444444444444444444444444444";

function index(overrides: Partial<OriginIndex> = {}): OriginIndex {
  return {
    fourmeme: new Set([MEME]),
    flap: new Set([FLAPPED]),
    allowlist: new Set([USDT, WBNB]),
    alpha: new Set(),
    pancakeList: new Set([LISTED]),
    ...overrides,
  };
}

function pool(token0: string, token1: string, tier: PoolTier = "unclassified"): PoolStats {
  return {
    pool: "0x9999999999999999999999999999999999999999",
    protocol: "v3",
    token0,
    token1,
    token0Symbol: null,
    token1Symbol: null,
    fee: 100,
    liquidity: null,
    sqrtPriceX96: null,
    tick: null,
    tvlUsd: 1000,
    volume24hUsd: 100,
    lpFeeApr24h: 10,
    lpFeeApr7d: 10,
    cakeFarmApr: 0,
    combinedApr: 10,
    aprSources: ["lpFee", "cakeFarm"],
    farm: null,
    tier,
    tokenOrigin: { token0: "unknown", token1: "unknown" },
    asOf: 1,
    source: "pancake",
  };
}

describe("resolveOrigin", () => {
  it("answers from every source the plane already holds", () => {
    const built = index({ alpha: new Set([STRANGER]) });
    assert.equal(resolveOrigin(built, MEME), "fourmeme");
    assert.equal(resolveOrigin(built, FLAPPED), "flap");
    assert.equal(resolveOrigin(built, USDT), "allowlist");
    assert.equal(resolveOrigin(built, STRANGER), "alpha");
    assert.equal(resolveOrigin(built, LISTED), "pancake-list");
  });

  it("prefers the launchpad, which is the sharper fact about a token", () => {
    // A graduated Four.Meme token can also be on a curated list; saying it came
    // off a bonding curve says more than saying somebody listed it.
    const built = index({ pancakeList: new Set([MEME]), allowlist: new Set([MEME]) });
    assert.equal(resolveOrigin(built, MEME), "fourmeme");
  });

  it("is case-insensitive about the address it is asked", () => {
    assert.equal(resolveOrigin(index(), USDT.toUpperCase()), "allowlist");
  });

  it("says unknown rather than guessing", () => {
    assert.equal(resolveOrigin(index(), STRANGER), "unknown");
    // With the frozen allowlist unreadable, even a listed token falls through.
    assert.equal(resolveOrigin(index({ allowlist: null }), USDT), "unknown");
  });
});

describe("classifyPool", () => {
  it("labels a pool of two curated tokens core", () => {
    const result = classifyPool(index(), pool(USDT, WBNB));
    assert.equal(result.tier, "core");
    assert.deepEqual(result.tokenOrigin, { token0: "allowlist", token1: "allowlist" });
  });

  it("accepts PancakeSwap's own list as curation", () => {
    assert.equal(classifyPool(index(), pool(USDT, LISTED)).tier, "core");
  });

  it("labels a launchpad token paired with a known quote degen", () => {
    const result = classifyPool(index(), pool(USDT, MEME));
    assert.equal(result.tier, "degen");
    assert.deepEqual(result.tokenOrigin, { token0: "allowlist", token1: "fourmeme" });
    assert.equal(classifyPool(index(), pool(WBNB, FLAPPED)).tier, "degen");
  });

  it("leaves a pool unclassified when either side is a stranger", () => {
    // The wash-traded pairs at the top of the raw lane are exactly this shape:
    // two tokens nothing recognizes, quoting each other into a fabricated price.
    assert.equal(classifyPool(index(), pool(STRANGER, STRANGER)).tier, "unclassified");
    assert.equal(classifyPool(index(), pool(USDT, STRANGER)).tier, "unclassified");
    // Including a real launchpad token whose quote token is unaccounted for.
    assert.equal(classifyPool(index(), pool(MEME, STRANGER)).tier, "unclassified");
  });

  it("keeps the two tiers disjoint", () => {
    // A launchpad token can never satisfy `core`, so no pool can qualify twice.
    const built = index({ allowlist: new Set([USDT, MEME]) });
    assert.equal(classifyPool(built, pool(USDT, MEME)).tier, "degen");
  });
});

describe("labelPools", () => {
  it("writes the tier and the evidence behind it", () => {
    const [labelled] = labelPools(index(), [pool(USDT, WBNB)]);
    assert.equal(labelled?.tier, "core");
    assert.deepEqual(labelled?.tokenOrigin, { token0: "allowlist", token1: "allowlist" });
  });

  it("keeps an existing label rather than downgrading it to unclassified", () => {
    // Provenance does not change; an `unclassified` verdict on a pool that was
    // labelled before is nearly always a source being unavailable, not news.
    const empty = index({ fourmeme: new Set(), flap: new Set(), allowlist: new Set() });
    const [labelled] = labelPools(empty, [pool(USDT, MEME, "degen")]);
    assert.equal(labelled?.tier, "degen");
  });

  it("still replaces one real label with another", () => {
    const [labelled] = labelPools(index(), [pool(USDT, MEME, "core")]);
    assert.equal(labelled?.tier, "degen");
  });

  it("skips the pass entirely when the frozen allowlist cannot be read", () => {
    // Every verdict would be shaped by the absence rather than by the tokens —
    // the same reason the eligibility gate refuses to answer without it.
    const pools = [pool(USDT, WBNB, "core"), pool(USDT, MEME)];
    const result = labelPools(index({ allowlist: null }), pools);
    assert.deepEqual(result, pools);
  });
});

describe("loadOriginIndex", () => {
  async function putLane(store: MemoryStore, key: string, addresses: string[]): Promise<void> {
    await store.put(
      key,
      addresses.map((address) => ({ address, symbol: "X" })),
      { source: "test", freshForMs: 600_000, deadAfterMs: 3_600_000 },
    );
  }

  async function putTokenList(store: MemoryStore, addresses: string[]): Promise<void> {
    await store.put(PANCAKE_TOKEN_LIST_KEY, addresses, {
      source: "pancake",
      freshForMs: 86_400_000,
      deadAfterMs: 604_800_000,
    });
  }

  /** Stands in for the launchpad contracts. */
  function originsFor(map: Record<string, LaunchpadOrigin>) {
    const asked: string[][] = [];
    const read = async (tokens: string[]): Promise<Map<string, LaunchpadOrigin>> => {
      asked.push(tokens);
      return new Map(tokens.map((token) => [token, map[token] ?? "none"]));
    };
    return { read, asked };
  }

  it("resolves launchpad origin from the chain, not from a ranking lane", async () => {
    const store = new MemoryStore();
    await putLane(store, COINS_UNIVERSE_KEY, [STRANGER]);
    await putTokenList(store, [LISTED]);
    const chain = originsFor({ [MEME]: "fourmeme", [FLAPPED]: "flap" });

    const built = await loadOriginIndex(store, {
      fetchFn: fakeFetch(() => jsonResponse({})).fetch,
      tokens: [MEME, FLAPPED, USDT],
      readOrigins: chain.read,
    });

    assert.equal(resolveOrigin(built, MEME), "fourmeme");
    assert.equal(resolveOrigin(built, FLAPPED), "flap");
    assert.equal(resolveOrigin(built, STRANGER), "alpha");
    assert.equal(resolveOrigin(built, LISTED), "pancake-list");
  });

  it("asks about a token once and never again", async () => {
    const store = new MemoryStore();
    await putTokenList(store, [LISTED]);
    const chain = originsFor({ [MEME]: "fourmeme" });
    const options = {
      fetchFn: fakeFetch(() => jsonResponse({})).fetch,
      readOrigins: chain.read,
    };

    await loadOriginIndex(store, { ...options, tokens: [MEME, USDT] });
    assert.deepEqual(chain.asked, [[MEME, USDT]]);

    // Provenance is permanent, so a second cycle over the same tokens must not
    // put a single call back on the chain.
    const second = await loadOriginIndex(store, { ...options, tokens: [MEME, USDT] });
    assert.equal(chain.asked.length, 1);
    assert.equal(resolveOrigin(second, MEME), "fourmeme");

    // A token it has never seen is still asked about, on its own.
    await loadOriginIndex(store, { ...options, tokens: [MEME, USDT, FLAPPED] });
    assert.deepEqual(chain.asked[1], [FLAPPED]);
  });

  it("does not record a negative it could not actually read", async () => {
    const store = new MemoryStore();
    await putTokenList(store, [LISTED]);
    const options = {
      fetchFn: fakeFetch(() => jsonResponse({})).fetch,
      readOrigins: async (): Promise<Map<string, LaunchpadOrigin>> => {
        throw new Error("all rpc endpoints failed");
      },
    };

    const built = await loadOriginIndex(store, { ...options, tokens: [MEME] });
    assert.equal(resolveOrigin(built, MEME), "unknown");
    // The cache is forever, so an outage must not be written into it as `none`.
    assert.equal(await store.get(LAUNCHPAD_ORIGINS_KEY), null);
  });

  it("re-validates the stored cache and ignores entries it cannot read", async () => {
    const store = new MemoryStore();
    await putTokenList(store, [LISTED]);
    await store.put(
      LAUNCHPAD_ORIGINS_KEY,
      { [MEME]: "fourmeme", [STRANGER]: "not-a-launchpad", "junk-key": "flap" },
      { source: "pool-tier", freshForMs: 86_400_000, deadAfterMs: 86_400_000 },
    );

    const built = await loadOriginIndex(store, {
      fetchFn: fakeFetch(() => jsonResponse({})).fetch,
    });
    assert.equal(resolveOrigin(built, MEME), "fourmeme");
    assert.equal(resolveOrigin(built, STRANGER), "unknown");
  });

  it("costs a fixed handful of store reads whatever the lane size", async () => {
    const store = new MemoryStore();
    await putTokenList(store, [LISTED]);
    const fake = fakeFetch(() => jsonResponse({}));

    await loadOriginIndex(store, { fetchFn: fake.fetch });
    // A fresh cached list means no upstream call at all, and with no `tokens`
    // asked for, no chain read either.
    assert.equal(fake.calls.length, 0);
  });

  it("refreshes the token list once it has aged out", async () => {
    let now = 1_000_000;
    const store = new MemoryStore(() => now);
    await putTokenList(store, [LISTED]);
    now += 2 * 86_400_000;

    const fake = fakeFetch(() =>
      jsonResponse({ tokens: [{ chainId: 56, address: STRANGER }, { chainId: 1, address: MEME }] }),
    );
    const built = await loadOriginIndex(store, { fetchFn: fake.fetch });

    assert.equal(fake.calls.length, 1);
    assert.equal(resolveOrigin(built, STRANGER), "pancake-list");
    // Another chain's entry is not a BSC token.
    assert.equal(resolveOrigin(built, MEME), "unknown");
    assert.deepEqual((await store.get<string[]>(PANCAKE_TOKEN_LIST_KEY))?.data, [STRANGER]);
  });

  it("falls back to the aged copy when the refresh fails", async () => {
    let now = 1_000_000;
    const store = new MemoryStore(() => now);
    await putTokenList(store, [LISTED]);
    now += 2 * 86_400_000;

    const built = await loadOriginIndex(store, {
      fetchFn: fakeFetch(() => textResponse("gateway", 502)).fetch,
    });
    // Yesterday's editorial decisions are still true today; dropping the list
    // would unlabel every pool that depends on it.
    assert.equal(resolveOrigin(built, LISTED), "pancake-list");
  });

  it("survives a store with no lanes in it at all", async () => {
    const store = new MemoryStore();
    const built = await loadOriginIndex(store, {
      fetchFn: fakeFetch(() => textResponse("nope", 500)).fetch,
    });
    assert.equal(built.fourmeme.size, 0);
    assert.equal(built.pancakeList.size, 0);
    // The frozen allowlist is a file, not a lane, so it is still there.
    assert.notEqual(built.allowlist, null);
  });
});
