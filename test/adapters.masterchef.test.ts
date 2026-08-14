import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MASTERCHEF_V3,
  clearPidCache,
  computeCakeFarmApr,
  fetchCakeEmissions,
} from "../src/adapters/masterchefV3.js";

describe("computeCakeFarmApr", () => {
  it("reproduces the farm APR PancakeSwap's UI shows", () => {
    // quq/USDT, measured on chain 2026-08-14: cakePerSecond 0.051376979369288193
    // (raw 51376979369288192401149691358 / 1e12 / 1e18), allocPoint 529 of 6526,
    // TVL $1,275,645, CAKE $1.4529147910410678. The UI showed 14.97% against the
    // same snapshot; the remaining hundredth is the price moving between reads.
    const cakePerYear = 0.051376979369288193 * (529 / 6526) * 31_536_000;
    assert.equal(computeCakeFarmApr(cakePerYear, 1.4529147910410678, 1_275_645), 14.96);
  });

  it("scales linearly with the allocation share", () => {
    const perYear = 100_000;
    assert.equal(computeCakeFarmApr(perYear, 2, 1_000_000), 20);
    assert.equal(computeCakeFarmApr(perYear / 2, 2, 1_000_000), 10);
  });

  it("reports zero emissions as a real zero, whatever the price", () => {
    assert.equal(computeCakeFarmApr(0, 1.45, 1_000_000), 0);
    // Even without a price: no emissions is no yield, and that much is known.
    assert.equal(computeCakeFarmApr(0, null, 1_000_000), 0);
  });

  it("is absent — not zero — when a price or TVL is missing", () => {
    // A missing input must never read as "this pool pays nothing"; that is the
    // difference between an unfarmed pool and an unanswered question.
    assert.equal(computeCakeFarmApr(100_000, null, 1_000_000), null);
    assert.equal(computeCakeFarmApr(100_000, 1.45, null), null);
    assert.equal(computeCakeFarmApr(100_000, 0, 1_000_000), null);
    assert.equal(computeCakeFarmApr(100_000, 1.45, 0), null);
  });

  it("rejects an impossible emission rate rather than propagating it", () => {
    assert.equal(computeCakeFarmApr(-1, 1.45, 1_000_000), null);
    assert.equal(computeCakeFarmApr(Number.NaN, 1.45, 1_000_000), null);
  });
});

describe("fetchCakeEmissions", () => {
  it("targets MasterChefV3 on BSC", () => {
    assert.match(MASTERCHEF_V3, /^0x[0-9a-fA-F]{40}$/u);
    assert.equal(MASTERCHEF_V3.toLowerCase(), "0x556b9306565093c855aea9ae92a594704c2cd59e");
  });

  it("performs no read at all when there is nothing to resolve", async () => {
    // An empty endpoint list would fail any real call, so reaching a result
    // proves the chain was never dialled.
    const result = await fetchCakeEmissions({ pools: [], rpcUrls: [] });
    assert.equal(result.farms.size, 0);
    assert.equal(result.cakePerSecond, 0);
    assert.equal(result.totalAllocPoint, 0);
  });

  it("ignores addresses that are not addresses", async () => {
    const result = await fetchCakeEmissions({ pools: ["not-an-address", ""], rpcUrls: [] });
    assert.equal(result.farms.size, 0);
  });

  it("fails loudly when no endpoint answers, rather than reporting no farms", async () => {
    // A silent empty map would turn an RPC outage into "nothing earns CAKE",
    // which understates every farmed pool's APR instead of leaving it unknown.
    await assert.rejects(
      () =>
        fetchCakeEmissions({
          pools: ["0x9485ff32b6b4444c21d5abe4d9a2283d127075a2"],
          rpcUrls: ["https://a.invalid", "https://b.invalid"],
        }),
      /all rpc endpoints failed/u,
    );
    // Nothing was verified, so nothing may have been remembered.
    clearPidCache();
  });
});
