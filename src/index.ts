import { serve } from "@hono/node-server";
import { loadDotEnv } from "./config/env.js";
import { createScheduler } from "./core/scheduler.js";
import { createStore } from "./core/store.js";
import { createServer } from "./server.js";
import { binancePricesJob } from "./jobs/binancePrices.js";
import { binanceUniverseJob } from "./jobs/binanceUniverse.js";
import { flapLaunchesJob } from "./jobs/flapLaunches.js";
import { fourmemeRankingJob } from "./jobs/fourmemeRanking.js";
import { majorsPricesJob } from "./jobs/majorsPrices.js";
import { pancakePoolsJob } from "./jobs/pancakePools.js";
import { tradingFeaturesJob } from "./jobs/tradingFeatures.js";
import {
  venusCoreHotJob,
  venusCoreMarketsJob,
  venusCoreRewardsJob,
  venusCoreRiskJob,
} from "./jobs/venusCore.js";

loadDotEnv();

const DEFAULT_PORT = 8080;

function resolvePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`invalid PORT: ${raw}`);
  }
  return parsed;
}

const store = await createStore();
const scheduler = createScheduler(store);

scheduler.register({
  name: "heartbeat",
  intervalMs: 30_000,
  jitterMs: 1_000,
  timeoutMs: 5_000,
  run: async () => {
    await store.put(
      "heartbeat",
      { ts: Date.now() },
      { source: "heartbeat", freshForMs: 60_000, deadAfterMs: 300_000 },
    );
  },
});

// Market-data producers. Each is fully isolated by the scheduler: a failing
// upstream degrades its own lane and nothing else.
scheduler.register(fourmemeRankingJob(store));
// The other half of the meme lane. Independent of the Four.Meme job on purpose:
// they write different keys, so one launchpad going dark cannot blank the other.
scheduler.register(flapLaunchesJob(store));
scheduler.register(binanceUniverseJob(store));
scheduler.register(binancePricesJob(store));
scheduler.register(pancakePoolsJob(store));
scheduler.register(tradingFeaturesJob(store));
// USD prices for the majors every wallet holds; the lanes never carry them.
scheduler.register(majorsPricesJob(store));
// Venus Core v2: independent catalog, risk, hot-risk and reward producers.
scheduler.register(venusCoreMarketsJob(store));
scheduler.register(venusCoreRiskJob(store));
scheduler.register(venusCoreHotJob(store));
scheduler.register(venusCoreRewardsJob(store));

scheduler.start();

const app = createServer({ scheduler, store });
const port = resolvePort(process.env["PORT"]);
const server = serve({ fetch: app.fetch, port });

console.log(`[server] listening on port ${port}`);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await scheduler.stop();
  await store.close();
  console.log("[server] shutdown complete");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      console.error(`[server] shutdown_failed: ${error instanceof Error ? error.message : "unknown error"}`);
      process.exitCode = 1;
    });
  });
}
