/**
 * Read-only measurement: Binance Flash (LiquidMesh) quote vs the best single
 * PancakeSwap V3 USDT pool (QuoterV2 eth_call), same pair, same size, same
 * moment. No signing, no transaction. Usage: node --import tsx scripts/flash-vs-amm.ts
 */
import { loadDotEnv } from "../src/config/env.js";
import { signedRequest } from "../src/adapters/binanceRwa.js";
import { withBscClient } from "../src/chain/rpc.js";
loadDotEnv();

const USDT = "0x55d398326f99059ff775485246999027b3197955" as const;
const QUOTER = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997" as const;
const TAKER = "0x000000000000000000000000000000000000dead";
const TOKENS: Record<string, `0x${string}`> = {
  SPYB: "0x7138b48df7d98d7e3cc221bfe7192d0a178182d8", QQQB: "0x205812cdbed920aff76c6580abd681a46d11efc7",
  NVDAB: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", TSLAB: "0x5b1910eaad6450e50f816082aa078c41f10c292f",
  GOOGLB: "0x3f53de71c126bdabae20f9cd64848d317f6c3238",
};
const SIZES_USD = [100, 1_000, 10_000];
const quoterAbi = [{ type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
  inputs: [{ type: "tuple", name: "params", components: [{ name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" }, { name: "fee", type: "uint24" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "sqrtPriceX96After", type: "uint160" },
    { name: "initializedTicksCrossed", type: "uint32" }, { name: "gasEstimate", type: "uint256" }] }] as const;
const FEES = [100, 500, 2500, 10000] as const;
const toAtomic = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const num = (a: bigint) => Number(a) / 1e18;

async function flash(tokenIn: string, tokenOut: string, amount: bigint) {
  const t0 = performance.now();
  try {
    const d = await signedRequest({ method: "GET", path: "/api/v1/dex/aggregator/quote-and-swap", query: [
      ["binanceChainId", "56"], ["amount", amount.toString()], ["fromTokenAddress", tokenIn], ["toTokenAddress", tokenOut],
      ["userWalletAddress", TAKER], ["vendor", "LiquidMesh"], ["slippagePercent", "0.50"], ["enableRFQ", "true"],
      ["approveTransaction", "true"], ["approveAmount", amount.toString()], ["autoSlippage", "false"]],
      timeoutMs: 8000, retryOn429: false }) as any;
    const r = d.routerResult;
    return { ms: performance.now() - t0, out: BigInt(r.toTokenAmount), gas: Number(d.tx.gas), gasUsd: Number(r.tradeFee),
      impact: Number(r.priceImpactPercent), fee: r.feeAmount, route: r.dexRouterList.map((x: any) => `${x.dexProtocol.dexName} ${x.dexProtocol.percent}%`).join(" + "),
      calldataBytes: (d.tx.data.length - 2) / 2, priceUsd: Number(r.toToken.tokenUnitPrice), fromPriceUsd: Number(r.fromToken.tokenUnitPrice), rfq: d.rfq !== null };
  } catch (e) { return { ms: performance.now() - t0, error: (e as Error).message }; }
}

async function amm(tokenIn: `0x${string}`, tokenOut: `0x${string}`, amount: bigint) {
  const t0 = performance.now();
  const results = await withBscClient(async (client) => Promise.all(FEES.map(async (fee) => {
    try {
      const sim = await client.simulateContract({ address: QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle",
        args: [{ tokenIn, tokenOut, amountIn: amount, fee, sqrtPriceLimitX96: 0n }] });
      const [out, , ticks, gas] = sim.result;
      return { fee, out, ticks, gas };
    } catch { return null; }
  })));
  const best = results.filter((r) => r !== null).sort((a, b) => (b!.out > a!.out ? 1 : -1))[0] ?? null;
  return { ms: performance.now() - t0, best };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rows: any[] = [];
for (const [symbol, token] of Object.entries(TOKENS)) {
  let priceUsd: number | null = null;
  for (const dir of ["buy", "sell"] as const) {
    for (const usd of SIZES_USD) {
      if (dir === "sell" && priceUsd === null) continue;
      const amount: bigint = dir === "buy" ? toAtomic(usd) : toAtomic(usd / priceUsd!);
      const [tokenIn, tokenOut] = dir === "buy" ? [USDT, token] : [token, USDT];
      const [f, a] = await Promise.all([flash(tokenIn, tokenOut, amount), amm(tokenIn, tokenOut, amount)]);
      if ("priceUsd" in f && f.priceUsd && dir === "buy") priceUsd = f.priceUsd;
      const row: any = { symbol, dir, usd, flashMs: Math.round(f.ms), ammMs: Math.round(a.ms) };
      if ("error" in f) row.flashError = f.error;
      else Object.assign(row, { flashOut: num(f.out), route: f.route, impactPct: f.impact, flashGas: f.gas, flashGasUsd: f.gasUsd, aggFee: f.fee, calldata: f.calldataBytes, rfq: f.rfq });
      if (a.best) Object.assign(row, { ammOut: num(a.best.out), ammFee: a.best.fee, ammGas: Number(a.best.gas), ammTicks: a.best.ticks });
      if (!("error" in f) && a.best) row.edgeBps = Math.round((Number(f.out * 1_000_000n / a.best.out) / 1_000_000 - 1) * 1e4 * 10) / 10;
      rows.push(row);
      console.log(JSON.stringify(row));
      await sleep(400);
    }
  }
}
await import("node:fs").then((fs) => fs.writeFileSync(process.argv[2] ?? "flash-vs-amm.json", JSON.stringify({ at: new Date().toISOString(), rows }, null, 1)));
