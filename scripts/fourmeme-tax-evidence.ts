/**
 * Four.Meme tax, proven against real swaps (handoff 2026-10-06).
 *
 *   node --import tsx scripts/fourmeme-tax-evidence.ts census <board.json>
 *   node --import tsx scripts/fourmeme-tax-evidence.ts okx <token>              (hashes from OKX trades)
 *   node --import tsx scripts/fourmeme-tax-evidence.ts okx-notax <token>
 *   node --import tsx scripts/fourmeme-tax-evidence.ts swaps <token> [blocks]   (hashes from a log scan)
 *   node --import tsx scripts/fourmeme-tax-evidence.ts swaps-notax <token> [blocks]
 *
 * `census`: TokenManager2 `_tokenInfos(token).template` creator type
 * (`(template >> 10) & 0x3F`) against the bytecode shape and the fee views.
 *
 * The other modes take candidate transactions (OKX's recent trades, or a
 * trailing `eth_getLogs` scan) and judge each one from its receipt until one buy
 * and one sell are proven: the token's Transfer legs, the fee legs (sent to the
 * token contract), the pair's own Swap amounts, and the fee the views predict.
 * `-notax` looks for plain swaps with no fee leg at all instead.
 */

import { readFileSync } from "node:fs";
import { decodeEventLog, parseAbi, parseAbiItem } from "viem";
import { createSignature } from "../src/adapters/onchainos.js";
import { readLogRpcUrls, withBscClient } from "../src/chain/rpc.js";

const withBscLogClient = <T>(fn: Parameters<typeof withBscClient<T>>[0]) => withBscClient(fn, { rpcUrls: readLogRpcUrls() });

const TM2 = "0x5c952063c7fc8610FFDB798152D69F0B9550762b" as const;
const tm2Abi = parseAbi([
  "struct TokenInfo { address base; address quote; uint256 template; uint256 totalSupply; uint256 maxOffers; uint256 maxRaising; uint256 launchTime; uint256 offers; uint256 funds; uint256 lastPrice; uint256 K; uint256 T; uint256 status; }",
  "function _tokenInfos(address token) view returns (TokenInfo)",
]);
const tokenAbi = parseAbi([
  "function feeRate() view returns (uint256)",
  "function feeRateBuy() view returns (uint256)",
  "function feeRateSell() view returns (uint256)",
  "function pair() view returns (address)",
  "function _mode() view returns (uint256)",
]);
const PANCAKE_V2_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73" as const;
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" as const;
const pairAbi = parseAbi(["function token1() view returns (address)"]);
const factoryAbi = parseAbi(["function getPair(address, address) view returns (address)"]);
const swapEvent = parseAbiItem("event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)");
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function proxyTarget(code: string): string | null {
  const m = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code);
  return m ? `0x${m[1]!.toLowerCase()}` : null;
}

async function census(file: string): Promise<void> {
  const addresses = (JSON.parse(readFileSync(file, "utf8")) as { data: { address: string }[] }).data.map((r) => r.address);
  const groups = new Map<string, string[]>();
  for (let i = 0; i < addresses.length; i += 50) {
    const chunk = addresses.slice(i, i + 50) as `0x${string}`[];
    const rows = await withBscClient(async (client) =>
      Promise.all(
        chunk.map(async (address) => {
          const code = (await client.getCode({ address })) ?? "0x";
          const kind = proxyTarget(code) ?? `non-proxy:${code.length / 2 - 1}B`;
          const [info, fee, buy, sell] = await client.multicall({
            contracts: [
              { address: TM2, abi: tm2Abi, functionName: "_tokenInfos", args: [address] },
              { address, abi: tokenAbi, functionName: "feeRate" },
              { address, abi: tokenAbi, functionName: "feeRateBuy" },
              { address, abi: tokenAbi, functionName: "feeRateSell" },
            ],
          });
          const template = info.status === "success" ? info.result.template : null;
          const creatorType = template === null ? "revert" : String((template >> 10n) & 0x3fn);
          const views = [fee, buy, sell].map((r) => (r.status === "success" ? "y" : "n")).join("");
          return { address, key: `type=${creatorType} ${kind} views(fee,buy,sell)=${views}` };
        }),
      ),
    );
    for (const { address, key } of rows) groups.set(key, [...(groups.get(key) ?? []), address]);
  }
  for (const [key, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) console.log(list.length, key, list[0]);
}

interface Leg {
  from: string;
  to: string;
  value: bigint;
}

interface TokenFacts {
  token: `0x${string}`;
  pair: `0x${string}`;
  tokenIsToken0: boolean;
  /** feeRate, feeRateBuy, feeRateSell, _mode as read now; "revert" when the view is absent. */
  views: string[];
}

async function readFacts(token: `0x${string}`): Promise<TokenFacts | null> {
  return withBscClient(async (client) => {
    const r = await client.multicall({
      contracts: (["feeRate", "feeRateBuy", "feeRateSell", "_mode"] as const).map((functionName) => ({ address: token, abi: tokenAbi, functionName })),
    });
    // Plain templates have no pair() view: ask PancakeSwap V2 for (token, curve quote; zero = WBNB).
    const pair =
      (await client.readContract({ address: token, abi: tokenAbi, functionName: "pair" }).catch(() => null)) ??
      (await client
        .readContract({ address: TM2, abi: tm2Abi, functionName: "_tokenInfos", args: [token] })
        .then((info) =>
          client.readContract({
            address: PANCAKE_V2_FACTORY,
            abi: factoryAbi,
            functionName: "getPair",
            args: [token, info.quote === "0x0000000000000000000000000000000000000000" ? WBNB : info.quote],
          }),
        )
        .catch(() => null));
    const views = r.map((x) => (x.status === "success" ? String(x.result) : "revert"));
    console.log(`token ${token} feeRate=${views[0]} feeRateBuy=${views[1]} feeRateSell=${views[2]} mode=${views[3]} pair=${pair}`);
    if (pair === null) return null;
    const token1 = await client.readContract({ address: pair, abi: pairAbi, functionName: "token1" });
    return { token, pair, tokenIsToken0: BigInt(token) < BigInt(token1), views };
  });
}

/**
 * One transaction, judged from its receipt. The pair prices from its own balance
 * change, so its Swap amount agreeing with the Transfer amounts is what rules out
 * a deduction that emits no event. Returns the side it proved, or null.
 */
async function judge(facts: TokenFacts, hash: `0x${string}`, expectZero: boolean): Promise<"buy" | "sell" | null> {
  const tokenLc = facts.token.toLowerCase();
  const pairLc = facts.pair.toLowerCase();
  const receipt = await withBscClient((client) => client.getTransactionReceipt({ hash }));
  if (receipt.status !== "success") return null;
  const legs: Leg[] = [];
  let swap: { in: bigint; out: bigint } | null = null;
  let swaps = 0;
  for (const log of receipt.logs) {
    const address = log.address.toLowerCase();
    if (address === tokenLc && log.topics[0] === TRANSFER_TOPIC) {
      const { args } = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
      legs.push({ from: args.from.toLowerCase(), to: args.to.toLowerCase(), value: args.value });
    } else if (address === pairLc) {
      try {
        const { args } = decodeEventLog({ abi: [swapEvent], data: log.data, topics: log.topics });
        swaps += 1;
        swap = facts.tokenIsToken0 ? { in: args.amount0In, out: args.amount0Out } : { in: args.amount1In, out: args.amount1Out };
      } catch {
        // Sync/Mint/Transfer on the pair: not the swap
      }
    }
  }
  if (swap === null || swaps !== 1 || legs.length > 4) return null; // plain single swaps only
  const feeLegs = legs.filter((l) => l.to === tokenLc);
  if ((feeLegs.length === 0) !== expectZero) return null;
  const fee = feeLegs.reduce((s, l) => s + l.value, 0n);
  const fromPair = legs.filter((l) => l.from === pairLc && l.to !== tokenLc);
  const toPair = legs.filter((l) => l.to === pairLc);
  let side: "buy" | "sell";
  let net: bigint;
  if (swap.out > 0n && swap.in === 0n && fromPair.length === 1 && toPair.length === 0 && feeLegs.every((l) => l.from === pairLc)) {
    side = "buy";
    net = fromPair[0]!.value;
  } else if (swap.in > 0n && swap.out === 0n && toPair.length === 1 && fromPair.length === 0 && feeLegs.every((l) => l.from === toPair[0]!.from)) {
    side = "sell";
    net = toPair[0]!.value;
  } else {
    return null;
  }
  const gross = net + fee;
  // What the pair accounted: on a buy it sent `gross` (net to the buyer, fee to
  // the token); on a sell it received `net` after the token kept its fee.
  const pairSaw = side === "buy" ? swap.out : swap.in;
  const pairMatches = pairSaw === (side === "buy" ? gross : net);
  const pct = side === "buy" ? facts.views[1] : facts.views[2];
  // Documented formulas: type 8/9 gross * rate / 100, type 5 gross * feeRate / 10000.
  const expected =
    pct !== undefined && pct !== "revert"
      ? (gross * BigInt(pct)) / 100n
      : facts.views[0] !== undefined && facts.views[0] !== "revert"
        ? (gross * BigInt(facts.views[0])) / 10_000n
        : 0n;
  console.log(`${side} tx ${hash} block ${receipt.blockNumber}`);
  for (const l of legs) console.log(`   Transfer ${l.from} -> ${l.to} ${l.value}`);
  console.log(`   pair Swap, token side: in=${swap.in} out=${swap.out} (${pairMatches ? "matches the Transfer legs" : "DOES NOT MATCH the Transfer legs"})`);
  console.log(`   fee ${fee} / gross ${gross} = ${Number((fee * 1_000_000n) / gross) / 100} bps; views predict ${expected}: ${expected === fee ? "EXACT" : "MISMATCH"}`);
  return pairMatches && expected === fee ? side : null;
}

async function prove(facts: TokenFacts, hashes: Iterable<string>, expectZero: boolean): Promise<void> {
  const found = { buy: false, sell: false };
  let tried = 0;
  for (const hash of hashes) {
    if (found.buy && found.sell) break;
    tried += 1;
    try {
      const side = await judge(facts, hash as `0x${string}`, expectZero);
      if (side !== null && !found[side]) found[side] = true;
    } catch {
      // a receipt no endpoint served: try the next hash
    }
  }
  console.log(`   proven: buy=${found.buy} sell=${found.sell} (${tried} transactions judged)`);
}

/** Candidate hashes from a trailing `eth_getLogs` scan over the token's Transfer logs. */
async function scanHashes(token: `0x${string}`, maxBack: number): Promise<string[]> {
  const head = await withBscLogClient((client) => client.getBlockNumber());
  const out = new Set<string>();
  for (let to = head; to > head - BigInt(maxBack) && out.size < 400; to -= 50n) {
    try {
      const logs = (await withBscLogClient((client) =>
        client.request({
          method: "eth_getLogs",
          params: [{ address: token, topics: [TRANSFER_TOPIC], fromBlock: `0x${(to - 49n).toString(16)}`, toBlock: `0x${to.toString(16)}` }],
        }),
      )) as { transactionHash: string }[];
      for (const log of logs) out.add(log.transactionHash);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2_000)); // public log endpoints throttle
    }
  }
  return [...out];
}

/** Candidate hashes from OKX's recent trades for the token (signed DEX API). */
async function okxHashes(token: string): Promise<string[]> {
  const query = new URLSearchParams([["chainIndex", "56"], ["tokenContractAddress", token.toLowerCase()], ["limit", "500"]]).toString();
  const requestPath = `/api/v6/dex/market/trades?${query}`;
  const timestamp = new Date().toISOString();
  const headers: Record<string, string> = {
    "OK-ACCESS-KEY": process.env["OKX_API_KEY"] ?? "",
    "OK-ACCESS-PASSPHRASE": process.env["OKX_PASSPHRASE"] ?? "",
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-SIGN": createSignature({ timestamp, method: "GET", requestPath, body: "", secretKey: process.env["OKX_SECRET_KEY"] ?? "" }),
  };
  const project = process.env["OKX_PROJECT_ID"];
  if (project) headers["OK-ACCESS-PROJECT"] = project;
  const response = await fetch(`https://web3.okx.com${requestPath}`, { headers });
  const body = (await response.json()) as { code: string; msg?: string; data?: { txHashUrl?: string }[] };
  if (body.code !== "0") throw new Error(`okx trades ${body.code} ${body.msg ?? ""}`);
  const hashes = (body.data ?? []).map((row) => /0x[0-9a-fA-F]{64}/.exec(row.txHashUrl ?? "")?.[0]).filter((h): h is string => h !== undefined);
  console.log(`   okx trades: ${body.data?.length ?? 0} rows, ${new Set(hashes).size} hashes`);
  return [...new Set(hashes)];
}

const [mode, arg, back] = process.argv.slice(2);
if (mode === "census") {
  await census(arg!);
} else if (mode !== undefined && arg !== undefined) {
  const token = arg as `0x${string}`;
  const expectZero = mode.endsWith("-notax");
  const facts = await readFacts(token);
  if (facts !== null) {
    const hashes = mode.startsWith("okx") ? await okxHashes(token) : await scanHashes(token, Number(back ?? 2000));
    await prove(facts, hashes, expectZero);
  }
}
