import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  combinePoolApr,
  fetchCakePriceUsd,
  fetchPancakeFarmedPools,
  fetchPancakePoolApr,
  fetchPancakePoolList,
  fetchPancakePoolStats,
  fetchPoolStats,
  normalizeExplorerPool,
  normalizeExplorerPoolRow,
  poolKey,
  seedPools,
  toAprPercent,
  withCakeFarm,
} from "../src/adapters/pancake.js";
import { fakeFetch, jsonResponse, textResponse } from "./helpers.js";

const POOL = "0xCC2bFfaeC373a6004bb6cCc8a62Cdd66061f7C6a";
const LOWER = POOL.toLowerCase();

/**
 * A live per-pool explorer response, trimmed to the fields the normalizer reads.
 * `feeUSD24h` and `protocolFeeUSD24h` are kept deliberately: they are the two
 * fields an APR must *not* be derived from.
 */
const EXPLORER_POOL = {
  id: LOWER,
  token0: {
    id: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436",
    symbol: "NVDAB",
    decimals: 18,
  },
  token1: {
    id: "0x55d398326f99059ff775485246999027b3197955",
    symbol: "USDT",
    decimals: 18,
  },
  feeTier: 500,
  liquidity: "1947475966191175457735",
  sqrtPrice: "1187202354464281119897578974267",
  tick: 54143,
  tvlUSD: "3209.6914354648143",
  volumeUSD24h: "2596.37578719614",
  feeUSD24h: "1.29818789359809",
  protocolFeeUSD24h: "0.44138388382335",
};

/** The APR endpoint's payload: fractions, not percentages. */
const EXPLORER_APR = {
  apr24h: "0.108307337277915",
  apr7d: "0.0964881220145",
  volumeUSD24h: "82435956.504111377708213335666903386841816",
};

/** A live list row. Note it carries no liquidity, sqrtPrice or tick. */
const LIST_ROW = {
  id: "0x172fcd41e0913e95784454622d1c3724f546f849",
  chainId: 56,
  protocol: "v3",
  feeTier: 100,
  tvlUSD: "18619755.030171722",
  volumeUSD24h: "82435956.504111377",
  apr24h: "0.108307337277915",
  token0: { id: "0x55d398326f99059ff775485246999027b3197955", symbol: "USDT", decimals: 18 },
  token1: { id: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", symbol: "WBNB", decimals: 18 },
};

describe("seed pools", () => {
  it("lists the verified V3 pools, lowercased and unique", () => {
    const pools = seedPools();
    assert.equal(pools.length, 6);
    assert.equal(new Set(pools).size, pools.length);
    for (const pool of pools) assert.match(pool, /^0x[0-9a-f]{40}$/u);
  });

  it("returns a fresh array so callers cannot corrupt the static list", () => {
    seedPools().push("0xdeadbeef");
    assert.equal(seedPools().length, 6);
  });

  it("namespaces the store key by pool address", () => {
    assert.equal(poolKey(POOL), `pool:${LOWER}`);
  });
});

describe("toAprPercent", () => {
  it("converts the upstream fraction to a percentage", () => {
    // The exact pair PancakeSwap's UI showed for quq/USDT: 232.72% LP fee APR.
    assert.equal(toAprPercent("2.32715979009727"), 232.72);
    assert.equal(toAprPercent("0.108307337277915"), 10.83);
  });

  it("keeps a real zero rather than collapsing it to absent", () => {
    assert.equal(toAprPercent("0"), 0);
    assert.equal(toAprPercent(0), 0);
  });

  it("treats a missing or impossible value as absent", () => {
    assert.equal(toAprPercent(undefined), null);
    assert.equal(toAprPercent(""), null);
    assert.equal(toAprPercent("n/a"), null);
    // Fees cannot be negative; carrying one through into a sum would understate.
    assert.equal(toAprPercent("-0.5"), null);
  });
});

describe("combinePoolApr", () => {
  it("adds the two components the way the PancakeSwap UI does", () => {
    // quq/USDT as displayed: 232.72 LP fee + 14.97 farm = 247.69 combined.
    assert.equal(combinePoolApr(232.72, 14.97), 247.69);
  });

  it("keeps an unfarmed pool's combined APR equal to its fee APR", () => {
    assert.equal(combinePoolApr(89.62, 0), 89.62);
  });

  it("is absent when either component is unknown", () => {
    assert.equal(combinePoolApr(10, null), null);
    assert.equal(combinePoolApr(null, 3), null);
    assert.equal(combinePoolApr(null, null), null);
  });
});

describe("withCakeFarm", () => {
  const base = normalizeExplorerPoolRow(LIST_ROW);

  it("records both components and their sum", () => {
    assert.ok(base !== null);
    const stats = withCakeFarm(base, { pid: 137, allocPoint: 1645, cakePerYear: 100 }, 3.19);
    assert.equal(stats.cakeFarmApr, 3.19);
    assert.equal(stats.combinedApr, 14.02);
    assert.deepEqual(stats.aprSources, ["lpFee", "cakeFarm"]);
    assert.deepEqual(stats.farm, { pid: 137, allocPoint: 1645, cakePerYear: 100 });
  });

  it("distinguishes a pool that earns no CAKE from one nobody asked about", () => {
    assert.ok(base !== null);
    const unfarmed = withCakeFarm(base, null, 0);
    assert.equal(unfarmed.combinedApr, 10.83);
    assert.deepEqual(unfarmed.aprSources, ["lpFee", "cakeFarm"]);

    const unasked = withCakeFarm(base, null, null);
    assert.equal(unasked.combinedApr, null);
    assert.deepEqual(unasked.aprSources, ["lpFee"]);
  });
});

describe("normalizeExplorerPoolRow", () => {
  it("maps a list row onto PoolStats with the APR as a percentage", () => {
    const stats = normalizeExplorerPoolRow(LIST_ROW);
    assert.ok(stats !== null);
    assert.equal(stats.pool, LIST_ROW.id);
    assert.equal(stats.protocol, "v3");
    assert.equal(stats.token0Symbol, "USDT");
    assert.equal(stats.token1Symbol, "WBNB");
    assert.equal(stats.fee, 100);
    assert.equal(stats.tvlUsd, 18619755.030171722);
    assert.equal(stats.lpFeeApr24h, 10.83);
    assert.deepEqual(stats.aprSources, ["lpFee"]);
  });

  it("leaves chain state null, since the list endpoint does not carry it", () => {
    const stats = normalizeExplorerPoolRow(LIST_ROW);
    assert.equal(stats?.liquidity, null);
    assert.equal(stats?.sqrtPriceX96, null);
    assert.equal(stats?.tick, null);
  });

  it("re-checks the protocol and chain filters instead of trusting them", () => {
    // An Infinity row carries a 32-byte pool id where consumers expect an address.
    assert.equal(normalizeExplorerPoolRow({ ...LIST_ROW, protocol: "infinityCl" }), null);
    assert.equal(normalizeExplorerPoolRow({ ...LIST_ROW, protocol: undefined }), null);
    assert.equal(normalizeExplorerPoolRow({ ...LIST_ROW, chainId: 8453 }), null);
  });

  it("rejects a row without the pool identity fields", () => {
    assert.equal(normalizeExplorerPoolRow({ ...LIST_ROW, id: "not-an-address" }), null);
    assert.equal(normalizeExplorerPoolRow({ ...LIST_ROW, token0: null }), null);
    assert.equal(normalizeExplorerPoolRow({ ...LIST_ROW, feeTier: "n/a" }), null);
    assert.equal(normalizeExplorerPoolRow(null), null);
    assert.equal(normalizeExplorerPoolRow([LIST_ROW]), null);
  });

  it("keeps a row whose APR is missing, without an lpFee source", () => {
    const stats = normalizeExplorerPoolRow({ ...LIST_ROW, apr24h: undefined });
    assert.equal(stats?.lpFeeApr24h, null);
    assert.deepEqual(stats?.aprSources, []);
  });
});

describe("normalizeExplorerPool", () => {
  it("maps the explorer payload onto PoolStats", () => {
    const stats = normalizeExplorerPool(POOL, EXPLORER_POOL);
    assert.ok(stats !== null);
    assert.equal(stats.pool, LOWER);
    assert.equal(stats.protocol, "v3");
    assert.equal(stats.token0, "0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
    assert.equal(stats.token1, "0x55d398326f99059ff775485246999027b3197955");
    assert.equal(stats.token0Symbol, "NVDAB");
    assert.equal(stats.token1Symbol, "USDT");
    assert.equal(stats.fee, 500);
    assert.equal(stats.liquidity, "1947475966191175457735");
    assert.equal(stats.sqrtPriceX96, "1187202354464281119897578974267");
    assert.equal(stats.tick, 54143);
    assert.equal(stats.source, "pancake");
  });

  it("keeps liquidity and sqrtPrice as strings so no precision is lost", () => {
    const stats = normalizeExplorerPool(POOL, EXPLORER_POOL);
    assert.ok(stats !== null);
    assert.ok(stats.liquidity !== null && stats.sqrtPriceX96 !== null);
    // Both exceed Number.MAX_SAFE_INTEGER; round-tripping must be exact.
    assert.equal(BigInt(stats.liquidity).toString(), "1947475966191175457735");
    assert.equal(BigInt(stats.sqrtPriceX96).toString(), "1187202354464281119897578974267");
  });

  it("never derives an APR from the fee totals in the payload", () => {
    const stats = normalizeExplorerPool(POOL, EXPLORER_POOL);
    // feeUSD24h / tvlUSD * 365 * 100 would be 14.76% — gross of the protocol
    // fee, and roughly 1.5x what an LP actually receives. Without the APR
    // endpoint the honest answer is that the APR is unknown.
    assert.equal(stats?.lpFeeApr24h, null);
    assert.equal(stats?.lpFeeApr7d, null);
    assert.deepEqual(stats?.aprSources, []);
  });

  it("carries an APR reading through when one was supplied", () => {
    const stats = normalizeExplorerPool(POOL, EXPLORER_POOL, {
      lpFeeApr24h: 10.83,
      lpFeeApr7d: 9.65,
    });
    assert.equal(stats?.lpFeeApr24h, 10.83);
    assert.equal(stats?.lpFeeApr7d, 9.65);
    assert.deepEqual(stats?.aprSources, ["lpFee"]);
    // The farm half is a separate read; it is unknown here, not zero.
    assert.equal(stats?.cakeFarmApr, null);
    assert.equal(stats?.combinedApr, null);
  });

  it("keeps a real zero volume distinct from an absent one", () => {
    assert.equal(normalizeExplorerPool(POOL, { ...EXPLORER_POOL, volumeUSD24h: "0" })?.volume24hUsd, 0);
    assert.equal(
      normalizeExplorerPool(POOL, { ...EXPLORER_POOL, volumeUSD24h: null })?.volume24hUsd,
      null,
    );
  });

  it("rejects a payload without the pool identity fields", () => {
    assert.equal(normalizeExplorerPool(POOL, { ...EXPLORER_POOL, token0: null }), null);
    assert.equal(normalizeExplorerPool(POOL, { ...EXPLORER_POOL, feeTier: "n/a" }), null);
    assert.equal(normalizeExplorerPool(POOL, { ...EXPLORER_POOL, liquidity: "1.5e21" }), null);
    assert.equal(normalizeExplorerPool(POOL, null), null);
    assert.equal(normalizeExplorerPool(POOL, [EXPLORER_POOL]), null);
  });

  it("tolerates a missing symbol without losing the pool", () => {
    const stats = normalizeExplorerPool(POOL, {
      ...EXPLORER_POOL,
      token0: { id: EXPLORER_POOL.token0.id },
    });
    assert.equal(stats?.token0Symbol, null);
    assert.equal(stats?.token0, EXPLORER_POOL.token0.id);
  });
});

describe("fetchPancakePoolList", () => {
  const page = { hasNextPage: true, endCursor: "cursor-2", rows: [LIST_ROW] };

  it("asks for one BSC V3 page at the endpoint's own maximum size", async () => {
    const fake = fakeFetch(() => jsonResponse(page));
    await fetchPancakePoolList({ fetchFn: fake.fetch });

    const url = new URL(fake.calls[0]?.url ?? "https://example.invalid");
    assert.equal(url.host, "explorer.pancakeswap.com");
    assert.equal(url.pathname, "/api/cached/pools/list");
    assert.equal(url.searchParams.get("chains"), "bsc");
    assert.equal(url.searchParams.get("protocols"), "v3");
    assert.equal(url.searchParams.get("orderBy"), "tvlUSD");
    // Anything above 50 is silently truncated upstream, so 50 is what we ask for.
    assert.equal(url.searchParams.get("limit"), "50");
    assert.equal(url.searchParams.get("after"), null);
  });

  it("passes the cursor through and reports whether more pages remain", async () => {
    const fake = fakeFetch(() => jsonResponse(page));
    const result = await fetchPancakePoolList({ after: "cursor-1", fetchFn: fake.fetch });

    const url = new URL(fake.calls[0]?.url ?? "https://example.invalid");
    assert.equal(url.searchParams.get("after"), "cursor-1");
    assert.equal(result.endCursor, "cursor-2");
    assert.equal(result.hasNextPage, true);
    assert.equal(result.rows.length, 1);
  });

  it("drops rows it cannot trust and keeps the rest of the page", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({
        hasNextPage: false,
        endCursor: null,
        rows: [LIST_ROW, { ...LIST_ROW, protocol: "infinityCl" }, { junk: true }],
      }),
    );
    const result = await fetchPancakePoolList({ fetchFn: fake.fetch });
    assert.equal(result.rows.length, 1);
    assert.equal(result.hasNextPage, false);
    assert.equal(result.endCursor, null);
  });

  it("rejects a payload that is not a page", async () => {
    const fake = fakeFetch(() => jsonResponse([LIST_ROW]));
    await assert.rejects(
      () => fetchPancakePoolList({ fetchFn: fake.fetch }),
      /unexpected pool list payload/u,
    );
  });
});

describe("fetchPancakeFarmedPools", () => {
  it("reads the unpaginated farming list for BSC V3", async () => {
    const fake = fakeFetch(() => jsonResponse([LIST_ROW]));
    const rows = await fetchPancakeFarmedPools({ fetchFn: fake.fetch });

    const url = new URL(fake.calls[0]?.url ?? "https://example.invalid");
    assert.equal(url.pathname, "/api/cached/pools/farming");
    assert.equal(url.searchParams.get("chains"), "bsc");
    assert.equal(url.searchParams.get("protocols"), "v3");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.pool, LIST_ROW.id);
  });

  it("refuses a validation complaint rather than reading it as no farms", async () => {
    // The endpoint answers `{type:"validation"}` with HTTP 200 when its query is
    // wrong; treating that as an empty list would silence every farm at once.
    const fake = fakeFetch(() => jsonResponse({ type: "validation", on: "query" }));
    await assert.rejects(
      () => fetchPancakeFarmedPools({ fetchFn: fake.fetch }),
      /unexpected farming payload/u,
    );
  });
});

describe("fetchPancakePoolApr", () => {
  it("reads both windows and converts them to percentages", async () => {
    const fake = fakeFetch(() => jsonResponse(EXPLORER_APR));
    const apr = await fetchPancakePoolApr({ address: POOL, fetchFn: fake.fetch });

    const url = new URL(fake.calls[0]?.url ?? "https://example.invalid");
    assert.equal(url.pathname, `/api/cached/pools/apr/v3/bsc/${LOWER}`);
    assert.equal(apr.lpFeeApr24h, 10.83);
    assert.equal(apr.lpFeeApr7d, 9.65);
  });

  it("rejects a payload that is not an APR reading", async () => {
    const fake = fakeFetch(() => jsonResponse([EXPLORER_APR]));
    await assert.rejects(
      () => fetchPancakePoolApr({ address: POOL, fetchFn: fake.fetch }),
      /unexpected pool apr payload/u,
    );
  });
});

describe("fetchCakePriceUsd", () => {
  const KEY = "56:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82";

  it("reads the price from the explorer's own index", async () => {
    const fake = fakeFetch(() => jsonResponse({ [KEY]: { priceUSD: "1.4529147910410678" } }));
    const price = await fetchCakePriceUsd({ fetchFn: fake.fetch });

    const url = new URL(fake.calls[0]?.url ?? "https://example.invalid");
    assert.equal(url.pathname, `/api/cached/tokens/price/list/${KEY}`);
    assert.equal(price, 1.4529147910410678);
  });

  it("matches the response key regardless of address casing", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({ "56:0x0E09FABB73BD3Ade0a17ECC321fD13a19e81cE82": { priceUSD: "2" } }),
    );
    assert.equal(await fetchCakePriceUsd({ fetchFn: fake.fetch }), 2);
  });

  it("refuses a missing or nonsensical price rather than returning zero", async () => {
    for (const body of [{}, { [KEY]: {} }, { [KEY]: { priceUSD: "0" } }]) {
      const fake = fakeFetch(() => jsonResponse(body));
      await assert.rejects(
        () => fetchCakePriceUsd({ fetchFn: fake.fetch }),
        /cake price unavailable/u,
      );
    }
  });
});

describe("fetchPancakePoolStats", () => {
  /** Routes the pool read and the APR read to different bodies. */
  function explorer(apr: Response | null): ReturnType<typeof fakeFetch> {
    return fakeFetch((call) => {
      if (call.url.includes("/pools/apr/")) {
        return apr ?? textResponse("gateway", 502);
      }
      return jsonResponse(EXPLORER_POOL);
    });
  }

  it("requests the pool and its APR together, with the lowercased address", async () => {
    const fake = explorer(jsonResponse(EXPLORER_APR));
    const stats = await fetchPancakePoolStats({ address: POOL, fetchFn: fake.fetch });

    const paths = fake.calls.map((call) => new URL(call.url).pathname).sort();
    assert.deepEqual(paths, [
      `/api/cached/pools/apr/v3/bsc/${LOWER}`,
      `/api/cached/pools/v3/bsc/${LOWER}`,
    ]);
    assert.equal(stats.lpFeeApr24h, 10.83);
    assert.equal(stats.lpFeeApr7d, 9.65);
  });

  it("sends no credential header", async () => {
    const fake = explorer(jsonResponse(EXPLORER_APR));
    await fetchPancakePoolStats({ address: POOL, fetchFn: fake.fetch });
    const headers = fake.calls[0]?.headers ?? {};
    assert.equal(headers["x-apikey"], undefined);
    assert.equal(headers["authorization"], undefined);
  });

  it("keeps the pool when the APR endpoint fails, without inventing an APR", async () => {
    const fake = explorer(null);
    const stats = await fetchPancakePoolStats({ address: POOL, fetchFn: fake.fetch });
    assert.equal(stats.pool, LOWER);
    assert.equal(stats.tvlUsd, 3209.6914354648143);
    assert.equal(stats.lpFeeApr24h, null);
    assert.deepEqual(stats.aprSources, []);
  });

  it("rejects a payload that is not a pool", async () => {
    const fake = fakeFetch(() => jsonResponse({ message: "internal error" }));
    await assert.rejects(
      () => fetchPancakePoolStats({ address: POOL, fetchFn: fake.fetch }),
      /unexpected pool payload/u,
    );
  });

  it("surfaces an upstream failure as a sanitized error", async () => {
    const fake = fakeFetch(() => textResponse("boom", 500));
    await assert.rejects(
      () => fetchPancakePoolStats({ address: POOL, fetchFn: fake.fetch }),
      /upstream responded 500/u,
    );
  });
});

describe("fetchPoolStats", () => {
  it("serves the explorer result without touching the chain", async () => {
    const fake = fakeFetch((call) =>
      jsonResponse(call.url.includes("/pools/apr/") ? EXPLORER_APR : EXPLORER_POOL),
    );
    const stats = await fetchPoolStats({ address: POOL, fetchFn: fake.fetch, rpcUrls: [] });
    assert.equal(stats.source, "pancake");
    assert.equal(stats.tvlUsd, 3209.6914354648143);
    assert.equal(stats.lpFeeApr24h, 10.83);
  });

  it("reports the explorer failure when the chain fallback also fails", async () => {
    const fake = fakeFetch(() => textResponse("gateway", 502));
    await assert.rejects(
      // An empty endpoint list makes the on-chain path fail immediately.
      () => fetchPoolStats({ address: POOL, fetchFn: fake.fetch, rpcUrls: [] }),
      /upstream responded 502/u,
    );
  });
});
