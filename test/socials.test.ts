import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStore } from "../src/core/store.js";
import { normalizeSocials, type TokenSocials } from "../src/adapters/fourmeme.js";
import {
  SOCIALS_DEAD_AFTER_MS,
  getSocials,
  socialsKey,
} from "../src/query/socials.js";

const TOKEN = "0x0def65862204710b5a13095c53345b454bebffff";

function links(over: Partial<TokenSocials> = {}): TokenSocials {
  return {
    address: TOKEN,
    website: "https://qan.xyz/",
    twitter: "https://x.com/QanChain",
    telegram: "https://t.me/QANXYZ",
    description: "A quantum-resistant Layer 1 blockchain.",
    ...over,
  };
}

describe("normalizeSocials", () => {
  it("reads the measured detail payload shape", () => {
    // Shaped from the live response of `private/token/get/v2` (2026-08-12).
    const payload = {
      code: 0,
      msg: "success",
      data: {
        address: TOKEN,
        webUrl: "https://qan.xyz/",
        telegramUrl: "https://t.me/QANXYZ",
        twitterUrl: "https://x.com/QanChain",
        descr: "A quantum-resistant Layer 1 blockchain.",
      },
    };
    const result = normalizeSocials(TOKEN, payload);
    assert.deepEqual(result, links());
  });

  it("answers null for the measured unknown-token shape", () => {
    // Measured: an address Four.Meme never launched answers success with no
    // `data` at all — a definite negative, not an error.
    assert.equal(normalizeSocials(TOKEN, { code: 0, msg: "success" }), null);
  });

  it("rejects non-http links, which creators can and do paste in", () => {
    const payload = {
      code: 0,
      data: { webUrl: "javascript:alert(1)", twitterUrl: "not a url", telegramUrl: "" },
    };
    const result = normalizeSocials(TOKEN, payload);
    assert.equal(result?.website, null);
    assert.equal(result?.twitter, null);
    assert.equal(result?.telegram, null);
  });
});

describe("getSocials", () => {
  it("fetches, caches, and serves the cache without re-dialing", async () => {
    const store = new MemoryStore();
    let dials = 0;
    const fetchSocials = async (): Promise<TokenSocials> => {
      dials += 1;
      return links();
    };

    const first = await getSocials(store, { address: TOKEN, fetchSocials });
    const second = await getSocials(store, { address: TOKEN, fetchSocials });

    assert.equal(dials, 1);
    assert.equal(first?.socials.twitter, "https://x.com/QanChain");
    assert.equal(second?.staleness, "fresh");
  });

  it("caches a definite negative so unknown addresses stop dialing upstream", async () => {
    const store = new MemoryStore();
    let dials = 0;
    const fetchSocials = async (): Promise<TokenSocials | null> => {
      dials += 1;
      return null;
    };

    const first = await getSocials(store, { address: TOKEN, fetchSocials });
    const second = await getSocials(store, { address: TOKEN, fetchSocials });

    assert.equal(dials, 1);
    assert.equal(first?.socials.website, null);
    assert.equal(second?.socials.twitter, null);
  });

  it("serves the stale record when the upstream fails", async () => {
    const store = new MemoryStore();
    await store.put(socialsKey(TOKEN), links(), {
      source: "fourmeme",
      freshForMs: 0,
      deadAfterMs: SOCIALS_DEAD_AFTER_MS,
    });

    const result = await getSocials(store, {
      address: TOKEN,
      fetchSocials: async () => {
        throw new Error("upstream down");
      },
    });
    assert.equal(result?.socials.website, "https://qan.xyz/");
    assert.equal(result?.staleness, "stale");
  });

  it("returns null for a malformed address without dialing", async () => {
    const result = await getSocials(new MemoryStore(), {
      address: "nonsense",
      fetchSocials: async () => {
        assert.fail("must not dial");
      },
    });
    assert.equal(result, null);
  });
});
