/**
 * Flap launchpad adapter (BSC only).
 *
 * Flap launches tokens continuously — measured at roughly 40k/day — so, like
 * Four.Meme, its universe can never be a snapshot. It is discovered instead by
 * reading `TokenCreated` off the Portal and asking the Portal's own lens which
 * of those tokens is still worth showing.
 *
 * Flap is deployed on several chains; only the BSC Portal is wired in here,
 * because `getTokenV8Safe` exists on BNB mainnet/testnet alone (other chains cap
 * out at `getTokenV7`) and BSC is the only chain this plane serves.
 *
 * Two measured facts shape the log path, both learned the hard way on
 * 2026-08-11:
 *
 *  1. **The `topics` filter cannot be trusted.** `bsc-rpc.publicnode.com` — the
 *     only public endpoint currently serving `eth_getLogs` at all — returns the
 *     identical 157 logs whether or not a topic filter is passed, other events
 *     included. So the filter is still sent (a server that honours it saves ~30x
 *     of payload, since only 11 of 338 Portal logs in a window are launches) but
 *     the match is *always* redone locally. Trusting the server's filter would
 *     hand `decodeEventLog` the wrong events.
 *  2. **Endpoints disagree about `eth_getLogs` entirely.** `bsc-dataseed*`
 *     refuses any range outright, `publicnode` refuses historical ranges, and
 *     `drpc` answers then rate-limits. {@link withBscClient} is applied per
 *     chunk rather than per scan so one refusing endpoint costs one chunk, not
 *     the whole cycle.
 */

import { decodeEventLog, keccak256, numberToHex, toHex, type Abi } from "viem";
import { isContractLevelFailure, type BscClient, withBscClient } from "../chain/rpc.js";
import { AdapterError, isEvmAddress, sanitizeMessage } from "./http.js";

const SOURCE = "flap";

/**
 * Flap's Portal on BSC (v5.14.16). There is no separate lens contract: the
 * `IPortalLens` view functions live on the Portal proxy itself.
 */
export const FLAP_PORTAL = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0" as const;

/**
 * `TokenStatus` values that mean the token can actually be traded: on its
 * bonding curve, or graduated onto a pool. The enum also carries `Invalid` (0),
 * the obsolete `InDuel` (2) and `Killed` (3), and `Staged` (5) for a token whose
 * address is determined but which has not been deployed yet.
 */
export const FLAP_STATUS_TRADABLE = 1;
export const FLAP_STATUS_DEX = 4;

/**
 * Measured, not read off the docs: nothing in `TokenCreated` is indexed. A live
 * log carries exactly one topic and all seven arguments in `data`, so the
 * address, name and symbol all come out of the payload.
 */
const tokenCreatedAbi = [
  {
    name: "TokenCreated",
    type: "event",
    inputs: [
      { name: "ts", type: "uint256" },
      { name: "creator", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "token", type: "address" },
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "meta", type: "string" },
    ],
  },
] as const satisfies Abi;

/** `keccak256` of the event signature — the only reliable way to spot a launch. */
export const TOKEN_CREATED_TOPIC = keccak256(
  toHex("TokenCreated(uint256,address,uint256,address,string,string,string)"),
);

/**
 * `getTokenV8Safe` rather than `getTokenV8`: it returns the four enum-typed
 * fields as `uint8`, so a future Flap release that adds an enum variant widens a
 * number here instead of failing to decode. Declared as the full 18-field tuple
 * because viem decodes positionally.
 */
export const flapPortalAbi = [
  {
    name: "getTokenV8Safe",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "status", type: "uint8" },
          { name: "reserve", type: "uint256" },
          { name: "circulatingSupply", type: "uint256" },
          { name: "price", type: "uint256" },
          { name: "tokenVersion", type: "uint8" },
          { name: "r", type: "uint256" },
          { name: "h", type: "uint256" },
          { name: "k", type: "uint256" },
          { name: "dexSupplyThresh", type: "uint256" },
          { name: "quoteTokenAddress", type: "address" },
          { name: "nativeToQuoteSwapEnabled", type: "bool" },
          { name: "extensionID", type: "bytes32" },
          { name: "buyTaxRate", type: "uint256" },
          { name: "sellTaxRate", type: "uint256" },
          { name: "pool", type: "address" },
          { name: "progress", type: "uint256" },
          { name: "lpFeeProfile", type: "uint8" },
          { name: "dexId", type: "uint8" },
        ],
      },
    ],
  },
] as const satisfies Abi;

/** One decoded `TokenCreated` event. */
export interface FlapLaunch {
  /** Token contract address, lowercased. */
  address: string;
  symbol: string;
  name: string;
  /** Creator address, lowercased. */
  creator: string;
  /** IPFS CID of the metadata JSON. Empty when the launcher supplied none. */
  meta: string;
  /** Epoch milliseconds, from the event's own `ts` field. */
  launchedAt: number;
}

export interface FlapLaunchScan {
  launches: FlapLaunch[];
  fromBlock: number;
  toBlock: number;
  /**
   * Chunks no endpoint would serve. A scan with misses is partial, not wrong —
   * the caller merges into a rolling set, so a missed chunk costs freshness at
   * the tail rather than emptying the lane.
   */
  missedChunks: number;
}

/**
 * Blocks per `eth_getLogs` call. 50 is what the surviving public endpoints
 * accept; larger ranges come back as `LimitExceededRpcError`.
 */
const CHUNK_BLOCKS = 50n;

export interface FetchFlapLaunchesOptions {
  /** How far back to scan. Default covers a little over one job interval. */
  blocks?: number;
  signal?: AbortSignal | undefined;
}

/**
 * Scans recent Portal logs for launches, newest block last.
 *
 * Throws only when *every* chunk failed, which is the case that means "the chain
 * could not be read" rather than "there were no launches".
 */
export async function fetchFlapLaunches(
  options: FetchFlapLaunchesOptions = {},
): Promise<FlapLaunchScan> {
  const blocks = BigInt(options.blocks ?? 150);
  const signal = options.signal;
  const clientOptions = signal === undefined ? {} : { signal };

  const head = await withBscClient((client) => client.getBlockNumber(), clientOptions);
  const from = head > blocks ? head - blocks + 1n : 0n;

  const byAddress = new Map<string, FlapLaunch>();
  let missedChunks = 0;
  let chunks = 0;

  for (let start = from; start <= head; start += CHUNK_BLOCKS) {
    const end = start + CHUNK_BLOCKS - 1n > head ? head : start + CHUNK_BLOCKS - 1n;
    chunks += 1;
    try {
      // Raw `eth_getLogs` rather than viem's typed `getLogs`, because the typed
      // one takes an `event` and does the decoding itself. Doing it by hand
      // keeps the topic re-check explicit and testable — which matters when the
      // server's own filter cannot be trusted.
      const logs = await withBscClient(
        (client: BscClient) =>
          client.request({
            method: "eth_getLogs",
            params: [
              {
                address: FLAP_PORTAL,
                fromBlock: numberToHex(start),
                toBlock: numberToHex(end),
                // Sent as an optimisation only; see the header note. Every log
                // is re-checked against TOKEN_CREATED_TOPIC below regardless.
                topics: [TOKEN_CREATED_TOPIC],
              },
            ],
          }),
        clientOptions,
      );
      for (const launch of decodeLaunches(logs)) byAddress.set(launch.address, launch);
    } catch {
      missedChunks += 1;
    }
  }

  if (chunks > 0 && missedChunks === chunks) {
    throw new AdapterError(SOURCE, "no rpc endpoint served eth_getLogs");
  }

  return {
    launches: [...byAddress.values()].sort((a, b) => a.launchedAt - b.launchedAt),
    fromBlock: Number(from),
    toBlock: Number(head),
    missedChunks,
  };
}

/** Log payloads are untrusted: anything that will not decode is skipped, not thrown on. */
export function decodeLaunches(
  logs: readonly { topics: readonly string[]; data: string }[],
): FlapLaunch[] {
  const launches: FlapLaunch[] = [];

  for (const log of logs) {
    if (log.topics[0] !== TOKEN_CREATED_TOPIC) continue;
    try {
      const decoded = decodeEventLog({
        abi: tokenCreatedAbi,
        eventName: "TokenCreated",
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      const args = decoded.args;
      const address = args.token.toLowerCase();
      if (!isEvmAddress(address)) continue;
      launches.push({
        address,
        symbol: args.symbol.trim(),
        name: args.name.trim(),
        creator: args.creator.toLowerCase(),
        meta: args.meta.trim(),
        // `ts` is the block timestamp in seconds, per the event reference.
        launchedAt: Number(args.ts) * 1000,
      });
    } catch {
      // A Portal event that merely shares the topic shape, or a future revision
      // of the payload. Either way this is not a launch we can describe.
    }
  }

  return launches;
}

/** What the Portal lens says about one token, narrowed to what the lane needs. */
export interface FlapMarketState {
  status: number;
  tokenVersion: number;
  /** Progress toward graduation, 0 to 1e18, as a decimal string. */
  progress: string;
  /** Quote token, lowercased; the zero address means native BNB. */
  quote: string;
  /** PancakeSwap V2 pair once graduated, zero address while on the curve. */
  pool: string;
  buyTaxBps: number;
  sellTaxBps: number;
}

/** True for a token the Portal will still trade. */
export function isFlapTradable(status: number): boolean {
  return status === FLAP_STATUS_TRADABLE || status === FLAP_STATUS_DEX;
}

/**
 * Reads the lens for many tokens at once.
 *
 * All reads are issued in the same tick, so viem's multicall batching folds them
 * into a handful of `eth_call`s rather than one per token. A token the Portal
 * does not know reverts `TokenNotFound(address)` and is simply omitted — absence
 * from the returned map is the negative answer.
 */
export async function readFlapMarketStates(
  addresses: readonly string[],
  signal?: AbortSignal | undefined,
): Promise<Map<string, FlapMarketState>> {
  if (addresses.length === 0) return new Map();

  const read = async (client: BscClient): Promise<Map<string, FlapMarketState>> => {
    const settled = await Promise.allSettled(
      addresses.map((address) =>
        client.readContract({
          address: FLAP_PORTAL,
          abi: flapPortalAbi,
          functionName: "getTokenV8Safe",
          args: [address as `0x${string}`],
        }),
      ),
    );

    const states = new Map<string, FlapMarketState>();
    for (const [index, result] of settled.entries()) {
      const address = addresses[index];
      if (address === undefined) continue;
      if (result.status === "rejected") {
        // Only a revert may be read as "the Portal does not know this token".
        // A timeout or a 429 must rotate instead, or the caller would prune a
        // live token from the lane because one endpoint blinked.
        if (isContractLevelFailure(result.reason)) continue;
        throw result.reason;
      }
      const value = result.value;
      states.set(address.toLowerCase(), {
        status: value.status,
        tokenVersion: value.tokenVersion,
        progress: value.progress.toString(),
        quote: value.quoteTokenAddress.toLowerCase(),
        pool: value.pool.toLowerCase(),
        buyTaxBps: Number(value.buyTaxRate),
        sellTaxBps: Number(value.sellTaxRate),
      });
    }
    return states;
  };

  try {
    return await withBscClient(read, signal === undefined ? {} : { signal });
  } catch (error) {
    throw new AdapterError(SOURCE, `lens read failed: ${sanitizeMessage(error)}`);
  }
}
