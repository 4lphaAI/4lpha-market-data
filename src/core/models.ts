/**
 * Normalized market-data models.
 *
 * Every adapter converts its provider payload into these shapes before the value
 * reaches the store, the query layer or HTTP. Provider payloads are untrusted:
 * missing or unparseable fields become `null`, never `NaN` and never a guess.
 */

/**
 * Which product surface a token belongs to. `allowlist` is the frozen
 * `data/eligible-tokens.json` snapshot, enumerable over `/universe`
 * (ALLOWLIST-PRICE-SPEC §2b item 5).
 */
export type Lane = "meme" | "coins" | "bstocks" | "allowlist";

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

/**
 * Verdict of a token security scan.
 *
 * `unavailable` is a first-class result, not an error: a scanner that has never
 * seen the token, or that is down, says "I don't know" and the caller decides
 * what to do with that. It is deliberately the *weakest* level, so it can never
 * mask a real verdict from another scanner.
 */
export type RiskLevel = "ok" | "warn" | "danger" | "unavailable";

/** Severity ordering used when several scanners disagree. Higher is worse. */
const RISK_RANK: Record<RiskLevel, number> = {
  unavailable: 0,
  ok: 1,
  warn: 2,
  danger: 3,
};

/**
 * Conservative combination of two verdicts: the worse one wins, and a scanner
 * with no opinion never drags a real verdict down to `unavailable`.
 */
export function worstRiskLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

/** Normalized security scan for one token, from one scanner or several merged. */
export interface TokenSecuritySummary {
  riskLevel: RiskLevel;
  /** Stable snake_case flag names, deduplicated and sorted. */
  flags: string[];
  /** Epoch milliseconds at which the scan was performed. */
  scannedAt: number;
  /** Scanner that produced it, e.g. `onchainos` or `onchainos+gmgn`. */
  source: string;
}

/** Holder distribution for one token. Every field is nullable and independent. */
export interface HolderStats {
  /** Total holder count. */
  holders: number | null;
  /** Share of supply held by the top 10 holders, as a percentage 0..100. */
  top10Pct: number | null;
  /** Number of "smart money" wallets currently holding. */
  smartMoneyCount: number | null;
  /** Epoch milliseconds at which the stats were captured. */
  asOf: number;
  source: string;
}

/** An empty, nothing-known holder read. */
export function emptyHolderStats(source: string, asOf: number): HolderStats {
  return { holders: null, top10Pct: null, smartMoneyCount: null, asOf, source };
}

/**
 * Field-wise merge of two holder reads: a `null` never overwrites a known value,
 * so a smart-money-only read can be layered onto a count-only read.
 */
export function mergeHolderStats(base: HolderStats, incoming: HolderStats): HolderStats {
  return {
    holders: incoming.holders ?? base.holders,
    top10Pct: incoming.top10Pct ?? base.top10Pct,
    smartMoneyCount: incoming.smartMoneyCount ?? base.smartMoneyCount,
    asOf: Math.max(base.asOf, incoming.asOf),
    source: base.source === incoming.source ? base.source : `${base.source}+${incoming.source}`,
  };
}

/**
 * Which APR components a record actually carries.
 *
 * Reported alongside the numbers so a consumer can tell "this pool earns no
 * CAKE" from "nobody asked the farm contract" — the two produce the same
 * `combinedApr` shape but mean opposite things.
 */
export type AprSource = "lpFee" | "cakeFarm";

/**
 * How much is known about the two tokens a pool is made of.
 *
 * A label, never a filter: the plane classifies and reports, and the caller
 * decides what to do with the classification. `unclassified` is the honest
 * default for a pool nothing has been established about yet.
 */
export type PoolTier = "core" | "degen" | "unclassified";

/**
 * Where one of a pool's tokens came from, and the evidence {@link PoolTier} is
 * derived from. `unknown` means this plane holds nothing about the token — not
 * that anything is wrong with it.
 */
export type TokenOrigin = "fourmeme" | "flap" | "allowlist" | "alpha" | "pancake-list" | "unknown";

/** The provenance of both sides of a pool. */
export interface PoolTokenOrigins {
  token0: TokenOrigin;
  token1: TokenOrigin;
}

/** A pool's MasterChefV3 farm slot. `allocPoint` 0 is registered but unfunded. */
export interface PoolFarm {
  /** MasterChefV3 pool id. Assigned once and never reassigned. */
  pid: number;
  /** Share of CAKE emissions, set by veCAKE gauge voting. */
  allocPoint: number;
  /** CAKE emitted to this pool over a year at the current rate. */
  cakePerYear: number;
}

/**
 * State of one PancakeSwap V3 pool.
 *
 * Three groups of fields, with different failure modes:
 *
 * - Identity (`pool` … `fee`) is always present; a record without it is not
 *   built at all.
 * - Chain state (`liquidity`, `sqrtPriceX96`, `tick`) comes from the pool
 *   contract or the per-pool explorer read. The list endpoint does not carry it,
 *   so a record discovered through the lane leaves all three `null`.
 * - USD and APR fields come from PancakeSwap's aggregation API and the farm
 *   contract. They are never re-derived locally — see {@link PoolStats.lpFeeApr24h}.
 */
export interface PoolStats {
  /** Pool contract address, lowercased. */
  pool: string;
  /** Only V3 is served. The field exists so an Infinity lane is additive. */
  protocol: "v3";
  /** token0 contract address, lowercased. */
  token0: string;
  /** token1 contract address, lowercased. */
  token1: string;
  token0Symbol: string | null;
  token1Symbol: string | null;
  /** Fee tier in hundredths of a basis point, e.g. `2500` for 0.25%. */
  fee: number;
  /** In-range liquidity, as a decimal string because it exceeds `Number`. */
  liquidity: string | null;
  /** Q64.96 price, as a decimal string for the same reason. */
  sqrtPriceX96: string | null;
  tick: number | null;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  /**
   * Trading-fee APR over 24h, as a percentage, net of the protocol fee cut.
   *
   * This is PancakeSwap's own `apr24h`, converted from a fraction to a percent
   * and never recomputed from `feeUSD24h`: that field is gross of the ~33%
   * protocol fee, so deriving from it overstates what an LP receives by about
   * 1.5x and would not match the number PancakeSwap's own UI shows.
   */
  lpFeeApr24h: number | null;
  /** The same measure over 7 days. Steadier, and the honest tiebreak. */
  lpFeeApr7d: number | null;
  /** CAKE emissions APR, percent. `0` means not farmed; `null` means unasked. */
  cakeFarmApr: number | null;
  /**
   * `lpFeeApr24h + cakeFarmApr` — the APR column of PancakeSwap's pool list.
   * `null` unless both components are known, because a sum missing a term reads
   * as a smaller pool yield rather than as a gap.
   */
  combinedApr: number | null;
  aprSources: AprSource[];
  farm: PoolFarm | null;
  tier: PoolTier;
  /** The evidence behind `tier`, carried so a label can be argued with. */
  tokenOrigin: PoolTokenOrigins;
  /**
   * Epoch milliseconds at which *this pool* was read.
   *
   * Distinct from the age of the lane snapshot holding it: a cycle that only
   * managed part of its paging republishes the lane with fresh rows alongside
   * rows carried over from before, and each one keeps saying when it was read.
   */
  asOf: number;
  source: string;
}

/** Health banding of a Venus borrow position. */
export type VenusTier = "HEALTHY" | "WARNING" | "DANGER" | "LIQUIDATABLE";

/** One market an owner is active in, valued in USD. */
export interface VenusAssetPosition {
  /** vToken symbol, e.g. `vUSDT`. */
  symbol: string;
  supplyUsd: number;
  borrowUsd: number;
}

/** An owner's whole Venus Core Pool position. */
export interface VenusHealth {
  /** Owner address, lowercased. */
  owner: string;
  /** Collateral-weighted collateral over borrows. `null` when nothing is borrowed. */
  healthFactor: number | null;
  tier: VenusTier;
  /** Collateral value already multiplied by each market's collateral factor. */
  collateralValueUsd: number;
  borrowValueUsd: number;
  assets: VenusAssetPosition[];
  /** Epoch milliseconds at which the chain was read. */
  asOf: number;
}
