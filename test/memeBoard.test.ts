import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeMemeRush, type MemeRushRow, type MemeRushStage } from "../src/adapters/binanceWeb3.js";
import { normalizeActivityRows, normalizeSignals, type SmartSignal, type TokenActivity } from "../src/adapters/onchainos.js";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import { MEME_BOARD_KEY, MEME_STATE_KEY, runMemeBoard } from "../src/jobs/memeBoard.js";
import {
  MEME_RULES,
  classifyMeme,
  classifyStage,
  classifyStatus,
  findClones,
  type ClassifyInput,
  type MemeBoardRow,
} from "../src/query/memeClassify.js";
import { QUOTE_KINDS_KEY, resolveQuoteKinds, type QuoteKind } from "../src/query/quoteKind.js";
import { createServer } from "../src/server.js";

const NOW = 1_791_120_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const BNB = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const BNCB = "0x4902c5ebc598265ed2212b559b042de8a5eeec3f";

function addr(n: number): string {
  return `0x${n.toString(16).padStart(40, "0")}`;
}

function rush(overrides: Partial<MemeRushRow> = {}): MemeRushRow {
  return {
    address: addr(1),
    symbol: "MEME",
    name: "Meme",
    launchpad: "flap",
    stage: "finalizing",
    createdAt: NOW - 3 * HOUR,
    progress: 40,
    migrated: false,
    migratedAt: null,
    quote: BNB,
    priceUsd: 0.0001,
    marketCapUsd: 50_000,
    liquidityUsd: 10_000,
    volume24hUsd: 20_000,
    priceChange24hPct: 10,
    holders: 200,
    count24h: 500,
    buys24h: 300,
    sells24h: 200,
    netBuy24hUsd: 1_000,
    top10Pct: 20,
    devPct: 0,
    sniperPct: 5,
    insiderPct: 0,
    bundlerPct: 0,
    newWalletPct: 1,
    smartMoneyHolders: 0,
    kolHolders: 0,
    devAddress: addr(999),
    devSoldAll: false,
    devMigrateCount: 0,
    washTrading: false,
    socials: { website: null, twitter: null, telegram: null },
    ...overrides,
  };
}

function activity(overrides: Partial<TokenActivity> = {}): TokenActivity {
  return {
    address: addr(1),
    observedAt: NOW,
    priceUsd: 0.0001,
    marketCapUsd: 50_000,
    liquidityUsd: 10_000,
    holders: 200,
    txs5m: 5,
    txs1h: 60,
    txs4h: 200,
    txs24h: 500,
    volume5mUsd: 200,
    volume1hUsd: 3_000,
    volume4hUsd: 9_000,
    volume24hUsd: 20_000,
    priceChange5mPct: 1,
    priceChange1hPct: 5,
    priceChange4hPct: 10,
    priceChange24hPct: 10,
    ...overrides,
  };
}

function signal(overrides: Partial<SmartSignal> = {}): SmartSignal {
  const at = overrides.at ?? NOW - 10 * MIN;
  const address = overrides.address ?? addr(1);
  const walletType = overrides.walletType ?? "smart_money";
  return {
    id: `${walletType}:${address}:${at}`,
    address,
    symbol: "MEME",
    walletType,
    walletCount: 4,
    amountUsd: 1_000,
    soldRatioPct: 10,
    priceUsd: 0.0001,
    marketCapUsd: 50_000,
    at,
    ...overrides,
  };
}

function input(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    rush: rush(),
    activity: activity(),
    signals: [],
    quoteKind: "bnb",
    cloneOf: null,
    lastListedAt: NOW,
    firstSeenAt: NOW - HOUR,
    previousDeadSince: null,
    now: NOW,
    ...overrides,
  };
}

describe("normalizeMemeRush", () => {
  it("keeps Four.Meme and Flap, drops launchpads it does not serve, and reads the dev/wash tags", () => {
    const rows = normalizeMemeRush(
      {
        code: "000000",
        data: [
          {
            contractAddress: "0xEA5EA1F5C734B362C009B60A6CB25AAE87494444",
            symbol: "牛来GM",
            name: "牛来GM",
            protocol: 2001,
            createTime: 1791094857000,
            progress: "94.378131",
            migrateStatus: 0,
            migrateTime: 0,
            pairAnchorAddress: USDT,
            holders: 383,
            count: 755,
            countBuy: 562,
            countSell: 193,
            holdersSniperPercent: "70.71",
            smartMoneyHolders: 8,
            kolHolders: 46,
            devPosition: 2,
            tagInsiderWashTrading: 1,
            socials: { twitter: "https://x.com/cz_binance", website: null, telegram: null },
          },
          { contractAddress: addr(2), symbol: "SOL", protocol: 2006, createTime: 1791094857000 },
          { contractAddress: addr(3), symbol: "NO_TIME", protocol: 2002 },
        ],
      },
      "finalizing",
    );
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.address, "0xea5ea1f5c734b362c009b60a6cb25aae87494444");
    assert.equal(row.launchpad, "fourmeme");
    assert.equal(row.progress, 94.378131);
    assert.equal(row.migrated, false);
    assert.equal(row.migratedAt, null);
    assert.equal(row.quote, USDT);
    assert.equal(row.devSoldAll, true);
    assert.equal(row.washTrading, true);
    assert.equal(row.sniperPct, 70.71);
    assert.equal(row.socials.twitter, "https://x.com/cz_binance");
  });

  it("rejects a failed envelope instead of reading it as an empty list", () => {
    assert.throws(() => normalizeMemeRush({ code: "100004", message: "rate limited" }, "new"), /rate limited/);
  });
});

describe("OKX activity and signals", () => {
  it("reads windowed trade counts and never tradeNum, which is a token amount", () => {
    const rows = normalizeActivityRows([
      { tokenContractAddress: addr(1).toUpperCase().replace("0X", "0x"), txs5M: "6", txs1H: "85", volume1H: "389.25", liquidity: "11675.37", tradeNum: "777427995.88" },
    ]);
    const row = rows.get(addr(1))!;
    assert.equal(row.txs5m, 6);
    assert.equal(row.txs1h, 85);
    assert.equal(row.volume1hUsd, 389.25);
    assert.equal(row.liquidityUsd, 11675.37);
    assert.equal(Object.values(row).includes(777427995.88), false);
  });

  it("keys signals by wallet type and drops codes it does not know", () => {
    const signals = normalizeSignals([
      { timestamp: "1791124151355", walletType: "1", triggerWalletCount: "8", soldRatioPercent: "91.37", token: { tokenAddress: addr(5), symbol: "SXSI" } },
      { timestamp: "1791124151355", walletType: "9", token: { tokenAddress: addr(6) } },
    ]);
    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.walletType, "smart_money");
    assert.equal(signals[0]!.walletCount, 8);
    assert.equal(signals[0]!.soldRatioPct, 91.37);
  });
});

describe("classifyStage", () => {
  it("orders graduated over new over graduating over bonding", () => {
    assert.equal(classifyStage(rush({ migrated: true, createdAt: NOW - MIN }), NOW), "graduated");
    assert.equal(classifyStage(rush({ createdAt: NOW - 5 * MIN, progress: 95 }), NOW), "new");
    assert.equal(classifyStage(rush({ progress: MEME_RULES.graduatingMinProgress }), NOW), "graduating");
    assert.equal(classifyStage(rush({ progress: 10 }), NOW), "bonding");
  });
});

describe("classifyStatus", () => {
  const row = rush();
  it("is unknown when OKX has not indexed the token, never guessed", () => {
    assert.equal(classifyStatus(row, null, "bonding", NOW), "unknown");
  });

  it("calls a chart dead when it has not traded for an hour, but only past the grace period", () => {
    assert.equal(classifyStatus(row, activity({ txs1h: 0, txs5m: 0 }), "bonding", NOW), "dead");
    const young = rush({ createdAt: NOW - 10 * MIN });
    assert.equal(classifyStatus(young, activity({ txs1h: 0, txs5m: 0 }), "new", NOW), "active");
  });

  it("calls a graduated token with its pool pulled dead even while it still trades", () => {
    const pulled = activity({ liquidityUsd: MEME_RULES.deadMaxLiquidityUsd - 1, txs5m: 50, txs1h: 500 });
    assert.equal(classifyStatus(rush({ migrated: true }), pulled, "graduated", NOW), "dead");
    assert.equal(classifyStatus(row, pulled, "bonding", NOW), "active");
  });

  it("calls a chart fading when the last 5 minutes are empty or the last hour is a sliver of the last four", () => {
    assert.equal(classifyStatus(row, activity({ txs5m: 0, txs1h: 12 }), "bonding", NOW), "fading");
    // The 2026-10-04 HOT #1: $102k over 4h, $22 in the last hour.
    assert.equal(classifyStatus(row, activity({ volume1hUsd: 22, volume4hUsd: 102_369 }), "bonding", NOW), "fading");
  });

  it("calls a young, busy, rising chart a runner, and the same chart falling merely active", () => {
    const busy = activity({ txs5m: 40, txs1h: 400, volume1hUsd: 50_000, priceChange1hPct: 120 });
    assert.equal(classifyStatus(row, busy, "bonding", NOW), "runner");
    assert.equal(classifyStatus(row, { ...busy, priceChange1hPct: -30 }, "bonding", NOW), "active");
    const old = rush({ createdAt: NOW - (MEME_RULES.runnerMaxAgeHours * 60 + 1) * MIN });
    assert.equal(classifyStatus(old, busy, "graduated", NOW), "active");
  });
});

describe("classifyMeme flags", () => {
  it("raises churn when an hour's volume dwarfs the market cap", () => {
    const row = classifyMeme(input({ activity: activity({ volume1hUsd: 127_000, marketCapUsd: 5_300 }) }));
    assert.ok(row.flags.includes("churn"));
    const normal = classifyMeme(input({ activity: activity({ volume1hUsd: 30_000, marketCapUsd: 50_000 }) }));
    assert.ok(!normal.flags.includes("churn"));
  });

  it("counts only signals inside the window and flags an exit when the wallets sold out", () => {
    const row = classifyMeme(
      input({
        signals: [
          signal({ at: NOW - 5 * MIN, soldRatioPct: 91, walletCount: 8 }),
          signal({ at: NOW - 30 * MIN, walletType: "kol", walletCount: 3 }),
          signal({ at: NOW - (MEME_RULES.signalWindowHours + 1) * HOUR, walletType: "whale" }),
        ],
      }),
    );
    assert.deepEqual(row.smartMoney.signals, { smart_money: 1, kol: 1, whale: 0 });
    assert.equal(row.smartMoney.maxWallets, 8);
    assert.equal(row.smartMoney.lastSoldRatioPct, 91);
    for (const flag of ["smart_money", "kol", "smart_exit"] as const) assert.ok(row.flags.includes(flag), flag);
    assert.ok(!row.flags.includes("whale"));
  });

  it("flags a bStock quote and carries the dead timestamp forward", () => {
    const row = classifyMeme(
      input({ quoteKind: "bstock", activity: activity({ txs1h: 0, txs5m: 0 }), previousDeadSince: NOW - HOUR }),
    );
    assert.ok(row.flags.includes("bstock_quote"));
    assert.equal(row.status, "dead");
    assert.equal(row.deadSince, NOW - HOUR);
    assert.equal(classifyMeme(input({ previousDeadSince: NOW - HOUR })).deadSince, null);
  });
});

describe("findClones", () => {
  it("treats the earliest token with a symbol as the original, whatever case or spacing the copies use", () => {
    const clones = findClones([
      { address: addr(1), symbol: "LongFlap", createdAt: NOW - 3 * MIN },
      { address: addr(2), symbol: "longflap ", createdAt: NOW - 2 * MIN },
      { address: addr(3), symbol: "Long Flap", createdAt: NOW - MIN },
      { address: addr(4), symbol: "Other", createdAt: NOW },
    ]);
    assert.equal(clones.get(addr(1)), undefined);
    assert.equal(clones.get(addr(2)), addr(1));
    assert.equal(clones.get(addr(3)), addr(1));
    assert.equal(clones.has(addr(4)), false);
  });
});

describe("resolveQuoteKinds", () => {
  it("answers native, stables and static bStocks without touching the chain", async () => {
    const store = new MemoryStore();
    let asked = 0;
    const kinds = await resolveQuoteKinds(store, [BNB, USDT, NVDAB], {
      readIssuer: async () => {
        asked += 1;
        return new Map();
      },
    });
    assert.equal(asked, 0);
    assert.deepEqual([...kinds.entries()], [[BNB, "bnb"], [USDT, "stable"], [NVDAB, "bstock"]]);
  });

  it("asks the chain once, caches the verdict forever, and never caches an unanswered read", async () => {
    const store = new MemoryStore();
    const other = addr(77);
    const asked: string[][] = [];
    const reader = async (addresses: string[]): Promise<Map<string, QuoteKind>> => {
      asked.push(addresses);
      return new Map([[BNCB, "bstock" as QuoteKind]]); // `other` unanswered (transport failure)
    };
    const first = await resolveQuoteKinds(store, [BNCB, other], { readIssuer: reader });
    assert.equal(first.get(BNCB), "bstock");
    assert.equal(first.has(other), false);
    const cached = (await store.get<Record<string, string>>(QUOTE_KINDS_KEY))!.data;
    assert.deepEqual(cached, { [BNCB]: "bstock" });

    await resolveQuoteKinds(store, [BNCB, other], { readIssuer: reader });
    assert.deepEqual(asked, [[BNCB, other], [other]]);
  });
});

function fakeUpstreams(lists: Partial<Record<MemeRushStage, MemeRushRow[] | Error>>) {
  return {
    fetchRush: async (stage: MemeRushStage) => {
      const value = lists[stage] ?? [];
      if (value instanceof Error) throw value;
      return value;
    },
    readIssuer: async () => new Map<string, QuoteKind>(),
  };
}

async function board(store: MemoryStore): Promise<MemeBoardRow[]> {
  return ((await store.get<MemeBoardRow[]>(MEME_BOARD_KEY))?.data ?? []) as MemeBoardRow[];
}

describe("runMemeBoard", () => {
  it("publishes a partial cycle and refuses to restamp when every list failed", async () => {
    const store = new MemoryStore();
    const result = await runMemeBoard(store, AbortSignal.timeout(5_000), {
      ...fakeUpstreams({ new: new Error("down"), finalizing: [rush()], migrated: new Error("down") }),
      fetchActivity: async () => new Map([[addr(1), activity()]]),
      fetchSignals: async () => [],
      now: () => NOW,
    });
    assert.equal(result.rows, 1);
    assert.equal(result.failures.length, 2);
    const asOf = (await store.get(MEME_BOARD_KEY))!.asOf;

    await assert.rejects(
      runMemeBoard(store, AbortSignal.timeout(5_000), {
        ...fakeUpstreams({ new: new Error("x"), finalizing: new Error("x"), migrated: new Error("x") }),
        now: () => NOW + MIN,
      }),
      /no meme rush list/,
    );
    assert.equal((await store.get(MEME_BOARD_KEY))!.asOf, asOf);
  });

  it("keeps tracking a token after it scrolls off the lists, and drops it once dead for two hours", async () => {
    const store = new MemoryStore();
    const base = {
      fetchSignals: async () => [] as SmartSignal[],
      readIssuer: async () => new Map<string, QuoteKind>(),
    };
    await runMemeBoard(store, AbortSignal.timeout(5_000), {
      ...base,
      fetchRush: async (stage) => (stage === "new" ? [rush({ address: addr(1) }), rush({ address: addr(2), symbol: "B" })] : []),
      fetchActivity: async () => new Map([[addr(1), activity()], [addr(2), activity({ address: addr(2) })]]),
      now: () => NOW,
    });

    // Token 1 scrolls off and stops trading; token 2 is still listed.
    const later = (t: number) => ({
      ...base,
      fetchRush: async (stage: MemeRushStage) => (stage === "new" ? [rush({ address: addr(2), symbol: "B" })] : []),
      fetchActivity: async () =>
        new Map([[addr(1), activity({ txs1h: 0, txs5m: 0 })], [addr(2), activity({ address: addr(2) })]]),
      now: () => t,
    });
    await runMemeBoard(store, AbortSignal.timeout(5_000), later(NOW + 10 * MIN));
    let rows = await board(store);
    assert.equal(rows.find((r) => r.address === addr(1))?.status, "dead");
    assert.equal(rows.find((r) => r.address === addr(1))?.deadSince, NOW + 10 * MIN);

    await runMemeBoard(store, AbortSignal.timeout(5_000), later(NOW + HOUR));
    rows = await board(store);
    assert.equal(rows.find((r) => r.address === addr(1))?.deadSince, NOW + 10 * MIN);

    await runMemeBoard(store, AbortSignal.timeout(5_000), later(NOW + 10 * MIN + 2 * HOUR + 1));
    rows = await board(store);
    assert.equal(rows.some((r) => r.address === addr(1)), false);
    assert.equal(rows.some((r) => r.address === addr(2)), true);
  });

  it("falls back to the previous activity when OKX fails, rather than turning the board unknown", async () => {
    const store = new MemoryStore();
    const lists = fakeUpstreams({ finalizing: [rush()] });
    await runMemeBoard(store, AbortSignal.timeout(5_000), {
      ...lists,
      fetchActivity: async () => new Map([[addr(1), activity({ txs5m: 7 })]]),
      fetchSignals: async () => [],
      now: () => NOW,
    });
    const result = await runMemeBoard(store, AbortSignal.timeout(5_000), {
      ...lists,
      fetchActivity: async () => {
        throw new Error("okx 429");
      },
      fetchSignals: async () => [],
      now: () => NOW + MIN,
    });
    const rows = await board(store);
    assert.equal(rows[0]!.activity?.txs5m, 7);
    assert.notEqual(rows[0]!.status, "unknown");
    assert.ok(result.failures.some((f) => f.startsWith("activity")));
  });

  it("accumulates signals across cycles and forgets them past the window", async () => {
    const store = new MemoryStore();
    const lists = fakeUpstreams({ finalizing: [rush()] });
    const run = (now: number, signals: SmartSignal[]) =>
      runMemeBoard(store, AbortSignal.timeout(5_000), {
        ...lists,
        fetchActivity: async () => new Map([[addr(1), activity()]]),
        fetchSignals: async () => signals,
        now: () => now,
      });
    await run(NOW, [signal({ at: NOW - MIN })]);
    await run(NOW + MIN, [signal({ at: NOW, walletType: "kol" })]);
    let rows = await board(store);
    assert.deepEqual(rows[0]!.smartMoney.signals, { smart_money: 1, kol: 1, whale: 0 });

    await run(NOW + (MEME_RULES.signalWindowHours + 1) * HOUR, []);
    rows = await board(store);
    assert.deepEqual(rows[0]!.smartMoney.signals, { smart_money: 0, kol: 0, whale: 0 });
    const state = (await store.get<{ signals: unknown[] }>(MEME_STATE_KEY))!.data;
    assert.equal(state.signals.length, 0);
  });
});

describe("GET /memes", () => {
  async function seeded(): Promise<ReturnType<typeof createServer>> {
    const store = new MemoryStore();
    const rows = [
      classifyMeme(input({ rush: rush({ address: addr(1), symbol: "RUN", createdAt: Date.now() - HOUR }), activity: activity({ txs5m: 40, txs1h: 400, volume1hUsd: 50_000, priceChange1hPct: 80 }), quoteKind: "bstock", now: Date.now() })),
      classifyMeme(input({ rush: rush({ address: addr(2), symbol: "DEAD", createdAt: Date.now() - 5 * HOUR }), activity: activity({ address: addr(2), txs1h: 0, txs5m: 0 }), now: Date.now() })),
      classifyMeme(input({ rush: rush({ address: addr(3), symbol: "SLOW", createdAt: Date.now() - 2 * HOUR, devSoldAll: true }), activity: activity({ address: addr(3), txs5m: 3 }), now: Date.now() })),
    ];
    await store.put(MEME_BOARD_KEY, rows, { source: "test", freshForMs: 60_000, deadAfterMs: 600_000 });
    return createServer({ scheduler: createScheduler(store), store });
  }

  it("hides dead charts by default, orders by 5-minute trades, and publishes its rules", async () => {
    const app = await seeded();
    const body = (await (await app.request("/memes")).json()) as { data: MemeBoardRow[]; meta: Record<string, unknown> };
    assert.deepEqual(body.data.map((r) => r.symbol), ["RUN", "SLOW"]);
    assert.equal(body.data[0]!.status, "runner");
    assert.deepEqual(body.meta["byStatus"], { runner: 1, dead: 1, active: 1 });
    assert.deepEqual(body.meta["rules"], MEME_RULES);
  });

  it("returns dead charts when asked and applies the caller's screens", async () => {
    const app = await seeded();
    const dead = (await (await app.request("/memes?status=dead")).json()) as { data: MemeBoardRow[] };
    assert.deepEqual(dead.data.map((r) => r.symbol), ["DEAD"]);
    const screened = (await (await app.request("/memes?quote=bstock&minTxs5m=10")).json()) as { data: MemeBoardRow[] };
    assert.deepEqual(screened.data.map((r) => r.symbol), ["RUN"]);
    const noDevDump = (await (await app.request("/memes?excludeFlags=dev_sold_all")).json()) as { data: MemeBoardRow[] };
    assert.deepEqual(noDevDump.data.map((r) => r.symbol), ["RUN"]);
  });

  it("rejects an unknown label instead of silently matching nothing", async () => {
    const app = await seeded();
    const response = await app.request("/memes?status=mooning");
    assert.equal(response.status, 400);
  });

  it("serves one token, and says when it is not on the board", async () => {
    const app = await seeded();
    const one = (await (await app.request(`/memes/${addr(1)}`)).json()) as { data: MemeBoardRow };
    assert.equal(one.data.symbol, "RUN");
    assert.equal((await app.request(`/memes/${addr(9)}`)).status, 404);
    assert.equal((await app.request("/memes/nope")).status, 400);
  });
});
