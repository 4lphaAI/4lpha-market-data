import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import {
  BinanceFlashInvalidResponseError,
  fetchBinanceFlashQuote,
  normalizeBinanceFlashResponse,
} from "../src/adapters/binanceFlash.js";
import {
  BINANCE_FLASH_USDT_ADDRESS,
  type BinanceFlashConfig,
} from "../src/config/binanceFlash.js";
import { createServer } from "../src/server.js";

const TAKER = "0x1111111111111111111111111111111111111111";
const ROUTER = "0xb44446b0c8e56988c34f7ff73ae904982b5fdda5";
const SPENDER = ROUTER;
const RWA_TOKEN = "0x4444444444444444444444444444444444444444";
const RUNTIME_CODE_HASH = `0x${"11".repeat(32)}`;
const AMOUNT_ATOMIC = "1000000000000000000";
const APPROVE_CALLDATA = `0x095ea7b3${SPENDER.slice(2).padStart(64, "0")}${BigInt(AMOUNT_ATOMIC).toString(16).padStart(64, "0")}`;
const APPROVAL_EVIDENCE = JSON.stringify({ approveContract: SPENDER, approveTxCalldata: APPROVE_CALLDATA });
const WRONG_APPROVAL_EVIDENCE = JSON.stringify({
  approveContract: TAKER,
  approveTxCalldata: `0x095ea7b3${TAKER.slice(2).padStart(64, "0")}${BigInt(AMOUNT_ATOMIC).toString(16).padStart(64, "0")}`,
});

const CONFIG: BinanceFlashConfig = {
  chainId: 56,
  vendor: "LiquidMesh",
  taker: TAKER,
  router: ROUTER,
  spender: SPENDER,
  guardRuntimeCodeHash: RUNTIME_CODE_HASH,
};

/** Protocol-shaped offline fixture; it is not a live provider response. */
const PROTOCOL_SHAPED_DATA = {
  routerResult: {
    binanceChainId: "56",
    vendorName: "LiquidMesh",
    fromTokenAmount: "1000000000000000000",
    toTokenAmount: "250000000000000000",
    tradeFee: null,
    estimateGasFee: "180000",
    router: `${BINANCE_FLASH_USDT_ADDRESS}--${RWA_TOKEN}`,
    priceImpactPercent: "-0.01",
    fromToken: { tokenContractAddress: BINANCE_FLASH_USDT_ADDRESS, tokenSymbol: "USDT", decimal: "18" },
    toToken: { tokenContractAddress: RWA_TOKEN, tokenSymbol: "NVDAB", decimal: "18" },
    feeAmount: null,
    feeToken: null,
    actualSwapAmount: null,
  },
  tx: {
    from: TAKER,
    to: ROUTER,
    data: "0xad43f73daabbccdd",
    value: "0",
    gas: "180000",
    gasPrice: "3000000000",
    minReceiveAmount: "247500000000000000",
    slippagePercent: "1.00",
    signatureData: [APPROVAL_EVIDENCE],
  },
  executionMode: "SWAP",
  rfq: null,
  timestamp: 1_900_000_000_000,
} as const;

const REQUEST = {
  tokenIn: BINANCE_FLASH_USDT_ADDRESS,
  tokenOut: RWA_TOKEN,
  amountAtomic: AMOUNT_ATOMIC,
  slippageBps: 100,
} as const;

const originalApiKey = process.env["BINANCE_WEB3_API_KEY"];
const originalSecretKey = process.env["BINANCE_WEB3_SECRET_KEY"];
const originalDpToken = process.env["DP_AUTH_TOKEN"];

afterEach(() => {
  if (originalApiKey === undefined) delete process.env["BINANCE_WEB3_API_KEY"];
  else process.env["BINANCE_WEB3_API_KEY"] = originalApiKey;
  if (originalSecretKey === undefined) delete process.env["BINANCE_WEB3_SECRET_KEY"];
  else process.env["BINANCE_WEB3_SECRET_KEY"] = originalSecretKey;
  if (originalDpToken === undefined) delete process.env["DP_AUTH_TOKEN"];
  else process.env["DP_AUTH_TOKEN"] = originalDpToken;
});

function armCredentials(): void {
  process.env["BINANCE_WEB3_API_KEY"] = "offline-api-key";
  process.env["BINANCE_WEB3_SECRET_KEY"] = "offline-secret-key";
}

function providerResponse(data: unknown = PROTOCOL_SHAPED_DATA, status = 200): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("Binance Flash adapter", () => {
  it("normalizes the protocol-shaped fixture and applies the local 15-second validity", () => {
    const startedAt = 1_900_000_000_000;
    const quote = normalizeBinanceFlashResponse(PROTOCOL_SHAPED_DATA, REQUEST, CONFIG, startedAt);
    assert.equal(quote.version, "tradfi-binance-flash-v1");
    assert.equal(quote.taker, TAKER);
    assert.equal(quote.router, ROUTER);
    assert.equal(quote.spender, SPENDER);
    assert.equal(quote.calldata, "0xad43f73daabbccdd");
    assert.equal(quote.value, "0");
    assert.equal(quote.observedAt, startedAt);
    assert.equal(quote.expiresAt, startedAt + 15_000);
  });

  it("sends one signed GET with closed Flash options and does not retry a 429", async () => {
    armCredentials();
    let calls = 0;
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchFn: typeof globalThis.fetch = async (input, init) => {
      calls += 1;
      seenUrl = String(input);
      seenInit = init;
      return new Response("rate limited", { status: 429 });
    };

    await assert.rejects(
      fetchBinanceFlashQuote(REQUEST, CONFIG, { fetchFn, requestStartedAt: 1_900_000_000_000 }),
      /rate limited/u,
    );
    assert.equal(calls, 1);
    const url = new URL(seenUrl);
    assert.equal(url.origin, "https://web3.binance.com");
    assert.equal(url.pathname, "/build/api/v1/dex/aggregator/quote-and-swap");
    assert.equal(url.searchParams.get("binanceChainId"), "56");
    assert.equal(url.searchParams.get("amount"), REQUEST.amountAtomic);
    assert.equal(url.searchParams.get("fromTokenAddress"), REQUEST.tokenIn);
    assert.equal(url.searchParams.get("toTokenAddress"), REQUEST.tokenOut);
    assert.equal(url.searchParams.get("userWalletAddress"), TAKER);
    assert.equal(url.searchParams.get("vendor"), "LiquidMesh");
    assert.equal(url.searchParams.get("slippagePercent"), "1.00");
    assert.equal(url.searchParams.get("enableRFQ"), "true");
    assert.equal(url.searchParams.get("approveTransaction"), "true");
    assert.equal(url.searchParams.get("approveAmount"), REQUEST.amountAtomic);
    assert.equal(url.searchParams.get("autoSlippage"), "false");
    assert.equal(seenInit?.method, "GET");
    assert.equal(seenInit?.redirect, "error");
  });

  it("refuses an unexpected router or spender as an invalid provider response", () => {
    const bad = {
      ...PROTOCOL_SHAPED_DATA,
      tx: { ...PROTOCOL_SHAPED_DATA.tx, to: TAKER },
    };
    assert.throws(
      () => normalizeBinanceFlashResponse(bad, REQUEST, CONFIG, 1_900_000_000_000),
      (error: unknown) => error instanceof BinanceFlashInvalidResponseError && error.reason === "router_mismatch",
    );
    const wrongSpender = {
      ...PROTOCOL_SHAPED_DATA,
      tx: { ...PROTOCOL_SHAPED_DATA.tx, signatureData: [WRONG_APPROVAL_EVIDENCE] },
    };
    assert.throws(
      () => normalizeBinanceFlashResponse(wrongSpender, REQUEST, CONFIG, 1_900_000_000_000),
      (error: unknown) => error instanceof BinanceFlashInvalidResponseError && error.reason === "spender_mismatch",
    );
  });

  it("rejects the historical selector and other opaque selectors", () => {
    const historical = {
      ...PROTOCOL_SHAPED_DATA,
      tx: { ...PROTOCOL_SHAPED_DATA.tx, data: "0x810c705baabbccdd" },
    };
    assert.throws(
      () => normalizeBinanceFlashResponse(historical, REQUEST, CONFIG, 1_900_000_000_000),
      (error: unknown) => error instanceof BinanceFlashInvalidResponseError && error.reason === "calldata_selector",
    );
    const unknown = {
      ...PROTOCOL_SHAPED_DATA,
      tx: { ...PROTOCOL_SHAPED_DATA.tx, data: "0xdeadbeefaabbccdd" },
    };
    assert.throws(
      () => normalizeBinanceFlashResponse(unknown, REQUEST, CONFIG, 1_900_000_000_000),
      (error: unknown) => error instanceof BinanceFlashInvalidResponseError && error.reason === "calldata_selector",
    );
    const short = {
      ...PROTOCOL_SHAPED_DATA,
      tx: { ...PROTOCOL_SHAPED_DATA.tx, data: "0xad43" },
    };
    assert.throws(
      () => normalizeBinanceFlashResponse(short, REQUEST, CONFIG, 1_900_000_000_000),
      (error: unknown) => error instanceof BinanceFlashInvalidResponseError && error.reason === "calldata_size",
    );
  });
});

describe("POST /trading/binance/quote-and-swap", () => {
  it("returns the normalized quote only for a fresh known RWA token", async () => {
    armCredentials();
    const store = new MemoryStore();
    await store.put("universe:rwa", { rows: [{ address: RWA_TOKEN }], byPlatform: { bstock: 1 } }, {
      source: "binance-rwa",
      freshForMs: 60_000,
      deadAfterMs: 300_000,
    });
    let calls = 0;
    const fetchFn: typeof globalThis.fetch = async () => {
      calls += 1;
      return providerResponse();
    };
    const app = createServer({ scheduler: createScheduler(store), store, binanceFlash: CONFIG, fetchBinanceFlash: fetchFn });
    const response = await app.request("/trading/binance/quote-and-swap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REQUEST),
    });
    assert.equal(response.status, 200);
    const body: unknown = await response.json();
    assert.ok(isRecord(body));
    assert.equal(calls, 1);
    assert.ok(isRecord(body["data"]));
    assert.equal(body["data"]["tokenOut"], RWA_TOKEN);
    assert.equal(body["data"]["value"], "0");
    await store.close();
  });

  it("returns a closed unavailable error when verified guard configuration is absent", async () => {
    const store = new MemoryStore();
    const app = createServer({ scheduler: createScheduler(store), store, binanceFlash: null });
    const response = await app.request("/trading/binance/quote-and-swap", {
      method: "POST",
      body: JSON.stringify(REQUEST),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      data: null,
      error: { code: "aggregator_guard_unavailable", reason: "verified_guard_config_missing" },
    });
    await store.close();
  });

  it("refuses a token outside the fresh RWA registry without touching upstream", async () => {
    armCredentials();
    const store = new MemoryStore();
    await store.put("universe:rwa", { rows: [], byPlatform: {} }, {
      source: "binance-rwa",
      freshForMs: 60_000,
      deadAfterMs: 300_000,
    });
    let calls = 0;
    const fetchFn: typeof globalThis.fetch = async () => {
      calls += 1;
      return providerResponse();
    };
    const app = createServer({ scheduler: createScheduler(store), store, binanceFlash: CONFIG, fetchBinanceFlash: fetchFn });
    const response = await app.request("/trading/binance/quote-and-swap", {
      method: "POST",
      body: JSON.stringify(REQUEST),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      data: null,
      error: { code: "binance_no_route", reason: "token_not_in_rwa_registry" },
    });
    assert.equal(calls, 0);
    await store.close();
  });

  it("enforces the request body bound", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const fetchFn: typeof globalThis.fetch = async () => {
      calls += 1;
      return providerResponse();
    };
    const app = createServer({ scheduler: createScheduler(store), store, binanceFlash: CONFIG, fetchBinanceFlash: fetchFn });
    const response = await app.request("/trading/binance/quote-and-swap", {
      method: "POST",
      body: `${JSON.stringify(REQUEST)}${" ".repeat(4096)}`,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      data: null,
      error: { code: "binance_no_route", reason: "request_body_too_large" },
    });
    assert.equal(calls, 0);
    await store.close();
  });
});
