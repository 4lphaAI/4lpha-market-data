import type { CardSummary } from "./a2a.js";
import { record, REGISTRY, type Target } from "./config.js";
import { type PostJson } from "./http.js";

export interface Identity { owner: string; agentURI: string }
export interface Tool { name: string; description: string | null }
export interface Observation {
  id: string; chainId: 56; registry: string; name: string | null; owner: string | null;
  mcpEndpoint?: string; a2aCardUrl?: string; a2a?: CardSummary | null; checkedAt: number; connected: boolean; tools: Tool[];
  studioProvenance: "unverified"; errorCode: string | null;
}
export function unavailable(target: Target, now: number, code = "studio_probe_failed"): Observation {
  return { ...target, ...(target.a2aCardUrl !== undefined ? { a2a: null } : {}), chainId: 56, registry: REGISTRY, name: null, owner: null,
    checkedAt: now, connected: false, tools: [], studioProvenance: "unverified", errorCode: code };
}
export function metadata(identity: Identity, target: Target): string {
  const prefix = "data:application/json;base64,";
  if (!/^0x[0-9a-fA-F]{40}$/u.test(identity.owner) || !identity.agentURI.startsWith(prefix)
    || identity.agentURI.length > 65536) throw new Error("studio_identity_invalid");
  const encoded = identity.agentURI.slice(prefix.length);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new Error("studio_identity_invalid");
  const value: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (!record(value) || typeof value["name"] !== "string" || !value["name"].trim() || value["name"].length > 200
    || !Array.isArray(value["services"]) || value["services"].length > 32) throw new Error("studio_identity_invalid");
  const protocol = target.a2aCardUrl !== undefined ? "A2A" : "MCP";
  const endpoint = target.a2aCardUrl ?? target.mcpEndpoint;
  const mcp = value["services"].filter((s: unknown) => record(s) && s["name"] === protocol);
  if (mcp.length !== 1 || !record(mcp[0]) || mcp[0]["endpoint"] !== endpoint) throw new Error("studio_identity_invalid");
  return value["name"];
}
function result(reply: unknown, id: number): Record<string, unknown> {
  if (!record(reply) || reply["jsonrpc"] !== "2.0" || reply["id"] !== id || "method" in reply
    || "error" in reply || !record(reply["result"])) throw new Error("studio_protocol_invalid");
  return reply["result"];
}
export async function probeMcp(endpoint: string, signal: AbortSignal, post: PostJson): Promise<Tool[]> {
  const version = "2025-06-18";
  const init = await post(endpoint, { jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: version, capabilities: {}, clientInfo: { name: "4lpha-studio-discovery", version: "1.0.0" },
  } }, signal);
  const first = result(init.body, 1);
  if (init.status !== 200 || first["protocolVersion"] !== version || !record(first["capabilities"])
    || !record(first["capabilities"]["tools"]) || !record(first["serverInfo"])) throw new Error("studio_protocol_invalid");
  const notification = await post(endpoint, { jsonrpc: "2.0", method: "notifications/initialized" }, signal, init.session, version);
  if (![202,204].includes(notification.status) || notification.body !== null) throw new Error("studio_protocol_invalid");
  const response = await post(endpoint, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, signal, init.session, version);
  const tools = result(response.body, 2);
  if (response.status !== 200 || tools["nextCursor"] !== undefined && tools["nextCursor"] !== ""
    || !Array.isArray(tools["tools"]) || tools["tools"].length > 64) throw new Error("studio_protocol_invalid");
  const parsed = tools["tools"].map((tool: unknown): Tool => {
    if (!record(tool) || typeof tool["name"] !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/u.test(tool["name"])
      || !record(tool["inputSchema"]) || tool["inputSchema"]["type"] !== "object"
      || tool["description"] !== undefined && (typeof tool["description"] !== "string" || tool["description"].length > 1000)) throw new Error("studio_protocol_invalid");
    return { name: tool["name"], description: typeof tool["description"] === "string" ? tool["description"] : null };
  });
  if (new Set(parsed.map(t => t.name)).size !== parsed.length) throw new Error("studio_protocol_invalid");
  return parsed;
}
