/**
 * DI1 golden (agentic-rfq-stocks R2.3, R4.11): the pool calculator is byte-identical.
 *
 * The expected digests below were recorded at the base revision (data plane `ca8eb81`)
 * before any source change of the underlying-features phase. A drift in any metric,
 * coverage field, snapshot id or the retained input of a gecko / dexpaprika / sintral
 * series, in v1 or v2, turns this red.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { calculateFeatures, FEATURE_VERSION, FEATURE_VERSION_V2, type FeatureInput } from "../src/query/tradingFeatures.js";

const POOL = "0x0000000000000000000000000000000000000010";
const BASE = "0x0000000000000000000000000000000000000001";
const QUOTE = "0x0000000000000000000000000000000000000002";
// Wednesday 2026-09-23 16:00 UTC (12:00 ET, regular session), on a bucket edge plus 20 s.
const NOW = Date.UTC(2026, 8, 23, 16, 0, 20);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

/** 120 closed buckets before NOW; a few missing ones so the sintral fill and the gap logic both act. */
function input(source: string, interval: "15m" | "1h", withVolume: boolean, withSession: boolean, gaps = true): FeatureInput {
  const step = interval === "15m" ? 900_000 : 3_600_000;
  const cutoff = Math.floor((NOW - 15_000) / step) * step;
  const candles = [];
  for (let i = 0; i < 120; i++) {
    if (gaps && i % 17 === 5) continue;
    const c = 100 + Math.sin(i / 3) * 4 + (i % 7) * 0.25;
    candles.push({ timestamp: cutoff - (120 - i) * step, open: c - 0.3, high: c + 1.1, low: c - 1.2, close: c, volume: withVolume ? 10 + (i % 5) : null });
  }
  return { chainId: 56, poolAddress: POOL, baseAddress: BASE, quoteAddress: QUOTE, priceCurrency: "usd",
    volumeCurrency: withVolume ? "usd" : "none", volumeUnavailableReason: withVolume ? null : "no_volume", source, interval,
    observedAt: NOW, conflictingTimestamps: [], candles,
    ...(withSession ? { referenceSession: { underlyingTicker: "NVDA", marketStatus: null, openState: true, asOf: NOW - 60_000 } } : {}) };
}

/** Recorded at the base revision. Keys: source / version / interval / volume / session. */
const GOLDEN: Record<string, { snapshotId: string; digest: string }> = {
  "geckoterminal/pool-features-v1/15m/vol/nosession/gaps": { snapshotId: "c0937b47201a2522e2244182e0f10c77b574ad69bd7244e72ca5cc3f3a86dd0f", digest: "00b2d7eeb21aa2259c9973b661642015dd32ead31c8f0ce0851df0cbc5514544" },
  "geckoterminal/pool-features-v1/1h/vol/nosession/gaps": { snapshotId: "74455a0a361ad7a3a33fd2588680bf57861e79c511bf55a039713c347512af32", digest: "4afd2c49274413a7976ba73354b7ccc596c54831a1b4d5703d359a9c9c0957c2" },
  "geckoterminal/pool-features-v2/15m/vol/session/gaps": { snapshotId: "74b6ce6e30e38a84eb8422c3f736af335b8abc27c3c8d1caef425348a75e19b2", digest: "8491d619f91a371ecdbe1afb226fcbfab83b6b160184c6358ccee66af89b550d" },
  "geckoterminal/pool-features-v2/1h/vol/session/gaps": { snapshotId: "ea355e65d64a1f9166da66c509ed364be9b07e661629454e8b8d1574a0a5f697", digest: "ac908ecabf4fe745d1acededed5373bf34e6410a34886e87e144368b8ad2bffc" },
  "dexpaprika/pool-features-v1/15m/vol/nosession/gaps": { snapshotId: "2a79a5ff7ff491146df555be34e565da803a4e46c96c19c3010c5d8465046c3c", digest: "d3eaa5595ecbd181d0bcf389b25e5135a38eb2b9ad7bf71e9be3183034db10e8" },
  "dexpaprika/pool-features-v1/1h/vol/nosession/gaps": { snapshotId: "8c7403825d3438b4a663b82603f961bbb53d33c00b8f5b54da1e7e20b83743bd", digest: "b1f89f2733acd1ca0bb697f2d51afa54431be9a66aefd36a566f7206150a784f" },
  "dexpaprika/pool-features-v2/15m/vol/session/gaps": { snapshotId: "4bd475619bc096aff79dbbb1894d30b7101866566b3a7d7d174efa6bd6341bf3", digest: "ac3c0c2c6eba7c432c68ca89a60b69db561643581933df54a10b028b52727c2d" },
  "dexpaprika/pool-features-v2/1h/vol/session/gaps": { snapshotId: "fbdaf68a8196084d0f57c0bf19f833ec9ffba76cfdcb9ad739388ecfe257ca7d", digest: "cb0cd3f9d30e742c92639b8b188a2f7076bfb0c019ea5d67dd61a88b9e238b17" },
  "sintral/pool-features-v1/15m/vol/nosession/gaps": { snapshotId: "c37f6bfced9f974e32cd4a4b87b479623f2531161ba882fb2a07471ec73fd94e", digest: "31f64253a5cda3fc16da227753c77cb560bc2363147d64b490ec15a7028b9e6e" },
  "sintral/pool-features-v1/1h/vol/nosession/gaps": { snapshotId: "e5014af0adaaf11a02485d6880812916ea94005f04e8b7754b129dee524bdbd4", digest: "a530c09df45c4aaf97a0f6854fb37379ea4deee70b273886e5e18701be957ded" },
  "sintral/pool-features-v2/15m/vol/session/gaps": { snapshotId: "2a6629a268c267f8a58f98ac20500b70cb383b328297237ec2922966f444ab71", digest: "6aa42866d58831452e684e144b486a1873772e7f21c2473cccda3915de47324e" },
  "sintral/pool-features-v2/1h/vol/session/gaps": { snapshotId: "1239f29c29b88a20b2f52125f2743a2f73bf3776271c1048426488ea82f01dbc", digest: "793cd5d40d967becaf63d06074f7f041116ec7d6169ce794e0c18b07b790dc67" },
  "sintral/pool-features-v2/15m/novol/session/gaps": { snapshotId: "00d859bff0a34cb731cd34124d3eeb24d9cfc0696daa02a2eb02e9a7ce70152b", digest: "ed27b26204f353763616a35fc810c1be8dc9b3e3ab3298cd3a015da6729ff9b0" },
  "geckoterminal/pool-features-v1/15m/vol/nosession/dense": { snapshotId: "1f07b2c210a220e6bd89156e5427132fa1bda1d125a880777ca4313620cae73f", digest: "1d28af64fab06d0bdd48f40c96c646731bd3fe756831c3ce205052ada86887b4" },
  "geckoterminal/pool-features-v2/15m/vol/session/dense": { snapshotId: "ecb608a0e8a7404d346727d017ad721020e8eb42413811e29fa1537d14a5dfbf", digest: "3a9c4c1a6b6267398e773c5fa4e6d84fab335e36c5c16a1060fe8ed1fd796a1d" },
  "dexpaprika/pool-features-v2/15m/vol/session/dense": { snapshotId: "92d97be7039248df10d6ed0b7f9dba874196085bc5b8da1a045d4ad66073567f", digest: "cc52702c553e8427b50bf575072bedbf9cfa646f2b6db40ca23a4cdda45aacb3" },
};

describe("pool calculator golden (DI1)", () => {
  const cases: Array<[string, string, "15m" | "1h", boolean, boolean, boolean]> = [];
  for (const source of ["geckoterminal", "dexpaprika", "sintral"]) {
    for (const version of [FEATURE_VERSION, FEATURE_VERSION_V2]) {
      for (const interval of ["15m", "1h"] as const) cases.push([source, version, interval, true, version === FEATURE_VERSION_V2, true]);
    }
  }
  cases.push(["sintral", FEATURE_VERSION_V2, "15m", false, true, true]);
  // Gap-free series, so the non-sintral sources reach their available metrics too.
  cases.push(["geckoterminal", FEATURE_VERSION, "15m", true, false, false]);
  cases.push(["geckoterminal", FEATURE_VERSION_V2, "15m", true, true, false]);
  cases.push(["dexpaprika", FEATURE_VERSION_V2, "15m", true, true, false]);
  for (const [source, version, interval, volume, session, gaps] of cases) {
    const key = `${source}/${version}/${interval}/${volume ? "vol" : "novol"}/${session ? "session" : "nosession"}/${gaps ? "gaps" : "dense"}`;
    it(`is byte-identical for ${key}`, () => {
      const snapshot = calculateFeatures(input(source, interval, volume, session, gaps), NOW, version as typeof FEATURE_VERSION);
      if (process.env["RECORD_GOLDEN"] === "1") { console.log(`  ${JSON.stringify(key)}: { snapshotId: "${snapshot.snapshotId}", digest: "${digest(snapshot)}" },`); return; }
      const expected = GOLDEN[key];
      assert.ok(expected, `no golden recorded for ${key}`);
      assert.equal(snapshot.snapshotId, expected.snapshotId);
      assert.equal(digest(snapshot), expected.digest);
    });
  }
  it("never carries changedBuckets on a pool input or in a pool snapshot", () => {
    for (const source of ["geckoterminal", "dexpaprika", "sintral"]) {
      const snapshot = calculateFeatures(input(source, "15m", true, true), NOW, FEATURE_VERSION_V2);
      assert.equal(Object.hasOwn(snapshot.input, "changedBuckets"), false, `${source}: input`);
      assert.equal(Object.hasOwn(snapshot.coverage, "changedBuckets"), false, `${source}: coverage`);
    }
  });
});
