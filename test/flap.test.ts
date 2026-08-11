import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyTokenSnapshot } from "../src/core/models.js";
import { MemoryStore } from "../src/core/store.js";
import { MissingCredentialsError } from "../src/adapters/http.js";
import { normalizePriceInfoRows } from "../src/adapters/onchainos.js";
import { readTokenSnapshot } from "../src/jobs/tokenStore.js";
import {
  TOKEN_CREATED_TOPIC,
  decodeLaunches,
  isFlapTradable,
  type FlapLaunchScan,
  type FlapMarketState,
} from "../src/adapters/flap.js";
import {
  runFlapLaunches,
  selectLane,
  type FlapLaneRow,
} from "../src/jobs/flapLaunches.js";
import { FLAP_UNIVERSE_KEY, buildUniverse } from "../src/universe.js";

/**
 * A real `TokenCreated` log, captured from BSC block 115352193. Kept verbatim
 * rather than re-encoded in the test, so this asserts the decode against what
 * the Portal actually emits — including the measured fact that nothing in the
 * event is indexed, which is why there is exactly one topic.
 */
const REAL_LOG = {
  topics: [TOKEN_CREATED_TOPIC],
  data:
    "0x" +
    // ts, creator, nonce, token
    "000000000000000000000000000000000000000000000000000000006a7b5ad6" +
    "000000000000000000000000deadcfbb66dfd0830cba45c1802b50aa0b3261b1" +
    "00000000000000000000000000000000000000000000000000000000001dd951" +
    "000000000000000000000000096c955f71265b3969e5f8ba1df1c24328d67777" +
    // offsets to the three dynamic strings
    "00000000000000000000000000000000000000000000000000000000000000e0" +
    "0000000000000000000000000000000000000000000000000000000000000120" +
    "0000000000000000000000000000000000000000000000000000000000000160" +
    // name: 8 bytes, "Pump Bot"
    "0000000000000000000000000000000000000000000000000000000000000008" +
    "50756d7020426f74000000000000000000000000000000000000000000000000" +
    // symbol: 4 bytes, "Pump"
    "0000000000000000000000000000000000000000000000000000000000000004" +
    "50756d7000000000000000000000000000000000000000000000000000000000" +
    // meta: 59 bytes, the IPFS CID
    "000000000000000000000000000000000000000000000000000000000000003b" +
    "6261666b726569666a346d637268376a676368756c346b636a70647134766978" +
    "636872797676663271326b357a67773736646e6e76346f77336c340000000000",
};

const FLAP_TOKEN = "0x096c955f71265b3969e5f8ba1df1c24328d67777";

function state(over: Partial<FlapMarketState> = {}): FlapMarketState {
  return {
    status: 1,
    tokenVersion: 6,
    progress: "1000",
    quote: "0x0000000000000000000000000000000000000000",
    pool: "0x0000000000000000000000000000000000000000",
    buyTaxBps: 300,
    sellTaxBps: 300,
    ...over,
  };
}

function row(over: Partial<FlapLaneRow> = {}): FlapLaneRow {
  return {
    address: "0xaa00000000000000000000000000000000007777",
    symbol: "AAA",
    source: "flap",
    launchedAt: 1_000,
    progress: "0",
    status: 1,
    ...over,
  };
}

function scan(over: Partial<FlapLaunchScan> = {}): FlapLaunchScan {
  return { launches: [], fromBlock: 1, toBlock: 150, missedChunks: 0, ...over };
}

describe("decodeLaunches", () => {
  it("decodes a real TokenCreated log", () => {
    const [launch] = decodeLaunches([REAL_LOG]);
    assert.equal(launch?.address, FLAP_TOKEN);
    assert.equal(launch?.name, "Pump Bot");
    assert.equal(launch?.symbol, "Pump");
    assert.equal(launch?.creator, "0xdeadcfbb66dfd0830cba45c1802b50aa0b3261b1");
    assert.equal(launch?.meta, "bafkreifj4mcrh7jgchul4kcjpdq4vixchryvvf2q2k5zgw76dnnv4ow3l4");
    // ts 0x6a7b5ad6 seconds, surfaced as epoch milliseconds.
    assert.equal(launch?.launchedAt, 0x6a7b5ad6 * 1000);
  });

  it("ignores a Portal log that is not a launch", () => {
    // The measured reason this matters: the only public endpoint still serving
    // eth_getLogs returns the same logs whether or not a topic filter is passed,
    // so the server's filter cannot be the thing that keeps other events out.
    const other = { topics: ["0x115c78ad17c4763fb97bca94f3e59dc8cb2e59c9d3862f24a694ec401200f562"], data: "0x" };
    assert.deepEqual(decodeLaunches([other]), []);
    assert.equal(decodeLaunches([other, REAL_LOG]).length, 1);
  });

  it("skips a log carrying the right topic but undecodable data", () => {
    const truncated = { topics: [TOKEN_CREATED_TOPIC], data: "0xdeadbeef" };
    assert.deepEqual(decodeLaunches([truncated]), []);
  });
});

describe("isFlapTradable", () => {
  it("accepts only Tradable and DEX", () => {
    assert.equal(isFlapTradable(1), true);
    assert.equal(isFlapTradable(4), true);
    // Invalid, the obsolete InDuel/Killed, and the not-yet-deployed Staged.
    for (const status of [0, 2, 3, 5]) assert.equal(isFlapTradable(status), false);
  });
});

describe("selectLane", () => {
  it("keeps both the newest launches and the ones closest to graduation", () => {
    const rows = [
      row({ address: "0x01".padEnd(42, "0"), launchedAt: 9_000, progress: "0" }),
      row({ address: "0x02".padEnd(42, "0"), launchedAt: 1, progress: "900000000000000000" }),
    ];
    const selected = selectLane(rows).map((r) => r.address);
    // The old-but-hot token survives even though it is not among the newest.
    assert.equal(selected.length, 2);
    assert.ok(selected.includes("0x02".padEnd(42, "0")));
  });

  it("compares progress as a bigint, not a float", () => {
    // Two values that collide once they are pushed through Number().
    const low = "1000000000000000001";
    const high = "1000000000000000002";
    const rows = Array.from({ length: 60 }, (_, i) =>
      row({ address: `0x${(i + 10).toString(16).padStart(40, "0")}`, launchedAt: 0, progress: "0" }),
    );
    rows.push(row({ address: "0xaa".padEnd(42, "1"), launchedAt: 0, progress: low }));
    rows.push(row({ address: "0xbb".padEnd(42, "2"), launchedAt: 0, progress: high }));

    const selected = selectLane(rows).map((r) => r.address);
    assert.ok(selected.includes("0xbb".padEnd(42, "2")));
    assert.ok(selected.includes("0xaa".padEnd(42, "1")));
  });

  it("caps the lane at the two slices combined", () => {
    // Progress runs opposite to launch time, so "newest" and "hottest" pick
    // disjoint halves and the union is the full cap rather than one slice.
    const rows = Array.from({ length: 400 }, (_, i) =>
      row({ address: `0x${i.toString(16).padStart(40, "0")}`, launchedAt: i, progress: String(400 - i) }),
    );
    assert.equal(selectLane(rows).length, 100);
  });

  it("collapses to one slice when the same rows top both rankings", () => {
    const rows = Array.from({ length: 400 }, (_, i) =>
      row({ address: `0x${i.toString(16).padStart(40, "0")}`, launchedAt: i, progress: String(i) }),
    );
    // Newest and hottest are the same 50 tokens here, so the lane is 50, not
    // 100 — the cap is an upper bound, not a quota to fill.
    assert.equal(selectLane(rows).length, 50);
  });
});

describe("runFlapLaunches", () => {
  it("publishes decoded launches to the flap lane", async () => {
    const store = new MemoryStore();
    const result = await runFlapLaunches(store, AbortSignal.timeout(5_000), {
      scan: async () => scan({ launches: decodeLaunches([REAL_LOG]) }),
      readStates: async (addresses) => new Map(addresses.map((a) => [a, state()])),
    });

    assert.equal(result.discovered, 1);
    assert.equal(result.entries, 1);
    const stored = await store.get<FlapLaneRow[]>(FLAP_UNIVERSE_KEY);
    assert.equal(stored?.data[0]?.address, FLAP_TOKEN);
    assert.equal(stored?.data[0]?.symbol, "Pump");
    await store.close();
  });

  it("accumulates across cycles instead of keeping only the last window", async () => {
    const store = new MemoryStore();
    const readStates = async (addresses: string[]): Promise<Map<string, FlapMarketState>> =>
      new Map(addresses.map((a) => [a, state()]));

    const first = { ...row({ address: "0x0a".padEnd(42, "0"), launchedAt: 1 }) };
    await runFlapLaunches(store, AbortSignal.timeout(5_000), {
      scan: async () =>
        scan({ launches: [{ address: first.address, symbol: "A", name: "A", creator: "0x0", meta: "", launchedAt: 1 }] }),
      readStates,
    });
    const second = await runFlapLaunches(store, AbortSignal.timeout(5_000), {
      scan: async () =>
        scan({
          launches: [
            { address: "0x0b".padEnd(42, "0"), symbol: "B", name: "B", creator: "0x0", meta: "", launchedAt: 2 },
          ],
        }),
      readStates,
    });

    // The token from the first window is still there, even though the second
    // window did not contain it.
    assert.equal(second.entries, 2);
    await store.close();
  });

  it("prunes a token the Portal no longer reports as tradable", async () => {
    const store = new MemoryStore();
    const launches = [
      { address: "0x0a".padEnd(42, "0"), symbol: "A", name: "A", creator: "0x0", meta: "", launchedAt: 1 },
      { address: "0x0b".padEnd(42, "0"), symbol: "B", name: "B", creator: "0x0", meta: "", launchedAt: 2 },
    ];
    const result = await runFlapLaunches(store, AbortSignal.timeout(5_000), {
      scan: async () => scan({ launches }),
      readStates: async (addresses) =>
        new Map(
          addresses
            .filter((a) => a !== launches[1]!.address)
            .map((a) => [a, state()]),
        ),
    });

    // The one the lens did not answer for is gone: absence is TokenNotFound,
    // which is a real answer.
    assert.equal(result.entries, 1);
    assert.equal(result.pruned, 1);
    await store.close();
  });

  it("publishes unpruned rather than emptying the lane when the lens is unreadable", async () => {
    const store = new MemoryStore();
    const launches = [
      { address: "0x0a".padEnd(42, "0"), symbol: "A", name: "A", creator: "0x0", meta: "", launchedAt: 1 },
    ];
    const result = await runFlapLaunches(store, AbortSignal.timeout(5_000), {
      scan: async () => scan({ launches }),
      readStates: async () => {
        throw new Error("all rpc endpoints failed");
      },
    });

    // Opposite default to the eligibility gate on purpose: a universe lane that
    // empties on an RPC outage is worse than one carrying a stale row, and the
    // record's own age already says how much to trust it.
    assert.equal(result.entries, 1);
    assert.equal(result.pruned, 0);
    assert.equal(result.prunedSkipped, true);
    await store.close();
  });
});

describe("runFlapLaunches price enrichment", () => {
  const CURVE = "0x0a".padEnd(42, "0");
  const GRADUATED = "0x0b".padEnd(42, "0");

  async function twoTokens(): Promise<FlapLaunchScan> {
    return scan({
      launches: [
        { address: CURVE, symbol: "CURVE", name: "On Curve", creator: "0x0", meta: "", launchedAt: 1 },
        { address: GRADUATED, symbol: "GRAD", name: "Graduated", creator: "0x0", meta: "", launchedAt: 2 },
      ],
    });
  }

  const states = async (addresses: string[]): Promise<Map<string, FlapMarketState>> =>
    new Map(addresses.map((a) => [a, state({ status: a === GRADUATED ? 4 : 1 })]));

  it("asks OnchainOS only about the graduated rows", async () => {
    const store = new MemoryStore();
    let asked: string[] = [];
    const result = await runFlapLaunches(store, AbortSignal.timeout(5_000), {
      scan: twoTokens,
      readStates: states,
      readPrices: async (addresses) => {
        asked = addresses;
        return new Map([[GRADUATED, { ...emptyTokenSnapshot(GRADUATED), priceUsd: 0.0000106, holders: 132 }]]);
      },
    });

    // Measured: OKX has no data for a token still on its bonding curve, so
    // including it would spend the batch on a guaranteed empty answer.
    assert.deepEqual(asked, [GRADUATED]);
    assert.equal(result.enriched, 1);

    const snapshot = await readTokenSnapshot(store, GRADUATED);
    assert.equal(snapshot?.priceUsd, 0.0000106);
    assert.equal(snapshot?.holders, 132);
    assert.equal(await readTokenSnapshot(store, CURVE), null);
    await store.close();
  });

  it("tolerates OnchainOS dropping a token it has never indexed", async () => {
    const store = new MemoryStore();
    const result = await runFlapLaunches(store, AbortSignal.timeout(5_000), {
      scan: twoTokens,
      readStates: states,
      // A batch of n addresses can come back with fewer rows; the adapter keys
      // by the response's own address, so a missing one is simply not merged.
      readPrices: async () => new Map(),
      });

    assert.equal(result.enriched, 0);
    assert.equal(result.entries, 2);
    await store.close();
  });

  it("still publishes the lane when OnchainOS is unavailable", async () => {
    const store = new MemoryStore();
    const result = await runFlapLaunches(store, AbortSignal.timeout(5_000), {
      scan: twoTokens,
      readStates: states,
      readPrices: async () => {
        throw new MissingCredentialsError("onchainos");
      },
    });

    // Enrichment is a bonus on top of a lane that is already written; discovery
    // succeeded, so the cycle succeeded.
    assert.equal(result.enriched, 0);
    assert.equal(result.entries, 2);
    const stored = await store.get<FlapLaneRow[]>(FLAP_UNIVERSE_KEY);
    assert.equal(stored?.data.length, 2);
    await store.close();
  });
});

describe("normalizePriceInfoRows", () => {
  it("keys rows by the response's own address, not by request position", () => {
    // Shaped from a real price-info reply: four addresses were sent and two
    // rows came back, so position would have mismatched every field.
    const rows = normalizePriceInfoRows([
      {
        chainIndex: "56",
        tokenContractAddress: "0xC2C0FAEEB0BC7C9A7780377F3F5DFBA927777777",
        price: "0.00001064296056918005560453984851431194",
        marketCap: "10642.960569180055604539",
        volume24H: "35910.361110981507589034",
        holders: "132",
        priceChange24H: "32.01",
      },
      { chainIndex: "56", price: "1", marketCap: "2" },
    ]);

    assert.equal(rows.size, 1);
    const row = rows.get("0xc2c0faeeb0bc7c9a7780377f3f5dfba927777777");
    assert.equal(row?.holders, 132);
    assert.equal(row?.priceChange24hPct, 32.01);
    assert.equal(row?.marketCapUsd, 10642.960569180055604539);
  });
});

describe("buildUniverse with both launchpads", () => {
  const FOURMEME_TOKEN = "0xaa00000000000000000000000000000000000001";

  it("unions Flap into the meme lane and names both sources", async () => {
    const store = new MemoryStore();
    await store.put(
      "universe:meme",
      [{ address: FOURMEME_TOKEN, symbol: "MEME", source: "fourmeme" }],
      { source: "fourmeme", freshForMs: 60_000, deadAfterMs: 900_000 },
    );
    await store.put(
      FLAP_UNIVERSE_KEY,
      [{ address: FLAP_TOKEN, symbol: "Pump", name: "Pump Bot", source: "flap", launchedAt: 1, progress: "0", status: 1 }],
      { source: "flap", freshForMs: 60_000, deadAfterMs: 900_000 },
    );

    const universe = await buildUniverse(store);
    const byAddress = new Map(universe.entries.map((e) => [e.address, e]));

    assert.equal(universe.lanes.meme.count, 2);
    assert.equal(universe.lanes.meme.source, "fourmeme+flap");
    assert.equal(byAddress.get(FLAP_TOKEN)?.lane, "meme");
    assert.equal(byAddress.get(FLAP_TOKEN)?.source, "flap");
    assert.equal(byAddress.get(FOURMEME_TOKEN)?.source, "fourmeme");
    await store.close();
  });

  it("serves the lane from one launchpad when the other has never run", async () => {
    const store = new MemoryStore();
    await store.put(
      FLAP_UNIVERSE_KEY,
      [{ address: FLAP_TOKEN, symbol: "Pump", source: "flap" }],
      { source: "flap", freshForMs: 60_000, deadAfterMs: 900_000 },
    );

    const universe = await buildUniverse(store);
    assert.equal(universe.lanes.meme.count, 1);
    // A launchpad that has never written is not counted as stale.
    assert.equal(universe.lanes.meme.source, "flap");
    assert.equal(universe.lanes.meme.staleness, "fresh");
    await store.close();
  });

  it("reports the lane as only as fresh as its stalest launchpad", async () => {
    const store = new MemoryStore();
    await store.put(
      "universe:meme",
      [{ address: FOURMEME_TOKEN, symbol: "MEME", source: "fourmeme" }],
      { source: "fourmeme", freshForMs: 60_000, deadAfterMs: 900_000 },
    );
    await store.put(
      FLAP_UNIVERSE_KEY,
      [{ address: FLAP_TOKEN, symbol: "Pump", source: "flap" }],
      { source: "flap", freshForMs: 0, deadAfterMs: 900_000 },
    );

    const universe = await buildUniverse(store);
    assert.equal(universe.lanes.meme.staleness, "stale");
    assert.equal(universe.lanes.meme.count, 2);
    await store.close();
  });
});
