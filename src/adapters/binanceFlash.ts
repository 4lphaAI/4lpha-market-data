import { isRecord, normalizeAddress, type FetchFn } from "./http.js";
import { BINANCE_RWA_LIMITER, signedRequest } from "./binanceRwa.js";
import type { RateLimiter } from "./rateLimiter.js";
import {
  BINANCE_FLASH_ROUTER_SPENDER_ADDRESS,
  BINANCE_FLASH_USDT_ADDRESS,
  type BinanceFlashConfig,
} from "../config/binanceFlash.js";

export const BINANCE_FLASH_PATH = "/api/v1/dex/aggregator/quote-and-swap";
export const BINANCE_FLASH_TIMEOUT_MS = 5_000;
export const BINANCE_FLASH_LOCAL_VALIDITY_MS = 15_000;
export const BINANCE_FLASH_MAX_RESPONSE_BYTES = 256 * 1024;
export const BINANCE_FLASH_MAX_CALLDATA_BYTES = 64 * 1024;
/**
 * Longest a quote waits for the shared 5 rps key bucket. Measured quote latency
 * is p95 ~250 ms, so this leaves the 5 s deadline for the upstream itself.
 */
export const BINANCE_FLASH_BUDGET_WAIT_MS = 1_000;
/** Envelope code LiquidMesh answers, inside an HTTP 200, when no path exists. */
export const BINANCE_FLASH_NO_PATH_CODE = "40465";

const UINT256_MAX = (1n << 256n) - 1n;
const DECIMAL_UINT = /^(?:0|[1-9][0-9]*)$/u;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})+$/u;
export const BINANCE_FLASH_SELECTOR = "0xad43f73d";
const APPROVE_SELECTOR = "0x095ea7b3";

export interface BinanceFlashQuoteRequest {
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountAtomic: string;
  readonly slippageBps: number;
}

export interface BinanceFlashQuote {
  readonly version: "tradfi-binance-flash-v1";
  readonly chainId: 56;
  readonly taker: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountInAtomic: string;
  readonly quotedOutAtomic: string;
  readonly minOutAtomic: string;
  readonly router: string;
  readonly spender: string;
  readonly calldata: string;
  readonly value: "0";
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly estimatedGasUnits: string;
  readonly gasPriceWei: string;
  readonly feeAmountAtomic: string | null;
  readonly feeToken: string | null;
}

/** Raised when a successful provider response cannot satisfy the closed wire. */
export class BinanceFlashInvalidResponseError extends Error {
  constructor(readonly reason: string) {
    super(`binance flash response invalid: ${reason}`);
    this.name = "BinanceFlashInvalidResponseError";
  }
}

/** Raised when no slot in the shared key bucket frees up within the budget wait. */
export class BinanceFlashRateBudgetError extends Error {
  constructor() {
    super("binance flash rate budget exhausted");
    this.name = "BinanceFlashRateBudgetError";
  }
}

function invalid(reason: string): never {
  throw new BinanceFlashInvalidResponseError(reason);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${field}_shape`);
  return value;
}

function canonicalUint(value: unknown, field: string, positive = true): string {
  if (typeof value !== "string" || !DECIMAL_UINT.test(value)) invalid(`${field}_format`);
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX || (positive && parsed === 0n)) invalid(`${field}_range`);
  return value;
}

function canonicalAddress(value: unknown, field: string): string {
  const normalized = normalizeAddress(value);
  if (normalized === null || normalized === "0x0000000000000000000000000000000000000000") invalid(`${field}_format`);
  return normalized;
}

function canonicalCalldata(value: unknown): string {
  if (typeof value !== "string" || !HEX_BYTES.test(value)) invalid("calldata_format");
  const bytes = (value.length - 2) / 2;
  const normalized = value.toLowerCase();
  if (bytes < 4 || bytes > BINANCE_FLASH_MAX_CALLDATA_BYTES) invalid("calldata_size");
  if (!normalized.startsWith(BINANCE_FLASH_SELECTOR)) invalid("calldata_selector");
  return normalized;
}

function slippagePercent(slippageBps: number): string {
  const whole = Math.floor(slippageBps / 100);
  const fraction = String(slippageBps % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
}

interface ApprovalEvidence {
  readonly spender: string;
  readonly amount: string;
}

function decodeApproveCalldata(value: unknown): ApprovalEvidence | null {
  if (typeof value !== "string" || !HEX_BYTES.test(value)) return null;
  const normalized = value.toLowerCase();
  if (normalized.length !== 2 + 4 * 2 + 32 * 2 + 32 * 2 || !normalized.startsWith(APPROVE_SELECTOR)) return null;
  const spenderWord = normalized.slice(10, 74);
  if (!/^0{24}[0-9a-f]{40}$/u.test(spenderWord)) return null;
  const amountWord = normalized.slice(74);
  const amountAtomic = BigInt(`0x${amountWord}`);
  if (amountAtomic > UINT256_MAX) return null;
  return { spender: `0x${spenderWord.slice(24)}`, amount: amountAtomic.toString() };
}

function typedSignatureEvidence(value: unknown): ApprovalEvidence | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) return null;
  const direct = normalizeAddress(value);
  if (direct !== null) return { spender: direct, amount: "" };
  const directCalldata = decodeApproveCalldata(value);
  if (directCalldata !== null) return directCalldata;
  if (!value.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "approveContract" || keys[1] !== "approveTxCalldata") return null;
  const spender = normalizeAddress(parsed["approveContract"]);
  const approveEvidence = decodeApproveCalldata(parsed["approveTxCalldata"]);
  if (spender === null || approveEvidence === null || spender !== approveEvidence.spender) return null;
  return approveEvidence;
}

function signatureApproval(value: unknown, expectedAmount: string): string {
  if (!Array.isArray(value)) invalid("signature_data_shape");
  let spender: string | null = null;
  let amount: string | null = null;
  for (const entry of value) {
    const evidence = typedSignatureEvidence(entry);
    if (evidence === null) invalid("signature_data_entry");
    if (spender !== null && spender !== evidence.spender) invalid("spender_conflict");
    spender = evidence.spender;
    if (evidence.amount !== "") {
      if (amount !== null && amount !== evidence.amount) invalid("approve_amount_conflict");
      amount = evidence.amount;
    }
  }
  if (spender === null) invalid("spender_missing");
  if (amount === null) invalid("approve_amount_missing");
  if (amount !== expectedAmount) invalid("approve_amount_mismatch");
  return spender;
}

function reliableProviderExpiry(value: Record<string, unknown>): number | null {
  const raw = value["expiresAt"];
  const parsed = typeof raw === "number"
    ? raw
    : typeof raw === "string" && DECIMAL_UINT.test(raw)
      ? Number(raw)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1_000_000_000_000) return null;
  return parsed;
}

function nullableFeeAmount(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return canonicalUint(value, "fee_amount", false);
}

function validateRequest(request: BinanceFlashQuoteRequest): void {
  if (normalizeAddress(request.tokenIn) !== request.tokenIn || normalizeAddress(request.tokenOut) !== request.tokenOut) {
    invalid("request_token_format");
  }
  if (request.tokenIn === request.tokenOut) invalid("request_same_token");
  if ((request.tokenIn === BINANCE_FLASH_USDT_ADDRESS) === (request.tokenOut === BINANCE_FLASH_USDT_ADDRESS)) {
    invalid("request_settlement_pair");
  }
  canonicalUint(request.amountAtomic, "request_amount");
  if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 300) {
    invalid("request_slippage");
  }
}

/** Normalizes the provider's protocol-shaped `data` object into the closed wire. */
export function normalizeBinanceFlashResponse(
  data: unknown,
  request: BinanceFlashQuoteRequest,
  config: BinanceFlashConfig,
  requestStartedAt: number,
): BinanceFlashQuote {
  validateRequest(request);
  if (!Number.isSafeInteger(requestStartedAt) || requestStartedAt <= 0) invalid("request_started_at");
  if (config.router !== BINANCE_FLASH_ROUTER_SPENDER_ADDRESS || config.spender !== BINANCE_FLASH_ROUTER_SPENDER_ADDRESS) {
    invalid("guard_config_identity");
  }
  const root = record(data, "data");
  const routerResult = record(root["routerResult"], "router_result");
  const tx = record(root["tx"], "tx");

  if (routerResult["binanceChainId"] !== String(config.chainId)) invalid("chain_id");
  if (routerResult["vendorName"] !== config.vendor) invalid("vendor");

  const amountInAtomic = canonicalUint(routerResult["fromTokenAmount"], "amount_in");
  if (amountInAtomic !== request.amountAtomic) invalid("amount_mismatch");
  const quotedOutAtomic = canonicalUint(routerResult["toTokenAmount"], "quoted_out");

  const fromToken = record(routerResult["fromToken"], "from_token");
  const toToken = record(routerResult["toToken"], "to_token");
  const fromAddress = canonicalAddress(fromToken["tokenContractAddress"], "from_token");
  const toAddress = canonicalAddress(toToken["tokenContractAddress"], "to_token");
  if (fromAddress !== request.tokenIn || toAddress !== request.tokenOut) invalid("token_mismatch");

  if (canonicalAddress(tx["from"], "taker") !== config.taker) invalid("taker_mismatch");
  if (canonicalAddress(tx["to"], "router") !== config.router) invalid("router_mismatch");
  if (tx["value"] !== "0") invalid("native_value");
  const calldata = canonicalCalldata(tx["data"]);
  const spender = signatureApproval(tx["signatureData"], request.amountAtomic);
  if (spender !== config.spender) invalid("spender_mismatch");
  if (root["executionMode"] !== "SWAP" || (root["rfq"] !== null && root["rfq"] !== undefined)) invalid("execution_mode");

  const minOutAtomic = canonicalUint(tx["minReceiveAmount"], "min_out");
  if (BigInt(minOutAtomic) > BigInt(quotedOutAtomic)) invalid("min_out_above_quote");
  const minimumForSlippage = BigInt(quotedOutAtomic) * BigInt(10_000 - request.slippageBps) / 10_000n;
  if (BigInt(minOutAtomic) < minimumForSlippage) invalid("min_out_below_slippage_floor");
  const estimatedGasUnits = canonicalUint(tx["gas"], "gas_units");
  const gasPriceWei = canonicalUint(tx["gasPrice"], "gas_price");

  const feeAmountAtomic = nullableFeeAmount(routerResult["feeAmount"]);
  const feeTokenRaw = routerResult["feeToken"];
  const feeToken = feeTokenRaw === null || feeTokenRaw === undefined
    ? null
    : canonicalAddress(feeTokenRaw, "fee_token");
  if ((feeAmountAtomic === null) !== (feeToken === null)) invalid("fee_pair");
  if (feeToken !== null && feeToken !== request.tokenIn && feeToken !== request.tokenOut) invalid("fee_asset");

  const providerExpiry = reliableProviderExpiry(root);
  const expiresAt = Math.min(requestStartedAt + BINANCE_FLASH_LOCAL_VALIDITY_MS, providerExpiry ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(requestStartedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= requestStartedAt) {
    invalid("expiry");
  }

  return {
    version: "tradfi-binance-flash-v1",
    chainId: config.chainId,
    taker: config.taker,
    tokenIn: request.tokenIn,
    tokenOut: request.tokenOut,
    amountInAtomic,
    quotedOutAtomic,
    minOutAtomic,
    router: config.router,
    spender,
    calldata,
    value: "0",
    observedAt: requestStartedAt,
    expiresAt,
    estimatedGasUnits,
    gasPriceWei,
    feeAmountAtomic,
    feeToken,
  };
}

export interface FetchBinanceFlashOptions {
  readonly fetchFn?: FetchFn | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly requestStartedAt?: number | undefined;
  /** Test hook: the key bucket to draw from. */
  readonly limiter?: RateLimiter | undefined;
  /** Test hook: how long to wait for a slot before refusing. */
  readonly budgetWaitMs?: number | undefined;
}

/**
 * Waits for a slot in the shared 5 rps key bucket for at most `budgetWaitMs`,
 * then gives up with {@link BinanceFlashRateBudgetError}. Queueing for the whole
 * 5 s upstream deadline would turn a burst into timeouts that read as outages.
 */
async function acquireFlashSlot(limiter: RateLimiter, budgetWaitMs: number, signal: AbortSignal | undefined): Promise<void> {
  const budget = AbortSignal.timeout(budgetWaitMs);
  try {
    await limiter.acquire(signal === undefined ? budget : AbortSignal.any([signal, budget]));
  } catch (error) {
    if (signal?.aborted !== true && budget.aborted) throw new BinanceFlashRateBudgetError();
    throw error;
  }
}

const NO_WAIT_LIMITER: RateLimiter = { acquire: async () => undefined, available: () => Number.POSITIVE_INFINITY };

/** Performs one bounded, signed Flash quote/build request. */
export async function fetchBinanceFlashQuote(
  request: BinanceFlashQuoteRequest,
  config: BinanceFlashConfig,
  options: FetchBinanceFlashOptions = {},
): Promise<BinanceFlashQuote> {
  validateRequest(request);
  const requestStartedAt = options.requestStartedAt ?? Date.now();
  await acquireFlashSlot(
    options.limiter ?? BINANCE_RWA_LIMITER,
    options.budgetWaitMs ?? BINANCE_FLASH_BUDGET_WAIT_MS,
    options.signal,
  );
  const data = await signedRequest({
    method: "GET",
    path: BINANCE_FLASH_PATH,
    query: [
      ["binanceChainId", String(config.chainId)],
      ["amount", request.amountAtomic],
      ["fromTokenAddress", request.tokenIn],
      ["toTokenAddress", request.tokenOut],
      ["userWalletAddress", config.taker],
      ["vendor", config.vendor],
      ["slippagePercent", slippagePercent(request.slippageBps)],
      ["enableRFQ", "true"],
      ["approveTransaction", "true"],
      ["approveAmount", request.amountAtomic],
      ["autoSlippage", "false"],
    ],
    fetchFn: options.fetchFn,
    signal: options.signal,
    timeoutMs: BINANCE_FLASH_TIMEOUT_MS,
    maxResponseBytes: BINANCE_FLASH_MAX_RESPONSE_BYTES,
    retryOn429: false,
    // The slot was taken above; a single attempt needs no second token.
    limiter: NO_WAIT_LIMITER,
    redirect: "error",
  });
  return normalizeBinanceFlashResponse(data, request, config, requestStartedAt);
}

/** Converts the closed request's integer bps to the provider's percentage string. */
export { slippagePercent };
