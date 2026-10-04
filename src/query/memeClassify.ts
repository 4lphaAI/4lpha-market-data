/**
 * Meme board classification — pure, so the decision table is testable offline.
 *
 * A meme is labelled twice. `stage` is where it is in the launchpad lifecycle
 * and comes straight from the launchpad's own state. `status` is whether the
 * chart is alive, and comes from windowed trade counts — the thing a 24h
 * leaderboard hides. Measured 2026-10-04: Four.Meme's HOT list ranked a token
 * first on $102k of 24h volume whose last hour had $22; of Meme Rush's 100
 * "Finalizing" tokens, 37 had not traded once in the last hour.
 *
 * Every threshold is in {@link MEME_RULES} and is published with the board, so
 * a label can be argued with. The raw numbers ride on every row too: a caller
 * who disagrees with `runner` can filter `txs5m` itself.
 */

import type { MemeLaunchpad, MemeRushRow } from "../adapters/binanceWeb3.js";
import type { SignalWalletType, SmartSignal, TokenActivity } from "../adapters/onchainos.js";
import type { QuoteInfo, QuoteKind } from "./quoteKind.js";

export type MemeStage = "new" | "bonding" | "graduating" | "graduated";
export type MemeStatus = "runner" | "active" | "quiet" | "fading" | "dead" | "unknown";
export type MemeFlag =
  | "clone"
  | "dev_sold_all"
  | "wash_trading"
  | "churn"
  | "sniper_heavy"
  | "bundler_heavy"
  | "top10_heavy"
  | "smart_money"
  | "kol"
  | "whale"
  | "smart_exit"
  | "bstock_quote";

export const MEME_STAGES: readonly MemeStage[] = ["new", "bonding", "graduating", "graduated"];
export const MEME_STATUSES: readonly MemeStatus[] = ["runner", "active", "quiet", "fading", "dead", "unknown"];
export const MEME_FLAGS: readonly MemeFlag[] = [
  "clone",
  "dev_sold_all",
  "wash_trading",
  "churn",
  "sniper_heavy",
  "bundler_heavy",
  "top10_heavy",
  "smart_money",
  "kol",
  "whale",
  "smart_exit",
  "bstock_quote",
];

/**
 * Thresholds, grounded in the 2026-10-04 distributions over 298 Meme Rush
 * tokens: `txs5m` p90 was 26 on Finalizing and 105 on Migrated, `txs1h` p90
 * 200 / 1,746. A runner is therefore roughly the top decile of the lists that
 * are trading at all.
 */
export const MEME_RULES = {
  /** Younger than this is `new` whatever its progress. */
  newMaxAgeMin: 30,
  /** Bonding-curve progress (0–100) at which a token is `graduating`. */
  graduatingMinProgress: 80,
  /** Grace period before "no trades" can mean dead: a token minutes old has not had time. */
  deadMinAgeMin: 30,
  /** A graduated token whose pool is shallower than this has been pulled. */
  deadMaxLiquidityUsd: 500,
  /** `fading` when the last hour carries less than this share of the last 4 hours' volume. */
  fadingMaxVolumeShare1h: 0.1,
  runnerMaxAgeHours: 24,
  runnerMinTxs5m: 20,
  runnerMinTxs1h: 100,
  runnerMinVolume1hUsd: 10_000,
  /**
   * Below either of these a chart that trades is `quiet`, not `active`.
   * Measured 2026-10-04: before this split, the median "active" token had $4 of
   * volume in its last hour — mostly launches whose only trade was the
   * creation buy (txs 1, liquidity $0.002).
   */
  activeMinTxs1h: 10,
  activeMinVolume1hUsd: 1_000,
  /**
   * 1h volume at or above this multiple of market cap is churn, not demand.
   * Measured 2026-10-04: SHEN traded $127k in an hour on a $5.3k cap (24x)
   * while real runners sat at 0.5–3x.
   */
  churnMinVolumeToMcap1h: 10,
  sniperHeavyPct: 30,
  bundlerHeavyPct: 20,
  top10HeavyPct: 50,
  /** A signal whose wallets have sold at least this share has exited. */
  smartExitSoldPct: 80,
  /** Signals older than this no longer count toward the row. */
  signalWindowHours: 24,
} as const;

export interface MemeSmartMoney {
  /** Tagged holders as Binance counts them. */
  holders: number | null;
  kolHolders: number | null;
  /** Signals inside the window, by wallet type. */
  signals: Record<SignalWalletType, number>;
  lastSignalAt: number | null;
  /** Largest `walletCount` on any signal in the window. */
  maxWallets: number | null;
  /** `soldRatioPct` of the newest signal. */
  lastSoldRatioPct: number | null;
}

export interface MemeBoardRow {
  address: string;
  symbol: string;
  name: string | null;
  launchpad: MemeLaunchpad;
  stage: MemeStage;
  status: MemeStatus;
  flags: MemeFlag[];
  createdAt: number;
  progress: number | null;
  migrated: boolean;
  migratedAt: number | null;
  /** `kind`/`symbol` are `null` until the quote contract could be read. */
  quote: { address: string | null; kind: QuoteKind | null; symbol: string | null };
  market: {
    priceUsd: number | null;
    marketCapUsd: number | null;
    liquidityUsd: number | null;
    holders: number | null;
  };
  /** Windowed activity from OnchainOS; `null` when OKX has not indexed the token yet. */
  activity: Omit<TokenActivity, "address"> | null;
  /** 24h trade split from Meme Rush — lifetime for a token under a day old. */
  trades24h: { count: number | null; buys: number | null; sells: number | null; netBuyUsd: number | null };
  holderMix: {
    top10Pct: number | null;
    devPct: number | null;
    sniperPct: number | null;
    insiderPct: number | null;
    bundlerPct: number | null;
    newWalletPct: number | null;
  };
  smartMoney: MemeSmartMoney;
  dev: { address: string | null; soldAll: boolean; migrateCount: number | null };
  /** Earliest token on the board with the same symbol, when this is not it. */
  cloneOf: string | null;
  socials: MemeRushRow["socials"];
  /**
   * Which sources carried it this cycle — `meme-rush:<stage>`, `okx-hot:<5m|1h>`
   * — empty when it is only being tracked after leaving every list.
   */
  listedOn: string[];
  /** The last hour's trade split from OKX's hot ranking, when it ranked there. */
  flow1h: { buys: number | null; sells: number | null; uniqueTraders: number | null; inflowUsd: number | null } | null;
  lastListedAt: number;
  firstSeenAt: number;
  /** When `status` first became `dead`; cleared when it trades again. */
  deadSince: number | null;
  classifiedAt: number;
}

export interface ClassifyInput {
  rush: MemeRushRow;
  activity: TokenActivity | null;
  signals: readonly SmartSignal[];
  quote: QuoteInfo | null;
  cloneOf: string | null;
  listedOn?: string[] | undefined;
  flow1h?: MemeBoardRow["flow1h"] | undefined;
  lastListedAt: number;
  firstSeenAt: number;
  previousDeadSince: number | null;
  now: number;
}

export function classifyStage(rush: MemeRushRow, now: number): MemeStage {
  if (rush.migrated) return "graduated";
  if (ageMinutes(rush.createdAt, now) < MEME_RULES.newMaxAgeMin) return "new";
  if (rush.progress !== null && rush.progress >= MEME_RULES.graduatingMinProgress) return "graduating";
  return "bonding";
}

/**
 * Whether the chart is alive. Order matters: dead, fading, runner, active, quiet —
 * so a token cannot be a runner on a stale 5-minute burst while its pool is gone,
 * and `active` means real trading rather than the creation buy alone.
 */
export function classifyStatus(
  rush: MemeRushRow,
  activity: TokenActivity | null,
  stage: MemeStage,
  now: number,
): MemeStatus {
  if (activity === null) return "unknown";
  const age = ageMinutes(rush.createdAt, now);
  const pastGrace = age >= MEME_RULES.deadMinAgeMin;

  if (pastGrace && activity.txs1h === 0) return "dead";
  if (
    stage === "graduated" &&
    activity.liquidityUsd !== null &&
    activity.liquidityUsd < MEME_RULES.deadMaxLiquidityUsd
  ) {
    return "dead";
  }

  if (pastGrace && activity.txs5m === 0) return "fading";
  const v1 = activity.volume1hUsd;
  const v4 = activity.volume4hUsd;
  if (pastGrace && v1 !== null && v4 !== null && v4 > 0 && v1 < v4 * MEME_RULES.fadingMaxVolumeShare1h) {
    return "fading";
  }

  if (
    age <= MEME_RULES.runnerMaxAgeHours * 60 &&
    (activity.txs5m ?? 0) >= MEME_RULES.runnerMinTxs5m &&
    (activity.txs1h ?? 0) >= MEME_RULES.runnerMinTxs1h &&
    (activity.volume1hUsd ?? 0) >= MEME_RULES.runnerMinVolume1hUsd &&
    (activity.priceChange1hPct ?? 0) > 0
  ) {
    return "runner";
  }
  if (
    (activity.txs1h ?? 0) >= MEME_RULES.activeMinTxs1h &&
    (activity.volume1hUsd ?? 0) >= MEME_RULES.activeMinVolume1hUsd
  ) {
    return "active";
  }
  return "quiet";
}

/** Signals for one token inside the window, newest first. */
export function summarizeSignals(signals: readonly SmartSignal[], now: number): MemeSmartMoney["signals"] & {
  lastSignalAt: number | null;
  maxWallets: number | null;
  lastSoldRatioPct: number | null;
} {
  const since = now - MEME_RULES.signalWindowHours * 3_600_000;
  const inWindow = signals.filter((signal) => signal.at >= since).sort((a, b) => b.at - a.at);
  const counts: Record<SignalWalletType, number> = { smart_money: 0, kol: 0, whale: 0 };
  for (const signal of inWindow) counts[signal.walletType] += 1;
  const newest = inWindow[0];
  return {
    ...counts,
    lastSignalAt: newest?.at ?? null,
    maxWallets: inWindow.length === 0 ? null : Math.max(...inWindow.map((signal) => signal.walletCount)),
    lastSoldRatioPct: newest?.soldRatioPct ?? null,
  };
}

export function classifyMeme(input: ClassifyInput): MemeBoardRow {
  const { rush, activity, now } = input;
  const stage = classifyStage(rush, now);
  const status = classifyStatus(rush, activity, stage, now);
  const summary = summarizeSignals(input.signals, now);
  const { lastSignalAt, maxWallets, lastSoldRatioPct, ...signalCounts } = summary;

  const flags: MemeFlag[] = [];
  if (input.cloneOf !== null) flags.push("clone");
  if (rush.devSoldAll) flags.push("dev_sold_all");
  if (rush.washTrading) flags.push("wash_trading");
  const mcap = activity?.marketCapUsd ?? rush.marketCapUsd;
  if (
    activity?.volume1hUsd !== null &&
    activity?.volume1hUsd !== undefined &&
    mcap !== null &&
    mcap > 0 &&
    activity.volume1hUsd >= mcap * MEME_RULES.churnMinVolumeToMcap1h
  ) {
    flags.push("churn");
  }
  if ((rush.sniperPct ?? 0) >= MEME_RULES.sniperHeavyPct) flags.push("sniper_heavy");
  if ((rush.bundlerPct ?? 0) >= MEME_RULES.bundlerHeavyPct) flags.push("bundler_heavy");
  if ((rush.top10Pct ?? 0) >= MEME_RULES.top10HeavyPct) flags.push("top10_heavy");
  if ((rush.smartMoneyHolders ?? 0) > 0 || signalCounts.smart_money > 0) flags.push("smart_money");
  if ((rush.kolHolders ?? 0) > 0 || signalCounts.kol > 0) flags.push("kol");
  if (signalCounts.whale > 0) flags.push("whale");
  if (lastSoldRatioPct !== null && lastSoldRatioPct >= MEME_RULES.smartExitSoldPct) flags.push("smart_exit");
  if (input.quote?.kind === "bstock") flags.push("bstock_quote");

  const { address: _address, ...activityFields } = activity ?? { address: "" };
  return {
    address: rush.address,
    symbol: rush.symbol,
    name: rush.name,
    launchpad: rush.launchpad,
    stage,
    status,
    flags,
    createdAt: rush.createdAt,
    progress: rush.migrated ? 100 : rush.progress,
    migrated: rush.migrated,
    migratedAt: rush.migratedAt,
    quote: { address: rush.quote, kind: input.quote?.kind ?? null, symbol: input.quote?.symbol ?? null },
    market: {
      priceUsd: activity?.priceUsd ?? rush.priceUsd,
      marketCapUsd: activity?.marketCapUsd ?? rush.marketCapUsd,
      liquidityUsd: activity?.liquidityUsd ?? rush.liquidityUsd,
      holders: rush.holders ?? activity?.holders ?? null,
    },
    activity: activity === null ? null : (activityFields as Omit<TokenActivity, "address">),
    trades24h: {
      count: rush.count24h,
      buys: rush.buys24h,
      sells: rush.sells24h,
      netBuyUsd: rush.netBuy24hUsd,
    },
    holderMix: {
      top10Pct: rush.top10Pct,
      devPct: rush.devPct,
      sniperPct: rush.sniperPct,
      insiderPct: rush.insiderPct,
      bundlerPct: rush.bundlerPct,
      newWalletPct: rush.newWalletPct,
    },
    smartMoney: {
      holders: rush.smartMoneyHolders,
      kolHolders: rush.kolHolders,
      signals: signalCounts,
      lastSignalAt,
      maxWallets,
      lastSoldRatioPct,
    },
    dev: { address: rush.devAddress, soldAll: rush.devSoldAll, migrateCount: rush.devMigrateCount },
    cloneOf: input.cloneOf,
    socials: rush.socials,
    listedOn: input.listedOn ?? [],
    flow1h: input.flow1h ?? null,
    lastListedAt: input.lastListedAt,
    firstSeenAt: input.firstSeenAt,
    deadSince: status === "dead" ? (input.previousDeadSince ?? now) : null,
    classifiedAt: now,
  };
}

/**
 * Marks copycats: among tokens sharing a symbol (case- and space-insensitive),
 * every one but the earliest created is a clone of it. Measured 2026-10-04: 147
 * of 298 Meme Rush tokens shared a symbol with another — launchers spray the
 * same name across quote tokens (LongFlap ×3 within a minute).
 */
export function findClones(rows: readonly Pick<MemeRushRow, "address" | "symbol" | "createdAt">[]): Map<string, string> {
  const earliest = new Map<string, { address: string; createdAt: number }>();
  for (const row of rows) {
    const key = normalizeSymbol(row.symbol);
    if (key === "") continue;
    const current = earliest.get(key);
    if (
      current === undefined ||
      row.createdAt < current.createdAt ||
      (row.createdAt === current.createdAt && row.address < current.address)
    ) {
      earliest.set(key, { address: row.address, createdAt: row.createdAt });
    }
  }
  const clones = new Map<string, string>();
  for (const row of rows) {
    const original = earliest.get(normalizeSymbol(row.symbol));
    if (original !== undefined && original.address !== row.address) clones.set(row.address, original.address);
  }
  return clones;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toLowerCase().replace(/\s+/g, "");
}

function ageMinutes(createdAt: number, now: number): number {
  return (now - createdAt) / 60_000;
}
