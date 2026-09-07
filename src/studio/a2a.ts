import { record, safeUrl } from "./config.js";
import type { GetJson } from "./http.js";

export interface CardSkill { id: string; name: string; description: string; tags: string[] }
export interface CardSummary {
  protocolVersion: "0.3.0"; name: string; description: string; version: string;
  invocationUrl: string; defaultInputModes: string[]; defaultOutputModes: string[];
  skills: CardSkill[]; authentication: "declared" | "not_declared";
}
function fail(): never { throw new Error("studio_card_invalid"); }
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) return fail();
  return value;
}
function strings(value: unknown, max: number, length: number, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length > max || value.length < minimum) return fail();
  return value.map((item: unknown) => text(item, length));
}
function auth(card: Record<string, unknown>): CardSummary["authentication"] {
  if (Buffer.byteLength(JSON.stringify({ security: card["security"], securitySchemes: card["securitySchemes"] })) > 16384) return fail();
  let declared = false;
  const requiredNames: string[] = [];
  const security = card["security"];
  if (security !== undefined) {
    if (!Array.isArray(security) || security.length > 16) return fail();
    for (const item of security) {
      if (!record(item) || Object.keys(item).length > 16) return fail();
      for (const [name, scopes] of Object.entries(item)) {
        text(name, 128); strings(scopes, 16, 128); requiredNames.push(name); declared = true;
      }
    }
  }
  const schemes = card["securitySchemes"];
  if (schemes !== undefined) {
    if (!record(schemes) || Object.keys(schemes).length > 16 || Buffer.byteLength(JSON.stringify(schemes)) > 16384) return fail();
    for (const [name, scheme] of Object.entries(schemes)) {
      text(name, 128);
      if (!record(scheme) || typeof scheme["type"] !== "string" || !["apiKey", "http", "oauth2", "openIdConnect", "mutualTLS"].includes(scheme["type"])) return fail();
      if (scheme["type"] === "http") text(scheme["scheme"], 128);
      if (scheme["type"] === "apiKey") {
        text(scheme["name"], 128);
        if (typeof scheme["in"] !== "string" || !["query", "header", "cookie"].includes(scheme["in"])) return fail();
      }
      if (scheme["type"] === "openIdConnect") text(scheme["openIdConnectUrl"], 2048);
      if (scheme["type"] === "oauth2") {
        const flows = scheme["flows"];
        if (!record(flows) || Object.keys(flows).length < 1 || Object.keys(flows).length > 4) return fail();
        for (const [kind, flow] of Object.entries(flows)) {
          if (!["implicit", "password", "clientCredentials", "authorizationCode"].includes(kind) || !record(flow)
            || !record(flow["scopes"]) || Object.keys(flow["scopes"]).length > 16) return fail();
          if (kind === "implicit" || kind === "authorizationCode") text(flow["authorizationUrl"], 2048);
          if (kind !== "implicit") text(flow["tokenUrl"], 2048);
          for (const [scope, description] of Object.entries(flow["scopes"])) { text(scope, 128); text(description, 1000); }
        }
      }
      declared = true;
    }
  }
  if (requiredNames.some(name => !record(schemes) || !Object.hasOwn(schemes, name))) return fail();
  return declared ? "declared" : "not_declared";
}
/** Parse discovery metadata only. URLs and seller skill text are never executable instructions. */
export function parseCard(value: unknown, cardUrl: string): CardSummary {
  if (!record(value) || value["protocolVersion"] !== "0.3.0" || !record(value["capabilities"])) return fail();
  const invocationUrl = safeUrl(value["url"]);
  if (new URL(invocationUrl).origin !== new URL(cardUrl).origin) return fail();
  if (!Array.isArray(value["skills"]) || value["skills"].length < 1 || value["skills"].length > 64) return fail();
  const skills = value["skills"].map((skill: unknown): CardSkill => {
    if (!record(skill)) return fail();
    for (const key of ["inputModes", "outputModes"]) if (skill[key] !== undefined) strings(skill[key], 16, 128, 1);
    return { id: text(skill["id"], 200), name: text(skill["name"], 200),
      description: text(skill["description"], 4000), tags: strings(skill["tags"], 32, 128) };
  });
  if (new Set(skills.map(s => s.id)).size !== skills.length) return fail();
  return { protocolVersion: "0.3.0", name: text(value["name"], 200), description: text(value["description"], 4000),
    version: text(value["version"], 100), invocationUrl, skills,
    defaultInputModes: strings(value["defaultInputModes"], 16, 128, 1),
    defaultOutputModes: strings(value["defaultOutputModes"], 16, 128, 1), authentication: auth(value) };
}
export async function probeCard(url: string, signal: AbortSignal, get: GetJson): Promise<CardSummary> {
  const reply = await get(url, signal);
  signal.throwIfAborted();
  if (reply.status !== 200) return fail();
  return parseCard(reply.body, url);
}
