/**
 * Read-only measurement for the TradFi aggregator handoff (A4): does
 * `enableRFQ=true` hand back quotes the proxy's normalizer then refuses?
 * Every token × side × size is quoted with enableRFQ=true and =false back to
 * back. No signing of transactions, no funds: the taker is an unfunded EOA.
 * Usage: node --import tsx scripts/flash-rfq-probe.ts [passes]
 */
import { randomUUID } from "node:crypto";
import { loadDotEnv } from "../src/config/env.js";
import { createSignature, fetchRwaTokens } from "../src/adapters/binanceRwa.js";
import { normalizeBinanceFlashResponse, BinanceFlashInvalidResponseError } from "../src/adapters/binanceFlash.js";
import { BINANCE_FLASH_ROUTER_SPENDER_ADDRESS, BINANCE_FLASH_USDT_ADDRESS } from "../src/config/binanceFlash.js";
loadDotEnv();

const PASSES = Number(process.argv[2] ?? 3);
const TAKER = "0x000000000000000000000000000000000000dead";
const SYMBOLS = { pool: ["NVDAB", "SPYB", "QQQB"], poolless: ["PLTRB", "LITEB", "AMDB"] };
const SIZES_USD = [5, 50];
const SLIPPAGE_BPS = 50;
const config = {
  chainId: 56 as const, vendor: "LiquidMesh" as const, taker: TAKER,
  router: BINANCE_FLASH_ROUTER_SPENDER_ADDRESS, spender: BINANCE_FLASH_ROUTER_SPENDER_ADDRESS,
  guardRuntimeCodeHash: `0x${"0".repeat(64)}`,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Raw signed GET that keeps the whole envelope, including non-zero codes. */
async function rawQuote(tokenIn: string, tokenOut: string, amount: bigint, rfq: boolean) {
  const query = new URLSearchParams([
    ["binanceChainId", "56"], ["amount", amount.toString()], ["fromTokenAddress", tokenIn], ["toTokenAddress", tokenOut],
    ["userWalletAddress", TAKER], ["vendor", "LiquidMesh"], ["slippagePercent", "0.50"], ["enableRFQ", String(rfq)],
    ["approveTransaction", "true"], ["approveAmount", amount.toString()], ["autoSlippage", "false"],
  ]).toString();
  const requestPath = `/build/api/v1/dex/aggregator/quote-and-swap?${query}`;
  const timestamp = new Date().toISOString();
  const headers = {
    accept: "application/json",
    "X-OC-APIKEY": process.env["BINANCE_WEB3_API_KEY"]!.trim(),
    "X-OC-TIMESTAMP": timestamp,
    "X-OC-SIGN": createSignature({ timestamp, method: "GET", requestPath, body: "", secretKey: process.env["BINANCE_WEB3_SECRET_KEY"]!.trim() }),
    "X-OC-NONCE": randomUUID(),
  };
  const startedAt = Date.now();
  const t0 = performance.now();
  const res = await fetch(`https://web3.binance.com${requestPath}`, { headers, signal: AbortSignal.timeout(8_000) });
  const text = await res.text();
  const ms = performance.now() - t0;
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, ms, startedAt, body, text: text.slice(0, 300) };
}

const { tokens } = await fetchRwaTokens({ platformId: "bstock" });
const bySymbol = new Map(tokens.map((t) => [t.symbol, t]));
const targets: Array<[string, string]> = [...SYMBOLS.pool.map((s): [string, string] => [s, "pool"]), ...SYMBOLS.poolless.map((s): [string, string] => [s, "poolless"])];
for (const [s] of targets) {
  const t = bySymbol.get(s);
  console.error(`${s}: ${t?.address ?? "MISSING"} price=${t?.tokenPriceUsd} ref=${t?.referencePriceUsd} dec=${t?.decimals}`);
}

const rows: any[] = [];
for (let pass = 0; pass < PASSES; pass++) {
  for (const [symbol, kind] of targets) {
    const token = bySymbol.get(symbol);
    if (!token || !token.tokenPriceUsd) continue;
    const dec = BigInt(token.decimals ?? 18);
    for (const usd of SIZES_USD) {
      for (const side of ["buy", "sell"] as const) {
        const tokenIn = side === "buy" ? BINANCE_FLASH_USDT_ADDRESS : token.address;
        const tokenOut = side === "buy" ? token.address : BINANCE_FLASH_USDT_ADDRESS;
        const amount = side === "buy"
          ? BigInt(usd) * 10n ** 18n
          : BigInt(Math.round((usd / token.tokenPriceUsd) * 1e9)) * 10n ** (dec - 9n);
        for (const rfq of [true, false]) {
          let r;
          try { r = await rawQuote(tokenIn, tokenOut, amount, rfq); }
          catch (e) { rows.push({ pass, symbol, kind, usd, side, rfq, error: (e as Error).message }); continue; }
          const d = r.body?.data;
          const rr = d?.routerResult;
          let normalizer = "n/a";
          if (r.status === 200 && String(r.body?.code) === "0") {
            try {
              normalizeBinanceFlashResponse(d, { tokenIn, tokenOut, amountAtomic: amount.toString(), slippageBps: SLIPPAGE_BPS }, config, r.startedAt);
              normalizer = "accept";
            } catch (e) {
              normalizer = e instanceof BinanceFlashInvalidResponseError ? `refuse:${e.reason}` : `throw:${(e as Error).message}`;
            }
          }
          const legs: string[] = rr?.dexRouterList?.map((x: any) => `${x?.dexProtocol?.dexName} ${x?.dexProtocol?.percent}%`) ?? [];
          const toPrice = Number(rr?.toToken?.tokenUnitPrice), fromPrice = Number(rr?.fromToken?.tokenUnitPrice);
          const toDec = Number(rr?.toToken?.decimal ?? 18), fromDec = Number(rr?.fromToken?.decimal ?? 18);
          rows.push({
            pass, symbol, kind, usd, side, rfq, http: r.status, code: r.body?.code, msg: r.body?.msg ?? null,
            ms: Math.round(r.ms), normalizer,
            rfqField: d ? (d.rfq === undefined ? "absent" : d.rfq === null ? "null" : JSON.stringify(d.rfq).slice(0, 200)) : null,
            executionMode: d?.executionMode ?? null,
            out: rr?.toTokenAmount ?? null, minOut: d?.tx?.minReceiveAmount ?? null,
            feeAmount: rr?.feeAmount ?? null, feeToken: rr?.feeToken ?? null,
            // USD out / USD in at the provider's own unit prices: ≈1 means out is gross, not net of anything hidden.
            valueRatio: rr ? (Number(rr.toTokenAmount) / 10 ** toDec * toPrice) / (Number(rr.fromTokenAmount) / 10 ** fromDec * fromPrice) : null,
            expiresAt: d?.expiresAt ?? null, expiryMs: d?.expiresAt != null ? Number(d.expiresAt) - r.startedAt : null,
            legs: legs.join(" + "), rfqLegs: legs.filter((l) => /rfq/iu.test(l)).length,
            calldataBytes: d?.tx?.data ? (d.tx.data.length - 2) / 2 : null,
            topKeys: d ? Object.keys(d).join(",") : null,
            raw: r.status !== 200 || String(r.body?.code) !== "0" ? r.text : undefined,
          });
          await sleep(250); // stay well under the shared 5 rps key budget
        }
      }
    }
  }
}
console.log(JSON.stringify(rows));
