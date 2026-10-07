/**
 * Read-only step 0 for the "where is a stock cheapest on BNB Chain" idea (exec repo
 * `MD here/AGENTIC-SKILLS-PLAN.md`, follow-up brainstorm 2026-10-07): for each ticker that has both a
 * bStock and an Ondo token on BSC, quote a USDT buy of each at several sizes through the Binance Flash
 * aggregator (enableRFQ=true, the route `baw` swaps use), then quote selling the received amount back,
 * and normalise everything to shares of the underlying. No signing, no funds: the taker is an unfunded EOA.
 * Usage: node --import tsx scripts/issuer-compare-probe.ts [outFile]
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { loadDotEnv } from "../src/config/env.js";
import { createSignature, fetchRwaTokens } from "../src/adapters/binanceRwa.js";
import { BINANCE_FLASH_USDT_ADDRESS } from "../src/config/binanceFlash.js";
loadDotEnv();

const OUT = process.argv[2];
const TAKER = "0x000000000000000000000000000000000000dead";
const TICKERS = ["NVDA", "TSLA", "AAPL", "SPY", "QQQ", "MU", "PLTR", "AMD"];
const SIZES_USD = [50, 500, 5000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function quote(tokenIn: string, tokenOut: string, amount: bigint) {
  const query = new URLSearchParams([
    ["binanceChainId", "56"], ["amount", amount.toString()], ["fromTokenAddress", tokenIn], ["toTokenAddress", tokenOut],
    ["userWalletAddress", TAKER], ["vendor", "LiquidMesh"], ["slippagePercent", "0.50"], ["enableRFQ", "true"],
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
  const t0 = performance.now();
  const res = await fetch(`https://web3.binance.com${requestPath}`, { headers, signal: AbortSignal.timeout(8_000) });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* keep null */ }
  const rr = body?.data?.routerResult;
  const ok = res.status === 200 && String(body?.code) === "0" && rr?.toTokenAmount != null;
  return {
    ok, http: res.status, code: body?.code ?? null, msg: ok ? null : (body?.msg ?? text.slice(0, 160)), ms: Math.round(performance.now() - t0),
    out: ok ? String(rr.toTokenAmount) : null, outDecimals: ok ? Number(rr.toToken?.decimal ?? 18) : null,
    legs: ok ? (rr.dexRouterList ?? []).map((x: any) => `${x?.dexProtocol?.dexName} ${x?.dexProtocol?.percent}%`).join(" + ") : null,
    feeAmount: rr?.feeAmount ?? null,
  };
}

// Addresses and share multipliers from the keyless full list (it carries bStocks /rwa/tokens omits);
// reference prices and session state from the signed /rwa/tokens list.
const listRes = await fetch("https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai",
  { headers: { "Accept-Encoding": "identity", "User-Agent": "binance-web3/1.1 (Skill)" } });
const list = ((await listRes.json()) as any).data.filter((x: any) => x.chainId === "56" && (x.type === 1 || x.type === 3));
const { tokens } = await fetchRwaTokens();
const signedByAddr = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));
const refByTicker = new Map<string, number>();
for (const t of tokens) if (t.underlyingTicker && t.referencePriceUsd) refByTicker.set(t.underlyingTicker, t.referencePriceUsd);

const rows: any[] = [];
for (const ticker of TICKERS) {
  const ref = refByTicker.get(ticker) ?? null;
  for (const type of [3, 1]) {
    const item = list.find((x: any) => x.ticker === ticker && x.type === type);
    if (!item) { rows.push({ ticker, issuer: type === 3 ? "bstock" : "ondo", missing: true }); continue; }
    const address = String(item.contractAddress), mult = Number(item.multiplier), dec = Number(item.d ?? 18);
    const signed = signedByAddr.get(address.toLowerCase());
    for (const usd of SIZES_USD) {
      const buy = await quote(BINANCE_FLASH_USDT_ADDRESS, address, BigInt(usd) * 10n ** 18n);
      await sleep(300);
      const row: any = {
        ticker, issuer: type === 3 ? "bstock" : "ondo", symbol: item.symbol, address, mult, ref, usd,
        navUsd: signed?.tokenPriceUsd ?? null, ratio: signed?.tokenToShareRatio ?? null,
        openState: signed?.openState ?? null, marketStatus: signed?.marketStatus ?? null, reasonCode: signed?.reasonCode ?? null,
        buy,
      };
      if (buy.ok) {
        const tokensOut = Number(buy.out) / 10 ** (buy.outDecimals ?? dec);
        const shares = tokensOut * mult;
        row.tokensOut = tokensOut; row.shares = shares;
        row.buyCostBps = ref ? Math.round(((usd / shares) / ref - 1) * 10_000) : null;
        const sell = await quote(address, BINANCE_FLASH_USDT_ADDRESS, BigInt(buy.out!));
        await sleep(300);
        row.sell = sell;
        if (sell.ok) {
          const usdBack = Number(sell.out) / 10 ** (sell.outDecimals ?? 18);
          row.usdBack = usdBack;
          row.roundTripBps = Math.round((1 - usdBack / usd) * 10_000);
        }
      }
      rows.push(row);
      console.error(`${ticker} ${row.issuer.padEnd(6)} ${String(usd).padStart(5)} USDT  ` + (buy.ok
        ? `shares=${row.shares.toFixed(6)} buyCost=${row.buyCostBps}bps roundTrip=${row.roundTripBps ?? "sell-fail"}bps  [${buy.legs}]`
        : `BUY FAIL ${buy.http}/${buy.code} ${buy.msg}`));
    }
  }
}
const result = { measuredAt: new Date().toISOString(), rows };
if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2));
else console.log(JSON.stringify(result));
