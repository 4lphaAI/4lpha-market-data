import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchDexScreenerTokenPairs, normalizeDexPairs } from "../src/adapters/dexScreener.js";
import { AdapterError } from "../src/adapters/http.js";
import { fakeFetch, jsonResponse } from "./helpers.js";
import { NVDAB_PAIRS } from "./rwaFixtures.js";

const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const USDT = "0x55d398326f99059ff775485246999027b3197955";



describe("normalizeDexPairs", () => {
  it("normalizes every pair, lowercases addresses, takes the first label as version", () => {
    const pairs = normalizeDexPairs(NVDAB_PAIRS);
    assert.equal(pairs.length, 5, "the row with a bad pair address is dropped");
    const [pcs, uni, v2, meme, topaz] = pairs;
    assert.equal(pcs!.pool, "0x8fb4243b553ac29ba088acf00b9b7da24bd6690c");
    assert.equal(pcs!.version, "v3");
    assert.equal(pcs!.base.address, NVDAB);
    assert.equal(pcs!.quote.symbol, "USDT");
    assert.equal(pcs!.liquidityUsd, 2729189.89);
    assert.equal(pcs!.txns24h, 10389);
    assert.equal(uni!.version, null, "Uniswap v3 pools arrive unlabelled");
    assert.equal(v2!.version, "v2");
    assert.equal(meme!.quote.address, NVDAB);
    assert.equal(meme!.txns24h, null);
    assert.equal(topaz!.dex, "topaz");
  });

  it("fetches one token's pairs and rejects a non-array payload", async () => {
    const fake = fakeFetch((call) => (call.url.endsWith(`/token-pairs/v1/bsc/${NVDAB}`) ? jsonResponse(NVDAB_PAIRS) : jsonResponse({ oops: 1 })));
    const pairs = await fetchDexScreenerTokenPairs({ address: NVDAB.toUpperCase(), fetchFn: fake.fetch });
    assert.equal(pairs.length, 5);
    await assert.rejects(fetchDexScreenerTokenPairs({ address: USDT, fetchFn: fake.fetch }), AdapterError);
  });
});
