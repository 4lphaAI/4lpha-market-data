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
export function createServer(deps: ServerDeps): Hono {
  const startedAt = Date.now();
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      data: {
        ok: true,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      },
    }),
  );

  app.get("/status", (c) =>
    c.json({
      data: {
        jobs: deps.scheduler.healthSnapshot(),
        startedAt,
      },
    }),
  );

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
