/**
 * Rule 5 of the eligibility gate — tokenized stocks. The veto precedes the
 * allowlist, the Alpha list and the cache; the positive follows them.
 * Everything here runs against the store only; the chain reader is forbidden.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { MemoryStore, PostgresStore } from "../src/core/store.js";
import type { SnapshotStore } from "../src/core/store.js";
import { createScheduler } from "../src/core/scheduler.js";
import { createServer } from "../src/server.js";
import {
  ELIGIBILITY_TTL,
  eligibilityKey,
  isEligible,
  isEligibleBatch,
  type ChainOutcomes,
  type EligibilityResult,
} from "../src/query/eligibility.js";
import { decideRwaVeto, loadRwaGateContext } from "../src/query/rwaGate.js";
import { RWA_FRESH_FOR_MS, normalizeRwaMembers, runBinanceRwa, type RwaMembers } from "../src/jobs/binanceRwa.js";
import { readTokenRecords, tokenKey } from "../src/jobs/tokenStore.js";
import { COINS_UNIVERSE_KEY, RWA_MEMBERS_KEY, RWA_UNIVERSE_KEY, RWA_VENUES_KEY, bstockAddresses, buildUniverse, venuePremiumBps } from "../src/universe.js";
import { FakePg } from "./fakePg.js";
import { fakeFetch, jsonResponse } from "./helpers.js";
import { ARQQON, ARQQON_ROW, NVDAB, NVDAB_ROW, USDT } from "./rwaFixtures.js";

const ok = (data: unknown) => jsonResponse({ code: 0, msg: "success", data, timestamp: 1, success: true });
const forbidChain = async (): Promise<ChainOutcomes> => {
  assert.fail("chain must not be read for a tokenized stock");
};
const signal = () => new AbortController().signal;

/** A bStock the static list does not know — the "previously discovered NON-static bStock" of acceptance 3. */
const HOODB = "0xaaaa000000000000000000000000000000000001";
const HOODB_ROW = { ...NVDAB_ROW, tokenContractAddress: HOODB, tokenSymbol: "HOODB", underlyingTicker: "HOOD", tokenPrice: "120", referencePrice: "119" };
/** An Ondo row that is open and trading. */
const FXION = "0xbbbb000000000000000000000000000000000002";
const FXION_ROW = { ...ARQQON_ROW, tokenContractAddress: FXION, tokenSymbol: "FXIon", underlyingTicker: "FXI", statusInfo: { openState: true, marketStatus: "regular", reasonCode: "TRADING", reasonMsg: null, nextOpenTime: 1, nextCloseTime: 2 } };
const PAUSED = "0xcccc000000000000000000000000000000000003";
const PAUSED_ROW = { ...ARQQON_ROW, tokenContractAddress: PAUSED, tokenSymbol: "PAUSon", statusInfo: { ...ARQQON_ROW.statusInfo, openState: false, reasonCode: "ASSET_PAUSED" } };

let clock = 1_000_000;
const now = () => clock;

function setCredentials(): void {
  process.env["BINANCE_WEB3_API_KEY"] = "unit-test-key";
  process.env["BINANCE_WEB3_SECRET_KEY"] = "unit-test-secret";
}
afterEach(() => {
  delete process.env["BINANCE_WEB3_API_KEY"];
  delete process.env["BINANCE_WEB3_SECRET_KEY"];
  clock = 1_000_000;
});

/** One real job cycle over a fixture list: writes universe:rwa, rwa:members, token rows. */
async function seed(store: SnapshotStore, rows: unknown[] = [NVDAB_ROW, HOODB_ROW, ARQQON_ROW, FXION_ROW, PAUSED_ROW]): Promise<void> {
  setCredentials();
  await runBinanceRwa(store, signal(), { fetchFn: fakeFetch(() => ok(rows)).fetch });
}

async function verdict(store: SnapshotStore, address: string): Promise<EligibilityResult> {
  return isEligible(store, { address, readState: forbidChain });
}

describe("decideRwaVeto", () => {
  it("covers every branch of the decision table", async () => {
    const store = new MemoryStore(now);
    await seed(store);
    const ctx = await loadRwaGateContext(store);
    assert.equal(decideRwaVeto(ctx, NVDAB), null, "open, TRADING");
    assert.equal(decideRwaVeto(ctx, FXION), null, "Ondo open in a supported session");
    assert.equal(decideRwaVeto(ctx, ARQQON), "rwa_unsupported", "openState false + UNSUPPORTED");
    assert.equal(decideRwaVeto(ctx, PAUSED), "rwa_halted", "ASSET_PAUSED folds into halted");
    assert.equal(decideRwaVeto(ctx, "0xdddd000000000000000000000000000000000004"), "rwa_stale", "member missing from the fresh snapshot");

    clock += RWA_FRESH_FOR_MS + 1;
    const stale = await loadRwaGateContext(store);
    assert.equal(stale.rows, null);
    assert.equal(stale.snapshotStaleness, "stale");
    assert.equal(decideRwaVeto(stale, NVDAB), "rwa_stale");
    assert.ok(stale.members.has(HOODB), "membership survives the snapshot going stale");
  });

  it("treats openState:true with a non-TRADING code, and nulls, as halted", async () => {
    const store = new MemoryStore(now);
    await seed(store, [
      { ...FXION_ROW, statusInfo: { ...FXION_ROW.statusInfo, reasonCode: "SOMETHING_NEW" } },
      { ...PAUSED_ROW, statusInfo: {} },
    ]);
    const ctx = await loadRwaGateContext(store);
    assert.equal(decideRwaVeto(ctx, FXION), "rwa_halted");
    assert.equal(decideRwaVeto(ctx, PAUSED), "rwa_halted");
  });
});

describe("isEligible — rule 5", () => {
  it("acceptance 1: an admitted Ondo token answers binance_rwa without touching the chain or the cache", async () => {
    const store = new MemoryStore(now);
    await seed(store);
    const r = await verdict(store, FXION);
    assert.equal(r.eligible, true);
    assert.equal(r.reason, "binance_rwa");
    assert.equal(r.source, "binance-rwa");
    assert.equal(r.venue, null);
    assert.equal(r.cached, false);
    assert.equal(await store.get(eligibilityKey(FXION)), null, "never cached as a verdict");
  });

  it("acceptance 2: an UNSUPPORTED Ondo row is rwa_unsupported; ASSET_PAUSED is rwa_halted", async () => {
    const store = new MemoryStore(now);
    await seed(store);
    assert.deepEqual([(await verdict(store, ARQQON)).reason, (await verdict(store, ARQQON)).eligible], ["rwa_unsupported", false]);
    assert.deepEqual([(await verdict(store, PAUSED)).reason, (await verdict(store, PAUSED)).source], ["rwa_halted", null]);
  });

  it("acceptance 3: with the snapshot absent, a previously discovered non-static bStock on the Alpha list and in the cache is rwa_stale", async () => {
    const store = new MemoryStore(now);
    await seed(store);
    // Make HOODB attractive to every other rule: Alpha-listed and a cached positive.
    await store.put(COINS_UNIVERSE_KEY, [{ address: HOODB, symbol: "HOODB", lane: "coins", source: "binance" }], { source: "binance", freshForMs: 12 * 60 * 60_000, deadAfterMs: 48 * 60 * 60_000 });
    const cachedPositive: EligibilityResult = { address: HOODB, eligible: true, reason: "not_listed" as never, source: "allowlist", venue: null, fourmeme: null, flap: null, checkedAt: now(), cached: false };
    await store.put(eligibilityKey(HOODB), { ...cachedPositive, reason: "allowlist" }, { source: "eligibility", ...ELIGIBILITY_TTL.eligible });
    // Sanity: while the snapshot is fresh and HOODB is TRADING, Alpha admits it.
    assert.equal((await verdict(store, HOODB)).reason, "binance_alpha");

    // Now the snapshot disappears entirely (restart with an empty RWA key), members persist.
    await store.put(RWA_UNIVERSE_KEY, { rows: [], byPlatform: {} }, { source: "binance-rwa", freshForMs: 1, deadAfterMs: 1 });
    clock += 5;
    const r = await verdict(store, HOODB);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "rwa_stale");
    assert.equal(r.source, null);
  });

  it("D2: the static bStocks are vetoed like any member — allowlist while fresh, rwa_stale without the snapshot", async () => {
    const store = new MemoryStore(now);
    const staticOne = bstockAddresses()[0]!;
    // No snapshot ever written: every static bStock is a member with nothing fresh to check against.
    const before = await verdict(store, staticOne);
    assert.equal(before.reason, "rwa_stale");
    await seed(store, [NVDAB_ROW]);
    const nvda = await verdict(store, NVDAB);
    assert.equal(nvda.reason, "allowlist", "positive order: the allowlist still answers for an allowlisted bStock that passed the veto");
    assert.equal(nvda.eligible, true);
  });

  it("a halted member on the allowlist AND the Alpha list is still refused; a cached positive is ignored", async () => {
    const store = new MemoryStore(now);
    await seed(store, [{ ...NVDAB_ROW, statusInfo: { ...NVDAB_ROW.statusInfo, openState: false, reasonCode: "ASSET_PAUSED" } }]);
    await store.put(COINS_UNIVERSE_KEY, [{ address: NVDAB, symbol: "NVDAB", lane: "coins", source: "binance" }], { source: "binance", freshForMs: 60_000, deadAfterMs: 60_000 });
    await store.put(eligibilityKey(NVDAB), { address: NVDAB, eligible: true, reason: "allowlist", source: "allowlist", venue: null, fourmeme: null, flap: null, checkedAt: now(), cached: false }, { source: "eligibility", ...ELIGIBILITY_TTL.eligible });
    const r = await verdict(store, NVDAB);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "rwa_halted");
  });

  it("does not touch non-members: USDT stays allowlist, an unknown address still reaches the chain", async () => {
    const store = new MemoryStore(now);
    await seed(store);
    assert.equal((await verdict(store, USDT)).reason, "allowlist");
    let touched = false;
    const r = await isEligible(store, {
      address: "0xeeee000000000000000000000000000000000005",
      readState: async () => {
        touched = true;
        return { fourmeme: { kind: "absent" }, flap: { kind: "absent" } };
      },
    });
    assert.equal(touched, true);
    assert.equal(r.reason, "not_listed");
  });

  it("batch: loads the RWA context once and preserves order", async () => {
    const store = new MemoryStore(now);
    await seed(store);
    let rwaReads = 0;
    const counting: SnapshotStore = {
      ...store,
      get: async (key) => {
        if (key === RWA_UNIVERSE_KEY) rwaReads++;
        return store.get(key);
      },
      put: (k, p, o) => store.put(k, p, o),
    } as SnapshotStore;
    const results = await isEligibleBatch(counting, [FXION, ARQQON, USDT, NVDAB, PAUSED], { readState: forbidChain });
    assert.deepEqual(results.map((r) => r.reason), ["binance_rwa", "rwa_unsupported", "allowlist", "allowlist", "rwa_halted"]);
    assert.equal(rwaReads, 1);
  });

  it("/eligibility/:address and the batch route carry the new reasons in the envelope", async () => {
    const store = new MemoryStore(now);
    await seed(store);
    const app = createServer({ scheduler: createScheduler(store), store });
    const one = await app.request(`/eligibility/${FXION}`);
    assert.equal(one.status, 200);
    const body = (await one.json()) as { data: EligibilityResult };
    assert.equal(body.data.reason, "binance_rwa");
    const many = await app.request(`/eligibility?addresses=${ARQQON},${FXION}`);
    const list = (await many.json()) as { data: EligibilityResult[] };
    assert.deepEqual(list.data.map((r) => r.reason), ["rwa_unsupported", "binance_rwa"]);
  });
});

describe("rwa:members", () => {
  for (const [label, make] of [
    ["MemoryStore", async () => new MemoryStore(now) as SnapshotStore],
    ["PostgresStore via FakePg", async () => PostgresStore.create("postgres://unused", { client: new FakePg(), now })],
  ] as const) {
    it(`is merged across cycles and never shrinks (${label})`, async () => {
      const store = await make();
      await seed(store, [NVDAB_ROW, HOODB_ROW]);
      await seed(store, [NVDAB_ROW]);
      const members = normalizeRwaMembers((await store.get<RwaMembers>(RWA_MEMBERS_KEY))?.data);
      assert.deepEqual(Object.keys(members).sort(), [NVDAB, HOODB].sort());
      assert.equal(members[HOODB]?.platform, "bstock");
      const ctx = await loadRwaGateContext(store);
      assert.equal(decideRwaVeto(ctx, HOODB), "rwa_stale", "delisted since last seen: still a stock, no longer visible");
    });
  }

  it("drops malformed entries on read", () => {
    const members = normalizeRwaMembers({ [NVDAB]: { platform: "bstock", lastSeenAt: 1 }, junk: { platform: "x", lastSeenAt: 1 }, [HOODB]: "nope" });
    assert.deepEqual(Object.keys(members), [NVDAB]);
  });
});

describe("/tokens rows for RWA addresses (item 2)", () => {
  it("synthesises a row from the RWA snapshot when no token record exists, and prefers the real record when it does", async () => {
    const store = new MemoryStore(now);
    await seed(store, [NVDAB_ROW, FXION_ROW]);
    // Simulate the window before the job's merge: drop the token records.
    const records = await readTokenRecords(store, [NVDAB, FXION, USDT]);
    assert.equal(records.get(NVDAB)?.data.priceUsd, 215.84, "real record");
    assert.equal(records.has(USDT), false, "not a stock, not synthesised");

    const store2 = new MemoryStore(now);
    const rwa = (await store.get<unknown>(RWA_UNIVERSE_KEY))!;
    await store2.put(RWA_UNIVERSE_KEY, rwa.data, { source: "binance-rwa", freshForMs: 60_000, deadAfterMs: 600_000 });
    const synth = (await readTokenRecords(store2, [FXION])).get(FXION)!;
    assert.equal(synth.source, "binance-rwa");
    assert.equal(synth.staleness, "fresh");
    assert.equal(synth.data.priceUsd, 19.24);
    assert.equal(synth.data.volume24hUsd, null, "never the underlying's volume");
    assert.equal(synth.data.holders, null);
    assert.equal(synth.data.symbol, "FXIon");
    assert.equal(await store2.get(tokenKey(FXION)), null, "nothing written back");

    const app = createServer({ scheduler: createScheduler(store2), store: store2 });
    const res = await app.request(`/tokens?addresses=${FXION},${USDT}`);
    const body = (await res.json()) as { data: Array<{ address: string; priceUsd: number | null }>; meta: { found: number; missing: number } };
    assert.deepEqual(body.meta, { requested: 2, found: 1, missing: 1 });
    assert.equal(body.data[0]?.priceUsd, 19.24);
  });

  it("the job merges the deepest venue's volume, never the underlying's, and the underlying market cap as ordered", async () => {
    const store = new MemoryStore(now);
    await store.put(RWA_VENUES_KEY, { byAddress: { [NVDAB]: [
      { dex: "uniswap", version: "v3", pool: "0x1000000000000000000000000000000000000001", feeTier: 500, quote: { address: USDT, symbol: "USDT" }, priceUsd: 216, liquidityUsd: 325000, volume24hUsd: 1136000, asOf: 1 },
      { dex: "pancakeswap", version: "v3", pool: "0x2000000000000000000000000000000000000002", feeTier: 2500, quote: { address: USDT, symbol: "USDT" }, priceUsd: 215.7, liquidityUsd: 2730000, volume24hUsd: 1682760, asOf: 1 },
    ] }, sweptAt: {}, cursor: null }, { source: "test", freshForMs: 60_000, deadAfterMs: 600_000 });
    await seed(store, [NVDAB_ROW]);
    const row = (await store.get<{ volume24hUsd: number | null; marketCapUsd: number | null }>(tokenKey(NVDAB)))!.data;
    assert.equal(row.volume24hUsd, 1682760, "deepest pool's volume");
    assert.equal(row.marketCapUsd, 28385091);
  });
});

describe("premiumBps on the universe row", () => {
  it("is the deepest priced venue against reference × share ratio, null without a venue", async () => {
    assert.equal(venuePremiumBps(undefined, 100, 1), null);
    assert.equal(venuePremiumBps([{ dex: "pancakeswap", version: "v3", pool: "0x1", feeTier: 100, quote: { address: USDT, symbol: "USDT" }, priceUsd: 101, liquidityUsd: 1, volume24hUsd: 0, asOf: 1 }], 100, 1), 100);
    // EEMon-style: ratio 1.0137, pool at NAV → 0 bps, not 137.
    assert.equal(venuePremiumBps([{ dex: "pancakeswap", version: "v3", pool: "0x1", feeTier: 100, quote: { address: USDT, symbol: "USDT" }, priceUsd: 101.37, liquidityUsd: 1, volume24hUsd: 0, asOf: 1 }], 100, 1.0137), 0);
    assert.equal(venuePremiumBps([{ dex: "pancakeswap", version: "v3", pool: "0x1", feeTier: 100, quote: { address: USDT, symbol: "USDT" }, priceUsd: null, liquidityUsd: 9, volume24hUsd: 0, asOf: 1 }], 100, 1), null);

    const store = new MemoryStore(now);
    await store.put(RWA_VENUES_KEY, { byAddress: { [NVDAB]: [
      { dex: "pancakeswap", version: "v3", pool: "0x2000000000000000000000000000000000000002", feeTier: 2500, quote: { address: USDT, symbol: "USDT" }, priceUsd: 217.7762, liquidityUsd: 2730000, volume24hUsd: 1, asOf: 1 },
    ] }, sweptAt: {}, cursor: null }, { source: "test", freshForMs: 60_000, deadAfterMs: 600_000 });
    await seed(store, [NVDAB_ROW]); // reference 215.62, ratio 1 → 217.7762 / 215.62 − 1 = +100 bps
    const universe = await buildUniverse(store);
    assert.equal(universe.entries.find((e) => e.address === NVDAB)?.premiumBps, 100);
  });
});
