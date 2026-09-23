/**
 * Handoff 2 §B1: derive TRADFI_BINANCE_GUARD_RUNTIME_CODEHASH from the deployed
 * guard. Reads `eth_getCode` from two independent public BSC RPCs, requires
 * both to return the same non-empty runtime of the expected length, and
 * prints keccak256(runtime). Read-only; sets nothing.
 *
 * Usage: node --import tsx scripts/guard-codehash.ts <guardAddress> [expectedBytes=3504]
 */
import { getAddress, keccak256, type Hex } from "viem";

const RPCS = ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com"];
const ROUTER_SPENDER = "0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5";

const [, , rawAddress, rawExpected] = process.argv;
if (!rawAddress) {
  console.error("usage: guard-codehash.ts <guardAddress> [expectedBytes=3504]");
  process.exit(2);
}
const address = getAddress(rawAddress);
const expectedBytes = Number(rawExpected ?? 3504);

async function getCode(url: string): Promise<Hex> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as { result?: Hex; error?: { message?: string } };
  if (!body.result) throw new Error(`${url}: ${body.error?.message ?? `HTTP ${res.status}`}`);
  return body.result.toLowerCase() as Hex;
}

const codes = await Promise.all(RPCS.map(getCode));
const [first, second] = codes as [Hex, Hex];
const bytes = (first.length - 2) / 2;
const problems: string[] = [];
if (first !== second) problems.push("the two RPCs returned different runtime code");
if (bytes === 0) problems.push("no code at this address");
if (bytes !== expectedBytes) problems.push(`runtime is ${bytes} bytes, expected ${expectedBytes}`);

console.log(`guard          ${address}`);
for (const [i, url] of RPCS.entries()) console.log(`rpc ${i + 1}          ${url}  ${(codes[i]!.length - 2) / 2} bytes`);
console.log(`runtime bytes  ${bytes}`);
console.log(`codehash       ${keccak256(first)}`);
if (problems.length > 0) {
  for (const p of problems) console.error(`REFUSED: ${p}`);
  process.exit(1);
}
console.log("\nRailway (data-plane), router/spender already set:");
console.log(`  TRADFI_BINANCE_GUARD_ADDRESS=${address.toLowerCase()}`);
console.log(`  TRADFI_BINANCE_GUARD_RUNTIME_CODEHASH=${keccak256(first)}`);
console.log(`  (router = spender = ${ROUTER_SPENDER})`);
