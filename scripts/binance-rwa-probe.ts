/**
 * Live probe of the Binance Web3 RWA Data API: signature check, token-list
 * shape, then a rate-limit ramp. Diagnostic only — not part of the test suite,
 * and every number it prints is DevEx-report material (see DEVEX-NOTES.md).
 *
 *   node --import tsx scripts/binance-rwa-probe.ts            # shape + ramp
 *   node --import tsx scripts/binance-rwa-probe.ts --shape    # shape only
 *   node --import tsx scripts/binance-rwa-probe.ts --rps 5,10,20 --secs 10
 *
 * Signing follows https://web3.binance.com/en/dev-docs/authentication:
 * base64(HMAC-SHA256(timestamp + METHOD + requestPath + body)), where the
 * signed requestPath carries the `/build` prefix and the query string.
 */

import { createHmac, randomUUID } from "node:crypto";
import { loadDotEnv } from "../src/config/env.js";

loadDotEnv();

const HOST = "https://web3.binance.com";
const PREFIX = "/build";
const RWA = "/api/v1/dex/market/rwa";
const BSC = "56";

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
const shapeOnly = args.includes("--shape");
const useNonce = !args.includes("--no-nonce");
const stagger = !args.includes("--burst");
const rpsSteps = (flag("--rps") ?? "5,10,20").split(",").map(Number);
const secsPerStep = Number(flag("--secs") ?? "10");

interface Probe {
  status: number;
  ms: number;
  code: number | undefined;
  msg: string | undefined;
  retryAfter: string | null;
  headers: Record<string, string>;
  body?: unknown;
}

function sign(timestamp: string, method: string, requestPath: string, body = ""): string {
  return createHmac("sha256", secretKey!).update(`${timestamp}${method}${requestPath}${body}`).digest("base64");
}

async function get(path: string, query: Record<string, string> = {}): Promise<Probe> {
  const qs = new URLSearchParams(query).toString();
  const requestPath = `${PREFIX}${path}${qs ? `?${qs}` : ""}`;
  const timestamp = new Date().toISOString();
  const started = performance.now();
  const res = await fetch(`${HOST}${requestPath}`, {
    headers: {
      "X-OC-APIKEY": apiKey!,
      "X-OC-TIMESTAMP": timestamp,
      "X-OC-SIGN": sign(timestamp, "GET", requestPath),
      ...(useNonce ? { "X-OC-NONCE": randomUUID() } : {}),
      accept: "application/json",
    },
  });
  const ms = Math.round(performance.now() - started);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (/limit|retry|ratelimit|quota|x-oc/i.test(k)) headers[k] = v;
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  const rec = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return {
    status: res.status,
    ms,
    code: typeof rec["code"] === "number" ? (rec["code"] as number) : undefined,
    msg: typeof rec["msg"] === "string" ? (rec["msg"] as string) : undefined,
    retryAfter: res.headers.get("retry-after"),
    headers,
    body,
  };
}

function summary(p: Probe): string {
  return `HTTP ${p.status} code=${p.code ?? "-"} msg=${JSON.stringify(p.msg ?? "")} ${p.ms}ms` +
    (p.retryAfter ? ` retry-after=${p.retryAfter}` : "") +
    (Object.keys(p.headers).length ? ` headers=${JSON.stringify(p.headers)}` : "");
}

// ---------------------------------------------------------------- shape ----

console.log("== 1. platforms (signature check)");
const platforms = await get(`${RWA}/platforms`);
console.log(summary(platforms));
console.log(JSON.stringify(platforms.body, null, 0).slice(0, 600));

console.log("\n== 2. tokens (binanceChainId=56)");
const tokens = await get(`${RWA}/tokens`, { binanceChainId: BSC });
console.log(summary(tokens));
const list = (tokens.body as { data?: unknown[] })?.data ?? [];
console.log(`rows=${Array.isArray(list) ? list.length : "n/a"}`);
const first = Array.isArray(list) ? list[0] : undefined;
if (first) {
  console.log("first row keys:", Object.keys(first as object).join(", "));
  console.log("first row:", JSON.stringify(first).slice(0, 900));
  const byPlatform = new Map<string, number>();
  for (const row of list as Array<Record<string, unknown>>) {
    const p = String(row["platformId"] ?? "?");
    byPlatform.set(p, (byPlatform.get(p) ?? 0) + 1);
  }
  console.log("by platformId:", Object.fromEntries(byPlatform));
  const symbols = (list as Array<Record<string, unknown>>)
    .map((r) => `${r["tokenSymbol"] ?? r["symbol"]}`)
    .join(" ");
  console.log("symbols:", symbols.slice(0, 1500));
}
const topLevel = tokens.body as Record<string, unknown>;
console.log("top-level keys:", Object.keys(topLevel ?? {}).join(", "), "(pagination fields, if any, would show here)");

const addresses = Array.isArray(list)
  ? (list as Array<Record<string, unknown>>).map((r) => String(r["tokenContractAddress"] ?? "")).filter(Boolean)
  : [];

if (addresses.length > 0) {
  console.log(`\n== 3. price (batch of ${Math.min(addresses.length, 100)})`);
  const price = await get(`${RWA}/price`, {
    binanceChainId: BSC,
    tokenContractAddresses: addresses.slice(0, 100).join(","),
  });
  console.log(summary(price));
  const rows = (price.body as { data?: unknown[] })?.data ?? [];
  console.log(`rows=${Array.isArray(rows) ? rows.length : "n/a"} (requested ${Math.min(addresses.length, 100)})`);
  if (Array.isArray(rows) && rows[0]) console.log("first:", JSON.stringify(rows[0]));

  if (price.status === 414 || args.includes("--batch-scan")) {
    console.log("\n== 3b. price batch-size scan (docs say max 100; a 414 means the URL, not the API, is the cap)");
    for (const n of [10, 20, 30, 40, 50, 60, 70, 80, 90]) {
      const qs = new URLSearchParams({ binanceChainId: BSC, tokenContractAddresses: addresses.slice(0, n).join(",") }).toString();
      const p = await get(`${RWA}/price`, { binanceChainId: BSC, tokenContractAddresses: addresses.slice(0, n).join(",") });
      const got = (p.body as { data?: unknown[] })?.data;
      console.log(`  n=${n} urlLen=${HOST.length + PREFIX.length + RWA.length + 7 + qs.length} -> ${summary(p)} rows=${Array.isArray(got) ? got.length : "n/a"}`);
      await new Promise((r) => setTimeout(r, 250));
      if (p.status === 414) break;
    }
  }

  console.log("\n== 4. underlying-market (first token)");
  const um = await get(`${RWA}/underlying-market`, { binanceChainId: BSC, tokenContractAddress: addresses[0]! });
  console.log(summary(um));
  console.log(JSON.stringify(um.body).slice(0, 900));
}

if (shapeOnly) process.exit(0);

// ----------------------------------------------------------------- ramp ----

console.log(
  `\n== 5. rate-limit ramp on /tokens: ${rpsSteps.join("/")} rps x ${secsPerStep}s each (nonce=${useNonce}, ${stagger ? "staggered" : "burst"})`,
);
console.log("documented: 1200 req/60s per key and per IP, 5 rps per endpoint default, 429 + Retry-After on breach");

let totalSent = 0;
for (const rps of rpsSteps) {
  const perSecond: string[] = [];
  let ok = 0;
  let limited = 0;
  let other = 0;
  let retryAfter: string | null = null;
  let limitHeaders: Record<string, string> = {};
  let limitedBody: unknown;
  const latencies: number[] = [];

  for (let s = 0; s < secsPerStep; s++) {
    const tick = Date.now();
    // `--burst` fires all rps requests in the same tick; the default spreads them across the second.
    const batch = await Promise.all(
      Array.from({ length: rps }, async (_, i) => {
        if (stagger) await new Promise((r) => setTimeout(r, Math.floor((i * 1000) / rps)));
        return get(`${RWA}/tokens`, { binanceChainId: BSC });
      }),
    );
    totalSent += rps;
    let sOk = 0;
    let sLim = 0;
    for (const p of batch) {
      latencies.push(p.ms);
      if (p.status === 200 && p.code === 0) {
        ok++;
        sOk++;
      } else if (p.status === 429 || p.code === 429 || /rate|limit|frequen/i.test(p.msg ?? "")) {
        limited++;
        sLim++;
        retryAfter = p.retryAfter ?? retryAfter;
        if (Object.keys(p.headers).length) limitHeaders = p.headers;
        limitedBody ??= p.body;
      } else {
        other++;
        if (other <= 2) console.log("  unexpected:", summary(p));
      }
    }
    perSecond.push(`${sOk}/${sLim}`);
    const wait = 1000 - (Date.now() - tick);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  latencies.sort((a, b) => a - b);
  const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];
  console.log(
    `rps=${rps}: ok=${ok} limited=${limited} other=${other} | per-second ok/limited: ${perSecond.join(" ")}` +
      ` | latency p50=${p(0.5)}ms p95=${p(0.95)}ms max=${latencies.at(-1)}ms`,
  );
  if (limited > 0) {
    console.log(`  first 429-ish: retry-after=${retryAfter} headers=${JSON.stringify(limitHeaders)} body=${JSON.stringify(limitedBody).slice(0, 300)}`);
  }
}
console.log(`total sent in ramp: ${totalSent} (budget 1200/60s per key)`);

// Is the 5 rps bucket per endpoint (docs) or per key? Run two endpoints at 5 rps each, at once.
console.log("\n== 6. per-endpoint vs per-key: /tokens 5rps + /platforms 5rps concurrently, 4s");
const perEndpoint = { tokens: { ok: 0, limited: 0 }, platforms: { ok: 0, limited: 0 } };
for (let s = 0; s < 4; s++) {
  const tick = Date.now();
  await Promise.all(
    (["tokens", "platforms"] as const).flatMap((ep) =>
      Array.from({ length: 5 }, async (_, i) => {
        await new Promise((r) => setTimeout(r, i * 200));
        const p = await get(`${RWA}/${ep}`, ep === "tokens" ? { binanceChainId: BSC } : {});
        if (p.status === 200 && p.code === 0) perEndpoint[ep].ok++;
        else perEndpoint[ep].limited++;
      }),
    ),
  );
  const wait = 1000 - (Date.now() - tick);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
console.log(JSON.stringify(perEndpoint), "(20 sent per endpoint; 20/20 ok = per-endpoint buckets, ~10/10 = one shared bucket)");
