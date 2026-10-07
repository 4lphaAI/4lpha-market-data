/**
 * The Four.Meme tax readers against a local JSON-RPC endpoint that speaks just
 * enough of BSC: `eth_getCode`, and `eth_call` either direct or through
 * Multicall3 `aggregate3` (viem's `batch.multicall`). Offline: the server binds
 * to 127.0.0.1. The audit's M1 lives here: viem reports a node's JSON-RPC -32603
 * as a contract revert, and a reader that treats a revert as an answer would
 * cache "TokenManager2 does not hold this token" forever.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  multicall3Abi,
  parseAbi,
  toFunctionSelector,
  type Hex,
} from "viem";
import { FOURMEME_TEMPLATES, readFourMemeCodes, readFourMemeTaxes } from "../src/query/fourmemeTax.js";

const TM2 = "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const IMPL = "7330d8865f4b6800b72bdd73e2007833a5d45c94";
const CLONE = `0x363d3d373d3d3d363d73${IMPL}5af43d82803e903d91602b57fd5bf3`;
const A = "0x48d8dfed649c097265680b650c1efbc8af42ffff";
const B = "0xa87e6b3d9acf59c6bb72bb7ec94f79e69736ffff";
const PAIR = "0xf712b9d6c2ca0e3323be4cf2d24e12c4d88ba4ec";

const tokenAbi = parseAbi([
  "function feeRate() view returns (uint256)",
  "function feeRateBuy() view returns (uint256)",
  "function feeRateSell() view returns (uint256)",
  "function pair() view returns (address)",
]);
const SEL = {
  tokenInfos: toFunctionSelector("_tokenInfos(address)"),
  feeRate: toFunctionSelector("feeRate()"),
  feeRateBuy: toFunctionSelector("feeRateBuy()"),
  feeRateSell: toFunctionSelector("feeRateSell()"),
  pair: toFunctionSelector("pair()"),
};

/** TokenManager2's 13-word struct; an unknown token answers all zero (measured). */
function tokenInfo(base: string, creatorType: number): Hex {
  const words = [base, "0x0000000000000000000000000000000000000000", BigInt(creatorType) << 10n, ...Array<bigint>(10).fill(0n)];
  return encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, ...Array(11).fill({ type: "uint256" })],
    words as never,
  );
}

interface Chain {
  mode: "ok" | "internal-error";
  code: Record<string, string>;
  /** target -> selector -> encoded return data, or null for a revert. */
  calls: Record<string, Record<string, Hex | null>>;
  /** Tokens TokenManager2 holds, with their creator type; any other token gets the zero struct. */
  tm2: Record<string, number>;
}

const chain: Chain = { mode: "ok", code: {}, calls: {}, tm2: {} };
const ZERO = "0x0000000000000000000000000000000000000000";

function call(target: string, data: Hex): Hex | null {
  if (target.toLowerCase() === TM2 && data.startsWith(SEL.tokenInfos)) {
    const token = `0x${data.slice(-40)}`.toLowerCase();
    const type = chain.tm2[token];
    return type === undefined ? tokenInfo(ZERO, 0) : tokenInfo(token, type);
  }
  const answer = chain.calls[target.toLowerCase()]?.[data.slice(0, 10)];
  return answer === undefined ? null : answer;
}

let server: Server;
let url: string;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      const reply = (payload: object) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...payload }));
      };
      if (request.method === "eth_chainId") return reply({ result: "0x38" });
      if (request.method === "eth_getCode") {
        const [address] = request.params as [string];
        return reply({ result: chain.code[address.toLowerCase()] ?? "0x" });
      }
      if (request.method === "eth_call") {
        if (chain.mode === "internal-error") return reply({ error: { code: -32603, message: "internal error: request timed out" } });
        const [{ to, data }] = request.params as [{ to: string; data: Hex }];
        if (to.toLowerCase() === MULTICALL3) {
          const { args } = decodeFunctionData({ abi: multicall3Abi, data });
          const calls = args[0] as readonly { target: string; callData: Hex }[];
          const result = calls.map(({ target, callData }) => {
            const answer = call(target, callData);
            return { success: answer !== null, returnData: answer ?? "0x" };
          });
          return reply({ result: encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result }) });
        }
        const answer = call(to, data);
        return answer === null ? reply({ error: { code: 3, message: "execution reverted", data: "0x" } }) : reply({ result: answer });
      }
      return reply({ error: { code: -32601, message: "method not found" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

function reset(): void {
  chain.mode = "ok";
  chain.code = { [A]: CLONE, [B]: CLONE };
  chain.tm2 = {};
  chain.calls = {
    [A]: {
      [SEL.feeRate]: encodeFunctionResult({ abi: tokenAbi, functionName: "feeRate", result: 0n }),
      [SEL.feeRateBuy]: encodeFunctionResult({ abi: tokenAbi, functionName: "feeRateBuy", result: 1n }),
      [SEL.feeRateSell]: encodeFunctionResult({ abi: tokenAbi, functionName: "feeRateSell", result: 1n }),
      [SEL.pair]: encodeFunctionResult({ abi: tokenAbi, functionName: "pair", result: PAIR }),
    },
    [B]: {
      [SEL.feeRateBuy]: encodeFunctionResult({ abi: tokenAbi, functionName: "feeRateBuy", result: 2n }),
      [SEL.feeRateSell]: encodeFunctionResult({ abi: tokenAbi, functionName: "feeRateSell", result: 4n }),
      [SEL.pair]: encodeFunctionResult({ abi: tokenAbi, functionName: "pair", result: PAIR }),
    },
  };
}

function tm2Holds(holdings: Record<string, number>): void {
  chain.tm2 = holdings;
}

const tax9 = FOURMEME_TEMPLATES.find((t) => t.id === "tax9-7330")!;

describe("readFourMemeCodes", () => {
  it("reads the clone target and the creator type, and returns only complete answers", async () => {
    reset();
    tm2Holds({ [A]: 9 });
    const codes = await readFourMemeCodes([A, B], undefined, [url]);
    assert.deepEqual(codes.get(A), { code: `proxy:0x${IMPL}`, creatorType: 9 });
    assert.deepEqual(codes.get(B), { code: `proxy:0x${IMPL}`, creatorType: null }, "a zero struct is TokenManager2's honest negative");
  });

  it("caches nothing when the node answers eth_call with -32603 (audit M1)", async () => {
    reset();
    tm2Holds({ [A]: 9, [B]: 9 });
    chain.mode = "internal-error";
    const codes = await readFourMemeCodes([A, B], undefined, [url]);
    assert.equal(codes.size, 0, "an overloaded node is not 'TokenManager2 does not hold this token'");
  });

  it("does not keep an empty code read", async () => {
    reset();
    tm2Holds({ [A]: 9 });
    chain.code = {};
    const codes = await readFourMemeCodes([A], undefined, [url]);
    assert.equal(codes.size, 0);
  });
});

describe("readFourMemeTaxes", () => {
  it("reads percent rates per direction and the pair", async () => {
    reset();
    const taxes = await readFourMemeTaxes([{ address: A, template: tax9 }, { address: B, template: tax9 }], undefined, [url]);
    assert.deepEqual(taxes.get(A), { tax: { buyBps: 100, sellBps: 100 }, pool: PAIR });
    assert.deepEqual(taxes.get(B), { tax: { buyBps: 200, sellBps: 400 }, pool: PAIR });
  });

  it("leaves out a token whose view failed instead of answering a partial row", async () => {
    reset();
    chain.calls[B]![SEL.pair] = null;
    const taxes = await readFourMemeTaxes([{ address: A, template: tax9 }, { address: B, template: tax9 }], undefined, [url]);
    assert.deepEqual(taxes.get(A)?.tax, { buyBps: 100, sellBps: 100 });
    assert.equal(taxes.has(B), false);
  });

  it("throws when nothing answered, so the caller reports null and rotates", async () => {
    reset();
    chain.mode = "internal-error";
    await assert.rejects(readFourMemeTaxes([{ address: A, template: tax9 }], undefined, [url]));
  });

  it("answers a plain template without any read", async () => {
    reset();
    chain.mode = "internal-error";
    const plain = FOURMEME_TEMPLATES.find((t) => t.id === "plain-3822")!;
    const taxes = await readFourMemeTaxes([{ address: A, template: plain }], undefined, [url]);
    assert.deepEqual(taxes.get(A), { tax: { buyBps: 0, sellBps: 0 }, pool: null });
  });
});
