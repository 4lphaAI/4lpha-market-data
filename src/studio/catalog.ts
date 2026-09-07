import { probeCard } from "./a2a.js";
import type { Hono } from "hono";
import type { SnapshotStore } from "../core/store.js";
import type { JobSpec } from "../core/types.js";
import { CATALOG_KEY, type StudioConfig, validId } from "./config.js";
import { abortable, getJson, postJson, type GetJson, type PostJson } from "./http.js";
import { metadata, probeMcp, unavailable, type Identity, type Observation } from "./probe.js";

export interface Catalog { digest: string; agents: Observation[] }
export interface ProbeDeps {
  post: PostJson;
  get?: GetJson;
  read: (id: string, rpc: string, signal: AbortSignal, post: PostJson) => Promise<Identity>;
  now: () => number;
}
const defaults: ProbeDeps = {
  post: postJson, get: getJson, now: Date.now,
  read: async (...args) => (await import("./registry.js")).readIdentity(...args),
};
export function studioJob(store: SnapshotStore, config: StudioConfig, deps: ProbeDeps = defaults): JobSpec {
  return { name: "studio-discovery", intervalMs: 120000, jitterMs: 1000, timeoutMs: 90000,
    async run(signal) {
      const agents: Observation[] = new Array(config.targets.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < config.targets.length) {
          signal.throwIfAborted();
          const index = cursor++; const target = config.targets[index]!;
          const local = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
          try {
            agents[index] = await abortable((async () => {
              const identity = await deps.read(target.id, config.rpcUrl, local, deps.post);
              local.throwIfAborted();
              const name = metadata(identity, target);
              if (target.a2aCardUrl !== undefined) {
                if (!deps.get) throw new Error("studio_get_unavailable");
                const a2a = await probeCard(target.a2aCardUrl, local, deps.get);
                local.throwIfAborted();
                return { ...unavailable(target, deps.now()), name, owner: identity.owner, a2a, connected: true, errorCode: null };
              }
              const tools = await probeMcp(target.mcpEndpoint, local, deps.post);
              local.throwIfAborted();
              return { ...unavailable(target, deps.now()), name, owner: identity.owner, tools, connected: true, errorCode: null };
            })(), local);
          } catch { agents[index] = unavailable(target, deps.now()); }
        }
      };
      await Promise.all([worker(), worker()]);
      signal.throwIfAborted();
      await store.put(CATALOG_KEY, { digest: config.digest, agents } satisfies Catalog,
        { source: "bnb-studio-sdk", freshForMs: 180000, deadAfterMs: 600000 });
    },
  };
}
/** Consumer traffic reads snapshots only; it cannot fan out to registry or sellers. */
export function mountStudio(app: Hono, store: SnapshotStore, config: StudioConfig | null): void {
  for (const path of ["/studio/agents", "/studio/agents/:id"]) app.get(path, async c => {
    if (!config) return c.json({ data: null, error: { code: "studio_disabled" } }, 404);
    if (!process.env["DP_AUTH_TOKEN"]?.trim()) return c.json({ data: null, error: { code: "auth_not_configured" } }, 503);
    const id = c.req.param("id");
    if (id !== undefined && (!validId(id) || !config.targets.some(t => t.id === id))) return c.json({ data: null, error: { code: "studio_not_found" } }, 404);
    const snapshot = await store.get<Catalog>(CATALOG_KEY);
    if (!snapshot || snapshot.data.digest !== config.digest) return c.json({ data: null, error: { code: "studio_not_ready" } }, 503);
    const agents = snapshot.data.agents.map(a => snapshot.staleness === "fresh" ? a
      : { ...a, ...(a.a2aCardUrl !== undefined ? { a2a: null } : {}), connected: false, tools: [], errorCode: "studio_stale" });
    return c.json({ data: id === undefined ? agents : agents.find(a => a.id === id) ?? null,
      meta: { asOf: snapshot.asOf, staleness: snapshot.staleness, source: snapshot.source } });
  });
}
