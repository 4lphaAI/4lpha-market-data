/**
 * BSC JSON-RPC access, shared by every on-chain adapter.
 *
 * Public BSC endpoints fail in uncorrelated ways — one refuses `eth_call` under
 * load, another caps `eth_getLogs`, a paid one expires — so a read is never
 * pinned to a single URL. {@link withBscClient} runs the caller's whole read set
 * against one endpoint and, on failure, replays it against the next.
 *
 * Replaying is safe because every read here is a `view` call: there is nothing
 * to make idempotent. It is deliberately whole-callback rather than
 * per-request, which keeps a read set internally consistent instead of
 * half-answered by two chains at two block heights.
 *
 * Endpoint order is `BSC_RPC_URL`, then `BSC_RPC_URL1..3`, then a small set of
 * public defaults so the service is never dark when nothing is configured.
 * Endpoint URLs may embed an API key, so they are never logged.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  http,
  type HttpTransport,
  type PublicClient,
} from "viem";
import { bsc } from "viem/chains";
import { AdapterError, REQUEST_TIMEOUT_MS, requestSignal, sanitizeMessage } from "../adapters/http.js";

const SOURCE = "bsc-rpc";

/**
 * Keyless public endpoints, used only after the configured ones are exhausted.
 * They rate-limit and cap `eth_getLogs`, which is why they are last.
 */
const PUBLIC_RPC_URLS = [
  "https://bsc-dataseed.bnbchain.org",
  "https://bsc-dataseed1.defibit.io",
  "https://bsc-rpc.publicnode.com",
];

const RPC_ENV_KEYS = ["BSC_RPC_URL", "BSC_RPC_URL1", "BSC_RPC_URL2", "BSC_RPC_URL3"];

/**
 * The endpoint list, configured first and public last, deduplicated and with
 * blanks dropped. Read on every call so an operator can change the environment
 * without a restart.
 */
export function readRpcUrls(): string[] {
  const configured = RPC_ENV_KEYS.map((key) => process.env[key]?.trim()).filter(
    (value): value is string => value !== undefined && value !== "",
  );
  return [...new Set([...configured, ...PUBLIC_RPC_URLS])];
}

/**
 * A viem public client bound to one BSC endpoint. Written out rather than
 * inferred from the factory: viem's inferred client type transitively names
 * internal `_types` modules, which `tsc --declaration` cannot emit portably.
 */
export type BscClient = PublicClient<HttpTransport, typeof bsc>;

/**
 * Builds a client for one endpoint. `batch.multicall` lets viem fold the
 * `readContract` calls issued in the same tick into a single Multicall3 request,
 * which is what keeps a per-owner Venus read to a couple of round trips.
 */
function createBscClient(url: string, signal: AbortSignal): BscClient {
  return createPublicClient({
    chain: bsc,
    batch: { multicall: true },
    transport: http(url, {
      timeout: REQUEST_TIMEOUT_MS,
      // Rotation is the retry strategy; retrying a dead endpoint just burns the
      // caller's deadline before the next one gets a turn.
      retryCount: 0,
      fetchOptions: { signal },
    }),
  });
}

export interface WithBscClientOptions {
  signal?: AbortSignal | undefined;
  /** Overrides the environment endpoint list. Tests use this. */
  rpcUrls?: string[] | undefined;
}

/**
 * Runs `fn` against the first endpoint that answers.
 *
 * A caller abort stops the rotation immediately — burning through the remaining
 * endpoints after the deadline has passed would defeat the timeout. The thrown
 * {@link AdapterError} never names an endpoint.
 */
export async function withBscClient<T>(
  fn: (client: BscClient) => Promise<T>,
  options: WithBscClientOptions = {},
): Promise<T> {
  const urls = options.rpcUrls ?? readRpcUrls();
  if (urls.length === 0) throw new AdapterError(SOURCE, "no rpc endpoint configured");

  let lastMessage = "no rpc endpoint answered";
  for (const url of urls) {
    if (isAborted(options.signal)) break;
    const signal = requestSignal(options.signal);
    try {
      return await fn(createBscClient(url, signal));
    } catch (error) {
      lastMessage = sanitizeMessage(error);
      if (isAborted(options.signal)) break;
    }
  }

  throw new AdapterError(SOURCE, `all rpc endpoints failed: ${lastMessage}`);
}

/**
 * Read through a call rather than inline, because `aborted` flips underneath a
 * running loop and inline narrowing would freeze it at its first observed value.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * A revert is an answer; a dead endpoint is not.
 *
 * viem wraps both in `ContractFunctionExecutionError`, so the discriminator has
 * to walk the cause chain for the two specifically-contractual failures: an
 * explicit revert, and `0x` returned by a call to an address holding no code.
 * Anything else — timeout, 429, malformed JSON-RPC — is transport, and must
 * reach {@link withBscClient} so it rotates to the next endpoint.
 *
 * Callers depend on this split in opposite directions and both are unsafe to get
 * wrong: the eligibility gate turns a transport failure into a denial, and the
 * Flap universe job would otherwise prune a token from the lane because the RPC
 * hiccupped rather than because the token is gone.
 */
export function isContractLevelFailure(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return (
    error.walk((cause) => cause instanceof ContractFunctionRevertedError) !== null ||
    error.walk((cause) => cause instanceof ContractFunctionZeroDataError) !== null
  );
}
