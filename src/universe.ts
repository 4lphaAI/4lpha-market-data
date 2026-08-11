/**
 * The three-lane token universe.
 *
 * `meme` and `coins` are discovered by background jobs and read back out of the
 * store; `bstocks` is a fixed, verified list of tokenized US equities that only
 * changes with a code change. Assembly is read-only: a lane whose job has never
 * run simply contributes nothing.
 */

import type { Lane, UniverseEntry } from "./core/models.js";
import type { SnapshotStore } from "./core/store.js";
import type { Staleness } from "./core/types.js";
import { normalizeAddress } from "./adapters/http.js";

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
  const bstocks = bstocksUniverse();

  const memeEntries = new Map<string, UniverseEntry>();
  for (const entry of [...fourmeme.entries, ...flap.entries]) memeEntries.set(entry.address, entry);

  const byAddress = new Map<string, UniverseEntry>();
  // Lowest precedence first, so later lanes overwrite earlier ones.
  for (const entry of [...memeEntries.values(), ...coins.entries, ...bstocks]) {
    byAddress.set(entry.address, entry);
  }

  const entries = [...byAddress.values()].sort((a, b) => a.address.localeCompare(b.address));

  return {
    entries,
    lanes: {
      meme: combineLane(memeEntries.size, [
        { name: "fourmeme", read: fourmeme },
        { name: "flap", read: flap },
      ]),
      coins: { count: coins.entries.length, staleness: coins.staleness, asOf: coins.asOf, source: "binance" },
      bstocks: { count: bstocks.length, staleness: "fresh", asOf: null, source: "static" },
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
