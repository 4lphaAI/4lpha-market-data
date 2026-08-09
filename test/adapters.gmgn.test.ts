import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  fetchGmgnSmartMoney,
  fetchGmgnTokenHolders,
  fetchGmgnTokenSecurity,
  hasGmgnCredentials,
  normalizeGmgnSecurity,
  resetGmgnCooldown,
} from "../src/adapters/gmgn.js";
import { AdapterError, MissingCredentialsError } from "../src/adapters/http.js";
import { fakeFetch, jsonResponse, textResponse, throwingFetch } from "./helpers.js";

const ADDRESS = "0x02FCA66C1D1AFB4E2A7884261EB00F63598A7436";
const LOWER = ADDRESS.toLowerCase();
const KEY = "unit-test-gmgn-key";

function setKey(): void {
  process.env["GMGN_API_KEY"] = KEY;
}

function clearKey(): void {
  delete process.env["GMGN_API_KEY"];
}

afterEach(() => {
  clearKey();
  resetGmgnCooldown();
});

/** The shape of a live GMGN scan of a healthy token, trimmed to what is read. */
const CLEAN_SECURITY = {
  address: LOWER,
  top_10_holder_rate: "0.4143",
  is_open_source: true,
  open_source: 1,
  is_blacklist: null,
  is_honeypot: false,
  honeypot: 0,
  is_renounced: true,
  renounced: 1,
  can_not_sell: 0,
  buy_tax: "0",
  sell_tax: "0",
  flags: [],
};

/** An unknown token: 200 OK, empty address, every verdict null. */
const UNKNOWN_SECURITY = {
  address: "",
  top_10_holder_rate: "",
  is_open_source: null,
  open_source: 0,
  is_blacklist: null,
  is_honeypot: null,
  honeypot: 0,
  is_renounced: null,
  renounced: null,
  buy_tax: "",
  sell_tax: "",
  flags: null,
};

describe("credential handling", () => {
  it("reports missing credentials instead of throwing at import time", () => {
    clearKey();
    assert.equal(hasGmgnCredentials(), false);
    setKey();
    assert.equal(hasGmgnCredentials(), true);
  });

  it("throws MissingCredentialsError without touching the network", async () => {
    clearKey();
    const fake = fakeFetch(() => jsonResponse({ code: 0, data: CLEAN_SECURITY }));
    await assert.rejects(
      () => fetchGmgnTokenSecurity({ address: ADDRESS, fetchFn: fake.fetch }),
      (error: unknown) => {
        assert.ok(error instanceof MissingCredentialsError);
        return true;
      },
    );
    assert.equal(fake.calls.length, 0);
  });

  it("treats a rejected key the same as an absent one", async () => {
    setKey();
    for (const status of [401, 403]) {
      const fake = fakeFetch(() => jsonResponse({ code: status, error: "AUTH_INVALID" }, status));
      await assert.rejects(
        () => fetchGmgnTokenSecurity({ address: ADDRESS, fetchFn: fake.fetch }),
        (error: unknown) => {
          assert.ok(error instanceof MissingCredentialsError);
          return true;
        },
      );
    }
  });
});

describe("fetchGmgnTokenSecurity", () => {
  it("sends the key in the header and the auth pair on the query string", async () => {
    setKey();
    const fake = fakeFetch(() => jsonResponse({ code: 0, data: CLEAN_SECURITY }));
    await fetchGmgnTokenSecurity({ address: ADDRESS, fetchFn: fake.fetch });

    const call = fake.calls[0];
    assert.ok(call !== undefined);
    const url = new URL(call.url);
    assert.equal(url.host, "openapi.gmgn.ai");
    assert.equal(url.pathname, "/v1/token/security");
    assert.equal(url.searchParams.get("chain"), "bsc");
    assert.equal(url.searchParams.get("address"), LOWER);
    assert.match(url.searchParams.get("timestamp") ?? "", /^\d+$/u);
    assert.match(url.searchParams.get("client_id") ?? "", /^[0-9a-f-]{36}$/u);
    assert.equal(call.headers["x-apikey"], KEY);
  });

  it("reads a clean token as ok with no flags", async () => {
    setKey();
    const fake = fakeFetch(() => jsonResponse({ code: 0, data: CLEAN_SECURITY }));
    const summary = await fetchGmgnTokenSecurity({ address: ADDRESS, fetchFn: fake.fetch });
    assert.equal(summary.riskLevel, "ok");
    assert.deepEqual(summary.flags, []);
    assert.equal(summary.source, "gmgn");
    assert.ok(summary.scannedAt > 0);
  });

  it("reads an unknown token as unavailable rather than clean", async () => {
    setKey();
    const fake = fakeFetch(() => jsonResponse({ code: 0, data: UNKNOWN_SECURITY }));
    const summary = await fetchGmgnTokenSecurity({ address: ADDRESS, fetchFn: fake.fetch });
    assert.equal(summary.riskLevel, "unavailable");
    assert.deepEqual(summary.flags, []);
  });

  it("treats a 404 as unavailable, not as an error", async () => {
    setKey();
    const fake = fakeFetch(() => jsonResponse({ error: "not found" }, 404));
    const summary = await fetchGmgnTokenSecurity({ address: ADDRESS, fetchFn: fake.fetch });
    assert.equal(summary.riskLevel, "unavailable");
  });

  it("maps rate limiting to a typed, sanitized error", async () => {
    setKey();
    const fake = fakeFetch(() => jsonResponse({}, 429));
    await assert.rejects(
      () => fetchGmgnTokenSecurity({ address: ADDRESS, fetchFn: fake.fetch }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterError);
        assert.equal(error.status, 429);
        assert.match(error.message, /rate limited/u);
        return true;
      },
    );
  });

  it("stops dialling after a 429, until the upstream's reset time", async () => {
    setKey();
    const resetAt = Math.floor(Date.now() / 1000) + 30;
    const fake = fakeFetch(
      () =>
        new Response("{}", {
          status: 429,
          headers: { "content-type": "application/json", "x-ratelimit-reset": String(resetAt) },
        }),
    );

    await assert.rejects(() => fetchGmgnTokenSecurity({ address: ADDRESS, fetchFn: fake.fetch }));
    // GMGN escalates repeat offenders to an IP ban, so the second call must not
    // reach the network at all.
    await assert.rejects(
      () => fetchGmgnTokenSecurity({ address: ADDRESS, fetchFn: fake.fetch }),
      /cooling down/u,
    );
    assert.equal(fake.calls.length, 1);
  });

  it("resumes dialling once the cooldown is cleared", async () => {
    setKey();
    const fake = fakeFetch(() => jsonResponse({}, 429));
    await assert.rejects(() => fetchGmgnTokenSecurity({ address: ADDRESS, fetchFn: fake.fetch }));

    resetGmgnCooldown();
    const ok = fakeFetch(() => jsonResponse({ code: 0, data: CLEAN_SECURITY }));
    assert.equal((await fetchGmgnTokenSecurity({ address: ADDRESS, fetchFn: ok.fetch })).riskLevel, "ok");
  });

  it("rejects a non-zero envelope code with the upstream message", async () => {
    setKey();
    const fake = fakeFetch(() => jsonResponse({ code: 40001, message: "bad request" }));
    await assert.rejects(
      () => fetchGmgnTokenSecurity({ address: ADDRESS, fetchFn: fake.fetch }),
      /bad request/u,
    );
  });

  it("rejects a non-JSON body", async () => {
    setKey();
    const fake = fakeFetch(() => textResponse("bad gateway", 200));
    await assert.rejects(
      () => fetchGmgnTokenSecurity({ address: ADDRESS, fetchFn: fake.fetch }),
      /invalid JSON in response/u,
    );
  });

  it("never echoes the key or the URL in an error message", async () => {
    setKey();
    const fetchFn = throwingFetch(
      new Error(`TLS failure calling https://openapi.gmgn.ai/v1?key=${KEY}${KEY}${KEY}`),
    );
    await assert.rejects(
      () => fetchGmgnTokenSecurity({ address: ADDRESS, fetchFn }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterError);
        assert.ok(!error.message.includes(KEY));
        assert.ok(!error.message.includes("openapi.gmgn.ai"));
        return true;
      },
    );
  });
});

describe("normalizeGmgnSecurity", () => {
  it("escalates a honeypot to danger", () => {
    const summary = normalizeGmgnSecurity({ ...CLEAN_SECURITY, is_honeypot: true, honeypot: 1 });
    assert.equal(summary.riskLevel, "danger");
    assert.ok(summary.flags.includes("honeypot"));
  });

  it("escalates an unsellable token to danger", () => {
    const summary = normalizeGmgnSecurity({ ...CLEAN_SECURITY, can_not_sell: 1 });
    assert.equal(summary.riskLevel, "danger");
    assert.ok(summary.flags.includes("cannot_sell"));
  });

  it("warns on a moderate tax and escalates a punitive one", () => {
    const warn = normalizeGmgnSecurity({ ...CLEAN_SECURITY, buy_tax: "0.06" });
    assert.equal(warn.riskLevel, "warn");
    assert.deepEqual(warn.flags, ["tax"]);

    const danger = normalizeGmgnSecurity({ ...CLEAN_SECURITY, sell_tax: "0.25" });
    assert.equal(danger.riskLevel, "danger");
    assert.ok(danger.flags.includes("high_tax"));
  });

  it("reads a percentage-scaled rate as a ratio", () => {
    // 85 means 85%, not 8500%, and must trip the same 80% threshold as 0.85.
    const asPercent = normalizeGmgnSecurity({ ...CLEAN_SECURITY, top_10_holder_rate: 85 });
    const asRatio = normalizeGmgnSecurity({ ...CLEAN_SECURITY, top_10_holder_rate: "0.85" });
    assert.deepEqual(asPercent.flags, ["top10_concentration"]);
    assert.deepEqual(asRatio.flags, ["top10_concentration"]);
  });

  it("warns on missing source or ownership renouncement", () => {
    const summary = normalizeGmgnSecurity({
      ...CLEAN_SECURITY,
      is_open_source: false,
      open_source: 0,
      is_renounced: false,
      renounced: 0,
    });
    assert.equal(summary.riskLevel, "warn");
    assert.deepEqual(summary.flags, ["not_open_source", "not_renounced"]);
  });

  it("does not read a null verdict as a passing one", () => {
    // `is_open_source: null` means "no opinion"; only an explicit false warns.
    const summary = normalizeGmgnSecurity({
      ...CLEAN_SECURITY,
      is_open_source: null,
      open_source: 1,
    });
    assert.deepEqual(summary.flags, []);
  });

  it("carries through upstream flags as normalized names", () => {
    const summary = normalizeGmgnSecurity({ ...CLEAN_SECURITY, flags: ["Slow Rug!", "  ", 7] });
    assert.equal(summary.riskLevel, "warn");
    assert.deepEqual(summary.flags, ["slow_rug"]);
  });

  it("returns sorted, deduplicated flags", () => {
    const summary = normalizeGmgnSecurity({
      ...CLEAN_SECURITY,
      is_honeypot: true,
      is_open_source: false,
      open_source: 0,
      flags: ["honeypot"],
    });
    assert.deepEqual(summary.flags, ["honeypot", "not_open_source"]);
  });

  it("reads a non-object payload as unavailable", () => {
    assert.equal(normalizeGmgnSecurity(null).riskLevel, "unavailable");
    assert.equal(normalizeGmgnSecurity([1, 2]).riskLevel, "unavailable");
  });
});

describe("fetchGmgnTokenHolders", () => {
  it("combines the holder count and top-10 concentration", async () => {
    setKey();
    const fake = fakeFetch((call) =>
      new URL(call.url).pathname === "/v1/token/info"
        ? jsonResponse({ code: 0, data: { holder_count: 22869 } })
        : jsonResponse({
            code: 0,
            data: { list: [{ amount_percentage: 0.6 }, { amount_percentage: 0.2 }] },
          }),
    );

    const stats = await fetchGmgnTokenHolders({ address: ADDRESS, fetchFn: fake.fetch });
    assert.equal(stats.holders, 22869);
    assert.equal(stats.top10Pct, 80);
    assert.equal(stats.smartMoneyCount, null);
    assert.equal(stats.source, "gmgn");
  });

  it("keeps the half that succeeded when one endpoint fails", async () => {
    setKey();
    const fake = fakeFetch((call) =>
      new URL(call.url).pathname === "/v1/token/info"
        ? jsonResponse({ code: 0, data: { holder_count: 500 } })
        : jsonResponse({}, 500),
    );

    const stats = await fetchGmgnTokenHolders({ address: ADDRESS, fetchFn: fake.fetch });
    assert.equal(stats.holders, 500);
    assert.equal(stats.top10Pct, null);
  });

  it("fails only when both endpoints fail", async () => {
    setKey();
    const fake = fakeFetch(() => jsonResponse({}, 500));
    await assert.rejects(
      () => fetchGmgnTokenHolders({ address: ADDRESS, fetchFn: fake.fetch }),
      /upstream responded 500/u,
    );
  });

  it("reports an unknown holder count as null, never as zero", async () => {
    setKey();
    const fake = fakeFetch(() =>
      jsonResponse({ code: 0, data: { holder_count: 0, list: [] } }),
    );
    const stats = await fetchGmgnTokenHolders({ address: ADDRESS, fetchFn: fake.fetch });
    assert.equal(stats.holders, null);
    assert.equal(stats.top10Pct, null);
  });
});

describe("fetchGmgnSmartMoney", () => {
  it("counts tagged holders and asks for the smart-money tag", async () => {
    setKey();
    const fake = fakeFetch(() =>
      jsonResponse({ code: 0, data: { list: [{ address: "0x1" }, { address: "0x2" }] } }),
    );

    const stats = await fetchGmgnSmartMoney({ address: ADDRESS, fetchFn: fake.fetch });
    const url = new URL(fake.calls[0]?.url ?? "https://example.invalid");
    assert.equal(url.searchParams.get("tag"), "smart_degen");
    assert.equal(stats.smartMoneyCount, 2);
    // The other fields belong to the holder read and must stay unclaimed.
    assert.equal(stats.holders, null);
    assert.equal(stats.top10Pct, null);
  });

  it("reports zero smart money for an empty list", async () => {
    setKey();
    const fake = fakeFetch(() => jsonResponse({ code: 0, data: { list: [] } }));
    const stats = await fetchGmgnSmartMoney({ address: ADDRESS, fetchFn: fake.fetch });
    assert.equal(stats.smartMoneyCount, 0);
  });

  it("leaves the count unknown for a token GMGN has never seen", async () => {
    setKey();
    const fake = fakeFetch(() => jsonResponse({}, 404));
    const stats = await fetchGmgnSmartMoney({ address: ADDRESS, fetchFn: fake.fetch });
    assert.equal(stats.smartMoneyCount, null);
  });
});
