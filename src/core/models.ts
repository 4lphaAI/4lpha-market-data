/**
 * Normalized market-data models.
 *
 * Every adapter converts its provider payload into these shapes before the value
 * reaches the store, the query layer or HTTP. Provider payloads are untrusted:
 * missing or unparseable fields become `null`, never `NaN` and never a guess.
 */

/** Which product surface a token belongs to. */
export type Lane = "meme" | "coins" | "bstocks";

/** A token that the data plane tracks, with the lane it was discovered in. */
export interface UniverseEntry {
  /** Contract address, always lowercased. */
  address: string;
  symbol: string;
  name?: string;
  lane: Lane;
  /** Adapter/job that produced the entry, e.g. `fourmeme` or `static`. */
  source: string;
  /** Set for tokenized equities, which only trade during US market hours. */
  marketHours?: "us-equities";
}

/**
 * Point-in-time market state for one token. Every numeric field is nullable so
 * a provider that simply does not carry the field is distinguishable from a
 * provider that reports a real zero.
 */
export interface TokenSnapshot {
  /** Contract address, always lowercased. */
  address: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  holders: number | null;
  priceChange24hPct: number | null;
  symbol?: string;
  /**
   * Names of the fields the most recent write actually populated. Reset on every
   * merge, so it describes that merge only — it is provenance for the last
   * write, not a cumulative history.
   */
  updatedFields: string[];
}

/** One OHLCV bar. `timestamp` is epoch milliseconds at the bar open. */
export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Mutable field names of {@link TokenSnapshot}, used for `updatedFields`. */
export type TokenSnapshotField =
  | "priceUsd"
  | "marketCapUsd"
  | "volume24hUsd"
  | "holders"
  | "priceChange24hPct"
  | "symbol";

/** An empty snapshot, useful as the base of a first merge. */
export function emptyTokenSnapshot(address: string): TokenSnapshot {
  return {
    address: address.toLowerCase(),
    priceUsd: null,
    marketCapUsd: null,
    volume24hUsd: null,
    holders: null,
    priceChange24hPct: null,
    updatedFields: [],
  };
}

/**
 * True when `incoming` carries real information for a field where zero cannot
 * occur naturally: a live token always has a positive price, market cap and
 * holder count, so a provider reporting `0` there is reporting "I don't know".
 */
function isMeaningfulPositive(incoming: number | null | undefined): incoming is number {
  return typeof incoming === "number" && Number.isFinite(incoming) && incoming > 0;
}

/**
 * True when `incoming` carries real information for a field where zero is a
 * legitimate observation (a token really can trade zero volume, or be flat).
 */
function isMeaningfulNumber(incoming: number | null | undefined): incoming is number {
  return typeof incoming === "number" && Number.isFinite(incoming);
}

/**
 * Conservative merge: a weaker provider must never erase what a stronger one
 * already established.
 *
 * The rule, per field:
 * - `priceUsd`, `marketCapUsd`, `holders` — overwritten only by a finite value
 *   greater than zero. `null`, `undefined`, `NaN` and `0` are all read as
 *   "provider has no data" because zero is implausible for a live token.
 * - `volume24hUsd`, `priceChange24hPct` — overwritten by any finite value,
 *   including `0`, which is a real and common observation for both.
 * - `symbol` — overwritten only by a non-empty trimmed string.
 * - `address` — never changes; the base address wins, and an empty base address
 *   is backfilled from the incoming one.
 *
 * `updatedFields` on the result lists exactly the fields this call wrote.
 */
export function mergeTokenSnapshot(
  base: TokenSnapshot,
  incoming: Partial<TokenSnapshot>,
): TokenSnapshot {
  const updated: TokenSnapshotField[] = [];
  const merged: TokenSnapshot = { ...base, updatedFields: [] };

  if (merged.address === "" && typeof incoming.address === "string") {
    merged.address = incoming.address.toLowerCase();
  }

  if (isMeaningfulPositive(incoming.priceUsd)) {
    merged.priceUsd = incoming.priceUsd;
    updated.push("priceUsd");
  }
  if (isMeaningfulPositive(incoming.marketCapUsd)) {
    merged.marketCapUsd = incoming.marketCapUsd;
    updated.push("marketCapUsd");
  }
  if (isMeaningfulPositive(incoming.holders)) {
    merged.holders = incoming.holders;
    updated.push("holders");
  }
  if (isMeaningfulNumber(incoming.volume24hUsd)) {
    merged.volume24hUsd = incoming.volume24hUsd;
    updated.push("volume24hUsd");
  }
  if (isMeaningfulNumber(incoming.priceChange24hPct)) {
    merged.priceChange24hPct = incoming.priceChange24hPct;
    updated.push("priceChange24hPct");
  }

  const symbol = incoming.symbol?.trim();
  if (symbol !== undefined && symbol !== "") {
    merged.symbol = symbol;
    updated.push("symbol");
  }

  merged.updatedFields = updated;
  return merged;
}
