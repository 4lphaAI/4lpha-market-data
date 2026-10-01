import { isRecord, normalizeAddress, MissingCredentialsError, type FetchFn } from "./http.js";
import { BINANCE_RWA_LIMITER, hasBinanceRwaCredentials, signedRequest } from "./binanceRwa.js";
import type { RateLimiter } from "./rateLimiter.js";

export const BINANCE_SIMULATE_PATH = "/api/v1/dex/pre-transaction/simulate"; // Step 0 measured path.
export const BINANCE_SIMULATE_TIMEOUT_MS = 1_500; // Leaves 500 ms for the limiter and hops.
export const BINANCE_SIMULATE_BUDGET_WAIT_MS = 250; // Four slots at 18 rps.
export const BINANCE_SIMULATE_MAX_RESPONSE_BYTES = 65_536; // Bounded change arrays.
export const BINANCE_SIMULATE_MAX_REQUEST_BYTES = 262_144; // Worst production batch plus JSON.
export const BINANCE_SIMULATE_MAX_DATA_HEX_CHARS = 196_610; // 96 KiB raw.
export const ERC7821_EXECUTE_SELECTOR = "0xe9ae5c53"; // execute(bytes32,bytes).
export const ERC7821_BATCH_MODE_WORD = `0100${"0".repeat(60)}`; // Step 0 batch mode.
export const BINANCE_SIMULATE_MAX_CHANGES = 64; // Bound each upstream array.

export type BinanceSimulateRequest = { readonly from: string; readonly to: string; readonly data: string };
export class BinanceSimulateInvalidResponseError extends Error {
  constructor(readonly reason: string) { super(`binance simulate response invalid: ${reason}`); }
}
export class BinanceSimulateRateBudgetError extends Error {}

export function readBinanceSimulateEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env["BINANCE_SIMULATE_ENABLED"];
  if (raw === undefined || raw === "false") return false;
  if (raw === "true") return true;
  throw new Error('BINANCE_SIMULATE_ENABLED must be exactly "true" or "false".');
}

export function parseBinanceSimulateRequest(value: unknown): BinanceSimulateRequest | string {
  if (!isRecord(value)) return "request_shape_invalid";
  const keys = Object.keys(value);
  if (keys.length !== 3 || !["from", "to", "data"].every(key => keys.includes(key))) return "request_shape_invalid";
  const from = normalizeAddress(value["from"]), to = normalizeAddress(value["to"]), data = value["data"];
  if (from === null || to === null || typeof data !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/u.test(data)) return "request_shape_invalid";
  if (from !== to) return "self_call_required";
  if (data.length > BINANCE_SIMULATE_MAX_DATA_HEX_CHARS) return "data_too_large";
  if (data.slice(0, 74).toLowerCase() !== ERC7821_EXECUTE_SELECTOR + ERC7821_BATCH_MODE_WORD) return "execute_batch_required";
  return { from, to, data: data.toLowerCase() };
}

export function normalizeBinanceSimulateResponse(data: unknown) {
  const invalid = (reason: string): never => { throw new BinanceSimulateInvalidResponseError(reason); };
  if (!isRecord(data) || (data["status"] !== "SUCCESS" && data["status"] !== "FAILED")) return invalid("status");
  const status = data["status"];
  const raw = data["failReason"];
  if (typeof raw !== "string" || raw.length > 2_048) return invalid("fail_reason");
  const changes = data["balanceChanges"];
  if (!Array.isArray(changes) || changes.length > BINANCE_SIMULATE_MAX_CHANGES) return invalid("balance_changes");
  const allowance = data["allowanceChanges"];
  if (allowance !== undefined && (!Array.isArray(allowance) || allowance.length > BINANCE_SIMULATE_MAX_CHANGES)) return invalid("allowance_changes");
  const balanceChanges: { token: string; owner: string; change: string }[] = [];
  let otherChangeCount = 0;
  for (const entry of changes) {
    if (!isRecord(entry)) return invalid("balance_change_entry");
    if (entry["tokenType"] !== "Erc20") { otherChangeCount += 1; continue; }
    const token = normalizeAddress(entry["contractAddress"]), owner = normalizeAddress(entry["owner"]), change = entry["change"];
    if (token === null || owner === null || typeof change !== "string" || !/^-?(0|[1-9][0-9]{0,77})$/u.test(change)
      || BigInt(change) <= -(1n << 256n) || BigInt(change) >= (1n << 256n)) return invalid("balance_change_entry");
    balanceChanges.push({ token, owner, change });
  }
  return { version: "binance-simulate-v1" as const, status, failReason: status === "SUCCESS" || raw === "" ? null : raw, balanceChanges, otherChangeCount };
}

export async function fetchBinanceSimulate(request: BinanceSimulateRequest, options: {
  readonly fetchFn?: FetchFn | undefined; readonly signal?: AbortSignal | undefined;
  readonly onDeadline?: (deadline: AbortSignal) => void; readonly limiter?: RateLimiter; readonly budgetWaitMs?: number;
  readonly onUpstreamMs?: (ms: number) => void;
}) {
  if (!hasBinanceRwaCredentials()) throw new MissingCredentialsError("binance-simulate");
  const budget = AbortSignal.timeout(options.budgetWaitMs ?? BINANCE_SIMULATE_BUDGET_WAIT_MS);
  try { await (options.limiter ?? BINANCE_RWA_LIMITER).acquire(options.signal === undefined ? budget : AbortSignal.any([options.signal, budget])); }
  catch (error) { if (!options.signal?.aborted && budget.aborted) throw new BinanceSimulateRateBudgetError(); throw error; }
  const deadline = AbortSignal.timeout(BINANCE_SIMULATE_TIMEOUT_MS);
  options.onDeadline?.(deadline);
  const start = performance.now();
  let data: unknown;
  try {
    data = await signedRequest({ method: "POST", path: BINANCE_SIMULATE_PATH,
      body: { binanceChainId: "56", evmTx: { from: request.from, to: request.to, value: "0", data: request.data } }, fetchFn: options.fetchFn,
      signal: options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]),
      timeoutMs: 2_000, maxResponseBytes: BINANCE_SIMULATE_MAX_RESPONSE_BYTES, retryOn429: false,
      limiter: { acquire: async () => undefined, available: () => Infinity }, redirect: "error" });
  } finally { options.onUpstreamMs?.(Math.round(performance.now() - start)); }
  return normalizeBinanceSimulateResponse(data);
}
