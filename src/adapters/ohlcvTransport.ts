/** Shared, fail-fast upstream budgets. Lease slots are atomic across replicas. */
import { randomUUID } from "node:crypto";
import type { SnapshotStore } from "../core/store.js";
import { AdapterError, type FetchFn } from "./http.js";

export type OhlcvProvider = "geckoterminal" | "dexpaprika";
const BUDGETS: Record<OhlcvProvider, number> = { geckoterminal: 8, dexpaprika: 12 };
export interface OhlcvCounters {
  requests: number;
  failures: number;
  rateLimited: number;
  budgetDenied: number;
  cooldownDenied: number;
}
export class OhlcvTransport {
  readonly counters: Record<OhlcvProvider, OhlcvCounters> = {
    geckoterminal: counters(), dexpaprika: counters(),
  };
  constructor(private readonly store: SnapshotStore, private readonly now = Date.now) {}

  fetch(provider: OhlcvProvider, underlying: FetchFn = globalThis.fetch): FetchFn {
    return async (input, init) => {
      if (init?.signal?.aborted) throw new AdapterError(provider, "request aborted");
      const stats = this.counters[provider];
      const cooldowns = await Promise.all([402, 429, 500].map((status) =>
        this.store.get<{ until: number }>(`ohlcv-control:${provider}:cooldown:${status}`)));
      if (cooldowns.some((entry) => (entry?.data.until ?? 0) > this.now())) {
        stats.cooldownDenied++;
        throw new AdapterError(provider, "cooling down");
      }
      let admitted = false;
      // Each successful HTTP admission owns one of N fixed slots for 60s.
      // Unique holder is essential: reusing it would renew a lease for free.
      for (let slot = 0; slot < BUDGETS[provider]; slot++) {
        if (await this.store.acquireSchedulerLease(`ohlcv-budget:${provider}:${slot}`, randomUUID(), 60_000)) {
          admitted = true;
          break;
        }
      }
      if (!admitted) {
        stats.budgetDenied++;
        throw new AdapterError(provider, "request budget exhausted");
      }
      stats.requests++;
      let response: Response;
      try { response = await underlying(input, init); }
      catch { stats.failures++; throw new AdapterError(provider, "transport failed"); }
      if (!response.ok) stats.failures++;
      if (response.status === 429 || response.status === 402 || response.status >= 500) {
        if (response.status === 429) stats.rateLimited++;
        const now = this.now();
        const monthEnd = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1);
        let until = now + (response.status === 429 ? 60_000 : 15_000);
        const retry = response.headers.get("retry-after");
        if (retry !== null) {
          const seconds = Number(retry);
          const retryAt = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : Date.parse(retry);
          if (Number.isFinite(retryAt)) until = Math.max(until, retryAt);
        }
        // A monthly quota is not a minute rate limit. Never keep retrying it.
        if (response.status === 402) {
          until = monthEnd;
          try {
            const body = await response.clone().json() as { resets_at?: unknown };
            const reset = typeof body.resets_at === "number" ? body.resets_at * 1000
              : typeof body.resets_at === "string" ? Date.parse(body.resets_at) : NaN;
            if (Number.isFinite(reset) && reset > now) until = reset;
          } catch { /* Missing reset: wait until the next UTC month. */ }
        }
        const cooldownKey = `ohlcv-control:${provider}:cooldown:${response.status >= 500 ? 500 : response.status}`;
        const prior = await this.store.get<{ until: number }>(cooldownKey);
        until = Math.max(until, prior?.data.until ?? 0);
        await this.store.put(cooldownKey, { until }, {
          source: provider, freshForMs: until - now, deadAfterMs: until - now,
        });
      }
      return response;
    };
  }
}
function counters(): OhlcvCounters {
  return { requests: 0, failures: 0, rateLimited: 0, budgetDenied: 0, cooldownDenied: 0 };
}
