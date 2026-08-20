import { randomUUID } from "node:crypto";
import { fetchVenusCoreAccount, fetchVenusCoreAccounts, fetchVenusCoreMarkets, fetchVenusCoreRewards } from "../adapters/venusCore.js";
import type { VenusHealth } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import {
  VENUS_CORE_MARKETS_KEY,
  VENUS_TRACKING_NAMESPACE,
  exactValue,
  venusCoreAccountKey,
  venusCoreRewardsKey,
  type VenusCoreAccountSnapshotV2,
  type VenusCoreRewardsSnapshotV2,
} from "../core/venus.js";
import { calculateVenusRisk } from "../query/venusRisk.js";
import { TRACKED_VENUS_OWNERS_KEY, venusKey } from "./venusHealth.js";

export const VENUS_CORE_CAPACITY = 1_000;
export const VENUS_CORE_MARKETS_JOB = "venus-core-markets";
export const VENUS_CORE_RISK_JOB = "venus-core-risk";
export const VENUS_CORE_HOT_JOB = "venus-core-risk-hot";
export const VENUS_CORE_REWARDS_JOB = "venus-core-rewards";

export const VENUS_RISK_TTL = { source: "venus-core", freshForMs: 90_000, deadAfterMs: 15 * 60_000 };
export const VENUS_MARKETS_TTL = { source: "venus-core", freshForMs: 120_000, deadAfterMs: 15 * 60_000 };
export const VENUS_REWARDS_TTL = { source: "venus-core", freshForMs: 5 * 60_000, deadAfterMs: 30 * 60_000 };

const MIGRATION_KEY = "venus:core:migration:tracked-owners:v1";
const RISK_CURSOR_KEY = "venus:core:cursor:risk:v1";
const LEASE_HOLDER = `${process.pid}:${randomUUID()}`;
const HOT_AT = 1_150_000_000_000_000_000n;

class Semaphore {
  #available: number;
  readonly #waiting: Array<() => void> = [];

  constructor(capacity: number) {
    this.#available = capacity;
  }

  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#available === 0) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    else this.#available -= 1;
    try {
      return await fn();
    } finally {
      const next = this.#waiting.shift();
      if (next !== undefined) next();
      else this.#available += 1;
    }
  }
}

const globalRpc = new Semaphore(12);
const baseQuota = new Semaphore(8);
const hotQuota = new Semaphore(4);
const rewardQuota = new Semaphore(2);
const accountInFlight = new Map<string, Promise<VenusCoreAccountSnapshotV2>>();
const rewardInFlight = new Map<string, Promise<VenusCoreRewardsSnapshotV2>>();

function isHot(snapshot: VenusCoreAccountSnapshotV2): boolean {
  if (snapshot.economicLiquidationCondition.effective) return true;
  const factor = snapshot.wakeRiskHealthFactor;
  return factor !== null && BigInt(factor.value) < HOT_AT;
}

function toDisplay(value: bigint): number {
  return Number((value * 1_000_000n) / 10n ** 18n) / 1_000_000;
}

/** Compatibility projection preserving the old Core-CF + spot presentation semantics. */
export function projectLegacyVenusHealth(snapshot: VenusCoreAccountSnapshotV2): VenusHealth {
  const inputs = snapshot.positions.map((position) => ({
    collateralMember: position.collateralMember,
    vTokenBalance: exactValue(position.vTokenBalance),
    exchangeRate: (exactValue(position.suppliedUnderlyingStored) * 10n ** 18n) /
      (exactValue(position.vTokenBalance) === 0n ? 1n : exactValue(position.vTokenBalance)),
    borrowBalance: exactValue(position.borrowStored),
    collateralFactor: exactValue(position.coreFactors.collateralFactor),
    liquidationThreshold: exactValue(position.coreFactors.liquidationThreshold),
    collateralPrice: BigInt(position.prices.spot),
    debtPrice: BigInt(position.prices.spot),
    spotPrice: BigInt(position.prices.spot),
  }));
  const risk = calculateVenusRisk(inputs, exactValue(snapshot.vaiDebt)).borrowingPower;
  const healthFactor = risk.healthFactor === null ? null : toDisplay(BigInt(risk.healthFactor.value));
  const tier = healthFactor === null || healthFactor >= 1.5
    ? "HEALTHY"
    : healthFactor >= 1.15
      ? "WARNING"
      : healthFactor >= 1
        ? "DANGER"
        : "LIQUIDATABLE";
  return {
    owner: snapshot.owner,
    healthFactor,
    tier,
    collateralValueUsd: toDisplay(BigInt(risk.collateral.value)),
    borrowValueUsd: toDisplay(BigInt(risk.debt.value)),
    assets: snapshot.positions.map((position) => {
      const supplyUsd = (exactValue(position.suppliedUnderlyingStored) * BigInt(position.prices.spot)) / 10n ** 18n;
      const borrowUsd = (exactValue(position.borrowStored) * BigInt(position.prices.spot)) / 10n ** 18n;
      return { symbol: position.vTokenSymbol, supplyUsd: toDisplay(supplyUsd), borrowUsd: toDisplay(borrowUsd) };
    }),
    asOf: snapshot.observedAt,
  };
}

async function readOwners(store: SnapshotStore): Promise<string[]> {
  return store.listTrackedSubjects(VENUS_TRACKING_NAMESPACE);
}

export async function migrateLegacyVenusOwners(store: SnapshotStore): Promise<void> {
  if (await store.get(MIGRATION_KEY) !== null) return;
  const legacy = await store.get<unknown>(TRACKED_VENUS_OWNERS_KEY);
  const owners = Array.isArray(legacy?.data) ? legacy.data.filter((value): value is string => typeof value === "string") : [];
  for (const owner of owners) {
    await store.addTrackingReference(VENUS_TRACKING_NAMESPACE, owner.toLowerCase(), "legacy-operator", VENUS_CORE_CAPACITY);
  }
  await store.put(MIGRATION_KEY, { migrated: owners.length }, {
    source: "venus-core-migration", freshForMs: 365 * 24 * 60 * 60_000, deadAfterMs: 10 * 365 * 24 * 60 * 60_000,
  });
}

async function readAccount(owner: string, signal: AbortSignal): Promise<VenusCoreAccountSnapshotV2> {
  const key = owner.toLowerCase();
  const existing = accountInFlight.get(key);
  if (existing !== undefined) return existing;
  const promise = globalRpc.use(() => fetchVenusCoreAccount(key, { signal })).finally(() => accountInFlight.delete(key));
  accountInFlight.set(key, promise);
  return promise;
}

async function readRewards(owner: string, signal: AbortSignal): Promise<VenusCoreRewardsSnapshotV2> {
  const key = owner.toLowerCase();
  const existing = rewardInFlight.get(key);
  if (existing !== undefined) return existing;
  const promise = globalRpc.use(() => fetchVenusCoreRewards(key, { signal })).finally(() => rewardInFlight.delete(key));
  rewardInFlight.set(key, promise);
  return promise;
}

export async function refreshVenusRisk(
  store: SnapshotStore,
  owner: string,
  signal: AbortSignal,
  priority: "base" | "hot" = "base",
): Promise<VenusCoreAccountSnapshotV2> {
  const quota = priority === "base" ? baseQuota : hotQuota;
  const snapshot = await quota.use(() => readAccount(owner, signal));
  await store.put(venusCoreAccountKey(owner), snapshot, VENUS_RISK_TTL);
  if (snapshot.status === "available") {
    await store.put(venusKey(owner), projectLegacyVenusHealth(snapshot), VENUS_RISK_TTL);
  }
  return snapshot;
}

async function persistRiskSnapshot(store: SnapshotStore, snapshot: VenusCoreAccountSnapshotV2): Promise<void> {
  await store.put(venusCoreAccountKey(snapshot.owner), snapshot, VENUS_RISK_TTL);
  if (snapshot.status === "available") {
    await store.put(venusKey(snapshot.owner), projectLegacyVenusHealth(snapshot), VENUS_RISK_TTL);
  }
}

async function refreshVenusRiskBatch(
  store: SnapshotStore,
  owners: readonly string[],
  signal: AbortSignal,
  priority: "base" | "hot",
): Promise<PromiseSettledResult<VenusCoreAccountSnapshotV2>[]> {
  const quota = priority === "base" ? baseQuota : hotQuota;
  const outcomes = await quota.use(() => globalRpc.use(() => fetchVenusCoreAccounts(owners, { signal })));
  await Promise.all(outcomes.map(async (outcome) => {
    if (outcome.status === "fulfilled") await persistRiskSnapshot(store, outcome.value);
  }));
  return outcomes;
}

export async function refreshVenusRewards(
  store: SnapshotStore,
  owner: string,
  signal: AbortSignal,
): Promise<VenusCoreRewardsSnapshotV2> {
  const snapshot = await rewardQuota.use(() => readRewards(owner, signal));
  await store.put(venusCoreRewardsKey(owner), snapshot, VENUS_REWARDS_TTL);
  return snapshot;
}

interface SweepResult { attempted: number; updated: number; failed: number }

function rotateAfter(owners: string[], after: string | null): string[] {
  if (after === null) return owners;
  const index = owners.findIndex((owner) => owner > after);
  return index < 0 ? owners : [...owners.slice(index), ...owners.slice(0, index)];
}

export async function runVenusRiskSweep(
  store: SnapshotStore,
  owners: string[],
  signal: AbortSignal,
  priority: "base" | "hot" = "base",
): Promise<SweepResult> {
  if (owners.length === 0) return { attempted: 0, updated: 0, failed: 0 };
  const cursor = priority === "base" ? await store.get<{ after: string }>(RISK_CURSOR_KEY) : null;
  const ordered = priority === "base" ? rotateAfter([...owners].sort(), cursor?.data.after ?? null) : owners;
  const result: SweepResult = { attempted: ordered.length, updated: 0, failed: 0 };
  const chunkSize = priority === "base" ? 16 : 4;
  for (let offset = 0; offset < ordered.length && !signal.aborted; offset += chunkSize) {
    const chunk = ordered.slice(offset, offset + chunkSize);
    let outcomes: PromiseSettledResult<VenusCoreAccountSnapshotV2>[];
    try {
      outcomes = await refreshVenusRiskBatch(store, chunk, signal, priority);
    } catch (error) {
      outcomes = chunk.map(() => ({ status: "rejected", reason: error }));
    }
    for (const outcome of outcomes) outcome.status === "fulfilled" ? result.updated += 1 : result.failed += 1;
    const last = chunk.at(-1);
    if (priority === "base" && last !== undefined) {
      await store.put(RISK_CURSOR_KEY, { after: last }, { source: "venus-core-scheduler", freshForMs: 60_000, deadAfterMs: 365 * 24 * 60 * 60_000 });
    }
  }
  if (result.updated === 0 && result.failed > 0) throw new Error(`no venus core owners updated (failed=${result.failed})`);
  return result;
}

async function readHotOwners(store: SnapshotStore): Promise<string[]> {
  const owners = await readOwners(store);
  const hot: string[] = [];
  for (const owner of owners) {
    const record = await store.get<VenusCoreAccountSnapshotV2>(venusCoreAccountKey(owner));
    if (record !== null && isHot(record.data)) hot.push(owner);
  }
  return hot;
}

async function withLease(store: SnapshotStore, name: string, ttlMs: number, run: () => Promise<void>): Promise<void> {
  if (await store.acquireSchedulerLease(name, LEASE_HOLDER, ttlMs)) await run();
}

export function venusCoreMarketsJob(store: SnapshotStore): JobSpec {
  return {
    name: VENUS_CORE_MARKETS_JOB, intervalMs: 60_000, jitterMs: 5_000, timeoutMs: 50_000,
    run: (signal) => withLease(store, VENUS_CORE_MARKETS_JOB, 70_000, async () => {
      await store.put(VENUS_CORE_MARKETS_KEY, await fetchVenusCoreMarkets({ signal }), VENUS_MARKETS_TTL);
    }),
  };
}

export function venusCoreRiskJob(store: SnapshotStore): JobSpec {
  return {
    name: VENUS_CORE_RISK_JOB, intervalMs: 60_000, jitterMs: 3_000, timeoutMs: 55_000,
    run: (signal) => withLease(store, VENUS_CORE_RISK_JOB, 70_000, async () => {
      await migrateLegacyVenusOwners(store);
      await runVenusRiskSweep(store, await readOwners(store), signal, "base");
    }),
  };
}

export function venusCoreHotJob(store: SnapshotStore): JobSpec {
  return {
    name: VENUS_CORE_HOT_JOB, intervalMs: 15_000, timeoutMs: 12_000,
    run: (signal) => withLease(store, VENUS_CORE_HOT_JOB, 20_000, async () => {
      await runVenusRiskSweep(store, await readHotOwners(store), signal, "hot");
    }),
  };
}

export function venusCoreRewardsJob(store: SnapshotStore): JobSpec {
  return {
    name: VENUS_CORE_REWARDS_JOB, intervalMs: 5 * 60_000, jitterMs: 10_000, timeoutMs: 4 * 60_000,
    run: (signal) => withLease(store, VENUS_CORE_REWARDS_JOB, 6 * 60_000, async () => {
      const owners = await readOwners(store);
      const outcomes = await Promise.allSettled(owners.map((owner) => refreshVenusRewards(store, owner, signal)));
      if (owners.length > 0 && outcomes.every((outcome) => outcome.status === "rejected")) throw new Error("no venus rewards updated");
    }),
  };
}
