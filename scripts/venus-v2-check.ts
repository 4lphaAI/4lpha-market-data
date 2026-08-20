/** Read-only Venus Core v2 acceptance probe. No transaction is constructed or sent. */
import { performance } from "node:perf_hooks";
import { fetchVenusCoreAccounts, fetchVenusCoreMarkets, fetchVenusCoreRewards } from "../src/adapters/venusCore.js";
import { normalizeAddress } from "../src/adapters/http.js";

const DEFAULT_OWNER = "0xd8d6ea18fe17b0b1d0d873e547907b6eeac962fa";
const capacityMode = process.argv.includes("--capacity");
const owners = [...new Set(process.argv.slice(2).filter((value) => value !== "--capacity").map(normalizeAddress).filter((value): value is string => value !== null))];
if (owners.length === 0) owners.push(DEFAULT_OWNER);
if (capacityMode) {
  owners.length = 0;
  for (let index = 1; index <= 1_000; index += 1) {
    owners.push(`0x10000000000000000000000000000000${index.toString(16).padStart(8, "0")}`);
  }
}
if (owners.length > 1_000) throw new Error("at most 1000 owners");

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

const marketStarted = performance.now();
const markets = await fetchVenusCoreMarkets();
const marketLatencyMs = performance.now() - marketStarted;

const accountChunkLatencies: number[] = [];
const accounts = [];
const accountStarted = performance.now();
for (let offset = 0; offset < owners.length; offset += 16) {
  const started = performance.now();
  const outcomes = await fetchVenusCoreAccounts(owners.slice(offset, offset + 16));
  accountChunkLatencies.push(performance.now() - started);
  for (const outcome of outcomes) if (outcome.status === "fulfilled") accounts.push(outcome.value);
}
const accountCycleMs = performance.now() - accountStarted;

const rewardsStarted = performance.now();
const rewards = await fetchVenusCoreRewards(owners[0] ?? DEFAULT_OWNER);
const rewardsLatencyMs = performance.now() - rewardsStarted;
const p95 = percentile(accountChunkLatencies, 0.95);

console.log(JSON.stringify({
  readOnly: true,
  market: {
    block: markets.block,
    marketCount: markets.markets.length,
    eModePoolCount: markets.eModePools.length,
    latencyMs: Math.round(marketLatencyMs),
  },
  accounts: {
    requested: owners.length,
    available: accounts.filter((account) => account.status === "available").length,
    reconciled: accounts.filter((account) =>
      account.protocolSnapshot?.borrowingPowerCheck.matched === true &&
      account.protocolSnapshot.liquidationCheck.matched === true).length,
    failed: owners.length - accounts.length,
    p95ChunkLatencyMs: Math.round(p95),
    measuredCycleMs: Math.round(accountCycleMs),
    projected1000OwnerCycleMs: Math.round(accountCycleMs * (1_000 / owners.length)),
    releaseGateMs: 55_000,
  },
  rewards: {
    owner: rewards.owner,
    observations: rewards.rewards.length,
    latencyMs: Math.round(rewardsLatencyMs),
  },
}, null, 2));
