import { createHash } from "node:crypto";

export const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
export const CATALOG_KEY = "studio:catalog:v1";
export type Target = { id: string; mcpEndpoint: string; a2aCardUrl?: never } | { id: string; a2aCardUrl: string; mcpEndpoint?: never };
export interface StudioConfig { rpcUrl: string; targets: Target[]; digest: string }
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function validId(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/u.test(value)
    && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
}
export function safeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("studio_config_invalid");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/u.test(url.hostname)
    || value !== url.href) throw new Error("studio_config_invalid");
  return url.href;
}
/** An optional integration cannot turn a malformed new knob into a market-data outage. */
export function studioConfig(env: Readonly<Record<string, string | undefined>>): StudioConfig | null {
  if (env["STUDIO_DISCOVERY_ENABLED"] !== "true") return null;
  try {
    const raw = env["STUDIO_DISCOVERY_TARGETS_JSON"];
    if (!raw || raw.length > 20000) return null;
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length < 1 || value.length > 8) return null;
    const targets = value.map((item: unknown): Target => {
      if (!record(item) || !validId(item["id"]) || !["id,mcpEndpoint", "a2aCardUrl,id"].includes(Object.keys(item).sort().join())) throw new Error("studio_config_invalid");
      return "a2aCardUrl" in item ? { id: item["id"], a2aCardUrl: safeUrl(item["a2aCardUrl"]) }
        : { id: item["id"], mcpEndpoint: safeUrl(item["mcpEndpoint"]) };
    }).sort((a, b) => a.id.localeCompare(b.id, "en"));
    if (new Set(targets.map(t => t.id)).size !== targets.length) return null;
    const rpcUrl = safeUrl(env["STUDIO_DISCOVERY_RPC_URL"]);
    const digest = createHash("sha256").update(JSON.stringify({ revision: 2, rpcUrl, targets })).digest("hex");
    return { rpcUrl, targets, digest };
  } catch { return null; }
}
