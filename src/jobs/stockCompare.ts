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
  STOCK_COMPARE_KEY,
  STOCK_COMPARE_SIZES_USDT,
  STOCK_COMPARE_SOURCE,
  STOCK_COMPARE_STALE_MS,
  STOCK_COMPARE_TICKER_PATTERN,
  atomicToNumber,
  buildAnsweredSize,
  buildFailedSize,
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

export const STOCK_COMPARE_DEFAULT_MIN_HEADROOM = 10;
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

export interface StockCompareConfig {
  /** Free slots the shared bucket must hold before a quote is sent. */
  readonly minHeadroom: number;
  /** Own pace ceiling, quotes per second. */
  readonly rps: number;
}

function readBoundedInt(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const raw = env[name];
  const text = raw === undefined ? String(fallback) : raw.trim();
  const value = /^[1-9][0-9]*$/u.test(text) ? Number(text) : Number.NaN;
  // The default is held to the same ceiling: a headroom above the shared bucket never passes.
  if (!Number.isSafeInteger(value) || value > max) {
    throw new Error(`invalid ${name}: expected an integer from 1 to ${max} (the BINANCE_RWA_RPS bucket)`);
  }
  return value;
}

/**
 * `STOCK_COMPARE_MIN_HEADROOM` (default 10) and `STOCK_COMPARE_RPS` (default 2): positive integers,
 * both capped by the shared bucket (`BINANCE_RWA_RPS`, 18 in production). A headroom above the bucket
 * could never be met and would idle every cycle, so it throws instead of clamping. A malformed value
 * throws rather than falling back, like `readBinanceRwaRps`.
 */
export function readStockCompareConfig(env: NodeJS.ProcessEnv = process.env): StockCompareConfig {
  const bucket = readBinanceRwaRps(env);
  const minHeadroom = readBoundedInt(env, "STOCK_COMPARE_MIN_HEADROOM", STOCK_COMPARE_DEFAULT_MIN_HEADROOM, bucket);
  const rps = readBoundedInt(env, "STOCK_COMPARE_RPS", STOCK_COMPARE_DEFAULT_RPS, bucket);
  return { minHeadroom, rps };
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
    if (row.tokenToShareRatio === null || !(row.tokenToShareRatio > 0)) continue;
    const entry = byTicker.get(ticker) ?? {};
    entry[row.platform] ??= row;
    byTicker.set(ticker, entry);
  }
  const planned: PlannedTicker[] = [];
  for (const [ticker, entry] of byTicker) {
    const { bstock, ondo } = entry;
    if (bstock === undefined || ondo === undefined) continue;
    const reference = [bstock.referencePriceUsd, ondo.referencePriceUsd].find((p): p is number => p !== null && p > 0);
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
  if (typeof out !== "string" || !DECIMAL_UINT.test(out)) throw new Error("unexpected quote amount");
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
  /** Test hook. A fake must advance the injected `now`, or the give-up timer never fires. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

class CycleStop extends Error {
  constructor(readonly reason: Exclude<StockCompareEnd, "complete" | "universe_not_fresh">) {
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
  const config = options.config ?? readStockCompareConfig();
  const limiter = options.limiter ?? BINANCE_RWA_LIMITER;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const quote = options.quote ?? createFlashQuote({ fetchFn: options.fetchFn });
  const spacingMs = Math.ceil(1000 / config.rps);

  const cycle: StockCompareCycle = {
    endedBy: "complete", tickersPlanned: 0, tickersQuoted: 0, quotesSent: 0, headroomWaits: 0, published: false,
  };

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
  let lastSendAt: number | null = null;

  /** Waits for own pace and for headroom in the shared bucket, then takes a slot from it. */
  async function gate(): Promise<void> {
    if (signal.aborted) throw new CycleStop("aborted");
    if (now() - startedAt > STOCK_COMPARE_CYCLE_BUDGET_MS) throw new CycleStop("time_budget");
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
        return { ok: false, noRoute: error.upstreamCode === BINANCE_FLASH_NO_PATH_CODE };
      }
      return { ok: false, noRoute: false };
    }
  }

  async function quoteSize(planned: PlannedTicker, version: PlannedVersion, usdt: number): Promise<StockCompareSize> {
    const tokenDecimals = version.row.decimals ?? 18;
    const amountAtomic = (BigInt(usdt) * 10n ** BigInt(USDT_DECIMALS)).toString();
    const buy = await attempt({ tokenIn: BINANCE_FLASH_USDT_ADDRESS, tokenOut: version.row.address, amountAtomic });
    if (!buy.ok) return buildFailedSize(usdt, buy.noRoute ? "no_route" : "quote_failed");

    // Sell back exactly what was quoted, as the atomic string the answer carried.
    const sell = await attempt({ tokenIn: version.row.address, tokenOut: BINANCE_FLASH_USDT_ADDRESS, amountAtomic: buy.raw.toTokenAmount });
    const sellCode: StockCompareCode | null = sell.ok ? null : sell.noRoute ? "sell_no_route" : "sell_failed";
    return buildAnsweredSize({
      usdt,
      tokensOut: atomicToNumber(buy.raw.toTokenAmount, buy.raw.decimals ?? tokenDecimals),
      ratio: version.row.tokenToShareRatio as number,
      referencePriceUsd: planned.referencePriceUsd,
      usdtBack: sell.ok ? atomicToNumber(sell.raw.toTokenAmount, sell.raw.decimals ?? USDT_DECIMALS) : null,
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
          marketStatus: version.row.marketStatus,
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
    if (fresh.length > 0) {
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

export function stockCompareJob(store: SnapshotStore): JobSpec {
  try {
    readStockCompareConfig();
  } catch (error) {
    // Each run re-reads the config and fails visibly in /status; say it once at boot too.
    console.error(`[${STOCK_COMPARE_JOB}] ${error instanceof Error ? error.message : "invalid configuration"}`);
  }
  return {
    name: STOCK_COMPARE_JOB,
    intervalMs: STOCK_COMPARE_INTERVAL_MS,
    jitterMs: STOCK_COMPARE_JITTER_MS,
    timeoutMs: STOCK_COMPARE_TIMEOUT_MS,
    run: async (signal) => {
      const startedAt = Date.now();
      const result = await runStockCompare(store, signal);
      console.log(
        `[${STOCK_COMPARE_JOB}] ended=${result.endedBy} tickers=${result.tickersQuoted}/${result.tickersPlanned} ` +
        `quotes=${result.quotesSent} headroomWaits=${result.headroomWaits} ms=${Date.now() - startedAt}`,
      );
    },
  };
}

/** The job when `STOCK_COMPARE_ENABLED=true`, else null: off means not registered. */
export function stockCompareJobIfEnabled(store: SnapshotStore, env: NodeJS.ProcessEnv = process.env): JobSpec | null {
  return isStockCompareEnabled(env) ? stockCompareJob(store) : null;
}
