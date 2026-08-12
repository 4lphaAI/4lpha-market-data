import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import { createServer } from "../src/server.js";
import {
  ELIGIBILITY_TTL,
  FOURMEME_TOKEN_MANAGER2,
  decideEligibility,
  eligibilityKey,
  isEligible,
  isEligibleBatch,
  loadAllowlist,
  type ChainOutcomes,
  type EligibilityResult,
  type FlapOutcome,
  type FlapState,
  type FourMemeState,
  type HelperOutcome,
} from "../src/query/eligibility.js";
import { COINS_UNIVERSE_KEY } from "../src/universe.js";

/** In the frozen snapshot. */
const USDT = "0x55d398326f99059ff775485246999027b3197955";
/** Not in the snapshot; stands in for a Four.Meme launch. */
const MEME = "0x061b1b1132dadf00aad85c422197d655e759ffff";
/** Not in the snapshot; stands in for a Flap launch (they all carry a vanity suffix). */
const FLAP = "0x8a1f09317964f3cd3f768d563b509e0da3e37777";

/**
 * Shaped from a real `getTokenInfo` response, verified against a raw `eth_call`
 * on BSC (word 0 = 2, word 1 = TokenManager2, word 11 = liquidityAdded).
 */
function fourMeme(state: Partial<FourMemeState> = {}): HelperOutcome {
  return {
    kind: "answered",
    state: {
      version: 2,
      tokenManager: FOURMEME_TOKEN_MANAGER2.toLowerCase(),
      quote: "0x0000000000000000000000000000000000000000",
      launchTime: 1_738_872_868,
      liquidityAdded: false,
      ...state,
    },
  };
}

/**
 * Shaped from a real `getTokenV8Safe` response on BSC mainnet: a TOKEN_TAXED_V3
 * token still on its curve, quoted in BNB, 3% both ways.
 */
function flapToken(state: Partial<FlapState> = {}): FlapOutcome {
  return {
    kind: "answered",
    state: {
      status: 1,
      tokenVersion: 6,
      quote: "0x0000000000000000000000000000000000000000",
      nativeToQuoteSwapEnabled: false,
      pool: "0x0000000000000000000000000000000000000000",
      progress: "435630522931182972",
      buyTaxBps: 300,
      sellTaxBps: 300,
      ...state,
    },
  };
}

/** Neither launchpad claims the token — the ordinary negative on both sides. */
const ABSENT = { kind: "absent" } as const;

/** Both reads, defaulted to "not ours" so each test states only what it varies. */
function chain(over: Partial<ChainOutcomes> = {}): ChainOutcomes {
  return { fourmeme: ABSENT, flap: ABSENT, ...over };
}

/** A reader that fails the test if the chain is touched at all. */
const forbidChain = async (): Promise<ChainOutcomes> => {
  assert.fail("chain must not be read on this path");
};

describe("loadAllowlist", () => {
  it("indexes the frozen snapshot by lowercased address", () => {
    const allowlist = loadAllowlist();
    assert.notEqual(allowlist, null);
    // 221 of the snapshot's 222: the BNB entry is the sentinel `"native"`, which
    // has no contract address and is therefore never asked about by address.
    assert.equal(allowlist!.size, 221);
    assert.equal(allowlist!.has("native"), false);
    assert.ok(allowlist!.has(USDT));
    // The snapshot itself is lowercase; a checksummed address only hits because
    // callers lowercase before looking up. Asserted so that stays true.
    assert.equal(allowlist!.has("0x55d398326f99059fF775485246999027B3197955"), false);
    assert.equal(allowlist!.has(MEME), false);
  });
});

describe("decideEligibility", () => {
  it("admits an allowlisted token without a chain answer", () => {
    const result = decideEligibility(USDT, "allowlist", null);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, "allowlist");
    assert.equal(result.source, "allowlist");
    // Allowlisted tokens carry no venue: they route by ordinary pool discovery.
    assert.equal(result.venue, null);
  });

  it("admits a Binance Alpha token without a chain answer", () => {
    const result = decideEligibility(MEME, "binance-alpha", null);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, "binance_alpha");
    assert.equal(result.source, "binance-alpha");
    // Same as the allowlist: no venue, it routes by ordinary pool discovery.
    assert.equal(result.venue, null);
  });

  it("admits a Four.Meme token and routes it to the bonding curve", () => {
    const result = decideEligibility(MEME, null,chain({ fourmeme: fourMeme() }));
    assert.equal(result.eligible, true);
    assert.equal(result.reason, "fourmeme_factory");
    assert.equal(result.source, "fourmeme");
    assert.equal(result.venue, "fourmeme-bonding");
    assert.equal(result.fourmeme?.launchTime, 1_738_872_868);
    assert.equal(result.flap, null);
  });

  it("routes a graduated Four.Meme token to PancakeSwap", () => {
    const outcomes = chain({ fourmeme: fourMeme({ liquidityAdded: true }) });
    const result = decideEligibility(MEME, null,outcomes);
    assert.equal(result.eligible, true);
    assert.equal(result.venue, "pancake-v2");
  });

  it("denies a token the helper has never heard of", () => {
    // Measured behaviour: the helper returns a zero-filled struct rather than
    // reverting, so version 0 is the ordinary negative answer.
    const outcomes = chain({ fourmeme: fourMeme({ version: 0 }) });
    const result = decideEligibility(MEME, null,outcomes);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "not_listed");
    assert.equal(result.fourmeme, null);
  });

  it("denies a Four.Meme token on a TokenManager version with no trade path", () => {
    const outcomes = chain({ fourmeme: fourMeme({ version: 1 }) });
    const result = decideEligibility(MEME, null,outcomes);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "unsupported_token_manager");
    // The state is still reported, so an operator can see why it was refused.
    assert.equal(result.fourmeme?.version, 1);
  });

  it("admits a Flap token and routes it to the Flap curve", () => {
    const result = decideEligibility(FLAP, null,chain({ flap: flapToken() }));
    assert.equal(result.eligible, true);
    assert.equal(result.reason, "flap_portal");
    assert.equal(result.source, "flap");
    assert.equal(result.venue, "flap-bonding");
    assert.equal(result.flap?.sellTaxBps, 300);
    assert.equal(result.fourmeme, null);
  });

  it("routes a graduated Flap token to PancakeSwap", () => {
    // Measured: all eight graduated tokens sampled carried a pool on the
    // PancakeSwap V2 factory, and the lens stops pricing them once it is set.
    const outcomes = chain({
      flap: flapToken({
        status: 4,
        pool: "0x25a85d181a8d9e66fd1f0da3dddd79c980b1a74f",
        progress: "1000000000000000000",
      }),
    });
    const result = decideEligibility(FLAP, null,outcomes);
    assert.equal(result.eligible, true);
    assert.equal(result.venue, "pancake-v2");
    assert.equal(result.flap?.pool, "0x25a85d181a8d9e66fd1f0da3dddd79c980b1a74f");
  });

  it("denies a Flap token that is staged but not yet deployed", () => {
    const outcomes = chain({ flap: flapToken({ status: 5 }) });
    const result = decideEligibility(FLAP, null,outcomes);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "unsupported_flap_status");
    assert.equal(result.flap?.status, 5);
  });

  it("carries a non-native quote through, rather than denying on it", () => {
    // Flap tokens quoted in a bStock are routine, not an edge case. The gate
    // reports the quote and lets the execution plane decide how to acquire it —
    // the same treatment Four.Meme's `quote` field gets.
    const outcomes = chain({
      flap: flapToken({ quote: "0x7138b48df7d98d7e3cc221bfe7192d0a178182d8" }),
    });
    const result = decideEligibility(FLAP, null,outcomes);
    assert.equal(result.eligible, true);
    assert.equal(result.flap?.quote, "0x7138b48df7d98d7e3cc221bfe7192d0a178182d8");
  });

  it("denies when neither launchpad claims the token", () => {
    const result = decideEligibility(MEME, null,chain());
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "not_listed");
  });

  it("denies when the chain could not be read", () => {
    const outcomes = chain({ fourmeme: { kind: "unavailable" }, flap: { kind: "unavailable" } });
    const result = decideEligibility(MEME, null,outcomes);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "chain_unavailable");
    assert.equal(result.source, null);
  });

  it("denies with chain_unavailable when only one launchpad could be read", () => {
    // The whole point of the fail-closed rule: a token the Flap Portal would
    // have admitted must not come back as a flat `not_listed` just because
    // Four.Meme answered first. `not_listed` is cached; `chain_unavailable` is
    // not, so mislabelling here would freeze the denial past the outage.
    const outcomes = chain({ fourmeme: fourMeme({ version: 0 }), flap: { kind: "unavailable" } });
    const result = decideEligibility(FLAP, null,outcomes);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "chain_unavailable");
  });

  it("still admits a Four.Meme token while the Flap read is failing", () => {
    const outcomes = chain({ fourmeme: fourMeme(), flap: { kind: "unavailable" } });
    const result = decideEligibility(MEME, null,outcomes);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, "fourmeme_factory");
  });

  it("still admits a Flap token while the Four.Meme read is failing", () => {
    const outcomes = chain({ fourmeme: { kind: "unavailable" }, flap: flapToken() });
    const result = decideEligibility(FLAP, null,outcomes);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, "flap_portal");
  });

  it("denies everything when the allowlist could not be loaded", () => {
    const result = decideEligibility(MEME, null,null);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "allowlist_unavailable");
  });

  it("denies a malformed address before anything else", () => {
    const result = decideEligibility("0xnot-an-address", "allowlist", chain({ fourmeme: fourMeme() }));
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "invalid_address");
  });

  it("stays JSON-serializable, so a verdict can be stored and served", () => {
    // `progress` is a uint256 on chain. Held as a bigint it would throw here,
    // taking down both the route and the snapshot write.
    const outcomes = chain({ flap: flapToken({ status: 4, progress: "1000000000000000000" }) });
    const result = decideEligibility(FLAP, null,outcomes);
    assert.doesNotThrow(() => JSON.stringify(result));
    assert.equal(JSON.parse(JSON.stringify(result)).flap.progress, "1000000000000000000");
  });
});

describe("isEligible", () => {
  it("answers an allowlisted token from the snapshot alone", async () => {
    const result = await isEligible(new MemoryStore(), {
      address: USDT.toUpperCase(),
      readState: forbidChain,
    });
    assert.equal(result.eligible, true);
    assert.equal(result.reason, "allowlist");
    assert.equal(result.address, USDT);
  });

  it("denies a malformed address without reading anything", async () => {
    const result = await isEligible(new MemoryStore(), {
      address: "not-an-address",
      readState: forbidChain,
    });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "invalid_address");
  });

  it("answers an Alpha-listed token from a fresh coins snapshot alone", async () => {
    const store = new MemoryStore();
    await store.put(COINS_UNIVERSE_KEY, [{ address: MEME, symbol: "ALPHA" }], {
      source: "binance",
      freshForMs: 60_000,
      deadAfterMs: 120_000,
    });

    const result = await isEligible(store, { address: MEME, readState: forbidChain });
    assert.equal(result.eligible, true);
    assert.equal(result.reason, "binance_alpha");
    assert.equal(result.source, "binance-alpha");
    assert.equal(result.cached, false);
  });

  it("ignores a stale coins snapshot and falls through to the chain", async () => {
    const store = new MemoryStore();
    // Fresh for zero milliseconds: stale the instant it lands. The rule must go
    // silent rather than trust an old membership list — fail-closed.
    await store.put(COINS_UNIVERSE_KEY, [{ address: MEME, symbol: "ALPHA" }], {
      source: "binance",
      freshForMs: 0,
      deadAfterMs: 120_000,
    });

    let reads = 0;
    const result = await isEligible(store, {
      address: MEME,
      readState: async () => {
        reads += 1;
        return chain();
      },
    });
    assert.equal(reads, 1);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "not_listed");
  });

  it("admits a token newly added to the Alpha list over a cached denial", async () => {
    const store = new MemoryStore();
    const denied: EligibilityResult = {
      address: MEME,
      eligible: false,
      reason: "not_listed",
      source: null,
      venue: null,
      fourmeme: null,
      flap: null,
      checkedAt: Date.now(),
      cached: false,
    };
    await store.put(eligibilityKey(MEME), denied, {
      source: "eligibility",
      ...ELIGIBILITY_TTL.ineligible,
    });
    await store.put(COINS_UNIVERSE_KEY, [{ address: MEME, symbol: "ALPHA" }], {
      source: "binance",
      freshForMs: 60_000,
      deadAfterMs: 120_000,
    });

    const result = await isEligible(store, { address: MEME, readState: forbidChain });
    assert.equal(result.eligible, true);
    assert.equal(result.reason, "binance_alpha");
  });

  it("caches a definite verdict and serves it without re-reading the chain", async () => {
    const store = new MemoryStore();
    let reads = 0;
    const readState = async (): Promise<ChainOutcomes> => {
      reads += 1;
      return chain({ fourmeme: fourMeme() });
    };

    const first = await isEligible(store, { address: MEME, readState });
    const second = await isEligible(store, { address: MEME, readState });

    assert.equal(reads, 1);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.eligible, true);
    assert.equal(second.venue, "fourmeme-bonding");
  });

  it("re-reads rather than serving a stale verdict", async () => {
    const store = new MemoryStore();
    // Written with a zero freshness window, so it is stale the instant it lands.
    const stale: EligibilityResult = {
      address: FLAP,
      eligible: true,
      reason: "flap_portal",
      source: "flap",
      venue: "flap-bonding",
      fourmeme: null,
      flap: null,
      checkedAt: Date.now(),
      cached: false,
    };
    await store.put(eligibilityKey(FLAP), stale, {
      source: "eligibility",
      freshForMs: 0,
      deadAfterMs: ELIGIBILITY_TTL.eligible.deadAfterMs,
    });

    let reads = 0;
    const result = await isEligible(store, {
      address: FLAP,
      readState: async () => {
        reads += 1;
        // The token graduated since the stale entry was written.
        return chain({ flap: flapToken({ status: 4, progress: "1000000000000000000" }) });
      },
    });

    assert.equal(reads, 1);
    assert.equal(result.cached, false);
    assert.equal(result.venue, "pancake-v2");
  });

  it("does not cache an outage, so denial ends when the chain comes back", async () => {
    const store = new MemoryStore();
    const outcomes: ChainOutcomes[] = [
      chain({ fourmeme: { kind: "unavailable" }, flap: { kind: "unavailable" } }),
      chain({ flap: flapToken() }),
    ];
    let call = 0;
    const readState = async (): Promise<ChainOutcomes> => outcomes[call++]!;

    const during = await isEligible(store, { address: FLAP, readState });
    assert.equal(during.eligible, false);
    assert.equal(during.reason, "chain_unavailable");
    assert.equal(await store.get(eligibilityKey(FLAP)), null);

    const after = await isEligible(store, { address: FLAP, readState });
    assert.equal(after.eligible, true);
    assert.equal(after.cached, false);
  });
});

describe("isEligibleBatch", () => {
  it("preserves input order across the concurrency limit", async () => {
    const store = new MemoryStore();
    // More than BATCH_CONCURRENCY, so the worker pool actually interleaves.
    const addresses = Array.from(
      { length: 20 },
      (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`,
    );
    addresses[5] = USDT;

    const results = await isEligibleBatch(store, addresses, {
      readState: async (address) => {
        if (address.endsWith("3")) return chain({ fourmeme: fourMeme() });
        if (address.endsWith("7")) return chain({ flap: flapToken() });
        return chain({ fourmeme: fourMeme({ version: 0 }) });
      },
    });

    assert.equal(results.length, addresses.length);
    for (const [index, result] of results.entries()) {
      assert.equal(result.address, addresses[index]);
    }
    assert.equal(results[5]?.reason, "allowlist");
    assert.equal(results[2]?.reason, "fourmeme_factory");
    assert.equal(results[6]?.reason, "flap_portal");
    assert.equal(results[0]?.reason, "not_listed");
  });
});

describe("GET /eligibility", () => {
  /*
   * These drive the real route, so every address used here must resolve without
   * a chain read: allowlisted, malformed, or already cached. An unknown address
   * would reach BSC, and the suite is offline by contract.
   */
  function build(): ReturnType<typeof createServer> {
    const store = new MemoryStore();
    return createServer({ scheduler: createScheduler(store), store });
  }

  function record(value: unknown): Record<string, unknown> {
    assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
    return value as Record<string, unknown>;
  }

  it("answers a single allowlisted token", async () => {
    const res = await build().request(`/eligibility/${USDT}`);
    assert.equal(res.status, 200);
    const data = record(record(await res.json())["data"]);
    assert.equal(data["eligible"], true);
    assert.equal(data["reason"], "allowlist");
  });

  it("answers a malformed address with a verdict, not a 400", async () => {
    // A gate that 404s or 400s invites the caller to treat the error as
    // "unknown, carry on"; an explicit ineligible verdict cannot be misread.
    const res = await build().request("/eligibility/not-an-address");
    assert.equal(res.status, 200);
    const data = record(record(await res.json())["data"]);
    assert.equal(data["eligible"], false);
    assert.equal(data["reason"], "invalid_address");
  });

  it("keeps malformed entries in a batch instead of dropping them", async () => {
    const res = await build().request(`/eligibility?addresses=${USDT},nonsense`);
    assert.equal(res.status, 200);
    const body = record(await res.json());
    const data = body["data"];
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 2);
    assert.equal(record(data[1])["reason"], "invalid_address");
    assert.equal(record(body["meta"])["eligible"], 1);
  });

  it("rejects a batch with no addresses", async () => {
    const res = await build().request("/eligibility?addresses=");
    assert.equal(res.status, 400);
    assert.equal(record(record(await res.json())["error"])["code"], "missing_addresses");
  });

  it("caps the batch size", async () => {
    const addresses = Array.from({ length: 51 }, () => USDT).join(",");
    const res = await build().request(`/eligibility?addresses=${addresses}`);
    assert.equal(res.status, 400);
    assert.equal(record(record(await res.json())["error"])["code"], "too_many_addresses");
  });
});
