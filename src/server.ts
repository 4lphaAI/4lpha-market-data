import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Scheduler } from "./core/scheduler.js";
import type { SnapshotStore } from "./core/store.js";
import type { Lane, TokenSnapshot, VenusHealth } from "./core/models.js";
import { isEvmAddress, normalizeAddress } from "./adapters/http.js";
import { MAX_KLINE_LIMIT, SUPPORTED_INTERVALS, getKlines, parseInterval } from "./query/klines.js";
import { getSecurity } from "./query/security.js";
import { buildUniverse } from "./universe.js";
import { tokenKey } from "./jobs/tokenStore.js";
import { readStoredPools } from "./jobs/pancakePools.js";
import { venusKey } from "./jobs/venusHealth.js";

/** Collaborators the HTTP layer reads from. Injected so the app stays testable. */
export interface ServerDeps {
  scheduler: Scheduler;
  store: SnapshotStore;
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
  "pool:",
  "pools:",
  "venus:",
];

function isAllowedSnapshotKey(key: string): boolean {
  return SNAPSHOT_KEY_PREFIXES.some((prefix) =>
    prefix.endsWith(":") ? key.startsWith(prefix) : key === prefix,
  );
}

function isLane(value: string): value is Lane {
  return (LANES as string[]).includes(value);
}

/** Named in the 404 hint so an operator knows exactly which key to write. */
const TRACKED_VENUS_OWNERS_HINT = "tracked:venus-owners";

/** Most tokens one batch read may request. */
const MAX_BATCH_TOKENS = 50;

/**
 * Snapshot keys surfaced in `/status`. These are the always-on feeds; per-token
 * and per-pool keys are demand-driven and would make the list unbounded.
 */
const STATUS_SNAPSHOT_KEYS = ["heartbeat", "universe:meme", "universe:coins", "pools:index"];

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
      meta: { asOf: record.asOf, source: record.source, staleness: record.staleness },
    });
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
