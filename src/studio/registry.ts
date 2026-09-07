import { createPublicClient, custom } from "viem";
import { bsc } from "viem/chains";
import { REGISTRY, record, validId } from "./config.js";
import type { PostJson } from "./http.js";
import type { Identity } from "./probe.js";

/** This is the entire RPC vocabulary available even if the SDK gains a new write path. */
export function readRpcAllowed(method: string, params: unknown): boolean {
  if (method === "eth_chainId") return params === undefined || Array.isArray(params) && params.length === 0;
  if (method !== "eth_call" || !Array.isArray(params) || params.length !== 2 || params[1] !== "latest") return false;
  const call: unknown = params[0];
  return record(call) && Object.keys(call).every(k => k === "to" || k === "data")
    && typeof call["to"] === "string" && call["to"].toLowerCase() === REGISTRY.toLowerCase()
    && typeof call["data"] === "string" && /^0x(?:6352211e|c87b56dd|00339509)[a-fA-F0-9]{64}$/u.test(call["data"]);
}
export async function readIdentity(id: string, rpcUrl: string, signal: AbortSignal, post: PostJson): Promise<Identity> {
  if (!validId(id)) throw new Error("studio_identity_invalid");
  const { ContractInterface } = await import("@bnbagent/sdk/erc8004");
  signal.throwIfAborted();
  // The SDK matches rate-limit text including viem's argument rendering (id 429).
  // Override its protected retry seam instead of relying on sanitized errors.
  class OnceReader extends ContractInterface {
    protected override async callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      return fn();
    }
  }
  let sequence = 0;
  const rpc = async (method: string, params: unknown): Promise<unknown> => {
    signal.throwIfAborted();
    if (!readRpcAllowed(method, params)) throw new Error("studio_rpc_denied");
    const requestId = ++sequence;
    const reply = await post(rpcUrl, { jsonrpc: "2.0", id: requestId, method, params: params ?? [] }, signal);
    if (reply.status !== 200 || !record(reply.body) || reply.body["id"] !== requestId || reply.body["jsonrpc"] !== "2.0"
      || "error" in reply.body || "method" in reply.body || typeof reply.body["result"] !== "string") throw new Error("studio_upstream_failed");
    return reply.body["result"];
  };
  if (await rpc("eth_chainId", []) !== "0x38") throw new Error("studio_chain_mismatch");
  const client = createPublicClient({ chain: bsc, transport: custom({ request: ({ method, params }) => rpc(method, params) }, { retryCount: 0 }) });
  const reader = new OnceReader({ client, contractAddress: REGISTRY });
  const info = await reader.getAgentInfo(Number(id));
  signal.throwIfAborted();
  return { owner: info.owner, agentURI: info.agentURI };
}
