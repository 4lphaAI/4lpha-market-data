import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStore } from "../src/core/store.js";
import { emptyHolderStats, type HolderStats } from "../src/core/models.js";
import {
  HOLDERS_DEAD_AFTER_MS,
  getHolders,
  holdersKey,
  type HolderFetchers,
} from "../src/query/holders.js";
import { AdapterError, MissingCredentialsError } from "../src/adapters/http.js";

const TOKEN = "0x061b1b1132dadf00aad85c422197d655e759ffff";

function holderRead(over: Partial<HolderStats> = {}): HolderStats {
  return { ...emptyHolderStats("gmgn", Date.now()), holders: 1_234, top10Pct: 41.5, ...over };
}

function smartRead(count: number): HolderStats {
  return { ...emptyHolderStats("gmgn", Date.now()), smartMoneyCount: count };
}

function fetchers(over: Partial<HolderFetchers> = {}): HolderFetchers {
  return {
    holders: async () => holderRead(),
    smartMoney: async () => smartRead(7),
    ...over,
  };
}

describe("getHolders", () => {
  it("merges the two GMGN reads and caches the result", async () => {
    const store = new MemoryStore();
    const result = await getHolders(store, { address: TOKEN, fetchers: fetchers() });

    assert.notEqual(result, null);
    assert.equal(result!.stats.holders, 1_234);
    assert.equal(result!.stats.top10Pct, 41.5);
    assert.equal(result!.stats.smartMoneyCount, 7);
    assert.equal(result!.staleness, "fresh");

    const written = await store.get<HolderStats>(holdersKey(TOKEN));
    assert.equal(written?.data.smartMoneyCount, 7);
  });

  it("issues the two reads strictly in sequence, never in parallel", async () => {
    // GMGN's burst limit is per IP and its penalty is a host-wide ban, so an
    // overlap here is not slowness, it is an outage waiting to happen.
    let inFlight = 0;
    const guard = async <T>(value: T): Promise<T> => {
      inFlight += 1;
      assert.equal(inFlight, 1, "reads overlapped");
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return value;
    };

    const result = await getHolders(new MemoryStore(), {
      address: TOKEN,
      fetchers: {
        holders: () => guard(holderRead()),
        smartMoney: () => guard(smartRead(3)),
      },
    });
    assert.equal(result?.stats.smartMoneyCount, 3);
  });

  it("serves a fresh cache without touching the upstream", async () => {
    const store = new MemoryStore();
    const forbid = async (): Promise<HolderStats> => {
      assert.fail("upstream must not be dialed on a fresh cache");
    };

    await getHolders(store, { address: TOKEN, fetchers: fetchers() });
    const second = await getHolders(store, {
      address: TOKEN,
      fetchers: { holders: forbid, smartMoney: forbid },
    });
    assert.equal(second?.stats.holders, 1_234);
  });

  it("keeps the surviving half when one read fails", async () => {
    const result = await getHolders(new MemoryStore(), {
      address: TOKEN,
      fetchers: fetchers({
        smartMoney: async () => {
          throw new AdapterError("gmgn", "rate limited", 429);
        },
      }),
    });
    assert.equal(result?.stats.holders, 1_234);
    assert.equal(result?.stats.smartMoneyCount, null);
  });

  it("serves the stale record when the upstream contributes nothing", async () => {
    const store = new MemoryStore();
    // Written stale-on-arrival, so the read path must go upstream and fail
    // before falling back to it.
    await store.put(holdersKey(TOKEN), holderRead({ holders: 999 }), {
      source: "gmgn",
      freshForMs: 0,
      deadAfterMs: HOLDERS_DEAD_AFTER_MS,
    });

    const fail = async (): Promise<HolderStats> => {
      throw new MissingCredentialsError("gmgn");
    };
    const result = await getHolders(store, {
      address: TOKEN,
      fetchers: { holders: fail, smartMoney: fail },
    });
    assert.equal(result?.stats.holders, 999);
    assert.equal(result?.staleness, "stale");
  });

  it("returns null for a malformed address without dialing", async () => {
    const forbid = async (): Promise<HolderStats> => {
      assert.fail("upstream must not be dialed for a malformed address");
    };
    const result = await getHolders(new MemoryStore(), {
      address: "not-an-address",
      fetchers: { holders: forbid, smartMoney: forbid },
    });
    assert.equal(result, null);
  });

  it("returns null when nothing is cached and nothing answered", async () => {
    const fail = async (): Promise<HolderStats> => {
      throw new AdapterError("gmgn", "down");
    };
    const result = await getHolders(new MemoryStore(), {
      address: TOKEN,
      fetchers: { holders: fail, smartMoney: fail },
    });
    assert.equal(result, null);
  });
});
