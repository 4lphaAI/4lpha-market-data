/**
 * Measures the Binance Web3 key's real rate ceiling after the 2026-10-01 raise.
 * Read-only (`/platforms`, `/tokens`, `/underlying-market`); no swaps, no Flash.
 *
 *   node --import tsx scripts/binance-rate-ceiling.ts                 # all phases
 *   node --import tsx scripts/binance-rate-ceiling.ts --rps 40 --max-secs 40
 *
 * Phases: (1) idle header reads, to see how `x-oc-ratelimit-remaining` moves;
 * (2) a same-tick burst across two endpoints; (3) a sustained two-endpoint
 * load until 429 42900 appears; (4) recovery polling. Everything printed is
 * PITFALL-6 material. It will exhaust the key's budget on purpose, so do not
 * run it while agents depend on the key.
 */

import { createHmac, randomUUID } from "node:crypto";
import { loadDotEnv } from "../src/config/env.js";

loadDotEnv();

const HOST = "https://web3.binance.com";
const PREFIX = "/build";
const RWA = "/api/v1/dex/market/rwa";

const apiKey = process.env["BINANCE_WEB3_API_KEY"]?.trim();
const secretKey = process.env["BINANCE_WEB3_SECRET_KEY"]?.trim();
if (!apiKey || !secretKey) {
  console.error("BINANCE_WEB3_API_KEY / BINANCE_WEB3_SECRET_KEY missing in .env");
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sustainedRps = Number(flag("--rps") ?? "40");
const maxSecs = Number(flag("--max-secs") ?? "40");
const burstSize = Number(flag("--burst") ?? "40");
const onlySustained = args.includes("--only-sustained");

const ENDPOINTS: Array<{ path: string; query: Record<string, string> }> = [
  { path: `${RWA}/tokens`, query: { binanceChainId: "56" } },
  { path: `${RWA}/platforms`, query: {} },
];

interface Result {
  status: number;
  ms: number;
  code: number | undefined;
  limit: string | null;
  remaining: string | null;
  retryAfter: string | null;
  blockedBy: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function call(i: number): Promise<Result> {
  const { path, query } = ENDPOINTS[i % ENDPOINTS.length]!;
  const qs = new URLSearchParams(query).toString();
  const requestPath = `${PREFIX}${path}${qs ? `?${qs}` : ""}`;
  const timestamp = new Date().toISOString();
  const signature = createHmac("sha256", secretKey!)
    .update(`${timestamp}GET${requestPath}`)
    .digest("base64");
  const started = performance.now();
  const res = await fetch(`${HOST}${requestPath}`, {
    headers: {
      "X-OC-APIKEY": apiKey!,
      "X-OC-TIMESTAMP": timestamp,
      "X-OC-SIGN": signature,
      "X-OC-NONCE": randomUUID(),
      accept: "application/json",
    },
  });
  const ms = Math.round(performance.now() - started);
  const text = await res.text();
  let code: number | undefined;
  try {
    const parsed = JSON.parse(text) as { code?: unknown };
    if (typeof parsed.code === "number") code = parsed.code;
  } catch {
    // non-JSON body: status alone tells the story
  }
  return {
    status: res.status,
    ms,
    code,
    limit: res.headers.get("x-oc-ratelimit-limit"),
    remaining: res.headers.get("x-oc-ratelimit-remaining"),
    retryAfter: res.headers.get("retry-after"),
    blockedBy: res.headers.get("x-oc-blocked-by"),
  };
}

const isOk = (r: Result): boolean => r.status === 200 && r.code === 0;
const stamp = (): string => new Date().toISOString().slice(11, 23);

console.log(`start ${new Date().toISOString()}`);

console.log("\n== 1. idle header reads (limit / remaining at 0s, 1s, 5s, 15s)");
for (const wait of onlySustained ? [] : [0, 1000, 4000, 10000]) {
  await sleep(wait);
  const r = await call(0);
  console.log(`${stamp()} HTTP ${r.status} limit=${r.limit} remaining=${r.remaining} ${r.ms}ms`);
}

console.log(`\n== 2. same-tick burst of ${burstSize} across two endpoints`);
if (!onlySustained) {
  const results = await Promise.all(Array.from({ length: burstSize }, (_, i) => call(i)));
  const ok = results.filter(isOk).length;
  const limited = results.filter((r) => r.status === 429);
  const remaining = results.map((r) => Number(r.remaining)).filter(Number.isFinite);
  console.log(
    `ok=${ok} limited=${limited.length} other=${results.length - ok - limited.length}` +
      ` | remaining min=${Math.min(...remaining)} | limit header=${results[0]?.limit}`,
  );
  if (limited[0]) console.log(`first 429: code=${limited[0].code} retry-after=${limited[0].retryAfter} blocked-by=${limited[0].blockedBy}`);
}

console.log(`\n== 3. sustained ${sustainedRps} rps across two endpoints, stop after 3 limited seconds or ${maxSecs}s`);
let sent = 0;
let limitedSeconds = 0;
let firstLimitedAt: number | null = null;
for (let s = 0; s < maxSecs && limitedSeconds < 3; s++) {
  const tick = Date.now();
  const batch = await Promise.all(
    Array.from({ length: sustainedRps }, async (_, i) => {
      await sleep(Math.floor((i * 1000) / sustainedRps));
      return call(i);
    }),
  );
  sent += batch.length;
  const ok = batch.filter(isOk).length;
  const limited = batch.filter((r) => r.status === 429);
  const remaining = batch.map((r) => Number(r.remaining)).filter(Number.isFinite);
  if (limited.length > 0) {
    limitedSeconds++;
    firstLimitedAt ??= sent - batch.length + batch.findIndex((r) => r.status === 429);
  }
  console.log(
    `${stamp()} s=${s} ok=${ok} limited=${limited.length} remaining min=${remaining.length ? Math.min(...remaining) : "-"} max=${remaining.length ? Math.max(...remaining) : "-"}` +
      (limited[0] ? ` retry-after=${limited[0].retryAfter} code=${limited[0].code} blocked-by=${limited[0].blockedBy}` : ""),
  );
  const wait = 1000 - (Date.now() - tick);
  if (wait > 0) await sleep(wait);
}
console.log(`total sent in phase 3: ${sent}; first limited request index: ${firstLimitedAt ?? "none"}`);

console.log("\n== 4. recovery: one request every 2s until 200 (max 90s)");
{
  const started = Date.now();
  for (;;) {
    const r = await call(0);
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(`${stamp()} +${elapsed}s HTTP ${r.status} remaining=${r.remaining} retry-after=${r.retryAfter}`);
    if (isOk(r) || elapsed > 90) break;
    await sleep(2000);
  }
}
