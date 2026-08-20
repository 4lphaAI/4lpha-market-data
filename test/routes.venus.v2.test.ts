import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import {
  VENUS_CHAIN_ID,
  VENUS_CORE_COMPTROLLER,
  VENUS_TRACKING_NAMESPACE,
  exact,
  venusCoreAccountKey,
  venusCoreRewardsKey,
  type VenusCoreAccountSnapshotV2,
  type VenusCoreRewardsSnapshotV2,
} from "../src/core/venus.js";
import { createServer } from "../src/server.js";

const OWNER = "0xd8d6ea18fe17b0b1d0d873e547907b6eeac962fa";
const TOKEN = "venus-test-token";
const originalToken = process.env["DP_AUTH_TOKEN"];

afterEach(() => {
  if (originalToken === undefined) delete process.env["DP_AUTH_TOKEN"];
  else process.env["DP_AUTH_TOKEN"] = originalToken;
});

const contracts = {
  comptroller: VENUS_CORE_COMPTROLLER,
  oracle: "0x0000000000000000000000000000000000000001",
  deviationBoundedOracle: "0x0000000000000000000000000000000000000002",
  vaiController: "0x0000000000000000000000000000000000000003",
  xvs: "0x0000000000000000000000000000000000000004",
  primeV2: "0x0000000000000000000000000000000000000005",
};

function account(): VenusCoreAccountSnapshotV2 {
  const zeroRisk = {
    collateral: exact(0n, 18), debt: exact(0n, 18), liquidity: exact(0n, 18), shortfall: exact(0n, 18), healthFactor: null,
  };
  return {
    schemaVersion: 2,
    chainId: VENUS_CHAIN_ID,
    pool: "core",
    owner: OWNER,
    status: "available",
    block: { number: "1", hash: `0x${"1".repeat(64)}`, timestamp: "1" },
    observedAt: 1,
    contracts,
    eMode: { userPoolId: "0", label: "Core", active: true, allowCorePoolFallback: true, supported: true },
    vaiDebt: exact(0n, 18),
    protocolSnapshot: {
      borrowingPower: zeroRisk,
      liquidationRisk: zeroRisk,
      borrowingPowerCheck: { errorCode: "0", liquidity: exact(0n, 18), shortfall: exact(0n, 18), matched: true },
      liquidationCheck: { errorCode: "0", liquidity: exact(0n, 18), shortfall: exact(0n, 18), matched: true },
    },
    fullyAccruedEstimate: { borrowingPower: zeroRisk, liquidationRisk: zeroRisk, kind: "fully_accrued_estimate" },
    wakeRiskHealthFactor: null,
    wakeRiskStatus: "available",
    economicLiquidationCondition: { protocolShortfall: false, forcedMarket: false, forcedVai: false, effective: false },
    positions: [],
    unavailable: [],
  };
}

function rewards(): VenusCoreRewardsSnapshotV2 {
  return {
    schemaVersion: 2,
    chainId: VENUS_CHAIN_ID,
    pool: "core",
    owner: OWNER,
    status: "available",
    block: { number: "1", hash: `0x${"1".repeat(64)}`, timestamp: "1" },
    observedAt: 1,
    contracts,
    primeHolder: false,
    rewards: [],
    unavailable: [],
  };
}

describe("Venus v2 routes", () => {
  it("never exposes internal registration when DP_AUTH_TOKEN is unset", async () => {
    delete process.env["DP_AUTH_TOKEN"];
    const store = new MemoryStore();
    const app = createServer({ scheduler: createScheduler(store), store });
    const response = await app.request(`/internal/venus/core/tracked-owners/${OWNER}/agent-a`, { method: "PUT" });
    assert.equal(response.status, 503);
  });

  it("registers first, refreshes independently, and serves account and rewards", async () => {
    process.env["DP_AUTH_TOKEN"] = TOKEN;
    const store = new MemoryStore();
    const app = createServer({
      scheduler: createScheduler(store),
      store,
      refreshVenusRisk: async (targetStore, owner) => {
        const value = { ...account(), owner };
        await targetStore.put(venusCoreAccountKey(owner), value, { source: "test", freshForMs: 1_000, deadAfterMs: 2_000 });
        return value;
      },
      refreshVenusRewards: async (targetStore, owner) => {
        const value = { ...rewards(), owner };
        await targetStore.put(venusCoreRewardsKey(owner), value, { source: "test", freshForMs: 1_000, deadAfterMs: 2_000 });
        return value;
      },
    });
    const headers = { "x-dp-token": TOKEN };
    const registered = await app.request(`/internal/venus/core/tracked-owners/${OWNER}/agent-a`, { method: "PUT", headers });
    assert.equal(registered.status, 201);
    assert.deepEqual(await store.listTrackedSubjects(VENUS_TRACKING_NAMESPACE), [OWNER]);
    assert.equal((await app.request(`/venus/core/accounts/${OWNER}`, { headers })).status, 200);
    assert.equal((await app.request(`/venus/core/accounts/${OWNER}/rewards`, { headers })).status, 200);

    const removed = await app.request(`/internal/venus/core/tracked-owners/${OWNER}/agent-a`, { method: "DELETE", headers });
    assert.equal(removed.status, 200);
    assert.equal(((await removed.json()) as { data: { tracked: boolean } }).data.tracked, false);
  });

  it("distinguishes tracked-pending from untracked", async () => {
    process.env["DP_AUTH_TOKEN"] = TOKEN;
    const store = new MemoryStore();
    await store.addTrackingReference(VENUS_TRACKING_NAMESPACE, OWNER, "agent", 1_000);
    const app = createServer({ scheduler: createScheduler(store), store });
    const headers = { "x-dp-token": TOKEN };
    assert.equal((await app.request(`/venus/core/accounts/${OWNER}`, { headers })).status, 202);
    assert.equal((await app.request("/venus/core/accounts/0x0000000000000000000000000000000000000009", { headers })).status, 404);
  });
});
