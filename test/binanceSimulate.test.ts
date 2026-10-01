import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createHmac } from "node:crypto";
import { createServer } from "../src/server.js";
import { MemoryStore } from "../src/core/store.js";
import { createScheduler } from "../src/core/scheduler.js";
import { BINANCE_RWA_LIMITER } from "../src/adapters/binanceRwa.js";
import { ERC7821_BATCH_MODE_WORD, fetchBinanceSimulate, normalizeBinanceSimulateResponse, parseBinanceSimulateRequest, readBinanceSimulateEnabled } from "../src/adapters/binanceSimulate.js";

const WALLET = "0x27146e20c2fb2521c7dd73e97be030c3147c9da6";
const TOKEN = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const DATA = `0xe9ae5c53${ERC7821_BATCH_MODE_WORD}${"00".repeat(64)}`;
const REQUEST = { from: WALLET, to: WALLET, data: DATA };
type Envelope = { error: { reason: string }; meta: { upstreamMs: number } };
const SUCCESS = { status: "SUCCESS", failReason: "", balanceChanges: [
  { contractAddress: TOKEN, tokenType: "Erc20", change: "4323945330964287", owner: WALLET },
  { contractAddress: "0x55d398326f99059ff775485246999027b3197955", tokenType: "Erc20", change: "-1000000000000000000", owner: WALLET },
], allowanceChanges: [] };
const original = { ...process.env };
afterEach(() => { for (const key of ["DP_AUTH_TOKEN", "BINANCE_WEB3_API_KEY", "BINANCE_WEB3_SECRET_KEY"]) {
  if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
} });
const credentials = () => { process.env["DP_AUTH_TOKEN"] = "offline"; process.env["BINANCE_WEB3_API_KEY"] = "offline-key"; process.env["BINANCE_WEB3_SECRET_KEY"] = "offline-secret"; };
const upstream = (data: unknown = SUCCESS, code: unknown = 0, status = 200) => new Response(JSON.stringify({ code, data }), { status });

it("DP1 forwards raw reasons and validates every bounded change shape", () => {
  const result = normalizeBinanceSimulateResponse(SUCCESS);
  assert.equal(result.balanceChanges[0]?.change, "4323945330964287"); assert.equal(result.balanceChanges[1]?.change, "-1000000000000000000");
  assert.equal(result.otherChangeCount, 0);
  for (const reason of ["execution reverted: Too little received", "x".repeat(300), " execution reverted\nArguments: x"]) {
    assert.equal(normalizeBinanceSimulateResponse({ status: "FAILED", failReason: reason, balanceChanges: [] }).failReason, reason);
  }
  for (const patch of [{ status: "other" }, { failReason: "x".repeat(2049) }, { balanceChanges: Array(65).fill({}) },
    { balanceChanges: [null] }, { balanceChanges: [{ ...SUCCESS.balanceChanges[0], change: "01" }] },
    { balanceChanges: [{ ...SUCCESS.balanceChanges[0], change: (1n << 256n).toString() }] }, { allowanceChanges: Array(65).fill({}) }]) {
    assert.throws(() => normalizeBinanceSimulateResponse({ ...SUCCESS, ...patch }));
  }
  assert.equal(normalizeBinanceSimulateResponse({ ...SUCCESS, balanceChanges: [{ tokenType: "Erc721" }] }).otherChangeCount, 1);
});
it("DP2 admits only bounded batch self-calls", () => {
  assert.deepEqual(parseBinanceSimulateRequest(REQUEST), REQUEST);
  for (const [patch, reason] of [
    [{ extra: 1 }, "request_shape_invalid"], [{ to: TOKEN }, "self_call_required"],
    [{ data: DATA.replace("e9ae5c53", "12345678") }, "execute_batch_required"],
    [{ data: DATA.replace("0100", "0200") }, "execute_batch_required"],
    [{ data: DATA + "0" }, "request_shape_invalid"], [{ data: DATA + "00".repeat(98306) }, "data_too_large"],
  ] as const) assert.equal(parseBinanceSimulateRequest({ ...REQUEST, ...patch }), reason);
  assert.equal(typeof parseBinanceSimulateRequest({ ...REQUEST, data: DATA + "0".repeat(152906 - DATA.length) }), "object");
});
it("DP3 internal auth, disabled flag, bounded body and closed upstream failures", async () => {
  credentials();
  const store = new MemoryStore(), scheduler = createScheduler(store);
  const post = (app: ReturnType<typeof createServer>, body = JSON.stringify(REQUEST), token = "offline") => app.request("/internal/binance/pre-transaction/simulate", { method: "POST", body, headers: { "x-dp-token": token } });
  let app = createServer({ store, scheduler });
  assert.equal((await post(app)).status, 503);
  delete process.env["DP_AUTH_TOKEN"];
  assert.equal((await post(app)).status, 503);
  credentials(); assert.equal((await post(app, "{}", "wrong")).status, 401);
  app = createServer({ store, scheduler, binanceSimulateEnabled: true, fetchBinanceSimulate: async () => upstream() });
  assert.equal((await post(app, " ".repeat(262145))).status, 400);
  let count = 0;
  for (const [status, code, expected] of [[429, 0, "upstream_rate_limited"], [401, 0, "auth_rejected"], [403, 0, "auth_rejected"], [200, 40001, "code:40001"]] as const) {
    count = 0; app = createServer({ store, scheduler, binanceSimulateEnabled: true, fetchBinanceSimulate: async () => { count += 1; return upstream(SUCCESS, code, status); } });
    assert.equal(((await (await post(app)).json()) as Envelope).error.reason, expected); assert.equal(count, 1);
  }
  delete process.env["BINANCE_WEB3_API_KEY"];
  let acquired = 0;
  await assert.rejects(fetchBinanceSimulate(REQUEST, { limiter: { acquire: async () => { acquired += 1; }, available: () => 1 } }));
  assert.equal(acquired, 0);
  assert.equal(((await (await post(app)).json()) as Envelope).error.reason, "credentials_unavailable");
});
it("DP3 limiter and upstream deadlines produce their closed reasons", async () => {
  credentials();
  const keepAlive = setTimeout(() => {}, 2500);
  try {
    await assert.rejects(fetchBinanceSimulate(REQUEST, { budgetWaitMs: 1, limiter: {
      available: () => 0, acquire: signal => new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    } }), { constructor: (await import("../src/adapters/binanceSimulate.js")).BinanceSimulateRateBudgetError });
    const store = new MemoryStore();
    const app = createServer({ store, scheduler: createScheduler(store), binanceSimulateEnabled: true,
      fetchBinanceSimulate: async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) });
    const response = await app.request("/internal/binance/pre-transaction/simulate", { method: "POST", body: JSON.stringify(REQUEST), headers: { "x-dp-token": "offline" } });
    assert.equal(((await response.json()) as Envelope).error.reason, "upstream_timeout");
  } finally { clearTimeout(keepAlive); }
});
it("DP3 upstream codes are normalized once for responses and logs", async t => {
  credentials();
  const lines: string[] = []; t.mock.method(console, "warn", (line: string) => lines.push(line));
  for (const raw of ["bad\ncode", "https://fake.invalid/path", "x".repeat(300), "apiKey=private-value"]) {
    const store = new MemoryStore();
    const app = createServer({ store, scheduler: createScheduler(store), binanceSimulateEnabled: true, fetchBinanceSimulate: async () => upstream(SUCCESS, raw) });
    const response = await app.request("/internal/binance/pre-transaction/simulate", { method: "POST", body: JSON.stringify(REQUEST), headers: { "x-dp-token": "offline" } });
    assert.equal(((await response.json()) as Envelope).error.reason, "code:other"); assert.match(lines.at(-1)!, /code=other/u); assert.ok(!lines.at(-1)!.includes(raw));
  }
});
it("DP4 one signed POST uses the measured body and shared bucket", async () => {
  credentials();
  const store = new MemoryStore();
  let count = 0;
  const app = createServer({ store, scheduler: createScheduler(store), binanceSimulateEnabled: true, fetchBinanceSimulate: async (url, init) => {
    count += 1; assert.equal(String(url), "https://web3.binance.com/build/api/v1/dex/pre-transaction/simulate");
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
    const body = JSON.stringify({ binanceChainId: "56", evmTx: { from: WALLET, to: WALLET, value: "0", data: DATA } });
    assert.equal(init?.body, body);
    const headers = new Headers(init?.headers);
    for (const key of ["X-OC-APIKEY", "X-OC-NONCE", "X-OC-TIMESTAMP", "X-OC-SIGN"]) assert.ok(headers.get(key));
    const expected = createHmac("sha256", "offline-secret").update(headers.get("X-OC-TIMESTAMP")! + "POST/build/api/v1/dex/pre-transaction/simulate" + body).digest("base64");
    assert.equal(headers.get("X-OC-SIGN"), expected); return upstream();
  } });
  const response = await app.request("/internal/binance/pre-transaction/simulate", { method: "POST", body: JSON.stringify(REQUEST), headers: { "x-dp-token": "offline" } });
  assert.equal(response.status, 200); assert.equal(count, 1); assert.ok(Number.isInteger(((await response.json()) as Envelope).meta.upstreamMs));
  assert.ok(BINANCE_RWA_LIMITER.available() >= 0);
});
it("DP5 flag is off by default and rejects typos", () => {
  assert.equal(readBinanceSimulateEnabled({}), false); assert.equal(readBinanceSimulateEnabled({ BINANCE_SIMULATE_ENABLED: "false" }), false);
  assert.equal(readBinanceSimulateEnabled({ BINANCE_SIMULATE_ENABLED: "true" }), true); assert.throws(() => readBinanceSimulateEnabled({ BINANCE_SIMULATE_ENABLED: "yes" }));
});
