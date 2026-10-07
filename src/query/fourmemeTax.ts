/**
 * Buy and sell tax of a graduated Four.Meme token, read from the token itself
 * (`FOURMEME-TAX-SPEC.md`, handoff 2026-10-06).
 *
 * Four.Meme deploys several token templates and they report tax differently.
 * TokenManager2 records each token's creator type, `(template >> 10) & 0x3F`,
 * which Four.Meme documents as the authoritative tax-family check; the bytecode
 * is the second, independent fact. A token gets a tax only when the pair
 * (creator type, code identity) is one this plane proved against real swaps:
 * every swap cited in `MEME-FOURMEME-TAX-REPLY-2026-10-06.md` charged exactly
 * the documented `amount * rate / 100` (types 8, 9) or `amount * feeRate / 10000`
 * (type 5), and the pair's own `Swap` amounts agreed with the `Transfer` legs.
 *
 * The trap: on types 8 and 9 `feeRate()` is a deprecated field that reads 0.
 * The rates are `feeRateBuy` / `feeRateSell`, in percent. It is never read there.
 *
 * Fail closed throughout: an unknown identity, a creator type that disagrees
 * with the code, a reverted or out-of-range rate all give `null`, never 0. A
 * plain template reports 0 because its bytecode is a proven no-tax template,
 * never because a view was missing.
 */

import { keccak256, parseAbi } from "viem";
import { withBscClient } from "../chain/rpc.js";
import { FOURMEME_TOKEN_MANAGER2 } from "./eligibility.js";

/** Permanent facts about a token's contract; read once and cached. */
export interface FourMemeCode {
  /** `proxy:<implementation>` for an EIP-1167 clone, `hash:<keccak256>` otherwise, `none` without code. */
  code: string;
  /** TokenManager2 creator type; `null` when TokenManager2 does not know the token. */
  creatorType: number | null;
}

type RateModel = "percent-buy-sell" | "bps-single" | "none";

export interface FourMemeTemplate {
  id: string;
  creatorType: number;
  code: string;
  rates: RateModel;
}

/**
 * Every entry is proven by a buy and a sell on chain (tx hashes in the reply).
 * An identity not listed here, including a new implementation Four.Meme ships
 * later, reads `tax: null` until it is proven and added.
 */
export const FOURMEME_TEMPLATES: readonly FourMemeTemplate[] = [
  { id: "tax9-7330", creatorType: 9, code: "proxy:0x7330d8865f4b6800b72bdd73e2007833a5d45c94", rates: "percent-buy-sell" },
  { id: "tax9-2812", creatorType: 9, code: "proxy:0x28129943b5f12826b7b190e2443c3fc223ad740c", rates: "percent-buy-sell" },
  { id: "tax9-e506", creatorType: 9, code: "proxy:0xe506cd33886785816895dbfb2bc8927696c0c8ec", rates: "percent-buy-sell" },
  { id: "tax8-13584", creatorType: 8, code: "hash:0xd8c7d12fc883a477ca8feda0f19d672cb37b1330cdd80287114bfb7680fa2bb9", rates: "percent-buy-sell" },
  { id: "tax8-13762", creatorType: 8, code: "hash:0x760eda3e4fa91e876396e6f761aae6df27c558ee016b9bcbcdd633b8b5bfc904", rates: "percent-buy-sell" },
  { id: "tax5-10456", creatorType: 5, code: "hash:0xf522baa0235a3c393cf4831f44a74d928bcde8e79f6ad8f0f0af2be115d36b24", rates: "bps-single" },
  { id: "plain-3822", creatorType: 0, code: "hash:0x1210dbadb4a9a84de0a99de0b17d70f917aa61bfc53711787d0ac0bf12d716ea", rates: "none" },
  { id: "plain-4686", creatorType: 0, code: "proxy:0x46862924e2a229170ebd065e24a0da72af58a986", rates: "none" },
  { id: "plain-2901", creatorType: 0, code: "hash:0x3e6b67a73f451cce26e65eae0ae3a07f9bce8542aa1fb25e95c7199f83d3579f", rates: "none" },
];

/** Documented ceiling for types 8/9: a rate of at most 10 percent. */
const MAX_PERCENT = 10n;
/** Type 5 creation options are 1/3/5/10 percent: at most 1000 bps. */
const MAX_BPS = 1_000n;

const EIP1167 = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;

/** The code identity of a runtime bytecode. */
export function codeIdentity(bytecode: string | undefined): string {
  if (bytecode === undefined || bytecode === "0x" || bytecode === "") return "none";
  const proxy = EIP1167.exec(bytecode);
  if (proxy !== null) return `proxy:0x${proxy[1]!.toLowerCase()}`;
  return `hash:${keccak256(bytecode as `0x${string}`)}`;
}

/** The proven template for this identity, or `null`: both facts must agree. */
export function matchFourMemeTemplate(identity: FourMemeCode): FourMemeTemplate | null {
  if (identity.creatorType === null) return null;
  return FOURMEME_TEMPLATES.find((t) => t.code === identity.code && t.creatorType === identity.creatorType) ?? null;
}

/** Raw rate views; `null` = the view reverted or was not read. */
export interface FourMemeRates {
  feeRate: bigint | null;
  feeRateBuy: bigint | null;
  feeRateSell: bigint | null;
}

/** Exported for tests: the tax a template's rate views describe, or `null`. */
export function taxFromRates(template: FourMemeTemplate, rates: FourMemeRates): { buyBps: number; sellBps: number } | null {
  switch (template.rates) {
    case "none":
      return { buyBps: 0, sellBps: 0 };
    case "bps-single": {
      const fee = rates.feeRate;
      if (fee === null || fee < 0n || fee > MAX_BPS) return null;
      return { buyBps: Number(fee), sellBps: Number(fee) };
    }
    case "percent-buy-sell": {
      const { feeRateBuy: buy, feeRateSell: sell } = rates;
      if (buy === null || sell === null || buy < 0n || sell < 0n || buy > MAX_PERCENT || sell > MAX_PERCENT) return null;
      return { buyBps: Number(buy) * 100, sellBps: Number(sell) * 100 };
    }
  }
}

const tm2Abi = parseAbi([
  "struct TokenInfo { address base; address quote; uint256 template; uint256 totalSupply; uint256 maxOffers; uint256 maxRaising; uint256 launchTime; uint256 offers; uint256 funds; uint256 lastPrice; uint256 K; uint256 T; uint256 status; }",
  "function _tokenInfos(address token) view returns (TokenInfo)",
]);

const taxAbi = parseAbi([
  "function feeRate() view returns (uint256)",
  "function feeRateBuy() view returns (uint256)",
  "function feeRateSell() view returns (uint256)",
  "function pair() view returns (address)",
]);

const ZERO = "0x0000000000000000000000000000000000000000";

/** Exported for tests: the creator type, or `null` when TokenManager2 does not hold this token. */
export function creatorTypeOf(token: string, info: { base: string; template: bigint }): number | null {
  if (info.base.toLowerCase() !== token.toLowerCase()) return null;
  return Number((info.template >> 10n) & 0x3fn);
}

export type FourMemeCodeReader = (addresses: readonly string[], signal?: AbortSignal) => Promise<Map<string, FourMemeCode>>;

export interface FourMemeTaxRead {
  tax: { buyBps: number; sellBps: number } | null;
  /** The token's own `pair()`, the pair the tax is charged on; `null` for plain templates. */
  pool: string | null;
}

export type FourMemeTaxReader = (
  items: readonly { address: string; template: FourMemeTemplate }[],
  signal?: AbortSignal,
) => Promise<Map<string, FourMemeTaxRead>>;

/**
 * Code identity and creator type for each address. Only a complete answer is
 * returned: a token whose reads failed, or whose code read came back empty, is
 * absent and asked again next cycle, because the caller caches the answer
 * forever. Every TokenManager2 error is treated as a failure, not as an answer:
 * TokenManager2 answers a token it does not hold with a zero struct (measured),
 * so a revert is never the honest negative, and viem reports an overloaded
 * node's JSON-RPC -32603 as a revert.
 */
export const readFourMemeCodes = async (
  addresses: readonly string[],
  signal?: AbortSignal,
  rpcUrls?: string[],
): Promise<Map<string, FourMemeCode>> => {
  const out = new Map<string, FourMemeCode>();
  // Small chunks: eth_getCode is one request per address and public endpoints throttle bursts.
  for (let i = 0; i < addresses.length; i += 20) {
    if (signal?.aborted === true) break;
    const chunk = addresses.slice(i, i + 20);
    try {
      const rows = await withBscClient(
        (client) =>
          Promise.all(
            chunk.map(async (address) => {
              const token = address as `0x${string}`;
              const [code, info] = await Promise.all([
                client.getCode({ address: token }),
                client.readContract({ address: FOURMEME_TOKEN_MANAGER2, abi: tm2Abi, functionName: "_tokenInfos", args: [token] }),
              ]);
              return [address, { code: codeIdentity(code), creatorType: creatorTypeOf(address, info) }] as const;
            }),
          ),
        { signal, rpcUrls },
      );
      // A graduated token always has code; "none" is a lagging node, not a fact to keep.
      for (const [address, identity] of rows) if (identity.code !== "none") out.set(address, identity);
    } catch {
      // the chunk stays unread and is asked again next cycle
    }
  }
  return out;
};

/**
 * Rate views and `pair()` for tokens whose template is already recognised, in
 * one callback so viem folds them into multicalls. A recognised template has
 * these views (proven), so any error on a token is a failed read, not a
 * missing view: that token is left out of the result (the caller reports it
 * `null` and retries next cycle) and never answers with a partial row. When
 * every token that needed a view failed, the read throws so the next endpoint
 * gets a turn. A returned `tax: null` means the views answered with a rate this
 * plane will not publish (out of range).
 */
export const readFourMemeTaxes = async (
  items: readonly { address: string; template: FourMemeTemplate }[],
  signal?: AbortSignal,
  rpcUrls?: string[],
): Promise<Map<string, FourMemeTaxRead>> =>
  withBscClient(
    async (client) => {
      const settled = await Promise.allSettled(
        items.map(async ({ address, template }): Promise<FourMemeTaxRead> => {
          const token = address as `0x${string}`;
          if (template.rates === "none") return { tax: taxFromRates(template, { feeRate: null, feeRateBuy: null, feeRateSell: null }), pool: null };
          const read = (functionName: "feeRate" | "feeRateBuy" | "feeRateSell") =>
            client.readContract({ address: token, abi: taxAbi, functionName });
          const [feeRate, feeRateBuy, feeRateSell, pair] = await Promise.all([
            template.rates === "bps-single" ? read("feeRate") : null,
            template.rates === "percent-buy-sell" ? read("feeRateBuy") : null,
            template.rates === "percent-buy-sell" ? read("feeRateSell") : null,
            client.readContract({ address: token, abi: taxAbi, functionName: "pair" }),
          ]);
          return { tax: taxFromRates(template, { feeRate, feeRateBuy, feeRateSell }), pool: pair === ZERO ? null : pair.toLowerCase() };
        }),
      );
      const out = new Map<string, FourMemeTaxRead>();
      let firstError: unknown = null;
      let needed = 0;
      let answered = 0;
      settled.forEach((result, index) => {
        const item = items[index]!;
        const readsViews = item.template.rates !== "none";
        if (readsViews) needed += 1;
        if (result.status === "fulfilled") {
          out.set(item.address, result.value);
          if (readsViews) answered += 1;
        } else {
          firstError ??= result.reason;
        }
      });
      if (needed > 0 && answered === 0) throw firstError;
      return out;
    },
    { signal, rpcUrls },
  );
