/**
 * Load test for the data plane's read path.
 *
 * Fires a fixed request rate at the store-backed endpoints (never directly at
 * upstreams — a cache-missing kline read is excluded on purpose so the test
 * cannot burn provider quota) and reports latency percentiles per route.
 *
 *   npm run loadtest -- [baseUrl] [seconds] [rps]
 *
 * Defaults: http://localhost:8080, 30 seconds, 100 req/s. Diagnostic: always
 * exits 0; read the table.
 */

import { loadDotEnv } from "../src/config/env.js";

loadDotEnv();

const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const TSLAB = "0x5b1910eaad6450e50f816082aa078c41f10c292f";

interface RouteResult {
  route: string;
  durations: number[];
  statuses: Map<number, number>;
  networkErrors: number;
}

const baseUrl = (process.argv[2] ?? "http://localhost:8080").replace(/\/$/, "");
const seconds = parsePositive(process.argv[3], 30);
const rps = parsePositive(process.argv[4], 100);

/** Store-backed read mix. Weights sum to 100. */
const MIX: Array<{ route: string; weight: number }> = [
  { route: "/health", weight: 10 },
  { route: "/status", weight: 10 },
  { route: "/universe", weight: 15 },
  { route: "/universe?lane=bstocks", weight: 15 },
  { route: `/tokens/${NVDAB}`, weight: 20 },
  { route: `/tokens?addresses=${NVDAB},${TSLAB}`, weight: 20 },
  { route: "/pools", weight: 10 },
];

function parsePositive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function pickRoute(): string {
  let roll = Math.random() * 100;
  for (const entry of MIX) {
    roll -= entry.weight;
    if (roll <= 0) return entry.route;
  }
  return MIX[MIX.length - 1]?.route ?? "/health";
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

async function fireOne(results: Map<string, RouteResult>): Promise<void> {
  const route = pickRoute();
  let result = results.get(route);
  if (result === undefined) {
    result = { route, durations: [], statuses: new Map(), networkErrors: 0 };
    results.set(route, result);
  }

  const startedAt = performance.now();
  try {
    const token = process.env["DP_AUTH_TOKEN"]?.trim();
    const response = await fetch(`${baseUrl}${route}`, {
      signal: AbortSignal.timeout(10_000),
      ...(token === undefined || token === "" ? {} : { headers: { "x-dp-token": token } }),
    });
    // Drain so keep-alive sockets are reusable and timings include the body.
    await response.arrayBuffer();
    result.durations.push(performance.now() - startedAt);
    result.statuses.set(response.status, (result.statuses.get(response.status) ?? 0) + 1);
  } catch {
    result.durations.push(performance.now() - startedAt);
    result.networkErrors += 1;
  }
}

async function main(): Promise<void> {
  console.log(`target=${baseUrl} duration=${seconds}s rate=${rps}rps`);

  const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) }).catch(
    () => null,
  );
  if (health === null || !health.ok) {
    console.error("target is not answering /health — start the service first");
    process.exitCode = 1;
    return;
  }
  await health.arrayBuffer();

  const results = new Map<string, RouteResult>();
  const inFlight = new Set<Promise<void>>();
  const endAt = Date.now() + seconds * 1_000;
  const tickMs = 100;
  const perTick = Math.max(1, Math.round(rps / (1_000 / tickMs)));

  while (Date.now() < endAt) {
    for (let i = 0; i < perTick; i += 1) {
      const task = fireOne(results).finally(() => {
        inFlight.delete(task);
      });
      inFlight.add(task);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, tickMs);
    });
  }
  await Promise.all([...inFlight]);

  let total = 0;
  let errors = 0;
  const rows = [...results.values()].sort((a, b) => a.route.localeCompare(b.route));

  console.log("");
  console.log(
    `${"ROUTE".padEnd(46)} ${"N".padStart(6)} ${"p50".padStart(7)} ${"p95".padStart(7)} ${"p99".padStart(7)} ${"max".padStart(7)}  STATUS`,
  );
  console.log("-".repeat(100));
  for (const row of rows) {
    const sorted = [...row.durations].sort((a, b) => a - b);
    total += sorted.length;
    const statusText = [...row.statuses.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([status, count]) => `${status}x${count}`)
      .join(" ");
    const non2xx = [...row.statuses.entries()]
      .filter(([status]) => status < 200 || status >= 300)
      .reduce((sum, [, count]) => sum + count, 0);
    errors += non2xx + row.networkErrors;
    console.log(
      `${row.route.padEnd(46)} ${String(sorted.length).padStart(6)} ${fmt(percentile(sorted, 50))} ${fmt(percentile(sorted, 95))} ${fmt(percentile(sorted, 99))} ${fmt(sorted[sorted.length - 1] ?? 0)}  ${statusText}${row.networkErrors > 0 ? ` neterr=${row.networkErrors}` : ""}`,
    );
  }
  console.log("-".repeat(100));
  const errorPct = total === 0 ? 0 : (errors / total) * 100;
  console.log(`total=${total} errors=${errors} (${errorPct.toFixed(2)}%)`);
}

function fmt(ms: number): string {
  return `${ms.toFixed(1).padStart(6)}ms`.padStart(7);
}

await main();
