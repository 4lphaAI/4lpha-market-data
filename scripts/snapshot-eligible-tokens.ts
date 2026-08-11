/**
 * One-time snapshot of the eligible-token allowlist for trade/LP gating.
 *
 * Sources merged, in precedence order:
 *   1. `static`        — WBNB, BTCB, native BNB: hand-verified anchor assets.
 *   2. `bstocks`       — the fixed tokenized-equity lane from src/universe.ts.
 *   3. `cmc-149`       — the BNB hackathon eligible list (symbols transcribed
 *                        from the rules page), resolved to BSC addresses.
 *   4. `cmc-top200-bsc`— top-ranked CMC tokens that have a BSC contract.
 *
 * Resolution pipeline per symbol:
 *   CMC /v1/cryptocurrency/map (credit-free, works on the expired key) gives
 *   canonical id + name + rank — rank!=null is what separates a real listing
 *   from a same-symbol fake. The map only carries the token's PRIMARY platform,
 *   so BSC addresses for multichain tokens come from CoinGecko's free
 *   /coins/list?include_platform=true, matched by symbol and disambiguated by
 *   name. Every resolved address is then verified on-chain: symbol() is read
 *   via Multicall3 on public BSC RPC and compared. Anything ambiguous or
 *   unverifiable is kept OUT of the eligible list and reported in
 *   meta.needsReview for a manual BscScan check.
 *
 * Usage:  node --import tsx scripts/snapshot-eligible-tokens.ts
 * Output: data/eligible-tokens.json  (deliberately static — commit it; the
 *         execution plane consumes a pinned copy and fails closed)
 * Env:    CMC_API_KEY, or CMC_ENV_FILE pointing at an env file containing it
 *         (defaults to D:\4lpha-fourmeme-skill\.env.local as a convenience).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, erc20Abi } from "viem";
import { bsc } from "viem/chains";
import { bstocksUniverse } from "../src/universe.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = join(ROOT, "data", "eligible-tokens.json");
const CMC_BASE = "https://pro-api.coinmarketcap.com";
const COINGECKO_LIST = "https://api.coingecko.com/api/v3/coins/list?include_platform=true";
const BSC_PLATFORM_CMC = /bnb|binance/i;
const COINGECKO_BSC_KEY = "binance-smart-chain";
const TOP_N = 200;

/**
 * Transcribed from the hackathon rules screenshot (149 entries as printed;
 * SLX appears twice there and USDf/USDF are distinct entries — kept verbatim,
 * dedupe happens by resolved address). Non-ASCII and one-letter symbols are
 * expected to land in needsReview rather than resolve silently.
 */
const HACKATHON_SYMBOLS = [
  "ETH", "USDT", "USDC", "XRP", "TRX", "DOGE", "ZEC", "ADA", "LINK", "BCH",
  "DAI", "TON", "USD1", "USDe", "M", "LTC", "AVAX", "SHIB", "XAUt", "WLFI",
  "H", "DOT", "UNI", "ASTER", "DEXE", "USDD", "ETC", "AAVE", "ATOM", "U",
  "STABLE", "FIL", "INJ", "币安人生", "NIGHT", "FET", "TUSD", "BONK", "PENGU",
  "CAKE", "SIREN", "LUNC", "ZRO", "KITE", "FDUSD", "BEAT", "PIEVERSE", "BTT",
  "NFT", "EDGE", "FLOKI", "LDO", "B", "FF", "PENDLE", "NEX", "STG", "AXS",
  "TWT", "HOME", "RAY", "COMP", "GWEI", "XCN", "GENIUS", "XPL", "BAT",
  "SKYAI", "APE", "IP", "SFP", "TAG", "NXPC", "AB", "SAHARA", "1INCH",
  "CHEEMS", "BANANAS31", "RIVER", "MYX", "RAVE", "SNX", "FORM", "LAB", "HTX",
  "USDf", "CTM", "BDX", "SLX", "UB", "DUCKY", "FRAX", "BILL", "WFI", "KOGE",
  "ALE", "FRXUSD", "USDF", "GOMINING", "VCNT", "GUA", "DUSD", "SMILEK", "0G",
  "BEAM", "MY", "SOON", "REAL", "Q", "AIOZ", "ZIG", "YFI", "TAC", "lisUSD",
  "CYS", "ZAMA", "TRIA", "HUMA", "PLUME", "ZIL", "XPR", "ZETA", "BabyDoge",
  "NILA", "ROSE", "VELO", "UAI", "BRETT", "OPEN", "BSB", "TOSHI", "BAS",
  "ACH", "AXL", "LUR", "ELF", "KAVA", "APR", "IRYS", "EURI", "XUSD", "BARD",
  "DUSK", "SUSHI", "PEAQ", "COAI", "BDCA", "XAUM",
];

/** Hand-verified anchors. Double-checked against BscScan before committing. */
const STATIC_TOKENS: EligibleToken[] = [
  {
    address: "native",
    symbol: "BNB",
    name: "BNB",
    sources: ["static"],
    addressSource: "static",
    verifiedOnChain: true,
  },
  {
    address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    symbol: "WBNB",
    name: "Wrapped BNB",
    sources: ["static"],
    addressSource: "static",
  },
  {
    address: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c",
    symbol: "BTCB",
    name: "BTCB (Binance-pegged BTC)",
    sources: ["static"],
    addressSource: "static",
  },
  {
    // The primary quote asset. CMC's map carries only its Ethereum deployment
    // and CoinGecko has too many same-symbol fakes, so it is pinned here.
    address: "0x55d398326f99059ff775485246999027b3197955",
    symbol: "USDT",
    name: "Tether USD (Binance-pegged, BSC-USD)",
    sources: ["static"],
    addressSource: "static",
    expectedOnChainSymbol: "BSC-USD",
  },
];

interface EligibleToken {
  address: string;
  symbol: string;
  name: string;
  cmcId?: number;
  cmcRank?: number | null;
  sources: string[];
  addressSource: "static" | "bstocks" | "cmc-map" | "coingecko";
  verifiedOnChain?: boolean;
  onChainSymbol?: string;
  /** For contracts whose on-chain symbol legitimately differs (e.g. BSC-USD). */
  expectedOnChainSymbol?: string;
}

interface ReviewItem {
  symbol: string;
  source: string;
  reason: string;
  candidates?: string[];
}

interface CmcMapEntry {
  id: number;
  rank: number | null;
  name: string;
  symbol: string;
  is_active: number;
  platform: { id: number; name: string; slug: string; token_address: string } | null;
}

interface GeckoCoin {
  id: string;
  symbol: string;
  name: string;
  platforms?: Record<string, string | null>;
}

function loadCmcKey(): string {
  const fromEnv = process.env["CMC_API_KEY"]?.trim();
  if (fromEnv) return fromEnv;
  const envFile = process.env["CMC_ENV_FILE"]?.trim() ?? "D:\\4lpha-fourmeme-skill\\.env.local";
  if (existsSync(envFile)) {
    const line = readFileSync(envFile, "utf8")
      .split(/\r?\n/)
      .find((row) => row.startsWith("CMC_API_KEY="));
    const value = line?.slice("CMC_API_KEY=".length).trim().replace(/^"|"$/g, "");
    if (value) return value;
  }
  throw new Error("CMC_API_KEY not set and not found via CMC_ENV_FILE");
}

async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`${url.split("?")[0]} -> ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

async function cmcMapBySymbols(key: string, symbols: string[]): Promise<CmcMapEntry[]> {
  const param = encodeURIComponent(symbols.join(","));
  const body = await fetchJson<{ status: { error_code: number; error_message: string | null }; data?: CmcMapEntry[] }>(
    `${CMC_BASE}/v1/cryptocurrency/map?listing_status=active&aux=platform,status&symbol=${param}`,
    { "X-CMC_PRO_API_KEY": key },
  );
  if (body.status.error_code !== 0) throw new Error(`CMC map: ${body.status.error_message}`);
  return body.data ?? [];
}

async function cmcMapTopRanked(key: string, limit: number): Promise<CmcMapEntry[]> {
  const body = await fetchJson<{ status: { error_code: number; error_message: string | null }; data?: CmcMapEntry[] }>(
    `${CMC_BASE}/v1/cryptocurrency/map?listing_status=active&sort=cmc_rank&limit=${limit}&aux=platform,status`,
    { "X-CMC_PRO_API_KEY": key },
  );
  if (body.status.error_code !== 0) throw new Error(`CMC map(top): ${body.status.error_message}`);
  return body.data ?? [];
}

const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");

function isBscAddress(value: string | null | undefined): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Resolve a CMC entry to its BSC address. The map's own platform wins when it
 * already IS the BSC deployment; otherwise CoinGecko provides the BSC address
 * of the multichain token, matched by symbol and disambiguated by name.
 */
function resolveBscAddress(
  entry: CmcMapEntry,
  geckoBySymbol: Map<string, GeckoCoin[]>,
): { address: string; via: "cmc-map" | "coingecko" } | { reason: string; candidates?: string[] } {
  const platform = entry.platform;
  if (platform !== null && BSC_PLATFORM_CMC.test(`${platform.name} ${platform.slug}`) && isBscAddress(platform.token_address)) {
    return { address: platform.token_address.toLowerCase(), via: "cmc-map" };
  }

  const candidates = (geckoBySymbol.get(normalize(entry.symbol)) ?? []).filter((coin) =>
    isBscAddress(coin.platforms?.[COINGECKO_BSC_KEY]),
  );
  if (candidates.length === 0) {
    return { reason: platform === null ? "native coin with no BSC deployment found" : "no BSC address on CMC or CoinGecko" };
  }
  if (candidates.length === 1) {
    return { address: candidates[0]!.platforms![COINGECKO_BSC_KEY]!.toLowerCase(), via: "coingecko" };
  }
  const byName = candidates.filter((coin) => normalize(coin.name) === normalize(entry.name));
  if (byName.length === 1) {
    return { address: byName[0]!.platforms![COINGECKO_BSC_KEY]!.toLowerCase(), via: "coingecko" };
  }
  return {
    reason: "multiple CoinGecko candidates with a BSC address; needs manual pick",
    candidates: candidates.map((coin) => `${coin.name} (${coin.id}) ${coin.platforms![COINGECKO_BSC_KEY]}`),
  };
}

/** Reads symbol() for every address via Multicall3 on public BSC RPC. */
async function verifyOnChain(tokens: EligibleToken[]): Promise<void> {
  const client = createPublicClient({ chain: bsc, transport: http() });
  const targets = tokens.filter((token) => token.address !== "native");
  const CHUNK = 60;

  for (let i = 0; i < targets.length; i += CHUNK) {
    const chunk = targets.slice(i, i + CHUNK);
    const results = await client.multicall({
      contracts: chunk.map((token) => ({
        address: token.address as `0x${string}`,
        abi: erc20Abi,
        functionName: "symbol" as const,
      })),
      allowFailure: true,
    });
    for (let j = 0; j < chunk.length; j++) {
      const token = chunk[j]!;
      const result = results[j]!;
      if (result.status !== "success") {
        token.verifiedOnChain = false;
        continue;
      }
      token.onChainSymbol = String(result.result);
      token.verifiedOnChain =
        (token.expectedOnChainSymbol !== undefined &&
          normalize(token.onChainSymbol) === normalize(token.expectedOnChainSymbol)) ||
        normalize(token.onChainSymbol) === normalize(token.symbol) ||
        normalize(token.onChainSymbol).includes(normalize(token.symbol)) ||
        normalize(token.symbol).includes(normalize(token.onChainSymbol));
    }
  }
}

async function main(): Promise<void> {
  const key = loadCmcKey();
  const needsReview: ReviewItem[] = [];
  const byAddress = new Map<string, EligibleToken>();

  const add = (token: EligibleToken): void => {
    const existing = byAddress.get(token.address);
    if (existing === undefined) {
      byAddress.set(token.address, token);
      return;
    }
    for (const source of token.sources) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
    }
    if (existing.cmcId === undefined && token.cmcId !== undefined) existing.cmcId = token.cmcId;
    if (existing.cmcRank === undefined && token.cmcRank !== undefined) existing.cmcRank = token.cmcRank;
  };

  for (const token of STATIC_TOKENS) add({ ...token });
  for (const stock of bstocksUniverse()) {
    add({
      address: stock.address,
      symbol: stock.symbol,
      name: stock.name ?? stock.symbol,
      sources: ["bstocks"],
      addressSource: "bstocks",
    });
  }

  console.log("Fetching CoinGecko coin list (one call, large)...");
  const geckoCoins = await fetchJson<GeckoCoin[]>(COINGECKO_LIST);
  const geckoBySymbol = new Map<string, GeckoCoin[]>();
  for (const coin of geckoCoins) {
    const bucket = geckoBySymbol.get(normalize(coin.symbol));
    if (bucket === undefined) geckoBySymbol.set(normalize(coin.symbol), [coin]);
    else bucket.push(coin);
  }
  console.log(`CoinGecko coins indexed: ${geckoCoins.length}`);

  // The 149-symbol lane is opt-in: it borrows another hackathon's rules and
  // produced most of the manual-review burden, while top-200 already covers
  // nearly all of it. Re-enable with INCLUDE_CMC_149=1 when wanted.
  const include149 = process.env["INCLUDE_CMC_149"] === "1";
  console.log(include149 ? "Resolving hackathon-149 symbols via CMC map..." : "Skipping cmc-149 lane (INCLUDE_CMC_149 unset)");
  const mapEntries = include149
    ? await cmcMapBySymbols(key, HACKATHON_SYMBOLS.filter((symbol) => /^[\x20-\x7e]+$/.test(symbol)))
    : [];
  const bySymbol = new Map<string, CmcMapEntry[]>();
  for (const entry of mapEntries) {
    const bucket = bySymbol.get(normalize(entry.symbol));
    if (bucket === undefined) bySymbol.set(normalize(entry.symbol), [entry]);
    else bucket.push(entry);
  }

  for (const symbol of include149 ? HACKATHON_SYMBOLS : []) {
    if (!/^[\x20-\x7e]+$/.test(symbol)) {
      needsReview.push({ symbol, source: "cmc-149", reason: "non-ASCII symbol; resolve manually on CMC + BscScan" });
      continue;
    }
    const ranked = (bySymbol.get(normalize(symbol)) ?? [])
      .filter((entry) => entry.rank !== null)
      .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
    const entry = ranked[0];
    if (entry === undefined) {
      needsReview.push({ symbol, source: "cmc-149", reason: "no ranked CMC listing found (only unranked/fake matches or none)" });
      continue;
    }
    const resolved = resolveBscAddress(entry, geckoBySymbol);
    if ("reason" in resolved) {
      needsReview.push({ symbol, source: "cmc-149", reason: resolved.reason, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) });
      continue;
    }
    add({
      address: resolved.address,
      symbol: entry.symbol,
      name: entry.name,
      cmcId: entry.id,
      cmcRank: entry.rank,
      sources: ["cmc-149"],
      addressSource: resolved.via,
    });
  }

  console.log("Building cmc-top200-bsc from rank-sorted map...");
  const topEntries = await cmcMapTopRanked(key, 1000);
  let found = 0;
  for (const entry of topEntries) {
    if (found >= TOP_N) break;
    const resolved = resolveBscAddress(entry, geckoBySymbol);
    if ("reason" in resolved) continue;
    add({
      address: resolved.address,
      symbol: entry.symbol,
      name: entry.name,
      cmcId: entry.id,
      cmcRank: entry.rank,
      sources: ["cmc-top200-bsc"],
      addressSource: resolved.via,
    });
    found++;
  }
  console.log(`Top-ranked tokens with a BSC address: ${found}`);

  const tokens = [...byAddress.values()];
  console.log(`Verifying ${tokens.length} addresses on-chain via Multicall3...`);
  await verifyOnChain(tokens);

  const failed = tokens.filter((token) => token.verifiedOnChain === false);
  for (const token of failed) {
    needsReview.push({
      symbol: token.symbol,
      source: token.sources.join("+"),
      reason: `on-chain symbol() ${token.onChainSymbol === undefined ? "reverted" : `= "${token.onChainSymbol}"`} does not match; address ${token.address}`,
    });
  }
  const eligible = tokens
    .filter((token) => token.verifiedOnChain !== false)
    .sort((a, b) => (a.cmcRank ?? Infinity) - (b.cmcRank ?? Infinity));

  const output = {
    meta: {
      snapshotAt: new Date().toISOString(),
      description:
        "Static eligible-token allowlist for trade/LP gating. Four.Meme-launched tokens are eligible by factory rule, not enumerated here. Deliberately frozen; regenerate only by explicit decision.",
      counts: {
        eligible: eligible.length,
        needsReview: needsReview.length,
        bySource: {
          static: eligible.filter((token) => token.sources.includes("static")).length,
          bstocks: eligible.filter((token) => token.sources.includes("bstocks")).length,
          "cmc-149": eligible.filter((token) => token.sources.includes("cmc-149")).length,
          "cmc-top200-bsc": eligible.filter((token) => token.sources.includes("cmc-top200-bsc")).length,
        },
      },
      needsReview,
    },
    tokens: eligible,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`\nWrote ${OUT_PATH}`);
  console.log(`Eligible: ${eligible.length} | needsReview: ${needsReview.length}`);
  for (const item of needsReview) console.log(`  REVIEW ${item.symbol} [${item.source}]: ${item.reason}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
