import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Scheduler } from "./core/scheduler.js";
import type { SnapshotStore } from "./core/store.js";
import type { Lane, PoolStats, PoolTier, TokenSnapshot, VenusHealth } from "./core/models.js";
import {
  VENUS_CORE_MARKETS_KEY,
  VENUS_TRACKING_NAMESPACE,
  venusCoreAccountKey,
  venusCoreRewardsKey,
  type VenusCoreAccountSnapshotV2,
  type VenusCoreMarketsSnapshotV1,
  type VenusCoreRewardsSnapshotV2,
} from "./core/venus.js";
import { isEvmAddress, normalizeAddress } from "./adapters/http.js";
import { MAX_KLINE_LIMIT, SUPPORTED_INTERVALS, getKlines, parseInterval } from "./query/klines.js";
import { getSecurity } from "./query/security.js";
import { getHolders } from "./query/holders.js";
import { getSocials } from "./query/socials.js";
import { isEligible, isEligibleBatch } from "./query/eligibility.js";
import { buildUniverse } from "./universe.js";
import { tokenKey } from "./jobs/tokenStore.js";
import { fetchPancakePoolStats, poolKey } from "./adapters/pancake.js";
import { type RangeRequest, estimateRange, loadRangeSnapshot } from "./query/poolRange.js";
import {
  MAX_LANE_POOLS,
  POOL_DEAD_AFTER_MS,
  POOL_FRESH_FOR_MS,
  readPoolsLane,
  readStoredPools,
} from "./jobs/pancakePools.js";
import { venusKey } from "./jobs/venusHealth.js";
import {
  VENUS_CORE_CAPACITY,
  refreshVenusRewards,
  refreshVenusRisk,
} from "./jobs/venusCore.js";

/** Collaborators the HTTP layer reads from. Injected so the app stays testable. */
export interface ServerDeps {
  scheduler: Scheduler;
  store: SnapshotStore;
  refreshVenusRisk?: typeof refreshVenusRisk;
  refreshVenusRewards?: typeof refreshVenusRewards;
}

const LANES: Lane[] = ["meme", "coins", "bstocks"];

/**
 * Debug reads are limited to these key prefixes so `/snapshots/:key` can never
 * be used to enumerate arbitrary internal state.
 */
const SNAPSHOT_KEY_PREFIXES = [
  "heartbeat",
  "universe:",
  "token:",
  "klines:",
  "security:",
  "holders:",
  "socials:",
  "eligibility:",
  "pool:",
  "pools:",
  "origins:",
  "pancake:",
];

function isAllowedSnapshotKey(key: string): boolean {
  if (SNAPSHOT_KEY_PREFIXES.some((prefix) => prefix.endsWith(":") ? key.startsWith(prefix) : key === prefix)) {
    return true;
  }
  return key === VENUS_CORE_MARKETS_KEY ||
    /^venus:0x[0-9a-f]{40}$/u.test(key) ||
    /^venus:core:(?:account|rewards):v2:0x[0-9a-f]{40}$/u.test(key);
}

function isLane(value: string): value is Lane {
  return (LANES as string[]).includes(value);
}

/** Named in the 404 hint so an operator knows exactly which key to write. */
const TRACKED_VENUS_OWNERS_HINT = "tracked:venus-owners";

/**
 * Fixed probe targets for `/diag/latency` — a hardcoded list, never derived
 * from request input, so the route cannot be steered at arbitrary hosts.
 */
const DIAG_TARGETS = [
  { name: "quicknode-x402-bsc-mainnet-402", url: "https://x402.quicknode.com/bsc-mainnet" },
  { name: "public-bnbchain", url: "https://bsc-dataseed.bnbchain.org" },
  { name: "public-publicnode", url: "https://bsc-rpc.publicnode.com" },
  { name: "public-defibit", url: "https://bsc-dataseed1.defibit.io" },
] as const;

/** Most tokens one batch read may request. */
const MAX_BATCH_TOKENS = 50;

/**
 * Snapshot keys surfaced in `/status`. These are the always-on feeds; per-token
 * and per-pool keys are demand-driven and would make the list unbounded.
 */
const STATUS_SNAPSHOT_KEYS = [
  "heartbeat",
  "universe:meme",
  "universe:coins",
  "universe:pools",
  "pools:index",
  VENUS_CORE_MARKETS_KEY,
];

/** Fields `/pools/top` will sort by. */
const POOL_ORDER_FIELDS = [
  "combinedApr",
  "lpFeeApr24h",
  "lpFeeApr7d",
  "cakeFarmApr",
  "tvlUsd",
  "volume24hUsd",
] as const;
type PoolOrderField = (typeof POOL_ORDER_FIELDS)[number];

/** The subset an APR filter may be measured against. */
const POOL_APR_FIELDS = ["combinedApr", "lpFeeApr24h", "lpFeeApr7d", "cakeFarmApr"] as const;
type PoolAprField = (typeof POOL_APR_FIELDS)[number];

const POOL_TIERS: PoolTier[] = ["core", "degen", "unclassified"];

const DEFAULT_POOL_LIMIT = 50;

/** A rejected query parameter, reported as a 400 rather than an empty result. */
class QueryError extends Error {}

/** Parses an optional numeric parameter. Absent and blank both mean "no filter". */
function numberParam(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new QueryError(`${name} must be a number`);
  return parsed;
}

/** Parses an optional parameter constrained to a fixed set. */
function enumParam<T extends string>(
  raw: string | undefined,
  name: string,
  allowed: readonly T[],
): T | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new QueryError(`${name} must be one of ${allowed.join(", ")}`);
  }
  return raw as T;
}

/**
 * Orders pools by one field, descending, with unknown values last.
 *
 * A `null` is not a zero: a pool whose farm could not be read has an unknown
 * yield, and sorting it as the worst pool in the lane would be a claim the data
 * does not support. Sorting it last is a display choice, not a verdict.
 */
function comparePools(a: PoolStats, b: PoolStats, field: PoolOrderField): number {
  const left = a[field];
  const right = b[field];
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

/**
 * Parses a `/pools/:address/range` query.
 *
 * All three are required and none has a sensible default: a range estimate
 * without bounds or without capital is not a smaller answer, it is a different
 * question.
 */
function parseRangeQuery(get: (name: string) => string | undefined): RangeRequest {
  const lowerPrice = requiredNumber(get("lower"), "lower");
  const upperPrice = requiredNumber(get("upper"), "upper");
  const capitalUsd = requiredNumber(get("capital"), "capital");

  if (lowerPrice <= 0 || upperPrice <= 0) throw new QueryError("lower and upper must be positive");
  if (lowerPrice >= upperPrice) throw new QueryError("lower must be below upper");
  if (capitalUsd <= 0) throw new QueryError("capital must be positive");
  return { lowerPrice, upperPrice, capitalUsd };
}

function requiredNumber(raw: string | undefined, name: string): number {
  const value = numberParam(raw, name);
  if (value === undefined) throw new QueryError(`${name} is required`);
  return value;
}

/** A parsed `/pools/top` query. Every filter is optional; none has a default. */
interface PoolQuery {
  tier: PoolTier | undefined;
  token: string | undefined;
  feeTier: number | undefined;
  minTvlUsd: number | undefined;
  maxTvlUsd: number | undefined;
  minVolume24hUsd: number | undefined;
  maxVolTvlRatio: number | undefined;
  /** Which APR `minAprPct`/`maxAprPct` are measured against. */
  aprField: PoolAprField;
  minAprPct: number | undefined;
  maxAprPct: number | undefined;
  orderBy: PoolOrderField;
  limit: number;
}

function parsePoolQuery(get: (name: string) => string | undefined): PoolQuery {
  const aprField = enumParam(get("aprField"), "aprField", POOL_APR_FIELDS) ?? "combinedApr";

  const tokenRaw = get("token");
  let token: string | undefined;
  if (tokenRaw !== undefined && tokenRaw.trim() !== "") {
    const normalized = normalizeAddress(tokenRaw);
    if (normalized === null) throw new QueryError("token must be an address");
    token = normalized;
  }

  const limitRaw = numberParam(get("limit"), "limit");
  if (limitRaw !== undefined && (!Number.isInteger(limitRaw) || limitRaw < 1)) {
    throw new QueryError("limit must be a positive integer");
  }

  return {
    tier: enumParam(get("tier"), "tier", POOL_TIERS),
    token,
    feeTier: numberParam(get("feeTier"), "feeTier"),
    minTvlUsd: numberParam(get("minTvlUsd"), "minTvlUsd"),
    maxTvlUsd: numberParam(get("maxTvlUsd"), "maxTvlUsd"),
    minVolume24hUsd: numberParam(get("minVolume24hUsd"), "minVolume24hUsd"),
    maxVolTvlRatio: numberParam(get("maxVolTvlRatio"), "maxVolTvlRatio"),
    aprField,
    minAprPct: numberParam(get("minAprPct"), "minAprPct"),
    maxAprPct: numberParam(get("maxAprPct"), "maxAprPct"),
    // Ordering follows the filtered APR unless asked otherwise, so a caller who
    // sets a floor gets the pools nearest it first without a second parameter.
    orderBy: enumParam(get("orderBy"), "orderBy", POOL_ORDER_FIELDS) ?? aprField,
    limit: Math.min(limitRaw ?? DEFAULT_POOL_LIMIT, MAX_LANE_POOLS),
  };
}

/**
 * Applies the caller's filters to one pool.
 *
 * A threshold on a field the pool does not carry excludes it. Asking for pools
 * above 20% APR is asking for pools *known* to be above 20%, and an unpriced
 * farm is not evidence of anything — including of being below the line.
 */
function matchesPoolQuery(pool: PoolStats, query: PoolQuery): boolean {
  if (query.tier !== undefined && pool.tier !== query.tier) return false;
  if (query.token !== undefined && pool.token0 !== query.token && pool.token1 !== query.token) {
    return false;
  }
  if (query.feeTier !== undefined && pool.fee !== query.feeTier) return false;

  if (query.minTvlUsd !== undefined && (pool.tvlUsd === null || pool.tvlUsd < query.minTvlUsd)) {
    return false;
  }
  if (query.maxTvlUsd !== undefined && (pool.tvlUsd === null || pool.tvlUsd > query.maxTvlUsd)) {
    return false;
  }
  if (
    query.minVolume24hUsd !== undefined &&
    (pool.volume24hUsd === null || pool.volume24hUsd < query.minVolume24hUsd)
  ) {
    return false;
  }

  if (query.maxVolTvlRatio !== undefined) {
    if (pool.tvlUsd === null || pool.tvlUsd <= 0 || pool.volume24hUsd === null) return false;
    if (pool.volume24hUsd / pool.tvlUsd > query.maxVolTvlRatio) return false;
  }

  const apr = pool[query.aprField];
  if (query.minAprPct !== undefined && (apr === null || apr < query.minAprPct)) return false;
  if (query.maxAprPct !== undefined && (apr === null || apr > query.maxAprPct)) return false;

  return true;
}

/**
 * Finds the lane a token was discovered in. Unknown tokens are treated as
 * `meme`: it carries the shortest TTL, so an unclassified token is re-scanned
 * often rather than trusted for a day.
 */
async function lookupLane(store: SnapshotStore, address: string): Promise<Lane> {
  const universe = await buildUniverse(store);
  return universe.entries.find((entry) => entry.address === address)?.lane ?? "meme";
}

/**
 * Builds the HTTP app. Pure: it never binds a port, so tests can drive it with
 * `app.request(...)`. Every response uses the `{ data, error?, meta? }` envelope.
 */
/**
 * Constant-time token comparison. Both sides are hashed first so the buffers
 * given to `timingSafeEqual` always have equal length, which it requires.
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function createServer(deps: ServerDeps): Hono {
  const startedAt = Date.now();
  const app = new Hono();

  // With DP_AUTH_TOKEN set, every route except the platform healthcheck
  // requires the x-dp-token header. Read per request so tests can flip it.
  app.use("*", async (c, next) => {
    const expected = process.env["DP_AUTH_TOKEN"]?.trim() ?? "";
    if (c.req.path.startsWith("/internal/") && expected === "") {
      return c.json({ error: { code: "auth_not_configured" } }, 503);
    }
    if (expected === "" || c.req.path === "/health") return next();
    const provided = c.req.header("x-dp-token") ?? "";
    if (!tokenMatches(provided, expected)) {
      return c.json({ error: { code: "unauthorized" } }, 401);
    }
    return next();
  });

  app.get("/health", (c) =>
    c.json({
      data: {
        ok: true,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      },
    }),
  );

  app.get("/status", async (c) => {
    const snapshots = await Promise.all(
      STATUS_SNAPSHOT_KEYS.map(async (key) => {
        const record = await deps.store.get<unknown>(key);
        if (record === null) return { key, missing: true as const };
        return { key, asOf: record.asOf, source: record.source, staleness: record.staleness };
      }),
    );

    return c.json({
      data: {
        jobs: deps.scheduler.healthSnapshot(),
        snapshots,
        startedAt,
      },
    });
  });

  app.get("/universe", async (c) => {
    const laneParam = c.req.query("lane");
    if (laneParam !== undefined && !isLane(laneParam)) {
      return c.json(
        { error: { code: "invalid_lane", message: `lane must be one of ${LANES.join(", ")}` } },
        400,
      );
    }

    const universe = await buildUniverse(deps.store);
    const entries =
      laneParam === undefined
        ? universe.entries
        : universe.entries.filter((entry) => entry.lane === laneParam);

    return c.json({
      data: entries,
      meta: {
        total: entries.length,
        ...(laneParam === undefined ? {} : { lane: laneParam }),
        lanes: universe.lanes,
      },
    });
  });

  app.get("/tokens", async (c) => {
    const raw = c.req.query("addresses");
    if (raw === undefined || raw.trim() === "") {
      return c.json(
        { error: { code: "missing_addresses", message: "pass ?addresses=0x..,0x.." } },
        400,
      );
    }

    const requested = raw.split(",").map((value) => value.trim()).filter((value) => value !== "");
    if (requested.length > MAX_BATCH_TOKENS) {
      return c.json(
        {
          error: {
            code: "too_many_addresses",
            message: `at most ${MAX_BATCH_TOKENS} addresses per request`,
          },
        },
        400,
      );
    }

    const invalid: string[] = [];
    const addresses: string[] = [];
    for (const value of requested) {
      const normalized = normalizeAddress(value);
      if (normalized === null) invalid.push(value);
      else addresses.push(normalized);
    }
    const unique = [...new Set(addresses)];

    const records = await Promise.all(
      unique.map(async (address) => ({
        address,
        record: await deps.store.get<TokenSnapshot>(tokenKey(address)),
      })),
    );
    const found = records.filter(
      (entry): entry is { address: string; record: NonNullable<typeof entry.record> } =>
        entry.record !== null,
    );

    return c.json({
      data: found.map((entry) => ({
        ...entry.record.data,
        asOf: entry.record.asOf,
        source: entry.record.source,
        staleness: entry.record.staleness,
      })),
      meta: {
        requested: requested.length,
        found: found.length,
        missing: unique.length - found.length,
        ...(invalid.length === 0 ? {} : { invalid }),
      },
    });
  });

  app.get("/tokens/:address", async (c) => {
    const address = c.req.param("address").toLowerCase();
    if (!isEvmAddress(address)) {
      return c.json({ error: { code: "invalid_address" } }, 400);
    }

    const record = await deps.store.get<TokenSnapshot>(tokenKey(address));
    if (record === null) {
      return c.json({ error: { code: "not_found", message: "no snapshot for this token" } }, 404);
    }

    return c.json({
      data: record.data,
      meta: { asOf: record.asOf, source: record.source, staleness: record.staleness },
    });
  });

  app.get("/klines/:address", async (c) => {
    const address = c.req.param("address").toLowerCase();
    if (!isEvmAddress(address)) {
      return c.json({ error: { code: "invalid_address" } }, 400);
    }

    const interval = parseInterval(c.req.query("interval") ?? "1m");
    if (interval === null) {
      return c.json(
        {
          error: {
            code: "invalid_interval",
            message: `interval must be one of ${SUPPORTED_INTERVALS.join(", ")}`,
          },
        },
        400,
      );
    }

    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_KLINE_LIMIT) {
      return c.json(
        { error: { code: "invalid_limit", message: `limit must be an integer 1..${MAX_KLINE_LIMIT}` } },
        400,
      );
    }

    const result = await getKlines(deps.store, { address, interval, limit });
    if (result === null) {
      return c.json({ error: { code: "not_found", message: "no candles available" } }, 404);
    }

    return c.json({
      data: result.candles,
      meta: {
        address: result.address,
        interval: result.interval,
        limit: result.limit,
        source: result.source,
        asOf: result.asOf,
        staleness: result.staleness,
        count: result.candles.length,
      },
    });
  });

  app.get("/security/:address", async (c) => {
    const address = c.req.param("address").toLowerCase();
    if (!isEvmAddress(address)) {
      return c.json({ error: { code: "invalid_address" } }, 400);
    }

    const laneParam = c.req.query("lane");
    if (laneParam !== undefined && !isLane(laneParam)) {
      return c.json(
        { error: { code: "invalid_lane", message: `lane must be one of ${LANES.join(", ")}` } },
        400,
      );
    }

    // Without an explicit lane the TTL follows how the token was discovered,
    // which is what decides how fast its risk can change.
    const lane = laneParam ?? (await lookupLane(deps.store, address));
    const result = await getSecurity(deps.store, { address, lane });

    return c.json({
      data: result.summary,
      meta: {
        address: result.address,
        lane: result.lane,
        sources: result.sources,
        asOf: result.asOf,
        staleness: result.staleness,
      },
    });
  });

  app.get("/holders/:address", async (c) => {
    const address = c.req.param("address").toLowerCase();
    if (!isEvmAddress(address)) {
      return c.json({ error: { code: "invalid_address" } }, 400);
    }

    const result = await getHolders(deps.store, { address });
    if (result === null) {
      return c.json({ error: { code: "not_found", message: "no holder data available" } }, 404);
    }

    return c.json({
      data: result.stats,
      meta: { address: result.address, asOf: result.asOf, staleness: result.staleness },
    });
  });

  app.get("/socials/:address", async (c) => {
    const address = c.req.param("address").toLowerCase();
    if (!isEvmAddress(address)) {
      return c.json({ error: { code: "invalid_address" } }, 400);
    }

    const result = await getSocials(deps.store, { address });
    if (result === null) {
      return c.json({ error: { code: "not_found", message: "no social data available" } }, 404);
    }

    return c.json({
      data: result.socials,
      meta: { address: result.address, asOf: result.asOf, staleness: result.staleness },
    });
  });

  // Eligibility is a gate, not a lookup: a token missing from every feed can
  // still be eligible by a launchpad rule (Four.Meme or Flap), so this never 404s.
  app.get("/eligibility", async (c) => {
    const raw = c.req.query("addresses");
    if (raw === undefined || raw.trim() === "") {
      return c.json(
        { error: { code: "missing_addresses", message: "pass ?addresses=0x..,0x.." } },
        400,
      );
    }

    const requested = raw.split(",").map((value) => value.trim()).filter((value) => value !== "");
    if (requested.length > MAX_BATCH_TOKENS) {
      return c.json(
        {
          error: {
            code: "too_many_addresses",
            message: `at most ${MAX_BATCH_TOKENS} addresses per request`,
          },
        },
        400,
      );
    }

    // Unlike /tokens, malformed input is not filtered out — it comes back as an
    // explicit ineligible verdict rather than vanishing, because a caller that
    // cannot find an address in the response must not read that as an allow.
    // Duplicates still collapse, so results are keyed by `address`, not position.
    const unique = [...new Set(requested.map((value) => value.toLowerCase()))];
    const results = await isEligibleBatch(deps.store, unique);

    return c.json({
      data: results,
      meta: {
        requested: requested.length,
        eligible: results.filter((result) => result.eligible).length,
      },
    });
  });

  app.get("/eligibility/:address", async (c) => {
    const result = await isEligible(deps.store, { address: c.req.param("address") });
    return c.json({
      data: result,
      meta: { address: result.address, checkedAt: result.checkedAt, cached: result.cached },
    });
  });

  /**
   * The yield surface: the stored lane, filtered and ordered by the caller.
   *
   * Every threshold is a query parameter and none is baked in. The plane
   * discovers pools, values their APR and labels them; deciding that $50k of TVL
   * is too little, or that 200% APR is too good to be true, belongs to whoever
   * is putting up the capital. `meta.cap` and `meta.ingestOrder` say plainly
   * that this is the top of a TVL-ordered lane rather than every pool on BSC.
   */
  app.get("/pools/top", async (c) => {
    let query: PoolQuery;
    try {
      query = parsePoolQuery((name) => c.req.query(name));
    } catch (error) {
      if (error instanceof QueryError) {
        return c.json({ error: { code: "invalid_query", message: error.message } }, 400);
      }
      throw error;
    }

    const lane = await readPoolsLane(deps.store);
    const pools = lane?.pools ?? [];
    const matched = pools.filter((pool) => matchesPoolQuery(pool, query));
    const ordered = [...matched].sort((a, b) => comparePools(a, b, query.orderBy));
    const data = ordered.slice(0, query.limit);

    return c.json({
      data,
      meta: {
        total: pools.length,
        matched: matched.length,
        returned: data.length,
        cap: MAX_LANE_POOLS,
        ingestOrder: "tvlUSD",
        orderBy: query.orderBy,
        aprField: query.aprField,
        asOf: lane?.asOf ?? null,
        staleness: lane?.staleness ?? null,
        source: lane?.source ?? null,
      },
    });
  });

  app.get("/pools", async (c) => {
    const tokenParam = c.req.query("token");
    let token: string | null = null;
    if (tokenParam !== undefined) {
      token = normalizeAddress(tokenParam);
      if (token === null) {
        return c.json({ error: { code: "invalid_address", message: "token must be an address" } }, 400);
      }
    }

    const stored = await readStoredPools(deps.store);
    const filtered =
      token === null
        ? stored
        : stored.filter((entry) => entry.stats.token0 === token || entry.stats.token1 === token);

    return c.json({
      data: filtered.map((entry) => ({
        ...entry.stats,
        asOf: entry.asOf,
        staleness: entry.staleness,
      })),
      meta: { total: filtered.length, ...(token === null ? {} : { token }) },
    });
  });

  /**
   * One pool, whether or not it made the lane.
   *
   * Read-through in three steps, cheapest first: the lane, then a cached
   * per-pool snapshot, then a live explorer read that is cached on the way out
   * so an address asked about twice costs one upstream call. `meta.source` says
   * which step answered, because they differ in what they carry — only a lane
   * row has been through farm pricing and classification.
   */
  /**
   * What one position in one pool would earn.
   *
   * `/pools/top` answers "which pool" with the APR the pool as a whole earns.
   * This answers "which range", for stated capital, which on a concentrated
   * AMM is a different number entirely — and the one an LP agent actually acts
   * on. `unavailable` names any input that was missing, so a `null` here is
   * always attributable.
   */
  app.get("/pools/:address/range", async (c) => {
    const address = normalizeAddress(c.req.param("address"));
    if (address === null) {
      return c.json({ error: { code: "invalid_address", message: "not an address" } }, 400);
    }

    let request: RangeRequest;
    try {
      request = parseRangeQuery((name) => c.req.query(name));
    } catch (error) {
      if (error instanceof QueryError) {
        return c.json({ error: { code: "invalid_query", message: error.message } }, 400);
      }
      throw error;
    }

    let loaded: Awaited<ReturnType<typeof loadRangeSnapshot>>;
    try {
      loaded = await loadRangeSnapshot(deps.store, address);
    } catch {
      return c.json(
        { error: { code: "not_found", message: "no priced PancakeSwap V3 pool at that address" } },
        404,
      );
    }

    const { inputs, basis, prices } = loaded.snapshot;
    return c.json({
      data: estimateRange(inputs, request, prices, basis),
      meta: { asOf: loaded.asOf, staleness: loaded.staleness, source: "pancake" },
    });
  });

  app.get("/pools/:address", async (c) => {
    const address = normalizeAddress(c.req.param("address"));
    if (address === null) {
      return c.json({ error: { code: "invalid_address", message: "not an address" } }, 400);
    }

    const lane = await readPoolsLane(deps.store);
    const laneRow = lane?.pools.find((pool) => pool.pool === address);
    if (laneRow !== undefined && lane !== null) {
      return c.json({
        data: laneRow,
        meta: { asOf: lane.asOf, staleness: lane.staleness, source: "lane" },
      });
    }

    const stored = await deps.store.get<PoolStats>(poolKey(address));
    if (stored !== null && stored.staleness !== "dead") {
      return c.json({
        data: stored.data,
        meta: { asOf: stored.asOf, staleness: stored.staleness, source: "cache" },
      });
    }

    try {
      const stats = await fetchPancakePoolStats({ address });
      await deps.store.put(poolKey(address), stats, {
        source: stats.source,
        freshForMs: POOL_FRESH_FOR_MS,
        deadAfterMs: POOL_DEAD_AFTER_MS,
      });
      return c.json({
        data: stats,
        // Off the lane, so nothing has priced its farm or classified its tokens.
        meta: { asOf: stats.asOf, staleness: "fresh", source: "live" },
      });
    } catch {
      // A dead snapshot beats no answer: this path is telemetry, not a gate.
      if (stored !== null) {
        return c.json({
          data: stored.data,
          meta: { asOf: stored.asOf, staleness: stored.staleness, source: "cache" },
        });
      }
      return c.json(
        { error: { code: "not_found", message: "no such PancakeSwap V3 pool on bsc" } },
        404,
      );
    }
  });

  app.get("/venus/:owner", async (c) => {
    const owner = c.req.param("owner").toLowerCase();
    if (!isEvmAddress(owner)) {
      return c.json({ error: { code: "invalid_address" } }, 400);
    }

    const record = await deps.store.get<VenusHealth>(venusKey(owner));
    if (record === null) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: `owner is not tracked; add it to the ${TRACKED_VENUS_OWNERS_HINT} snapshot`,
          },
        },
        404,
      );
    }

    return c.json({
      data: record.data,
      meta: {
        asOf: record.asOf,
        source: record.source,
        staleness: record.staleness,
        deprecated: true,
        replacement: `/venus/core/accounts/${owner}`,
      },
    });
  });

  app.get("/venus/core/markets", async (c) => {
    const record = await deps.store.get<VenusCoreMarketsSnapshotV1>(VENUS_CORE_MARKETS_KEY);
    if (record === null) {
      return c.json({ data: { status: "pending" }, meta: { staleness: null } }, 202);
    }
    return c.json({
      data: record.data,
      meta: { asOf: record.asOf, source: record.source, staleness: record.staleness },
    });
  });

  app.get("/venus/core/accounts/:owner/rewards", async (c) => {
    const owner = normalizeAddress(c.req.param("owner"));
    if (owner === null) return c.json({ error: { code: "invalid_address" } }, 400);
    const tracked = (await deps.store.listTrackedSubjects(VENUS_TRACKING_NAMESPACE)).includes(owner);
    if (!tracked) return c.json({ error: { code: "not_found" } }, 404);
    const record = await deps.store.get<VenusCoreRewardsSnapshotV2>(venusCoreRewardsKey(owner));
    if (record === null) return c.json({ data: { owner, status: "pending" }, meta: { staleness: null } }, 202);
    return c.json({ data: record.data, meta: { asOf: record.asOf, source: record.source, staleness: record.staleness } });
  });

  app.get("/venus/core/accounts/:owner", async (c) => {
    const owner = normalizeAddress(c.req.param("owner"));
    if (owner === null) return c.json({ error: { code: "invalid_address" } }, 400);
    const tracked = (await deps.store.listTrackedSubjects(VENUS_TRACKING_NAMESPACE)).includes(owner);
    if (!tracked) return c.json({ error: { code: "not_found" } }, 404);
    const record = await deps.store.get<VenusCoreAccountSnapshotV2>(venusCoreAccountKey(owner));
    if (record === null) return c.json({ data: { owner, status: "pending" }, meta: { staleness: null } }, 202);
    return c.json({ data: record.data, meta: { asOf: record.asOf, source: record.source, staleness: record.staleness } });
  });

  app.put("/internal/venus/core/tracked-owners/:owner/:reference", async (c) => {
    const owner = normalizeAddress(c.req.param("owner"));
    if (owner === null) return c.json({ error: { code: "invalid_address" } }, 400);
    const reference = c.req.param("reference");
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(reference)) {
      return c.json({ error: { code: "invalid_reference" } }, 400);
    }
    const added = await deps.store.addTrackingReference(
      VENUS_TRACKING_NAMESPACE,
      owner,
      reference,
      VENUS_CORE_CAPACITY,
    );
    if (!added.accepted) return c.json({ error: { code: "capacity_exceeded" } }, 409);
    const risk = (deps.refreshVenusRisk ?? refreshVenusRisk)(deps.store, owner, AbortSignal.timeout(12_000));
    const rewards = (deps.refreshVenusRewards ?? refreshVenusRewards)(deps.store, owner, AbortSignal.timeout(15_000));
    const [riskResult, rewardsResult] = await Promise.allSettled([risk, rewards]);
    const ready = riskResult.status === "fulfilled";
    return c.json({
      data: {
        owner,
        reference,
        created: added.created,
        referenceCount: added.referenceCount,
        tracked: true,
        snapshotStatus: ready ? riskResult.value.status : "pending",
        rewardsStatus: rewardsResult.status === "fulfilled" ? rewardsResult.value.status : "pending",
      },
      meta: { capacity: VENUS_CORE_CAPACITY },
    }, ready ? (added.created ? 201 : 200) : 202);
  });

  app.delete("/internal/venus/core/tracked-owners/:owner/:reference", async (c) => {
    const owner = normalizeAddress(c.req.param("owner"));
    if (owner === null) return c.json({ error: { code: "invalid_address" } }, 400);
    const reference = c.req.param("reference");
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(reference)) {
      return c.json({ error: { code: "invalid_reference" } }, 400);
    }
    const removed = await deps.store.removeTrackingReference(VENUS_TRACKING_NAMESPACE, owner, reference);
    return c.json({
      data: {
        owner,
        reference,
        removed: removed.removed,
        referenceCount: removed.referenceCount,
        tracked: removed.referenceCount > 0,
      },
    });
  });

  app.get("/diag/latency", async (c) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });
    const results = [];
    for (const target of DIAG_TARGETS) {
      const times: number[] = [];
      let status = 0;
      for (let i = 0; i < 3; i += 1) {
        const t0 = Date.now();
        try {
          const res = await fetch(target.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal: AbortSignal.timeout(8_000),
          });
          await res.arrayBuffer();
          status = res.status;
          times.push(Date.now() - t0);
        } catch {
          times.push(-1);
        }
      }
      const ok = times.filter((t) => t >= 0);
      results.push({
        name: target.name,
        status,
        runsMs: times,
        avgMs: ok.length > 0 ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null,
      });
    }
    return c.json({ data: results });
  });

  app.get("/snapshots/:key", async (c) => {
    const key = c.req.param("key");
    if (!isAllowedSnapshotKey(key)) {
      return c.json({ error: { code: "not_found" } }, 404);
    }

    const record = await deps.store.get<unknown>(key);
    if (record === null) {
      return c.json({ error: { code: "not_found" } }, 404);
    }

    return c.json({
      data: record.data,
      meta: { key, asOf: record.asOf, source: record.source, staleness: record.staleness },
    });
  });

  app.notFound((c) => c.json({ error: { code: "not_found" } }, 404));

  app.onError((error, c) => {
    console.error(`[server] unhandled_error: ${error.message}`);
    return c.json({ error: { code: "internal_error" } }, 500);
  });

  return app;
}
