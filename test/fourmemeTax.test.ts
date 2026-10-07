import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256 } from "viem";
import {
  FOURMEME_TEMPLATES,
  codeIdentity,
  creatorTypeOf,
  matchFourMemeTemplate,
  taxFromRates,
  type FourMemeTemplate,
} from "../src/query/fourmemeTax.js";

const IMPL = "7330d8865f4b6800b72bdd73e2007833a5d45c94";
/** The runtime code of a live Four.Meme TaxToken9 clone (0x48d8dfed...ffff). */
const CLONE = `0x363d3d373d3d3d363d73${IMPL}5af43d82803e903d91602b57fd5bf3`;
const TOKEN = "0x48d8dfed649c097265680b650c1efbc8af42ffff";

const template = (id: string): FourMemeTemplate => FOURMEME_TEMPLATES.find((t) => t.id === id)!;
const none = { feeRate: null, feeRateBuy: null, feeRateSell: null };

describe("codeIdentity", () => {
  it("names an EIP-1167 clone by its implementation and anything else by its hash", () => {
    assert.equal(codeIdentity(CLONE), `proxy:0x${IMPL}`);
    assert.equal(codeIdentity(CLONE.toUpperCase().replace("0X", "0x")), `proxy:0x${IMPL}`);
    const code = "0x6080604052";
    assert.equal(codeIdentity(code), `hash:${keccak256(code)}`);
    assert.equal(codeIdentity("0x"), "none");
    assert.equal(codeIdentity(undefined), "none");
  });

  it("does not read a near-clone as a clone", () => {
    assert.match(codeIdentity(`${CLONE}00`), /^hash:/);
  });
});

describe("creatorTypeOf", () => {
  it("decodes (template >> 10) & 0x3F, and only for a token TokenManager2 holds", () => {
    assert.equal(creatorTypeOf(TOKEN, { base: TOKEN.toUpperCase().replace("0X", "0x"), template: (9n << 10n) | 0x3ffn }), 9);
    assert.equal(creatorTypeOf(TOKEN, { base: TOKEN, template: 0n }), 0);
    assert.equal(creatorTypeOf(TOKEN, { base: "0x0000000000000000000000000000000000000000", template: 9n << 10n }), null);
  });
});

describe("matchFourMemeTemplate", () => {
  it("needs both facts to agree", () => {
    assert.equal(matchFourMemeTemplate({ code: `proxy:0x${IMPL}`, creatorType: 9 })?.id, "tax9-7330");
    assert.equal(matchFourMemeTemplate({ code: `proxy:0x${IMPL}`, creatorType: 8 }), null, "creator type disagrees with the code");
    assert.equal(matchFourMemeTemplate({ code: `proxy:0x${IMPL}`, creatorType: null }), null, "TokenManager2 does not hold it");
    assert.equal(matchFourMemeTemplate({ code: "proxy:0x1111111111111111111111111111111111111111", creatorType: 9 }), null, "unknown implementation");
    assert.equal(matchFourMemeTemplate({ code: "none", creatorType: 0 }), null);
  });

  it("marks curve-proven exactly the templates whose curve proof passed (G0a, G0b)", () => {
    assert.deepEqual(FOURMEME_TEMPLATES.filter((t) => t.curve).map((t) => t.id), ["tax9-7330", "plain-4686"]);
  });

  it("lists each proven identity once", () => {
    const codes = FOURMEME_TEMPLATES.map((t) => t.code);
    assert.equal(new Set(codes).size, codes.length);
  });
});

describe("taxFromRates", () => {
  it("reads types 8 and 9 in percent per direction, never the deprecated feeRate", () => {
    // 0xa87e...ffff on chain: feeRate 0, feeRateBuy 2, feeRateSell 4; swaps charged 200 and 400 bps.
    assert.deepEqual(taxFromRates(template("tax9-7330"), { feeRate: 0n, feeRateBuy: 2n, feeRateSell: 4n }), { buyBps: 200, sellBps: 400 });
    assert.deepEqual(taxFromRates(template("tax8-13584"), { feeRate: 0n, feeRateBuy: 1n, feeRateSell: 5n }), { buyBps: 100, sellBps: 500 });
    assert.deepEqual(taxFromRates(template("tax9-7330"), { feeRate: 0n, feeRateBuy: 0n, feeRateSell: 0n }), { buyBps: 0, sellBps: 0 });
  });

  it("reads type 5 as one bps rate for both directions", () => {
    assert.deepEqual(taxFromRates(template("tax5-10456"), { feeRate: 300n, feeRateBuy: null, feeRateSell: null }), { buyBps: 300, sellBps: 300 });
  });

  it("gives a proven plain template zero without reading anything", () => {
    assert.deepEqual(taxFromRates(template("plain-3822"), none), { buyBps: 0, sellBps: 0 });
    assert.deepEqual(taxFromRates(template("plain-4686"), none), { buyBps: 0, sellBps: 0 });
  });

  it("fails closed on a missing or out-of-range rate", () => {
    const pct = template("tax9-7330");
    assert.equal(taxFromRates(pct, none), null, "both views reverted");
    assert.equal(taxFromRates(pct, { feeRate: 0n, feeRateBuy: 1n, feeRateSell: null }), null, "one side missing");
    assert.equal(taxFromRates(pct, { feeRate: 0n, feeRateBuy: 11n, feeRateSell: 1n }), null, "above the documented 10%");
    assert.equal(taxFromRates(pct, { feeRate: 100n, feeRateBuy: null, feeRateSell: null }), null, "feeRate never stands in");
    const bps = template("tax5-10456");
    assert.equal(taxFromRates(bps, none), null);
    assert.equal(taxFromRates(bps, { feeRate: 1_001n, feeRateBuy: null, feeRateSell: null }), null);
  });
});
