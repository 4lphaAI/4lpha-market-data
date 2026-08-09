import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { MemoryStore } from "../src/core/store.js";
import { worstRiskLevel } from "../src/core/models.js";
import {
  SECURITY_TTL,
  getSecurity,
  mergeSecurityReports,
  securityKey,
  type StoredSecurity,
} from "../src/query/security.js";

const ADDRESS = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  delete process.env["OKX_API_KEY"];
  delete process.env["OKX_SECRET_KEY"];
  delete process.env["OKX_PASSPHRASE"];
  delete process.env["GMGN_API_KEY"];
});

function setCredentials(): void {
  process.env["OKX_API_KEY"] = "unit-test-key";
  process.env["OKX_SECRET_KEY"] = "unit-test-secret";
  process.env["OKX_PASSPHRASE"] = "unit-test-passphrase";
  process.env["GMGN_API_KEY"] = "unit-test-gmgn";
}

/** Silences the expected scanner-failure warnings for one test. */
function muteWarnings(): void {
  console.warn = () => {};
}

interface Routes {
  onchainos?: () => Response;
  gmgn?: () => Response;
}

/** Routes by host, so a test can fail one scanner and keep the other. */
function installFetch(routes: Routes): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(href);
    const host = new URL(href).host;
    const route = host.includes("gmgn") ? routes.gmgn : routes.onchainos;
    if (route === undefined) throw new Error(`unexpected call to ${host}`);
    return route();
  }) as typeof globalThis.fetch;
  return seen;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function scan(riskLevel: string, extra: Record<string, unknown> = {}): Response {
  return json({
    code: "0",
    data: [{ chainId: "56", isChainSupported: true, riskLevel, tokenAddress: ADDRESS, ...extra }],
  });
}

function gmgnSecurity(extra: Record<string, unknown> = {}): Response {
  return json({
    code: 0,
    data: {
      address: ADDRESS,
      is_honeypot: false,
      is_open_source: true,
      is_renounced: true,
      buy_tax: "0",
      sell_tax: "0",
      flags: [],
      ...extra,
    },
  });
}

describe("worstRiskLevel", () => {
  it("ranks danger above warn above ok", () => {
    assert.equal(worstRiskLevel("ok", "warn"), "warn");
    assert.equal(worstRiskLevel("danger", "warn"), "danger");
    assert.equal(worstRiskLevel("warn", "danger"), "danger");
  });

  it("never lets a silent scanner mask a real verdict", () => {
    assert.equal(worstRiskLevel("ok", "unavailable"), "ok");
    assert.equal(worstRiskLevel("unavailable", "danger"), "danger");
    assert.equal(worstRiskLevel("unavailable", "unavailable"), "unavailable");
  });
});

describe("mergeSecurityReports", () => {
  it("takes the worse verdict and the union of flags", () => {
    const summary = mergeSecurityReports(
      [
        { source: "onchainos", riskLevel: "ok", flags: ["mintable"] },
        { source: "gmgn", riskLevel: "danger", flags: ["honeypot", "mintable"] },
      ],
      1_000,
    );
    assert.equal(summary.riskLevel, "danger");
    assert.deepEqual(summary.flags, ["honeypot", "mintable"]);
    assert.equal(summary.source, "onchainos+gmgn");
    assert.equal(summary.scannedAt, 1_000);
  });

  it("keeps a real verdict when the other scanner has no opinion", () => {
    const summary = mergeSecurityReports(
      [
        { source: "onchainos", riskLevel: "ok", flags: [] },
        { source: "gmgn", riskLevel: "unavailable", flags: [] },
      ],
      0,
    );
    assert.equal(summary.riskLevel, "ok");
  });

  it("reports unavailable when nothing answered", () => {
    const summary = mergeSecurityReports([], 0);
    assert.equal(summary.riskLevel, "unavailable");
    assert.equal(summary.source, "none");
  });
});

describe("TTL policy", () => {
  it("re-scans meme tokens far more often than the slower lanes", () => {
    assert.equal(SECURITY_TTL.meme.freshForMs, 5 * 60_000);
    assert.equal(SECURITY_TTL.meme.deadAfterMs, 60 * 60_000);
    assert.equal(SECURITY_TTL.coins.freshForMs, 24 * 60 * 60_000);
    assert.equal(SECURITY_TTL.coins.deadAfterMs, 7 * 24 * 60 * 60_000);
    assert.deepEqual(SECURITY_TTL.bstocks, SECURITY_TTL.coins);
  });
});

describe("getSecurity", () => {
  it("combines both scanners and writes the merged verdict back", async () => {
    setCredentials();
    const store = new MemoryStore();
    const seen = installFetch({
      onchainos: () => scan("MEDIUM", { isMintable: true }),
      gmgn: () => gmgnSecurity({ is_honeypot: true }),
    });

    const result = await getSecurity(store, { address: ADDRESS, lane: "meme" });
    assert.equal(result.summary.riskLevel, "danger");
    assert.deepEqual(result.summary.flags, ["honeypot", "mintable"]);
    assert.deepEqual(
      result.sources.map((source) => source.source),
      ["onchainos", "gmgn"],
    );
    assert.equal(result.staleness, "fresh");
    assert.equal(seen.length, 2);

    const stored = await store.get<StoredSecurity>(securityKey(ADDRESS));
    assert.equal(stored?.data.summary.riskLevel, "danger");
  });

  it("serves a fresh record without calling either scanner", async () => {
    setCredentials();
    const store = new MemoryStore();
    await store.put(
      securityKey(ADDRESS),
      {
        summary: { riskLevel: "warn", flags: ["mintable"], scannedAt: 1, source: "onchainos" },
        sources: [{ source: "onchainos", riskLevel: "warn", flags: ["mintable"] }],
      },
      { source: "onchainos", freshForMs: 60_000, deadAfterMs: 600_000 },
    );
    const seen = installFetch({});

    const result = await getSecurity(store, { address: ADDRESS, lane: "meme" });
    assert.equal(result.summary.riskLevel, "warn");
    assert.equal(result.staleness, "fresh");
    assert.equal(seen.length, 0);
  });

  it("still answers from one scanner when the other is down", async () => {
    setCredentials();
    muteWarnings();
    const store = new MemoryStore();
    installFetch({
      onchainos: () => json({}, 500),
      gmgn: () => gmgnSecurity({ is_open_source: false }),
    });

    const result = await getSecurity(store, { address: ADDRESS, lane: "meme" });
    assert.equal(result.summary.riskLevel, "warn");
    assert.deepEqual(result.summary.flags, ["not_open_source"]);
    assert.deepEqual(
      result.sources.map((source) => source.source),
      ["gmgn"],
    );
  });

  it("skips an unconfigured scanner silently", async () => {
    // No credentials at all: both scanners report themselves unavailable.
    const store = new MemoryStore();
    let warned = 0;
    console.warn = () => {
      warned += 1;
    };
    const seen = installFetch({});

    const result = await getSecurity(store, { address: ADDRESS, lane: "meme" });
    assert.equal(result.summary.riskLevel, "unavailable");
    assert.equal(seen.length, 0);
    assert.equal(warned, 0);
  });

  it("falls back to a stale record when every scanner fails", async () => {
    setCredentials();
    muteWarnings();
    const store = new MemoryStore();
    await store.put(
      securityKey(ADDRESS),
      {
        summary: { riskLevel: "danger", flags: ["honeypot"], scannedAt: 1, source: "onchainos" },
        sources: [{ source: "onchainos", riskLevel: "danger", flags: ["honeypot"] }],
      },
      // Already stale on write, so the read must go upstream and then come back.
      { source: "onchainos", freshForMs: 0, deadAfterMs: 600_000 },
    );
    installFetch({ onchainos: () => json({}, 500), gmgn: () => json({}, 500) });

    const result = await getSecurity(store, { address: ADDRESS, lane: "meme" });
    assert.equal(result.summary.riskLevel, "danger");
    assert.equal(result.staleness, "stale");
  });

  it("returns unavailable rather than throwing when there is nothing at all", async () => {
    setCredentials();
    muteWarnings();
    const store = new MemoryStore();
    installFetch({ onchainos: () => json({}, 500), gmgn: () => json({}, 500) });

    const result = await getSecurity(store, { address: ADDRESS, lane: "meme" });
    assert.equal(result.summary.riskLevel, "unavailable");
    assert.deepEqual(result.summary.flags, []);
    assert.deepEqual(result.sources, []);
  });

  it("rejects a malformed address without touching the network", async () => {
    setCredentials();
    const store = new MemoryStore();
    const seen = installFetch({});

    const result = await getSecurity(store, { address: "0xnope", lane: "meme" });
    assert.equal(result.summary.riskLevel, "unavailable");
    assert.equal(seen.length, 0);
  });

  it("discards a stored payload whose shape no longer validates", async () => {
    setCredentials();
    const store = new MemoryStore();
    await store.put(securityKey(ADDRESS), { legacy: true }, {
      source: "old-build",
      freshForMs: 60_000,
      deadAfterMs: 600_000,
    });
    installFetch({ onchainos: () => scan("LOW"), gmgn: () => gmgnSecurity() });

    const result = await getSecurity(store, { address: ADDRESS, lane: "meme" });
    assert.equal(result.summary.riskLevel, "ok");
  });

  it("applies the lane's TTL to the record it writes", async () => {
    setCredentials();
    installFetch({ onchainos: () => scan("LOW"), gmgn: () => gmgnSecurity() });

    // Same scan, same elapsed time, two lanes: only the meme record has aged.
    for (const [lane, expected] of [
      ["meme", "stale"],
      ["bstocks", "fresh"],
    ] as const) {
      let now = 1_700_000_000_000;
      const store = new MemoryStore(() => now);
      await getSecurity(store, { address: ADDRESS, lane });
      now += 6 * 60_000;
      assert.equal((await store.get<StoredSecurity>(securityKey(ADDRESS)))?.staleness, expected);
    }
  });

  it("re-scans a lane-stale record instead of serving it", async () => {
    setCredentials();
    let now = 1_700_000_000_000;
    const store = new MemoryStore(() => now);
    installFetch({ onchainos: () => scan("LOW"), gmgn: () => gmgnSecurity() });
    await getSecurity(store, { address: ADDRESS, lane: "meme" });

    now += SECURITY_TTL.meme.freshForMs + 1;
    const seen = installFetch({
      onchainos: () => scan("HIGH", { isHoneypot: true }),
      gmgn: () => gmgnSecurity(),
    });
    const result = await getSecurity(store, { address: ADDRESS, lane: "meme" });

    assert.equal(seen.length, 2);
    assert.equal(result.summary.riskLevel, "danger");
  });
});
