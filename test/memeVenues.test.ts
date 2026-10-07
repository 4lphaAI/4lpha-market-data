import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FlapDividend, FlapMarketState } from "../src/adapters/flap.js";
import type { MemeLaunchpad } from "../src/adapters/binanceWeb3.js";
import { MemoryStore } from "../src/core/store.js";
import { CODE_READS_PER_CYCLE, MEME_VENUES_KEY, refreshVenues, type VenueCandidate } from "../src/jobs/memeVenues.js";
import { fromFlapState, type LaunchpadState } from "../src/query/launchpadState.js";
import type { MemeStatus } from "../src/query/memeClassify.js";
import { FOURMEME_TEMPLATES, type FourMemeCode, type FourMemeTaxRead } from "../src/query/fourmemeTax.js";

const NOW = 1_791_120_000_000;
const MIN = 60_000;
const ZERO = "0x0000000000000000000000000000000000000000";
const POOL = "0xe88701d7f67bd8f020cdf0f3bfda36b53c5200d0";
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";

function addr(n: number): string {
  return `0x${n.toString(16).padStart(40, "0")}`;
}

function lens(overrides: Partial<FlapMarketState> = {}): FlapMarketState {
  return {
    status: 1, tokenVersion: 6, progress: "500000000000000000", quote: NVDAB, pool: ZERO,
    buyTaxBps: 300, sellTaxBps: 200, nativeToQuoteSwapEnabled: true,
    ...overrides,
  };
}

describe("fromFlapState", () => {
  it("maps the lens status to the venue the eligibility gate would route to", () => {
    const bonding = fromFlapState(lens());
    assert.equal(bonding.venue, "flap-bonding");
    assert.equal(bonding.pool, null, "the zero address is no pool");
    assert.deepEqual(bonding.tax, { buyBps: 300, sellBps: 200 });
    assert.equal(bonding.nativeToQuoteSwapEnabled, true);
    assert.equal(bonding.progress, 50);
    const graduated = fromFlapState(lens({ status: 4, pool: POOL, progress: "1000000000000000000" }));
    assert.equal(graduated.venue, "pancake-v2");
    assert.equal(graduated.pool, POOL);
    assert.equal(graduated.migrated, true);
    for (const status of [0, 2, 3, 5]) assert.equal(fromFlapState(lens({ status })).venue, null, `status ${status}`);
  });
});

interface Harness {
  store: MemoryStore;
  stateReads: string[][];
  dividendReads: string[][];
  states: Map<string, LaunchpadState>;
  dividends: Map<string, FlapDividend> | Error;
  codeReads: string[][];
  taxReads: string[][];
  codes: Map<string, FourMemeCode> | Error;
  taxes: Map<string, FourMemeTaxRead> | Error;
  run: (now: number, candidates: VenueCandidate[], known?: Map<string, LaunchpadState>) => ReturnType<typeof refreshVenues>;
}

function harness(): Harness {
  const h: Harness = {
    store: new MemoryStore(() => NOW),
    stateReads: [],
    dividendReads: [],
    states: new Map(),
    dividends: new Map(),
    codeReads: [],
    taxReads: [],
    codes: new Map(),
    taxes: new Map(),
    run: (now, candidates, known = new Map()) =>
      refreshVenues(h.store, candidates, known, {
        now,
        signal: AbortSignal.timeout(5_000),
        readStates: async (items) => {
          h.stateReads.push(items.map((item) => item.address));
          return new Map(items.flatMap((item) => {
            const state = h.states.get(item.address);
            return state === undefined ? [] : [[item.address, state] as const];
          }));
        },
        readDividends: async (addresses) => {
          h.dividendReads.push([...addresses]);
          if (h.dividends instanceof Error) throw h.dividends;
          return h.dividends;
        },
        readFourMemeCodes: async (addresses) => {
          h.codeReads.push([...addresses]);
          if (h.codes instanceof Error) throw h.codes;
          const codes = h.codes;
          return new Map(addresses.flatMap((a) => (codes.has(a) ? [[a, codes.get(a)!] as const] : [])));
        },
        readFourMemeTaxes: async (items) => {
          h.taxReads.push(items.map((item) => item.address));
          if (h.taxes instanceof Error) throw h.taxes;
          const taxes = h.taxes;
          return new Map(items.flatMap((item) => (taxes.has(item.address) ? [[item.address, taxes.get(item.address)!] as const] : [])));
        },
      }),
  };
  return h;
}

const candidate = (n: number, launchpad: MemeLaunchpad, status: MemeStatus | undefined): VenueCandidate => ({
  address: addr(n),
  launchpad,
  status,
});

const fourMeme = (migrated: boolean): LaunchpadState => ({
  migrated, progress: migrated ? 100 : 40, quote: ZERO, launchedAt: null,
  venue: migrated ? "pancake-v2" : "fourmeme-bonding", pool: null, tax: null, nativeToQuoteSwapEnabled: null,
});

describe("refreshVenues", () => {
  it("reads every new token, Flap and Four.Meme, and reads a Flap dividend once", async () => {
    const h = harness();
    h.states.set(addr(1), fromFlapState(lens()));
    h.states.set(addr(2), fourMeme(false));
    h.dividends = new Map([[addr(1), { token: NVDAB, bps: 10_000 }]]);
    const { venues } = await h.run(NOW, [candidate(1, "flap", undefined), candidate(2, "fourmeme", undefined)]);
    assert.equal(venues.get(addr(1))?.venue, "flap-bonding");
    assert.deepEqual(venues.get(addr(1))?.dividend, { token: NVDAB, bps: 10_000 });
    assert.equal(venues.get(addr(2))?.venue, "fourmeme-bonding");
    assert.equal(venues.get(addr(2))?.tax, null, "Four.Meme tax is unknown, not zero");
    assert.deepEqual(h.dividendReads, [[addr(1)]], "no dividend read for Four.Meme");

    await h.run(NOW + MIN, [candidate(1, "flap", "active"), candidate(2, "fourmeme", "active")]);
    assert.deepEqual(h.dividendReads, [[addr(1)]], "the dividend is fixed at launch: never read again");
    assert.ok((await h.store.get(MEME_VENUES_KEY)) !== null);
  });

  it("re-reads a live curve token every cycle, an idle one after 10 minutes, a graduated one after 30", async () => {
    const h = harness();
    h.states.set(addr(1), fromFlapState(lens()));
    h.states.set(addr(2), fromFlapState(lens()));
    h.states.set(addr(3), fromFlapState(lens({ status: 4, pool: POOL })));
    const at = (status1: MemeStatus, status2: MemeStatus) => [
      candidate(1, "flap", status1), candidate(2, "flap", status2), candidate(3, "flap", "active"),
    ];
    await h.run(NOW, at("active", "quiet"));
    assert.deepEqual(h.stateReads.at(-1), [addr(1), addr(2), addr(3)]);
    await h.run(NOW + MIN, at("runner", "quiet"));
    assert.deepEqual(h.stateReads.at(-1), [addr(1)]);
    await h.run(NOW + 10 * MIN, at("fading", "dead"));
    assert.deepEqual(h.stateReads.at(-1), [addr(1), addr(2)]);
    await h.run(NOW + 20 * MIN, at("active", "quiet"));
    assert.deepEqual(h.stateReads.at(-1), [addr(1), addr(2)], "graduated: not yet");
    await h.run(NOW + 30 * MIN, at("active", "quiet"));
    assert.ok(h.stateReads.at(-1)?.includes(addr(3)), "a Flap tax can expire, so graduated rows are re-read");
  });

  it("picks up graduation on the next cycle", async () => {
    const h = harness();
    h.states.set(addr(1), fromFlapState(lens()));
    await h.run(NOW, [candidate(1, "flap", "runner")]);
    h.states.set(addr(1), fromFlapState(lens({ status: 4, pool: POOL })));
    const { venues } = await h.run(NOW + MIN, [candidate(1, "flap", "runner")]);
    assert.equal(venues.get(addr(1))?.venue, "pancake-v2");
    assert.equal(venues.get(addr(1))?.pool, POOL);
    assert.equal(venues.get(addr(1))?.checkedAt, NOW + MIN);
  });

  it("keeps the cached answer when a read misses, and retries a failed dividend read", async () => {
    const h = harness();
    h.states.set(addr(1), fromFlapState(lens()));
    h.dividends = new Error("rpc 429");
    const first = await h.run(NOW, [candidate(1, "flap", "active")]);
    assert.ok(first.failures.some((f) => f.startsWith("dividend:")));
    assert.equal(first.venues.get(addr(1))?.dividend, null);
    h.states.clear(); // the next lens read answers nothing
    h.dividends = new Map([[addr(1), { token: ZERO, bps: 0 }]]);
    const second = await h.run(NOW + MIN, [candidate(1, "flap", "active")]);
    assert.equal(second.venues.get(addr(1))?.venue, "flap-bonding", "cached venue kept");
    assert.equal(second.venues.get(addr(1))?.checkedAt, NOW, "still dated by the read that answered");
    assert.deepEqual(second.venues.get(addr(1))?.dividend, { token: ZERO, bps: 0 });
  });

  it("reuses states already read this cycle and drops tokens no longer tracked", async () => {
    const h = harness();
    h.states.set(addr(2), fromFlapState(lens()));
    await h.run(NOW, [candidate(2, "flap", "active")]);
    const known = new Map([[addr(1), fourMeme(true)]]);
    const { venues } = await h.run(NOW + MIN, [candidate(1, "fourmeme", undefined)], known);
    assert.deepEqual(h.stateReads.length, 1, "no read: the only candidate was already known");
    assert.equal(venues.get(addr(1))?.venue, "pancake-v2");
    assert.equal(venues.has(addr(2)), false);
  });

  describe("Four.Meme tax (FOURMEME-TAX-SPEC.md)", () => {
    const template = (id: string) => FOURMEME_TEMPLATES.find((t) => t.id === id)!;
    const proven = (id: string): FourMemeCode => ({ code: template(id).code, creatorType: template(id).creatorType });
    const PAIR = "0xf712b9d6c2ca0e3323be4cf2d24e12c4d88ba4ec";

    it("fills tax and pool on a graduated proven template, stamped with the venue read", async () => {
      const h = harness();
      h.states.set(addr(1), fourMeme(true));
      h.codes = new Map([[addr(1), proven("tax9-7330")]]);
      h.taxes = new Map([[addr(1), { tax: { buyBps: 100, sellBps: 100 }, pool: PAIR }]]);
      const { venues } = await h.run(NOW, [candidate(1, "fourmeme", "active")]);
      const entry = venues.get(addr(1))!;
      assert.equal(entry.venue, "pancake-v2");
      assert.deepEqual(entry.tax, { buyBps: 100, sellBps: 100 });
      assert.equal(entry.pool, PAIR);
      assert.equal(entry.checkedAt, NOW);
      assert.deepEqual(entry.fourmemeCode, proven("tax9-7330"));
    });

    it("publishes a curve tax only for a curve-proven template, always with pool null (FOURMEME-CURVE-PAPER-SPEC 5.1)", async () => {
      const h = harness();
      const ids = ["tax9-7330", "plain-4686", "tax9-2812", "tax8-13584", "tax5-10456"];
      ids.forEach((id, i) => {
        h.states.set(addr(i + 1), fourMeme(false));
        (h.codes as Map<string, FourMemeCode>).set(addr(i + 1), proven(id));
      });
      h.states.set(addr(6), fourMeme(true));
      (h.codes as Map<string, FourMemeCode>).set(addr(6), proven("tax9-7330"));
      h.taxes = new Map([
        [addr(1), { tax: { buyBps: 100, sellBps: 100 }, pool: PAIR }], // a non-zero pair() on a curve row
        [addr(2), { tax: { buyBps: 0, sellBps: 0 }, pool: null }],
        [addr(3), { tax: { buyBps: 100, sellBps: 100 }, pool: PAIR }],
        [addr(4), { tax: { buyBps: 100, sellBps: 100 }, pool: PAIR }],
        [addr(5), { tax: { buyBps: 100, sellBps: 100 }, pool: PAIR }],
        [addr(6), { tax: { buyBps: 100, sellBps: 100 }, pool: PAIR }],
      ]);
      const { venues } = await h.run(NOW, [1, 2, 3, 4, 5, 6].map((n) => candidate(n, "fourmeme", "active")));
      assert.equal(venues.get(addr(1))?.venue, "fourmeme-bonding");
      assert.deepEqual(venues.get(addr(1))?.tax, { buyBps: 100, sellBps: 100 });
      assert.equal(venues.get(addr(1))?.pool, null, "the curve has no pair, whatever pair() answers");
      assert.deepEqual(venues.get(addr(2))?.tax, { buyBps: 0, sellBps: 0 });
      assert.equal(venues.get(addr(2))?.pool, null);
      for (const n of [3, 4, 5]) {
        assert.equal(venues.get(addr(n))?.tax, null, `${ids[n - 1]} is not proven on the curve`);
        assert.equal(venues.get(addr(n))?.pool, null);
      }
      assert.deepEqual([...h.taxReads[0]!].sort(), [addr(1), addr(2), addr(6)], "unproven curve templates are never read");
      assert.deepEqual(venues.get(addr(6))?.tax, { buyBps: 100, sellBps: 100 });
      assert.equal(venues.get(addr(6))?.pool, PAIR, "graduated rows keep their pair");
    });

    it("re-reads curve rates every 5 minutes and carries the answered tax in between (spec F15)", async () => {
      const h = harness();
      h.states.set(addr(1), fourMeme(false));
      h.codes = new Map([[addr(1), proven("tax9-7330")]]);
      h.taxes = new Map([[addr(1), { tax: { buyBps: 100, sellBps: 100 }, pool: null }]]);
      const at = (status: MemeStatus) => [candidate(1, "fourmeme", status)];
      await h.run(NOW, at("active"));
      assert.equal(h.taxReads.length, 1);
      const early = await h.run(NOW + 5 * MIN - 1_000, at("active"));
      assert.equal(h.taxReads.length, 1, "4 min 59 s after an answered read: no rate call");
      assert.deepEqual(early.venues.get(addr(1))?.tax, { buyBps: 100, sellBps: 100 });
      assert.equal(early.venues.get(addr(1))?.checkedAt, NOW + 5 * MIN - 1_000);
      const due = await h.run(NOW + 5 * MIN, at("active"));
      assert.equal(h.taxReads.length, 2, "5 min: read again");
      assert.equal(due.venues.get(addr(1))?.fourmemeTaxReadAt, NOW + 5 * MIN);
    });

    it("keeps the carried curve tax through failed reads for under 10 minutes, then publishes null", async () => {
      const h = harness();
      h.states.set(addr(1), fourMeme(false));
      h.codes = new Map([[addr(1), proven("tax9-7330")]]);
      h.taxes = new Map([[addr(1), { tax: { buyBps: 100, sellBps: 100 }, pool: null }]]);
      const at = (status: MemeStatus) => [candidate(1, "fourmeme", status)];
      await h.run(NOW, at("active"));
      h.taxes = new Error("timeout");
      const failed = await h.run(NOW + 5 * MIN, at("active"));
      assert.ok(failed.failures.some((f) => f.startsWith("fourmeme tax:")));
      assert.deepEqual(failed.venues.get(addr(1))?.tax, { buyBps: 100, sellBps: 100 }, "one failure never blanks a curve row");
      const reads = h.stateReads.length;
      const quiet = await h.run(NOW + 6 * MIN, at("quiet"));
      assert.equal(h.stateReads.length, reads + 1, "due next cycle, also when quiet");
      assert.equal(h.taxReads.length, 3);
      assert.deepEqual(quiet.venues.get(addr(1))?.tax, { buyBps: 100, sellBps: 100 });
      const last = await h.run(NOW + 10 * MIN - 1_000, at("quiet"));
      assert.deepEqual(last.venues.get(addr(1))?.tax, { buyBps: 100, sellBps: 100 }, "9 min 59 s: still carried");
      const expired = await h.run(NOW + 10 * MIN, at("quiet"));
      assert.equal(expired.venues.get(addr(1))?.tax, null, "10 min with no answer");
      assert.equal(expired.venues.get(addr(1))?.checkedAt, NOW + 10 * MIN);
      h.taxes = new Map([[addr(1), { tax: { buyBps: 100, sellBps: 100 }, pool: null }]]);
      const back = await h.run(NOW + 10 * MIN + 30_000, at("quiet"));
      assert.deepEqual(back.venues.get(addr(1))?.tax, { buyBps: 100, sellBps: 100 }, "a null curve tax is retried next cycle");
    });

    it("reads the graduated rates in the cycle a curve row graduates", async () => {
      const h = harness();
      h.states.set(addr(1), fourMeme(false));
      h.codes = new Map([[addr(1), proven("tax9-7330")]]);
      h.taxes = new Map([[addr(1), { tax: { buyBps: 100, sellBps: 100 }, pool: null }]]);
      await h.run(NOW, [candidate(1, "fourmeme", "runner")]);
      h.states.set(addr(1), fourMeme(true));
      h.taxes = new Map([[addr(1), { tax: { buyBps: 300, sellBps: 300 }, pool: PAIR }]]);
      const { venues } = await h.run(NOW + MIN, [candidate(1, "fourmeme", "runner")]);
      assert.equal(h.taxReads.length, 2, "the carry never crosses a venue change");
      assert.equal(venues.get(addr(1))?.venue, "pancake-v2");
      assert.deepEqual(venues.get(addr(1))?.tax, { buyBps: 300, sellBps: 300 });
      assert.equal(venues.get(addr(1))?.pool, PAIR);
    });

    it("reads graduated identities before curve ones under the per-cycle cap (spec 5.4)", async () => {
      const h = harness();
      const candidates: VenueCandidate[] = [];
      for (let n = 1; n <= CODE_READS_PER_CYCLE; n += 1) {
        h.states.set(addr(n), fourMeme(false));
        candidates.push(candidate(n, "fourmeme", "active"));
      }
      const graduated = CODE_READS_PER_CYCLE + 1;
      h.states.set(addr(graduated), fourMeme(true));
      candidates.push(candidate(graduated, "fourmeme", "active"));
      await h.run(NOW, candidates);
      assert.equal(h.codeReads[0]?.length, CODE_READS_PER_CYCLE);
      assert.equal(h.codeReads[0]?.[0], addr(graduated), "the graduated row is read in the first cycle");
    });

    it("reads the code identity once, ever, and re-reads the rates with the venue", async () => {
      const h = harness();
      h.states.set(addr(1), fourMeme(true));
      h.codes = new Map([[addr(1), proven("tax8-13584")]]);
      h.taxes = new Map([[addr(1), { tax: { buyBps: 100, sellBps: 500 }, pool: PAIR }]]);
      await h.run(NOW, [candidate(1, "fourmeme", "active")]);
      await h.run(NOW + 30 * MIN, [candidate(1, "fourmeme", "active")]);
      assert.deepEqual(h.codeReads, [[addr(1)]], "identity is permanent");
      assert.deepEqual(h.taxReads, [[addr(1)], [addr(1)]], "rates follow the 30 minute graduated cadence");
      const cached = (await h.store.get<Record<string, { fourmemeCode?: FourMemeCode }>>(MEME_VENUES_KEY))!.data;
      assert.deepEqual(cached[addr(1)]?.fourmemeCode, proven("tax8-13584"), "the identity survives the cache round trip");
    });

    it("never stores a failed identity read and retries it next cycle", async () => {
      const h = harness();
      h.states.set(addr(1), fourMeme(true));
      h.codes = new Error("rpc 429");
      const first = await h.run(NOW, [candidate(1, "fourmeme", "active")]);
      assert.ok(first.failures.some((f) => f.startsWith("fourmeme code:")));
      assert.equal(first.venues.get(addr(1))?.tax, null);
      assert.equal(first.venues.get(addr(1))?.fourmemeCode, undefined);
      assert.deepEqual(h.taxReads, [], "no template, no rate read");
      h.codes = new Map([[addr(1), proven("tax9-7330")]]);
      h.taxes = new Map([[addr(1), { tax: { buyBps: 300, sellBps: 300 }, pool: PAIR }]]);
      const second = await h.run(NOW + MIN, [candidate(1, "fourmeme", "active")]);
      assert.deepEqual(second.venues.get(addr(1))?.tax, { buyBps: 300, sellBps: 300 }, "due next cycle, not in 30 minutes");
    });

    it("turns a failed rate read into null with the new stamp, then retries next cycle", async () => {
      const h = harness();
      h.states.set(addr(1), fourMeme(true));
      h.codes = new Map([[addr(1), proven("tax9-7330")]]);
      h.taxes = new Map([[addr(1), { tax: { buyBps: 100, sellBps: 100 }, pool: PAIR }]]);
      await h.run(NOW, [candidate(1, "fourmeme", "active")]);
      h.taxes = new Error("timeout");
      const failed = await h.run(NOW + 30 * MIN, [candidate(1, "fourmeme", "active")]);
      assert.ok(failed.failures.some((f) => f.startsWith("fourmeme tax:")));
      assert.equal(failed.venues.get(addr(1))?.tax, null, "a timeout is unknown, never the previous rate under a new stamp");
      assert.equal(failed.venues.get(addr(1))?.pool, null);
      assert.equal(failed.venues.get(addr(1))?.checkedAt, NOW + 30 * MIN);
      h.taxes = new Map([[addr(1), { tax: { buyBps: 100, sellBps: 100 }, pool: PAIR }]]);
      const retried = await h.run(NOW + 31 * MIN, [candidate(1, "fourmeme", "active")]);
      assert.deepEqual(retried.venues.get(addr(1))?.tax, { buyBps: 100, sellBps: 100 });
    });

    it("keeps an unrecognised template null without re-reading it every cycle", async () => {
      const h = harness();
      h.states.set(addr(1), fourMeme(true));
      h.codes = new Map([[addr(1), { code: "proxy:0x1111111111111111111111111111111111111111", creatorType: 9 }]]);
      const first = await h.run(NOW, [candidate(1, "fourmeme", "active")]);
      assert.equal(first.venues.get(addr(1))?.tax, null);
      assert.deepEqual(h.taxReads, []);
      await h.run(NOW + MIN, [candidate(1, "fourmeme", "active")]);
      assert.equal(h.stateReads.length, 1, "graduated and unrecognised: back on the 30 minute cadence");
    });

    it("reads a hot-only token's tax from the state the board already read", async () => {
      const h = harness();
      h.codes = new Map([[addr(1), proven("plain-3822")]]);
      h.taxes = new Map([[addr(1), { tax: { buyBps: 0, sellBps: 0 }, pool: null }]]);
      const { venues } = await h.run(NOW, [candidate(1, "fourmeme", undefined)], new Map([[addr(1), fourMeme(true)]]));
      assert.deepEqual(h.stateReads, []);
      assert.deepEqual(venues.get(addr(1))?.tax, { buyBps: 0, sellBps: 0 });
    });

    it("reports a rate out of range and does not re-read it every cycle (audit L2)", async () => {
      const h = harness();
      h.states.set(addr(1), fourMeme(true));
      h.codes = new Map([[addr(1), proven("tax9-7330")]]);
      h.taxes = new Map([[addr(1), { tax: null, pool: PAIR }]]);
      const first = await h.run(NOW, [candidate(1, "fourmeme", "active")]);
      assert.equal(first.venues.get(addr(1))?.tax, null);
      assert.ok(first.failures.some((f) => f.includes("out of range")));
      await h.run(NOW + MIN, [candidate(1, "fourmeme", "active")]);
      assert.equal(h.stateReads.length, 1, "an answered null waits for the 30 minute cadence");
    });

    it("keeps an unanswered token pending while its neighbour is answered", async () => {
      const h = harness();
      h.states.set(addr(1), fourMeme(true));
      h.states.set(addr(2), fourMeme(true));
      h.codes = new Map([[addr(1), proven("tax9-7330")], [addr(2), proven("tax9-7330")]]);
      h.taxes = new Map([[addr(1), { tax: { buyBps: 100, sellBps: 100 }, pool: PAIR }]]);
      const first = await h.run(NOW, [candidate(1, "fourmeme", "active"), candidate(2, "fourmeme", "active")]);
      assert.equal(first.venues.get(addr(2))?.tax, null);
      assert.ok(first.failures.includes("fourmeme tax: 1 of 2 unread"));
      await h.run(NOW + MIN, [candidate(1, "fourmeme", "active"), candidate(2, "fourmeme", "active")]);
      assert.deepEqual(h.stateReads.at(-1), [addr(2)], "only the unanswered one is due again");
    });

    it("leaves Flap rows to the lens", async () => {
      const h = harness();
      h.states.set(addr(1), fromFlapState(lens({ status: 4, pool: POOL })));
      const { venues } = await h.run(NOW, [candidate(1, "flap", "active")]);
      assert.deepEqual(venues.get(addr(1))?.tax, { buyBps: 300, sellBps: 200 });
      assert.equal(venues.get(addr(1))?.pool, POOL);
      assert.deepEqual(h.codeReads, []);
      assert.deepEqual(h.taxReads, []);
    });
  });
});
