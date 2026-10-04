/**
 * What a meme token is quoted in: native BNB, a stablecoin, a bStock, or
 * something else — and that token's symbol, so a consumer reads "quoted in
 * NVDAB" without a second lookup.
 *
 * Measured 2026-10-04 on the Meme Rush lists: roughly a third to a half of
 * Four.Meme and Flap launches are quoted in a bStock, and the most common one
 * (BNCB, CEA Industries) is not on Binance's RWA token list at all — that list
 * carries 46 of the issuer's 87 BSC tickers. So membership is decided on chain
 * instead: every genuine bStock is an AccessControl token whose
 * `DEFAULT_ADMIN_ROLE` member 0 is the issuer's admin. A copycat can reuse a
 * name and symbol (a fake "COHRB" with supply 0.01 sits on DexScreener) but not
 * that role.
 *
 * The answer is a property of the contract, so it is cached forever under
 * `quotes:kind` — the same reasoning as `origins:launchpad`. A read no endpoint
 * could serve is left unresolved and never written: an outage cached here
 * would be permanent.
 */

import { parseAbi } from "viem";
import type { SnapshotStore } from "../core/store.js";
import { normalizeAddress, sanitizeMessage } from "../adapters/http.js";
import { isContractLevelFailure, withBscClient, type BscClient } from "../chain/rpc.js";
import { bstocksUniverse } from "../universe.js";

const SOURCE = "quote-kind";

export type QuoteKind = "bnb" | "stable" | "bstock" | "other";

export interface QuoteInfo {
  kind: QuoteKind;
  /** On-chain `symbol()`; `null` when the contract does not answer one. */
  symbol: string | null;
}

/** Forever cache of on-chain verdicts: address → {@link QuoteInfo}. */
export const QUOTE_KINDS_KEY = "quotes:kind";
const FOREVER_MS = 100 * 365 * 24 * 3_600_000;

/** `DEFAULT_ADMIN_ROLE` member 0 on every genuine bStock (NVDAB, GLWB, BNCB, … read 2026-10-04). */
export const BSTOCK_ISSUER_ADMIN = "0x45e35fe982f3869221b222abea372fa97aa7679d";

const STATIC: Record<string, QuoteInfo> = {
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee": { kind: "bnb", symbol: "BNB" },
  "0x0000000000000000000000000000000000000000": { kind: "bnb", symbol: "BNB" },
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": { kind: "bnb", symbol: "WBNB" },
  "0x55d398326f99059ff775485246999027b3197955": { kind: "stable", symbol: "USDT" },
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": { kind: "stable", symbol: "USDC" },
  "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d": { kind: "stable", symbol: "USD1" },
  "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409": { kind: "stable", symbol: "FDUSD" },
  "0xe9e7cea3dedca5984780bafc599bd69add087d56": { kind: "stable", symbol: "BUSD" },
};

/**
 * Quotes that need no chain read: native, stables and the static bStocks.
 * Only the static bStocks are taken on trust — `rwa:members` also carries Ondo
 * tokens, which are stocks but not bStocks. Everything else is asked once.
 */
export function staticQuoteInfo(address: string): QuoteInfo | null {
  const known = STATIC[address];
  if (known !== undefined) return known;
  const stock = bstocksUniverse().find((entry) => entry.address === address);
  return stock === undefined ? null : { kind: "bstock", symbol: stock.symbol };
}

/** Reads the issuer role and symbol of contracts; an address it could not ask is absent. */
export type IssuerReader = (addresses: string[], signal?: AbortSignal) => Promise<Map<string, QuoteInfo>>;

const ABI = parseAbi([
  "function getRoleMember(bytes32,uint256) view returns (address)",
  "function symbol() view returns (string)",
]);
const DEFAULT_ADMIN_ROLE = `0x${"0".repeat(64)}` as const;

async function readInfoOn(client: BscClient, address: string): Promise<QuoteInfo> {
  const target = address as `0x${string}`;
  const [kind, symbol] = await Promise.all([
    client
      .readContract({ address: target, abi: ABI, functionName: "getRoleMember", args: [DEFAULT_ADMIN_ROLE, 0n] })
      .then((admin): QuoteKind => (admin.toLowerCase() === BSTOCK_ISSUER_ADMIN ? "bstock" : "other"))
      // No AccessControl, or no member: a real answer about the contract.
      .catch((error: unknown): QuoteKind => {
        if (isContractLevelFailure(error)) return "other";
        throw error;
      }),
    client
      .readContract({ address: target, abi: ABI, functionName: "symbol" })
      .then((value): string | null => (value.trim() === "" ? null : value.trim()))
      .catch((error: unknown): string | null => {
        if (isContractLevelFailure(error)) return null;
        throw error;
      }),
  ]);
  return { kind, symbol };
}

/** Default reader: one batched round trip; a transport failure resolves nothing. */
export const readIssuerInfo: IssuerReader = async (addresses, signal) => {
  const out = new Map<string, QuoteInfo>();
  if (addresses.length === 0) return out;
  try {
    const infos = await withBscClient(
      async (client) => Promise.all(addresses.map((address) => readInfoOn(client, address))),
      signal === undefined ? {} : { signal },
    );
    addresses.forEach((address, index) => {
      const info = infos[index];
      if (info !== undefined) out.set(address, info);
    });
  } catch (error) {
    console.warn(`[${SOURCE}] issuer read failed: ${sanitizeMessage(error)}`);
  }
  return out;
};

/**
 * Resolves every quote address. Unresolvable ones are absent from the result,
 * so a caller can tell "not a bStock" from "could not ask".
 */
export async function resolveQuotes(
  store: SnapshotStore,
  quotes: Iterable<string>,
  options: { signal?: AbortSignal | undefined; readIssuer?: IssuerReader | undefined } = {},
): Promise<Map<string, QuoteInfo>> {
  const cached = await readCache(store);
  const out = new Map<string, QuoteInfo>();
  const ask: string[] = [];

  for (const raw of new Set(quotes)) {
    const address = normalizeAddress(raw);
    if (address === null) continue;
    const info = staticQuoteInfo(address) ?? cached.get(address) ?? null;
    if (info === null) ask.push(address);
    else out.set(address, info);
  }

  if (ask.length > 0) {
    const read = options.readIssuer ?? readIssuerInfo;
    const fresh = await read(ask, options.signal);
    if (fresh.size > 0) {
      for (const [address, info] of fresh) {
        out.set(address, info);
        cached.set(address, info);
      }
      try {
        await store.put(QUOTE_KINDS_KEY, Object.fromEntries(cached), {
          source: SOURCE,
          freshForMs: FOREVER_MS,
          deadAfterMs: FOREVER_MS,
        });
      } catch (error) {
        console.warn(`[${SOURCE}] cache write failed: ${sanitizeMessage(error)}`);
      }
    }
  }
  return out;
}

async function readCache(store: SnapshotStore): Promise<Map<string, QuoteInfo>> {
  const out = new Map<string, QuoteInfo>();
  try {
    const record = await store.get<unknown>(QUOTE_KINDS_KEY);
    if (record !== null && typeof record.data === "object" && record.data !== null) {
      for (const [raw, value] of Object.entries(record.data as Record<string, unknown>)) {
        const address = normalizeAddress(raw);
        const info = parseInfo(value);
        if (address !== null && info !== null) out.set(address, info);
      }
    }
  } catch (error) {
    console.warn(`[${SOURCE}] cache read failed: ${sanitizeMessage(error)}`);
  }
  return out;
}

/** The store outlives code versions: an entry is re-checked, never trusted. */
function parseInfo(value: unknown): QuoteInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const { kind, symbol } = value as { kind?: unknown; symbol?: unknown };
  if (kind !== "bstock" && kind !== "other") return null;
  return { kind, symbol: typeof symbol === "string" ? symbol : null };
}
