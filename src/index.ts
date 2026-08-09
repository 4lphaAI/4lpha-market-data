import { serve } from "@hono/node-server";
import { createScheduler } from "./core/scheduler.js";
import { createStore } from "./core/store.js";
import { createServer } from "./server.js";

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
