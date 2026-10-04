/**
 * What a meme token is quoted in: native BNB, a stablecoin, a bStock, or
 * something else.
 *
 * Measured 2026-10-04 on the Meme Rush lists: roughly a third of Four.Meme and
 * Flap launches are quoted in a bStock, and the most common one (BNCB, CEA
 * Industries) is not on Binance's RWA token list at all — that list carries 46
 * of the issuer's 87 BSC tickers. So membership is decided on chain instead:
 * every genuine bStock is an AccessControl token whose `DEFAULT_ADMIN_ROLE`
 * member 0 is the issuer's admin. A copycat can reuse a name and symbol (a fake
 * "COHRB" with supply 0.01 sits on DexScreener) but not that role.
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
import { bstockAddresses } from "../universe.js";

const SOURCE = "quote-kind";

export type QuoteKind = "bnb" | "stable" | "bstock" | "other";

/** Forever cache of on-chain verdicts: address → `bstock` | `other`. */
export const QUOTE_KINDS_KEY = "quotes:kind";
const FOREVER_MS = 100 * 365 * 24 * 3_600_000;

/** `DEFAULT_ADMIN_ROLE` member 0 on every genuine bStock (NVDAB, GLWB, BNCB, … read 2026-10-04). */
export const BSTOCK_ISSUER_ADMIN = "0x45e35fe982f3869221b222abea372fa97aa7679d";

const NATIVE = new Set([
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "0x0000000000000000000000000000000000000000",
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
]);

const STABLES = new Set([
  "0x55d398326f99059ff775485246999027b3197955", // USDT
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
  "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", // USD1
  "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409", // FDUSD
  "0xe9e7cea3dedca5984780bafc599bd69add087d56", // BUSD
]);

/** Kinds that need no chain read. `null` means "ask the chain". */
export function staticQuoteKind(address: string, knownBstocks: ReadonlySet<string>): QuoteKind | null {
  if (NATIVE.has(address)) return "bnb";
  if (STABLES.has(address)) return "stable";
  if (knownBstocks.has(address)) return "bstock";
  return null;
}

/** Reads the admin role of one contract; `null` when the endpoint could not answer. */
export type IssuerReader = (addresses: string[], signal?: AbortSignal) => Promise<Map<string, QuoteKind>>;

const ROLE_ABI = parseAbi(["function getRoleMember(bytes32,uint256) view returns (address)"]);
const DEFAULT_ADMIN_ROLE = `0x${"0".repeat(64)}` as const;

async function readKindOn(client: BscClient, address: string): Promise<QuoteKind | null> {
  try {
    const admin = await client.readContract({
      address: address as `0x${string}`,
      abi: ROLE_ABI,
      functionName: "getRoleMember",
      args: [DEFAULT_ADMIN_ROLE, 0n],
    });
    return admin.toLowerCase() === BSTOCK_ISSUER_ADMIN ? "bstock" : "other";
  } catch (error) {
    // No AccessControl, or no member: a real answer about the contract.
    if (isContractLevelFailure(error)) return "other";
    throw error;
  }
}

/** Default reader: one batched round trip; a transport failure resolves nothing. */
export const readIssuerKinds: IssuerReader = async (addresses, signal) => {
  const out = new Map<string, QuoteKind>();
  if (addresses.length === 0) return out;
  try {
    const kinds = await withBscClient(
      async (client) => Promise.all(addresses.map((address) => readKindOn(client, address))),
      signal === undefined ? {} : { signal },
    );
    addresses.forEach((address, index) => {
      const kind = kinds[index];
      if (kind !== null && kind !== undefined) out.set(address, kind);
    });
  } catch (error) {
    console.warn(`[${SOURCE}] issuer read failed: ${sanitizeMessage(error)}`);
  }
  return out;
};

/**
 * Resolves the kind of every quote address. Unresolvable ones are absent from
 * the result, so a caller can tell "not a bStock" from "could not ask".
 */
export async function resolveQuoteKinds(
  store: SnapshotStore,
  quotes: Iterable<string>,
  options: { signal?: AbortSignal | undefined; readIssuer?: IssuerReader | undefined } = {},
): Promise<Map<string, QuoteKind>> {
  // Only the static bStocks are taken on trust: `rwa:members` also carries Ondo
  // tokens, which are stocks but not bStocks. Everything else is asked once.
  const known = new Set(bstockAddresses());
  const cached = await readCache(store);
  const out = new Map<string, QuoteKind>();
  const ask: string[] = [];

  for (const raw of new Set(quotes)) {
    const address = normalizeAddress(raw);
    if (address === null) continue;
    const kind = staticQuoteKind(address, known) ?? cached.get(address) ?? null;
    if (kind === null) ask.push(address);
    else out.set(address, kind);
  }

  if (ask.length > 0) {
    const read = options.readIssuer ?? readIssuerKinds;
    const fresh = await read(ask, options.signal);
    if (fresh.size > 0) {
      for (const [address, kind] of fresh) {
        out.set(address, kind);
        cached.set(address, kind);
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

async function readCache(store: SnapshotStore): Promise<Map<string, QuoteKind>> {
  const out = new Map<string, QuoteKind>();
  try {
    const record = await store.get<unknown>(QUOTE_KINDS_KEY);
    if (record !== null && typeof record.data === "object" && record.data !== null) {
      for (const [raw, kind] of Object.entries(record.data as Record<string, unknown>)) {
        const address = normalizeAddress(raw);
        if (address !== null && (kind === "bstock" || kind === "other")) out.set(address, kind);
      }
    }
  } catch (error) {
    console.warn(`[${SOURCE}] cache read failed: ${sanitizeMessage(error)}`);
  }
  return out;
}
