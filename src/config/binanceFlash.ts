import { normalizeAddress } from "../adapters/http.js";

/** The only chain and vendor admitted by the TradFi Flash proxy. */
export const BINANCE_FLASH_CHAIN_ID = 56 as const;
export const BINANCE_FLASH_VENDOR = "LiquidMesh" as const;
export const BINANCE_FLASH_USDT_ADDRESS = "0x55d398326f99059ff775485246999027b3197955";
export const BINANCE_FLASH_ROUTER_SPENDER_ADDRESS = "0xb44446b0c8e56988c34f7ff73ae904982b5fdda5";

export type BinanceFlashEnv = Readonly<Record<string, string | undefined>>;

/**
 * Verified guard facts supplied at boot. The runtime code hash is required even
 * though this data plane does not read chain state: execution binds the same
 * identity before it can submit the returned bytes.
 */
export interface BinanceFlashConfig {
  readonly chainId: typeof BINANCE_FLASH_CHAIN_ID;
  readonly vendor: typeof BINANCE_FLASH_VENDOR;
  readonly taker: string;
  readonly router: string;
  readonly spender: string;
  readonly guardRuntimeCodeHash: string;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function value(env: BinanceFlashEnv, name: string): string {
  return env[name]?.trim() ?? "";
}

function address(valueToCheck: string): string | null {
  const normalized = normalizeAddress(valueToCheck);
  return normalized === null || normalized === ZERO_ADDRESS ? null : normalized;
}

function runtimeCodeHash(valueToCheck: string): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(valueToCheck)) return null;
  return valueToCheck.toLowerCase();
}

/**
 * Returns null when the operator has not supplied a complete verified guard
 * configuration. A partial or malformed configuration must keep this route
 * unavailable rather than selecting a different target.
 */
export function readBinanceFlashConfig(env: BinanceFlashEnv): BinanceFlashConfig | null {
  const taker = address(value(env, "TRADFI_BINANCE_GUARD_ADDRESS"));
  const router = address(value(env, "TRADFI_BINANCE_GUARD_ROUTER_ADDRESS"));
  const spender = address(value(env, "TRADFI_BINANCE_GUARD_SPENDER_ADDRESS"));
  const guardRuntimeCodeHash = runtimeCodeHash(value(env, "TRADFI_BINANCE_GUARD_RUNTIME_CODEHASH"));
  if (taker === null || router === null || spender === null || guardRuntimeCodeHash === null) return null;
  if (router !== BINANCE_FLASH_ROUTER_SPENDER_ADDRESS || spender !== BINANCE_FLASH_ROUTER_SPENDER_ADDRESS) return null;

  return Object.freeze({
    chainId: BINANCE_FLASH_CHAIN_ID,
    vendor: BINANCE_FLASH_VENDOR,
    taker,
    router,
    spender,
    guardRuntimeCodeHash,
  });
}
