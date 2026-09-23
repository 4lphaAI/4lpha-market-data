/**
 * Handoff 2 §B2: one live Flash quote through the deployed proxy, printed as
 * the raw envelope. Read-only: the proxy returns calldata, nothing is signed
 * or sent. Quotes expire 15 s after `observedAt`, so run it right before the
 * zero-spend eth_call that consumes it.
 *
 * Usage: node --import tsx scripts/flash-proxy-quote.ts <SYMBOL|0xtoken> <buy|sell> <usdt> [slippageBps=100]
 * Env:   DP_AUTH_TOKEN (or DATA_PLANE_TOKEN), optional DATA_PLANE_URL,
 *        optional TRADFI_BINANCE_GUARD_ADDRESS to check `taker`.
 */
import { loadDotEnv } from "../src/config/env.js";
loadDotEnv();

const USDT = "0x55d398326f99059ff775485246999027b3197955";
const PLANE = (process.env["DATA_PLANE_URL"] ?? "https://data-plane-production.up.railway.app").replace(/\/$/u, "");
const TOKEN = (process.env["DP_AUTH_TOKEN"] ?? process.env["DATA_PLANE_TOKEN"] ?? "").trim();

const [, , tokenArg, sideArg, usdtArg, slippageArg] = process.argv;
if (!tokenArg || (sideArg !== "buy" && sideArg !== "sell") || !usdtArg || !(Number(usdtArg) > 0)) {
  console.error("usage: flash-proxy-quote.ts <SYMBOL|0xtoken> <buy|sell> <usdt> [slippageBps=100]");
  process.exit(2);
}
if (TOKEN === "") {
  console.error("DP_AUTH_TOKEN (or DATA_PLANE_TOKEN) is not set");
  process.exit(2);
}
const headers = { "x-dp-token": TOKEN, "content-type": "application/json" };

// Resolve symbol and USD price from the plane's own bStocks lane: the sell
// size is `usdt / tokenPriceUsd` shares, the same sizing execution uses.
const lane = (await (await fetch(`${PLANE}/universe?lane=bstocks`, { headers })).json()) as {
  data: Array<{ address: string; symbol: string; tokenPriceUsd: number | null; decimals: number | null }>;
};
const wanted = tokenArg.toLowerCase();
const token = lane.data.find((t) => t.address === wanted || t.symbol.toLowerCase() === wanted);
if (!token) {
  console.error(`${tokenArg} is not in the bStocks lane`);
  process.exit(2);
}
const decimals = BigInt(token.decimals ?? 18);
const toAtomic = (units: number) => (BigInt(Math.round(units * 1e9)) * 10n ** decimals) / 10n ** 9n;
const usdt = Number(usdtArg);
let amountAtomic: bigint;
if (sideArg === "buy") {
  amountAtomic = toAtomic(usdt);
} else {
  if (!token.tokenPriceUsd) throw new Error(`${token.symbol} has no tokenPriceUsd to size a sell`);
  amountAtomic = toAtomic(usdt / token.tokenPriceUsd);
}
const body = {
  tokenIn: sideArg === "buy" ? USDT : token.address,
  tokenOut: sideArg === "buy" ? token.address : USDT,
  amountAtomic: amountAtomic.toString(),
  slippageBps: Number(slippageArg ?? 100),
};

const t0 = performance.now();
const res = await fetch(`${PLANE}/trading/binance/quote-and-swap`, { method: "POST", headers, body: JSON.stringify(body) });
const text = await res.text();
const roundTripMs = Math.round(performance.now() - t0);

let envelope: unknown = text;
try { envelope = JSON.parse(text); } catch { /* print raw */ }
const data = (envelope as { data?: { taker?: string; observedAt?: number; expiresAt?: number } } | null)?.data;
const guard = process.env["TRADFI_BINANCE_GUARD_ADDRESS"]?.trim().toLowerCase();

console.log(JSON.stringify({
  request: { symbol: token.symbol, side: sideArg, usdt, ...body },
  http: res.status,
  serverTiming: res.headers.get("server-timing"),
  roundTripMs,
  ...(data?.taker && guard ? { takerIsGuard: data.taker === guard } : {}),
  ...(data?.expiresAt ? { msLeft: data.expiresAt - Date.now() } : {}),
  envelope,
}, null, 2));
