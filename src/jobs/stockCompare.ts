/**
 * `stock-compare` job: the same US stock quoted in both of its tokenized versions.
 *
 * For every ticker that has a bStock and an Ondo token in `universe:rwa`, at 100 / 1 000 / 5 000
 * USDT: one buy quote USDT -> token and, if it answered, one sell quote of exactly the quoted token
 * amount back to USDT, through the Binance Flash aggregator with `enableRFQ=true` (the route `baw`
 * swaps use). The taker is a constant unfunded address; nothing is signed, built or sent on chain.
 * Results are normalised to shares of the underlying and merged per ticker into one store key,
 * `stocks:compare`, read by `GET /trading/stock-compare`.
 *
 * Why not `fetchBinanceFlashQuote`: it returns the closed wire the live agents execute (no route
 * legs, taker bound to the guard config, approval and calldata evidence). This job needs the legs
 * for the route type and venue names, and has no guard. It uses the adapter's own signed request,
 * path, timeout, size cap and slippage format, and the same budget-wait idea.
 *
 * Budget, live agents first. The key's rate bucket (`BINANCE_RWA_LIMITER`) is shared with the live
 * agents' Flash proxy. A quote is sent only while the bucket holds at least
 * `STOCK_COMPARE_MIN_HEADROOM` free slots, at most `STOCK_COMPARE_RPS` a second; each send still
 * takes a slot from the shared bucket. The cycle gives up after 30 s without headroom and ends at
 * once on HTTP 429 or a rate-budget error. A ticker's row is replaced only when every one of its
 * quotes was attempted, so a cut-off cycle can never publish a one-sided comparison.
 */

import { randomUUID } from "node:crypto";
import type { RwaToken } from "../core/models.js";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import {
  BINANCE_FLASH_MAX_RESPONSE_BYTES,
  BINANCE_FLASH_NO_PATH_CODE,
  BINANCE_FLASH_PATH,
  BINANCE_FLASH_BUDGET_WAIT_MS,
  BINANCE_FLASH_TIMEOUT_MS,
  BinanceFlashRateBudgetError,
  slippagePercent,
} from "../adapters/binanceFlash.js";
import { BINANCE_RWA_LIMITER, readBinanceRwaRps, signedRequest } from "../adapters/binanceRwa.js";
import { AdapterError, isRecord, MissingCredentialsError, type FetchFn } from "../adapters/http.js";
import type { RateLimiter } from "../adapters/rateLimiter.js";
import { BINANCE_FLASH_USDT_ADDRESS, BINANCE_FLASH_VENDOR } from "../config/binanceFlash.js";
import { RWA_UNIVERSE_KEY } from "../universe.js";
import type { RwaUniverseSnapshot } from "./binanceRwa.js";
import {
  STOCK_COMPARE_FRESH_MS,
  STOCK_COMPARE_IMPLAUSIBLE_COST_BPS,
  STOCK_COMPARE_IMPLAUSIBLE_ROUND_TRIP_BPS,
  STOCK_COMPARE_KEY,
  STOCK_COMPARE_SIZES_USDT,
  STOCK_COMPARE_SOURCE,
  STOCK_COMPARE_STALE_MS,
  STOCK_COMPARE_TICKER_PATTERN,
  atomicToNumber,
  buildAnsweredSize,
  buildFailedSize,
  costBpsFor,
  roundTripBpsFor,
  sharesFor,
  cleanMarketStatus,
  isStockCompareAddress,
  isStockCompareSymbol,
  mergeStockCompareRows,
  normalizeStockCompare,
  type StockCompareCode,
  type StockCompareIssuer,
  type StockCompareRow,
  type StockCompareSize,
  type StockCompareVersion,
} from "../query/stockCompare.js";

export const STOCK_COMPARE_JOB = "stock-compare";
export const STOCK_COMPARE_INTERVAL_MS = 15 * 60_000;
export const STOCK_COMPARE_JITTER_MS = 30_000;
export const STOCK_COMPARE_TIMEOUT_MS = 12 * 60_000;
/** The cycle stops on its own a minute before the scheduler would abort it. */
export const STOCK_COMPARE_CYCLE_BUDGET_MS = 11 * 60_000;

/** Default headroom: 10 free slots of today's 18-slot bucket (operator ruling Q1), kept as a fraction. */
export const STOCK_COMPARE_DEFAULT_HEADROOM_RATIO = 10 / 18;
/** The compare job only runs against a shared bucket at least this big, and only when it is set explicitly. */
export const STOCK_COMPARE_MIN_BUCKET_RPS = 10;
/** Absolute floor on the free slots required before a send, whatever the ratio gives. */
export const STOCK_COMPARE_MIN_HEADROOM_FLOOR = 8;
/** Consecutive failed attempts (other than a plain no-route) that end the cycle. */
export const STOCK_COMPARE_MAX_CONSECUTIVE_FAILURES = 10;
/** One cycle at a time across processes (a deploy overlap): lease name and TTL (one interval). */
export const STOCK_COMPARE_LEASE = "stock-compare:cycle";
export const STOCK_COMPARE_LEASE_TTL_MS = 15 * 60_000;
/** The first cycle after boot waits a random time in this range (ms), so a deploy overlap never starts one at once. */
export const STOCK_COMPARE_BOOT_DELAY_MIN_MS = 2 * 60_000;
export const STOCK_COMPARE_BOOT_DELAY_MAX_MS = 5 * 60_000;
const UINT256_MAX = (1n << 256n) - 1n;
const PROCESS_HOLDER = randomUUID();
export const STOCK_COMPARE_DEFAULT_RPS = 2;
/** Re-check the shared bucket this often while it has too little headroom. */
export const STOCK_COMPARE_HEADROOM_RECHECK_MS = 1_000;
/** Give up the rest of the cycle after this long without headroom. */
export const STOCK_COMPARE_HEADROOM_GIVE_UP_MS = 30_000;

/** An unfunded address: the aggregator only needs somebody to quote for. */
export const STOCK_COMPARE_TAKER = "0x000000000000000000000000000000000000dead";
const STOCK_COMPARE_SLIPPAGE_BPS = 50;
const USDT_DECIMALS = 18;
const DECIMAL_UINT = /^[1-9][0-9]*$/u;

/** Raised when the shared bucket size is not explicitly configured, or too small for this job to be safe. */
export class StockCompareBudgetUnconfiguredError extends Error {
  constructor(reason: string) {
    super(`stock-compare budget unconfigured: ${reason}`);
    this.name = "StockCompareBudgetUnconfiguredError";
  }
}

export interface StockCompareConfig {
  /** Free slots the shared bucket must hold before a quote is sent: ceil(bucket x headroomRatio). */
  readonly minHeadroom: number;
  /** The fraction of the bucket that must be free. */
  readonly headroomRatio: number;
  /** Own pace ceiling, quotes per second. */
  readonly rps: number;
}

function readBoundedInt(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const raw = env[name];
  const text = raw === undefined ? String(fallback) : raw.trim();
  const value = /^[1-9][0-9]*$/u.test(text) ? Number(text) : Number.NaN;
  // The default is held to the same ceiling as an explicit value.
  if (!Number.isSafeInteger(value) || value > max) {
    throw new Error(`invalid ${name}: expected an integer from 1 to ${max} (the BINANCE_RWA_RPS bucket)`);
  }
  return value;
}

function readHeadroomRatio(env: NodeJS.ProcessEnv): number {
  const raw = env["STOCK_COMPARE_MIN_HEADROOM_RATIO"];
  if (raw === undefined) return STOCK_COMPARE_DEFAULT_HEADROOM_RATIO;
  const text = raw.trim();
  const ratio = /^(?:0\.[0-9]+|\.[0-9]+)$/u.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(ratio) || !(ratio > 0) || !(ratio < 1)) {
    throw new Error("invalid STOCK_COMPARE_MIN_HEADROOM_RATIO: expected a decimal strictly between 0 and 1");
  }
  return ratio;
}

/**
 * Fails closed. `BINANCE_RWA_RPS` (the shared bucket the live agents also draw from) must be set explicitly
 * and be at least 10; otherwise a missing Railway variable would silently shrink the bucket to its
 * default of 5 and this job would take a large share of it. Throws {@link StockCompareBudgetUnconfiguredError}.
 *
 * `STOCK_COMPARE_MIN_HEADROOM_RATIO` (default 10/18) is the fraction of the bucket that must be free before a
 * quote is sent: `max(ceil(bucket x ratio), 8)` free slots (10 at 18). `STOCK_COMPARE_RPS` is the own pace, an
 * integer capped by the bucket; unset it is 2. A malformed value throws rather than falling back, like
 * `readBinanceRwaRps`.
 */
export function readStockCompareConfig(env: NodeJS.ProcessEnv = process.env): StockCompareConfig {
  if (env["BINANCE_RWA_RPS"] === undefined) {
    throw new StockCompareBudgetUnconfiguredError("BINANCE_RWA_RPS is not set explicitly");
  }
  const bucket = readBinanceRwaRps(env);
  if (bucket < STOCK_COMPARE_MIN_BUCKET_RPS) {
    throw new StockCompareBudgetUnconfiguredError(`BINANCE_RWA_RPS=${bucket} is below ${STOCK_COMPARE_MIN_BUCKET_RPS}`);
  }
  const headroomRatio = readHeadroomRatio(env);
  // The epsilon keeps a float artefact (50 x 0.56 = 28.000000000000004) from rounding up one slot.
  const minHeadroom = Math.min(bucket, Math.max(STOCK_COMPARE_MIN_HEADROOM_FLOOR, Math.ceil(bucket * headroomRatio - 1e-9)));
  const rps = readBoundedInt(env, "STOCK_COMPARE_RPS", STOCK_COMPARE_DEFAULT_RPS, bucket);
  return { minHeadroom, headroomRatio, rps };
}

// ----------------------------------------------------------------- planning ----

export interface PlannedVersion {
  issuer: StockCompareIssuer;
  row: RwaToken;
}
export interface PlannedTicker {
  ticker: string;
  referencePriceUsd: number;
  versions: PlannedVersion[];
}

/**
 * Every ticker with a bStock row and an Ondo row (open or closed alike), bStock first. xStocks and
 * any other platform are left out, as are rows without a usable share ratio or reference price.
 */
export function planStockCompareTickers(rows: readonly RwaToken[]): PlannedTicker[] {
  const byTicker = new Map<string, Partial<Record<StockCompareIssuer, RwaToken>>>();
  for (const row of [...rows].sort((a, b) => (a.address < b.address ? -1 : 1))) {
    if (row.platform !== "bstock" && row.platform !== "ondo") continue;
    const ticker = row.underlyingTicker;
    if (ticker === null || !STOCK_COMPARE_TICKER_PATTERN.test(ticker)) continue;
    if (row.tokenToShareRatio === null || !Number.isFinite(row.tokenToShareRatio) || !(row.tokenToShareRatio > 0)) continue;
    if (!isStockCompareSymbol(row.symbol) || !isStockCompareAddress(row.address)) continue;
    const entry = byTicker.get(ticker) ?? {};
    entry[row.platform] ??= row;
    byTicker.set(ticker, entry);
  }
  const planned: PlannedTicker[] = [];
  for (const [ticker, entry] of byTicker) {
    const { bstock, ondo } = entry;
    if (bstock === undefined || ondo === undefined) continue;
    const reference = [bstock.referencePriceUsd, ondo.referencePriceUsd].find((p): p is number => p !== null && Number.isFinite(p) && p > 0);
    if (reference === undefined) continue;
    planned.push({
      ticker,
      referencePriceUsd: reference,
      versions: [{ issuer: "bstock", row: bstock }, { issuer: "ondo", row: ondo }],
    });
  }
  return planned.sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
}

// -------------------------------------------------------------------- quote ----

export interface StockCompareQuoteRequest {
  tokenIn: string;
  tokenOut: string;
  amountAtomic: string;
}
export interface StockCompareRawQuote {
  /** Decimal string, atomic units of `tokenOut`. */
  toTokenAmount: string;
  /** The answer's own `toToken.decimal`, when it carried a usable one. */
  decimals: number | null;
  /** Route leg names (`dexProtocol.dexName`) in the order the aggregator listed them. */
  legs: string[];
}
export type StockCompareQuoteFn = (request: StockCompareQuoteRequest, signal: AbortSignal) => Promise<StockCompareRawQuote>;

/** The shared bucket was already charged by the caller; the single attempt needs no second slot. */
const NO_WAIT_LIMITER: RateLimiter = { acquire: async () => undefined, available: () => Number.POSITIVE_INFINITY };

/** Reads only `routerResult.toTokenAmount`, `toToken.decimal` and `dexRouterList[].dexProtocol.dexName`. */
export function parseFlashRouterResult(data: unknown, request: StockCompareQuoteRequest): StockCompareRawQuote {
  if (!isRecord(data) || !isRecord(data["routerResult"])) throw new Error("unexpected quote shape");
  const result = data["routerResult"];
  const out = result["toTokenAmount"];
  if (typeof out !== "string" || !DECIMAL_UINT.test(out) || BigInt(out) > UINT256_MAX) throw new Error("unexpected quote amount");
  const from = result["fromTokenAmount"];
  if (from !== undefined && from !== request.amountAtomic) throw new Error("quote amount mismatch");
  const decimal = isRecord(result["toToken"]) ? Number(result["toToken"]["decimal"]) : Number.NaN;
  const legs: string[] = [];
  if (Array.isArray(result["dexRouterList"])) {
    for (const hop of result["dexRouterList"]) {
      const name = isRecord(hop) && isRecord(hop["dexProtocol"]) ? hop["dexProtocol"]["dexName"] : undefined;
      if (typeof name === "string") legs.push(name);
    }
  }
  return {
    toTokenAmount: out,
    decimals: Number.isInteger(decimal) && decimal >= 0 && decimal <= 36 ? decimal : null,
    legs,
  };
}

/** One signed Flash `quote-and-swap` GET with the query the adapter and the live `baw` route use. */
export function createFlashQuote(options: { fetchFn?: FetchFn | undefined } = {}): StockCompareQuoteFn {
  return async (request, signal) => {
    const data = await signedRequest({
      method: "GET",
      path: BINANCE_FLASH_PATH,
      query: [
        ["binanceChainId", "56"],
        ["amount", request.amountAtomic],
        ["fromTokenAddress", request.tokenIn],
        ["toTokenAddress", request.tokenOut],
        ["userWalletAddress", STOCK_COMPARE_TAKER],
        ["vendor", BINANCE_FLASH_VENDOR],
        ["slippagePercent", slippagePercent(STOCK_COMPARE_SLIPPAGE_BPS)],
        ["enableRFQ", "true"],
        ["approveTransaction", "true"],
        ["approveAmount", request.amountAtomic],
        ["autoSlippage", "false"],
      ],
      fetchFn: options.fetchFn,
      signal,
      timeoutMs: BINANCE_FLASH_TIMEOUT_MS,
      maxResponseBytes: BINANCE_FLASH_MAX_RESPONSE_BYTES,
      retryOn429: false,
      limiter: NO_WAIT_LIMITER,
      redirect: "error",
    });
    return parseFlashRouterResult(data, request);
  };
}

// -------------------------------------------------------------------- cycle ----

export type StockCompareEnd =
  | "complete"
  | "universe_not_fresh"
  | "no_headroom"
  | "rate_limited"
  | "rate_budget"
  | "auth_rejected"
  | "failure_brake"
  | "budget_unconfigured"
  | "lease_held"
  | "time_budget"
  | "aborted";

export interface StockCompareCycle {
  endedBy: StockCompareEnd;
  tickersPlanned: number;
  /** Tickers whose every quote was attempted and whose row was replaced. */
  tickersQuoted: number;
  quotesSent: number;
  headroomWaits: number;
  published: boolean;
}

export interface RunStockCompareOptions {
  quote?: StockCompareQuoteFn | undefined;
  fetchFn?: FetchFn | undefined;
  limiter?: RateLimiter | undefined;
  config?: StockCompareConfig | undefined;
  now?: (() => number) | undefined;
  /** Test hook: the environment the budget config is read from when `config` is not given. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Holder id for the cross-process lease. */
  holder?: string | undefined;
  /** Shortens the cycle's own time budget (the job passes what is left after its boot delay). */
  budgetMs?: number | undefined;
  /** Test hook. A fake must advance the injected `now`, or the give-up timer never fires. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

class CycleStop extends Error {
  constructor(readonly reason: Exclude<StockCompareEnd, "complete" | "universe_not_fresh" | "lease_held" | "budget_unconfigured">) {
    super(`stock-compare cycle stopped: ${reason}`);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs one cycle. Exported so tests and scripts can drive it directly. */
export async function runStockCompare(
  store: SnapshotStore,
  signal: AbortSignal,
  options: RunStockCompareOptions = {},
): Promise<StockCompareCycle> {
  let resolved = options.config;
  if (resolved === undefined) {
    try {
      resolved = readStockCompareConfig(options.env ?? process.env);
    } catch (error) {
      if (!(error instanceof StockCompareBudgetUnconfiguredError)) throw error;
      // Fail closed: nothing is sent, no lease taken, no store read. The job logs the one line.
      return { endedBy: "budget_unconfigured", tickersPlanned: 0, tickersQuoted: 0, quotesSent: 0, headroomWaits: 0, published: false };
    }
  }
  const config: StockCompareConfig = resolved;
  const limiter = options.limiter ?? BINANCE_RWA_LIMITER;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const quote = options.quote ?? createFlashQuote({ fetchFn: options.fetchFn });
  const spacingMs = Math.ceil(1000 / config.rps);

  const cycle: StockCompareCycle = {
    endedBy: "complete", tickersPlanned: 0, tickersQuoted: 0, quotesSent: 0, headroomWaits: 0, published: false,
  };

  // One cycle at a time across processes (a deploy overlap). The same holder renews its own lease.
  const holder = options.holder ?? PROCESS_HOLDER;
  if (!await store.acquireSchedulerLease(STOCK_COMPARE_LEASE, holder, STOCK_COMPARE_LEASE_TTL_MS)) {
    cycle.endedBy = "lease_held";
    return cycle;
  }

  const universe = await store.get<RwaUniverseSnapshot>(RWA_UNIVERSE_KEY);
  if (universe === null || universe.staleness !== "fresh" || !Array.isArray(universe.data?.rows)) {
    cycle.endedBy = "universe_not_fresh";
    return cycle;
  }
  const planned = planStockCompareTickers(universe.data.rows);
  cycle.tickersPlanned = planned.length;
  if (planned.length === 0) return cycle;

  const previous = normalizeStockCompare((await store.get<unknown>(STOCK_COMPARE_KEY))?.data).rows;
  // Least recently quoted first, so a cycle that gives up early still rotates through every ticker.
  planned.sort((a, b) => (previous[a.ticker]?.quotedAt ?? 0) - (previous[b.ticker]?.quotedAt ?? 0) || (a.ticker < b.ticker ? -1 : 1));

  const startedAt = now();
  const budgetMs = options.budgetMs ?? STOCK_COMPARE_CYCLE_BUDGET_MS;
  let lastSendAt: number | null = null;
  let consecutiveFailures = 0;

  /** Waits for own pace and for headroom in the shared bucket, then takes a slot from it. */
  async function gate(): Promise<void> {
    if (signal.aborted) throw new CycleStop("aborted");
    if (now() - startedAt > budgetMs) throw new CycleStop("time_budget");
    if (lastSendAt !== null) {
      const wait = spacingMs - (now() - lastSendAt);
      if (wait > 0) await sleep(wait);
    }
    const waitingSince = now();
    while (limiter.available() < config.minHeadroom) {
      if (signal.aborted) throw new CycleStop("aborted");
      if (now() - waitingSince >= STOCK_COMPARE_HEADROOM_GIVE_UP_MS) throw new CycleStop("no_headroom");
      cycle.headroomWaits++;
      await sleep(STOCK_COMPARE_HEADROOM_RECHECK_MS);
    }
    const budget = AbortSignal.timeout(BINANCE_FLASH_BUDGET_WAIT_MS);
    try {
      await limiter.acquire(AbortSignal.any([signal, budget]));
    } catch {
      throw new CycleStop(signal.aborted ? "aborted" : "rate_budget");
    }
    lastSendAt = now();
    cycle.quotesSent++;
  }

  /** A clean no-route answer, or a size whose buy and sell-back were both usable, resets the brake. */
  const good = (): void => { consecutiveFailures = 0; };
  /** A failed attempt or a rejected answer counts toward the brake. */
  const bad = (): void => {
    if (++consecutiveFailures >= STOCK_COMPARE_MAX_CONSECUTIVE_FAILURES) throw new CycleStop("failure_brake");
  };

  type Attempt = { ok: true; raw: StockCompareRawQuote } | { ok: false; noRoute: boolean };

  async function attempt(request: StockCompareQuoteRequest): Promise<Attempt> {
    await gate();
    try {
      return { ok: true, raw: await quote(request, signal) };
    } catch (error) {
      if (signal.aborted) throw new CycleStop("aborted");
      if (error instanceof BinanceFlashRateBudgetError) throw new CycleStop("rate_budget");
      if (error instanceof MissingCredentialsError) throw error;
      if (error instanceof AdapterError) {
        if (error.status === 429) throw new CycleStop("rate_limited");
        if (error.status === 401 || error.status === 403) throw new CycleStop("auth_rejected");
        if (error.upstreamCode === BINANCE_FLASH_NO_PATH_CODE) {
          consecutiveFailures = 0; // a clean "no path" answer: the upstream is working
          return { ok: false, noRoute: true };
        }
      }
      // In-band error codes and transport failures: a degraded upstream must not keep drawing from the bucket.
      bad();
      return { ok: false, noRoute: false };
    }
  }

  async function quoteSize(planned: PlannedTicker, version: PlannedVersion, usdt: number): Promise<StockCompareSize> {
    const tokenDecimals = version.row.decimals ?? 18;
    const amountAtomic = (BigInt(usdt) * 10n ** BigInt(USDT_DECIMALS)).toString();
    const buy = await attempt({ tokenIn: BINANCE_FLASH_USDT_ADDRESS, tokenOut: version.row.address, amountAtomic });
    if (!buy.ok) return buildFailedSize(usdt, buy.noRoute ? "no_route" : "quote_failed");

    // The answer's decimals must agree with the store's before either is trusted.
    if (buy.raw.decimals !== null && version.row.decimals !== null && buy.raw.decimals !== version.row.decimals) {
      bad();
      return buildFailedSize(usdt, "decimals_mismatch");
    }
    const tokensOut = atomicToNumber(buy.raw.toTokenAmount, buy.raw.decimals ?? tokenDecimals);
    const shares = sharesFor(tokensOut, version.row.tokenToShareRatio as number);
    if (!Number.isFinite(shares) || !(shares > 0) || costBpsFor(usdt, shares, planned.referencePriceUsd) < STOCK_COMPARE_IMPLAUSIBLE_COST_BPS) {
      return buildFailedSize(usdt, "implausible");
    }

    // Sell back exactly what was quoted, as the atomic string the answer carried. A sell-back that cannot be
    // trusted never discards the buy: the size stays ok with no round trip, which verdicts read as `no_exit`.
    const sell = await attempt({ tokenIn: version.row.address, tokenOut: BINANCE_FLASH_USDT_ADDRESS, amountAtomic: buy.raw.toTokenAmount });
    let usdtBack: number | null = null;
    let sellCode: StockCompareCode | null = sell.ok ? null : sell.noRoute ? "sell_no_route" : "sell_failed";
    if (sell.ok) {
      if (sell.raw.decimals !== null && sell.raw.decimals !== USDT_DECIMALS) {
        bad();
        sellCode = "decimals_mismatch";
      } else {
        usdtBack = atomicToNumber(sell.raw.toTokenAmount, sell.raw.decimals ?? USDT_DECIMALS);
        // Selling back more than 2 percent above what was spent cannot be right.
        if (roundTripBpsFor(usdt, usdtBack) < STOCK_COMPARE_IMPLAUSIBLE_ROUND_TRIP_BPS) {
          usdtBack = null;
          sellCode = "implausible";
        }
      }
    }
    // Only a size that came through clean (buy and sell-back both usable) resets the brake.
    if (sell.ok && sellCode === null) good();
    return buildAnsweredSize({
      usdt,
      tokensOut,
      ratio: version.row.tokenToShareRatio as number,
      referencePriceUsd: planned.referencePriceUsd,
      usdtBack,
      sellCode,
      legs: buy.raw.legs,
    });
  }

  const fresh: StockCompareRow[] = [];
  try {
    for (const ticker of planned) {
      const versions: StockCompareVersion[] = [];
      for (const version of ticker.versions) {
        const sizes: StockCompareSize[] = [];
        for (const usdt of STOCK_COMPARE_SIZES_USDT) sizes.push(await quoteSize(ticker, version, usdt));
        versions.push({
          issuer: version.issuer,
          symbol: version.row.symbol,
          address: version.row.address,
          ratio: version.row.tokenToShareRatio as number,
          openState: version.row.openState,
          marketStatus: cleanMarketStatus(version.row.marketStatus),
          sizes,
        });
      }
      // Reached only when every quote of this ticker was attempted.
      fresh.push({ ticker: ticker.ticker, quotedAt: now(), referencePriceUsd: ticker.referencePriceUsd, versions });
    }
  } catch (error) {
    if (!(error instanceof CycleStop)) throw error;
    cycle.endedBy = error.reason;
  } finally {
    cycle.tickersQuoted = fresh.length;
    // A run the scheduler timed out must not write late, and neither may one that lost its lease.
    const mayWrite = fresh.length > 0 && !signal.aborted
      && await store.acquireSchedulerLease(STOCK_COMPARE_LEASE, holder, STOCK_COMPARE_LEASE_TTL_MS);
    if (mayWrite) {
      await store.put(STOCK_COMPARE_KEY, { rows: mergeStockCompareRows(previous, fresh, now()) }, {
        source: STOCK_COMPARE_SOURCE,
        freshForMs: STOCK_COMPARE_FRESH_MS,
        deadAfterMs: STOCK_COMPARE_STALE_MS,
      });
      cycle.published = true;
    }
  }
  return cycle;
}

// --------------------------------------------------------------- registration ----

/** On only for the exact string `"true"`; anything else, including unset, is off. */
export function isStockCompareEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["STOCK_COMPARE_ENABLED"] === "true";
}

export interface StockCompareJobOptions {
  /** Test hook: the first cycle's wait. Default: random between 2 and 5 minutes. */
  bootDelayMs?: number | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => { signal.removeEventListener("abort", done); resolve(); }, ms);
    function done(): void { clearTimeout(timer); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function stockCompareJob(store: SnapshotStore, options: StockCompareJobOptions = {}): JobSpec {
  try {
    readStockCompareConfig();
  } catch (error) {
    // Each run re-reads the config and fails visibly in /status; say it once at boot too.
    console.error(`[${STOCK_COMPARE_JOB}] ${error instanceof Error ? error.message : "invalid configuration"}`);
  }
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? abortableSleep;
  const bootDelayMs = options.bootDelayMs
    ?? STOCK_COMPARE_BOOT_DELAY_MIN_MS + Math.floor(Math.random() * (STOCK_COMPARE_BOOT_DELAY_MAX_MS - STOCK_COMPARE_BOOT_DELAY_MIN_MS + 1));
  const createdAt = now();
  let first = true;
  return {
    name: STOCK_COMPARE_JOB,
    intervalMs: STOCK_COMPARE_INTERVAL_MS,
    jitterMs: STOCK_COMPARE_JITTER_MS,
    timeoutMs: STOCK_COMPARE_TIMEOUT_MS,
    run: async (signal) => {
      const startedAt = now();
      // The very first cycle after boot waits, so a deploy overlap never starts a ~580-quote cycle at once.
      // The wait counts against this run's scheduler timeout, so the cycle's own budget shrinks by it.
      if (first) {
        first = false;
        const wait = bootDelayMs - (startedAt - createdAt);
        if (wait > 0) await sleep(wait, signal);
        if (signal.aborted) return;
      }
      const waited = now() - startedAt;
      const result = await runStockCompare(store, signal, { budgetMs: Math.max(0, STOCK_COMPARE_CYCLE_BUDGET_MS - waited) });
      const hint = result.endedBy === "budget_unconfigured"
        ? ` (set BINANCE_RWA_RPS explicitly, at least ${STOCK_COMPARE_MIN_BUCKET_RPS}; nothing was sent)` : "";
      console.log(
        `[${STOCK_COMPARE_JOB}] ended=${result.endedBy}${hint} tickers=${result.tickersQuoted}/${result.tickersPlanned} ` +
        `quotes=${result.quotesSent} headroomWaits=${result.headroomWaits} ms=${now() - startedAt}`,
      );
    },
  };
}

/** The job when `STOCK_COMPARE_ENABLED=true`, else null: off means not registered. */
export function stockCompareJobIfEnabled(
  store: SnapshotStore,
  env: NodeJS.ProcessEnv = process.env,
  options: StockCompareJobOptions = {},
): JobSpec | null {
  return isStockCompareEnabled(env) ? stockCompareJob(store, options) : null;
}
