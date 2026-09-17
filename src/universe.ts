/**
 * The token universe, one lane per product surface.
 *
 * `meme` and `coins` are discovered by background jobs and read back out of the
 * store. `bstocks` is a fixed, verified list of tokenized US equities — the
 * floor that a provider outage can never shrink — unioned with the Binance Web3
 * RWA list, which also supplies the `ondo` lane. Assembly is read-only: a lane
 * whose job has never run simply contributes nothing.
 *
 * A fourth lane, `allowlist`, is the frozen `data/eligible-tokens.json`
 * snapshot; it is reported and served on its own rather than merged into the
 * three so the complete curated list remains enumerable.
 */

import type { Lane, RwaToken, UniverseEntry, Venue } from "./core/models.js";
import type { SnapshotStore } from "./core/store.js";
import type { Staleness } from "./core/types.js";
import { normalizeAddress } from "./adapters/http.js";
import { loadAllowlist } from "./allowlist.js";

/** Store key holding the Four.Meme-discovered lane. */
export const MEME_UNIVERSE_KEY = "universe:meme";
/**
 * Store key holding the Flap-discovered lane.
 *
 * Kept separate from {@link MEME_UNIVERSE_KEY} rather than written into it: the
 * two launchpads are polled by independent jobs on different cadences, and a
 * shared key would mean whichever job ran last silently erased the other's
 * tokens. They are unioned at read time instead, so either job can be down
 * without taking the other's half of the lane with it.
 */
export const FLAP_UNIVERSE_KEY = "universe:flap";
/** Store key holding the Binance-Alpha-discovered lane. */
export const COINS_UNIVERSE_KEY = "universe:coins";
/**
 * Store key holding the Binance Web3 RWA token list (bStocks + Ondo), written
 * by `binance-rwa`. Read into two lanes — `bstocks` (over the static floor)
 * and `ondo` — because the issuer is the product distinction the execution
 * plane routes on.
 */
export const RWA_UNIVERSE_KEY = "universe:rwa";
/** Store key holding per-token AMM venues for the RWA tokens, written by `stock-venues`. */
export const RWA_VENUES_KEY = "venues:rwa";
/** Store key remembering every address ever seen in an RWA list (see `jobs/binanceRwa.ts`). */
export const RWA_MEMBERS_KEY = "rwa:members";

interface StaticStock {
  symbol: string;
  address: string;
}

/**
 * Tokenized US equities on BSC. Addresses are verified contract addresses; the
 * list is deliberately static so a provider outage can never shrink the lane.
 */
const BSTOCK_CONTRACTS: StaticStock[] = [
  { symbol: "AMDB", address: "0x75fd4cf6f8392e41e70391d60c90c0d5211603a1" },
  { symbol: "CBRSB", address: "0xe81c6bb0266cd68b4f17278531dd03ea1f12da4e" },
  { symbol: "COINB", address: "0x585bde7c54abb5ccd7791f923d6c2187635f3952" },
  { symbol: "CRCLB", address: "0x80f3d493ebce97e343c53d29a137942416b4ffc0" },
  { symbol: "DRAMB", address: "0x93862d63fd9fd488b1328e9b47717d75e994a84b" },
  { symbol: "EWYB", address: "0xbe82f76637dba2c114c41df856c2c51e522e2cb8" },
  { symbol: "GLWB", address: "0x740e075cbbea22a082b9d6679e65e82767875b6a" },
  { symbol: "GOOGLB", address: "0x3f53de71c126bdabae20f9cd64848d317f6c3238" },
  { symbol: "INTCB", address: "0xe614e2fc6c787035ff51f452e8e826bfd32d5283" },
  { symbol: "LITEB", address: "0x64748bea17b6d19e242adf20425de2440c656142" },
  { symbol: "METAB", address: "0x7425889fe94f9d693e8daefe88bcced6acfef4c0" },
  { symbol: "MSFTB", address: "0x80106cb3ead06659a5ad19df39d9b4733863b9b0" },
  { symbol: "MSTRB", address: "0xe87afb3076aeb0f9b14e368de8145ae6a2826a14" },
  { symbol: "MUB", address: "0xcdf2f3e0fa43c47a6662a91c9e4a7c5f69762699" },
  { symbol: "NBISB", address: "0xe256bc2a4f5297f8ba6f043f180a46300ecbcbb1" },
  { symbol: "NVDAB", address: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436" },
  { symbol: "PLTRB", address: "0x0ca5d51d0277bd006fd9607d3e560785ebad8222" },
  { symbol: "QCOMB", address: "0x5f7a56e877b9130608bf8be962621011182fefe1" },
  { symbol: "QQQB", address: "0x205812cdbed920aff76c6580abd681a46d11efc7" },
  { symbol: "SNDKB", address: "0x3ee4df61bd4f867e349beae8bfe07bc31b4850fb" },
  { symbol: "SOXLB", address: "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf" },
  { symbol: "SPCXB", address: "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1" },
  { symbol: "SPYB", address: "0x7138b48df7d98d7e3cc221bfe7192d0a178182d8" },
  { symbol: "TSLAB", address: "0x5b1910eaad6450e50f816082aa078c41f10c292f" },
  { symbol: "WDCB", address: "0xebe29695f8047c13d36e7a790ca8c1b239ffad1c" },
];

/** The static bStocks lane. A fresh array each call, so callers cannot mutate it. */
export function bstocksUniverse(): UniverseEntry[] {
  return BSTOCK_CONTRACTS.map((stock) => ({
    address: stock.address,
    symbol: stock.symbol,
    lane: "bstocks" as const,
    source: "static",
    marketHours: "us-equities" as const,
  }));
}

/** Just the bStocks addresses, used as the default price-tracking set. */
export function bstockAddresses(): string[] {
  return BSTOCK_CONTRACTS.map((stock) => stock.address);
}

/**
 * The frozen allowlist as universe rows, read through the shared loader. Empty
 * when the snapshot is unreadable —
 * the same degradation the eligibility gate takes.
 */
export function allowlistUniverse(): UniverseEntry[] {
  const allowlist = loadAllowlist();
  if (allowlist === null) return [];
  return [...allowlist.values()].map((entry) => ({
    address: entry.address,
    symbol: entry.symbol,
    lane: "allowlist" as const,
    source: entry.source,
  }));
}

/** Per-lane provenance returned alongside the merged universe. */
export interface LaneStatus {
  count: number;
  /** `null` for lanes with no stored snapshot yet. */
  staleness: Staleness | null;
  /** Epoch milliseconds of the lane's snapshot; `null` for the static lane. */
  asOf: number | null;
  source: string;
}

export interface UniverseResult {
  entries: UniverseEntry[];
  /**
   * The allowlist lane, kept beside `entries` rather than merged into them:
   * every bStock is also allowlisted, so a
   * merge would either relabel the bStocks lane or drop those rows from this
   * one, and this lane has to answer with the whole snapshot.
   */
  allowlist: UniverseEntry[];
  lanes: Record<Lane, LaneStatus>;
}

/**
 * Merges the three lanes. A token listed in more than one lane is kept once,
 * under the highest-precedence lane: bstocks > coins > meme. The precedence
 * reflects certainty — the static equity list and the curated Alpha list are
 * both stronger classifications than "appeared in a meme ranking".
 *
 * The meme lane is itself a union of two launchpads, Four.Meme and Flap. They
 * stay one lane because they are one product surface — a continuously launching
 * token that no snapshot can enumerate — and each entry still names which
 * launchpad found it in its `source`.
 */
export async function buildUniverse(store: SnapshotStore): Promise<UniverseResult> {
  const fourmeme = await readLane(store, MEME_UNIVERSE_KEY, "meme");
  const flap = await readLane(store, FLAP_UNIVERSE_KEY, "meme");
  const coins = await readLane(store, COINS_UNIVERSE_KEY, "coins");
  const rwa = await readRwaLanes(store);
  const allowlist = allowlistUniverse();

  const memeEntries = new Map<string, UniverseEntry>();
  for (const entry of [...fourmeme.entries, ...flap.entries]) memeEntries.set(entry.address, entry);

  const byAddress = new Map<string, UniverseEntry>();
  // Lowest precedence first, so later lanes overwrite earlier ones. An issuer's
  // own list (ondo) beats an Alpha listing; the bStocks lane beats everything.
  for (const entry of [...memeEntries.values(), ...coins.entries, ...rwa.ondo, ...rwa.bstocks]) {
    byAddress.set(entry.address, entry);
  }

  const entries = [...byAddress.values()].sort((a, b) => a.address.localeCompare(b.address));

  return {
    entries,
    allowlist,
    lanes: {
      meme: combineLane(memeEntries.size, [
        { name: "fourmeme", read: fourmeme },
        { name: "flap", read: flap },
      ]),
      coins: { count: coins.entries.length, staleness: coins.staleness, asOf: coins.asOf, source: "binance" },
      // The static floor is always fresh; with the RWA snapshot present the
      // lane is only as fresh as that snapshot, since most rows come from it.
      bstocks: {
        count: rwa.bstocks.length,
        staleness: rwa.staleness ?? "fresh",
        asOf: rwa.asOf,
        source: rwa.staleness === null ? "static" : "static+binance-rwa",
      },
      ondo: { count: rwa.ondo.length, staleness: rwa.staleness, asOf: rwa.asOf, source: "binance-rwa" },
      // Static like bStocks, so always fresh with no `asOf` — except when the
      // file could not be read, where a count of 0 with no staleness says the
      // lane has nothing rather than that it is empty.
      allowlist: {
        count: allowlist.length,
        staleness: allowlist.length === 0 ? null : "fresh",
        asOf: null,
        source: "static",
      },
    },
  };
}

/** Worst-first ordering, so a lane is only as fresh as its stalest contributor. */
const STALENESS_RANK: Record<Staleness, number> = { fresh: 0, stale: 1, dead: 2 };

/**
 * Folds several producers into one lane status.
 *
 * A contributor that has never written is skipped rather than counted as dead —
 * a lane served entirely by one launchpad is not stale because the other has yet
 * to run. Where both have written, the lane reports the worse staleness and the
 * older `asOf`, because that is the age of the weakest part of what it returned.
 */
function combineLane(
  count: number,
  contributors: { name: string; read: LaneRead }[],
): LaneStatus {
  const present = contributors.filter((c) => c.read.staleness !== null);
  const source = present.length === 0
    ? contributors.map((c) => c.name).join("+")
    : present.map((c) => c.name).join("+");

  let staleness: Staleness | null = null;
  let asOf: number | null = null;
  for (const { read } of present) {
    if (read.staleness !== null) {
      if (staleness === null || STALENESS_RANK[read.staleness] > STALENESS_RANK[staleness]) {
        staleness = read.staleness;
      }
    }
    if (read.asOf !== null) asOf = asOf === null ? read.asOf : Math.min(asOf, read.asOf);
  }

  return { count, staleness, asOf, source };
}

interface LaneRead {
  entries: UniverseEntry[];
  staleness: Staleness | null;
  asOf: number | null;
}

async function readLane(store: SnapshotStore, key: string, lane: Lane): Promise<LaneRead> {
  const record = await store.get<unknown>(key);
  if (record === null) return { entries: [], staleness: null, asOf: null };
  return {
    entries: normalizeEntries(record.data, lane),
    staleness: record.staleness,
    asOf: record.asOf,
  };
}

/**
 * Stored payloads are re-validated on read: the store is durable across code
 * versions, so a shape written by an older build must not reach the API.
 */
function normalizeEntries(data: unknown, lane: Lane): UniverseEntry[] {
  if (!Array.isArray(data)) return [];
  const entries: UniverseEntry[] = [];

  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const address = normalizeAddress(row["address"]);
    if (address === null) continue;
    const symbol = typeof row["symbol"] === "string" ? row["symbol"] : "";
    const name = typeof row["name"] === "string" && row["name"] !== "" ? row["name"] : undefined;
    const source = typeof row["source"] === "string" && row["source"] !== "" ? row["source"] : lane;

    entries.push({
      address,
      symbol,
      ...(name === undefined ? {} : { name }),
      lane,
      source,
    });
  }

  return entries;
}

interface RwaLanes {
  bstocks: UniverseEntry[];
  ondo: UniverseEntry[];
  staleness: Staleness | null;
  asOf: number | null;
}

/**
 * The two issuer lanes from one snapshot. The static bStocks list is the
 * floor: an API row with the same address overwrites it (gaining the RWA
 * fields), API-only bStocks are added, and with the snapshot missing or
 * unreadable the lane is exactly the static 25. Venues, when swept, are
 * attached to every RWA row.
 */
async function readRwaLanes(store: SnapshotStore): Promise<RwaLanes> {
  const record = await store.get<unknown>(RWA_UNIVERSE_KEY);
  const rows = record === null ? [] : normalizeRwaRows(record.data);
  const venues = await readVenues(store);

  const bstocks = new Map<string, UniverseEntry>();
  for (const entry of bstocksUniverse()) bstocks.set(entry.address, entry);
  const ondo: UniverseEntry[] = [];

  for (const row of rows) {
    const lane: Lane | null = row.platform === "bstock" ? "bstocks" : row.platform === "ondo" ? "ondo" : null;
    if (lane === null) continue;
    const entry: UniverseEntry = {
      address: row.address,
      symbol: row.symbol,
      ...(row.name === null ? {} : { name: row.name }),
      lane,
      source: "binance-rwa",
      // Kept on bStocks for the execution plane's benefit (see models.ts).
      ...(lane === "bstocks" ? { marketHours: "us-equities" as const } : {}),
      platform: row.platform,
      ...(row.underlyingTicker === null ? {} : { underlyingTicker: row.underlyingTicker }),
      tokenPriceUsd: row.tokenPriceUsd,
      referencePriceUsd: row.referencePriceUsd,
      premiumBps: venuePremiumBps(venues.get(row.address), row.referencePriceUsd, row.tokenToShareRatio),
      openState: row.openState,
      marketStatus: row.marketStatus,
      reasonCode: row.reasonCode,
      nextOpenMs: row.nextOpenMs,
      nextCloseMs: row.nextCloseMs,
      decimals: row.decimals,
      tokenToShareRatio: row.tokenToShareRatio,
      ...(record === null ? {} : { staleness: record.staleness }),
      ...(venues.has(row.address) ? { venues: venues.get(row.address)! } : {}),
    };
    if (lane === "bstocks") bstocks.set(entry.address, entry);
    else ondo.push(entry);
  }
  // Static rows that the snapshot did not cover still get venues when swept.
  for (const entry of bstocks.values()) {
    if (entry.venues === undefined && venues.has(entry.address)) entry.venues = venues.get(entry.address)!;
  }

  return {
    bstocks: [...bstocks.values()],
    ondo,
    staleness: record === null ? null : record.staleness,
    asOf: record === null ? null : record.asOf,
  };
}

/**
 * Re-validates the stored RWA rows on read: the store is durable across code
 * versions, so an older shape must not reach the API. Only the fields the
 * lane needs are checked; anything unparseable becomes `null`.
 */
function normalizeRwaRows(data: unknown): RwaToken[] {
  if (typeof data !== "object" || data === null) return [];
  const rows = (data as Record<string, unknown>)["rows"];
  if (!Array.isArray(rows)) return [];
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const out: RwaToken[] = [];
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const address = normalizeAddress(row["address"]);
    const symbol = str(row["symbol"]);
    const platform = str(row["platform"]);
    if (address === null || symbol === null || platform === null) continue;
    out.push({
      address,
      symbol,
      name: str(row["name"]),
      platform,
      underlyingTicker: str(row["underlyingTicker"]),
      underlyingName: str(row["underlyingName"]),
      decimals: num(row["decimals"]),
      tokenToShareRatio: num(row["tokenToShareRatio"]),
      tokenPriceUsd: num(row["tokenPriceUsd"]),
      referencePriceUsd: num(row["referencePriceUsd"]),
      navPremiumBps: num(row["navPremiumBps"]),
      underlyingMarketCapUsd: num(row["underlyingMarketCapUsd"]),
      underlyingVolume24hUsd: num(row["underlyingVolume24hUsd"]),
      openState: typeof row["openState"] === "boolean" ? row["openState"] : null,
      marketStatus: str(row["marketStatus"]),
      reasonCode: str(row["reasonCode"]),
      nextOpenMs: num(row["nextOpenMs"]),
      nextCloseMs: num(row["nextCloseMs"]),
    });
  }
  return out;
}

/** Per-token venues from the `stock-venues` snapshot, deepest first; empty when never swept. */
async function readVenues(store: SnapshotStore): Promise<Map<string, Venue[]>> {
  const record = await store.get<unknown>(RWA_VENUES_KEY);
  const out = new Map<string, Venue[]>();
  if (record === null || typeof record.data !== "object" || record.data === null) return out;
  const byAddress = (record.data as Record<string, unknown>)["byAddress"];
  if (typeof byAddress !== "object" || byAddress === null) return out;
  const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
  for (const [rawAddress, rawVenues] of Object.entries(byAddress as Record<string, unknown>)) {
    const address = normalizeAddress(rawAddress);
    if (address === null || !Array.isArray(rawVenues)) continue;
    const venues: Venue[] = [];
    for (const raw of rawVenues) {
      if (typeof raw !== "object" || raw === null) continue;
      const v = raw as Record<string, unknown>;
      const pool = normalizeAddress(v["pool"]);
      const quote = typeof v["quote"] === "object" && v["quote"] !== null ? (v["quote"] as Record<string, unknown>) : null;
      const quoteAddress = quote === null ? null : normalizeAddress(quote["address"]);
      if (pool === null || quote === null || quoteAddress === null) continue;
      const dex = v["dex"];
      const version = v["version"];
      if ((dex !== "pancakeswap" && dex !== "uniswap") || (version !== "v2" && version !== "v3")) continue;
      venues.push({
        dex,
        version,
        pool,
        feeTier: num(v["feeTier"]),
        quote: { address: quoteAddress, symbol: typeof quote["symbol"] === "string" ? quote["symbol"] : "" },
        priceUsd: num(v["priceUsd"]),
        liquidityUsd: num(v["liquidityUsd"]),
        volume24hUsd: num(v["volume24hUsd"]),
        asOf: num(v["asOf"]) ?? 0,
      });
    }
    venues.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
    out.set(address, venues);
  }
  return out;
}

/**
 * The pool-vs-reference premium: the deepest priced venue against the
 * underlying's price scaled by the share ratio. Binance's own `tokenPriceUsd`
 * is NAV and would always read ≈ 0 bps here, which is why the venue price is
 * the one that goes into this number. Exported for tests.
 */
export function venuePremiumBps(
  venues: Venue[] | undefined,
  referencePriceUsd: number | null,
  tokenToShareRatio: number | null,
): number | null {
  if (referencePriceUsd === null || !(referencePriceUsd > 0)) return null;
  const ratio = tokenToShareRatio === null || !(tokenToShareRatio > 0) ? 1 : tokenToShareRatio;
  const priced = (venues ?? []).find((v) => v.priceUsd !== null && v.priceUsd > 0);
  if (priced === undefined) return null;
  return Math.round((priced.priceUsd! / (referencePriceUsd * ratio) - 1) * 10_000);
}
