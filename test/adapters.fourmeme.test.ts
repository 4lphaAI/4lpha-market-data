import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchFourMemeRanking } from "../src/adapters/fourmeme.js";
import { AdapterError } from "../src/adapters/http.js";
import { fakeFetch, jsonResponse, textResponse, throwingFetch } from "./helpers.js";

const ADDRESS = "0xAA00000000000000000000000000000000000001";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tokenAddress: ADDRESS,
    shortName: "PEPE",
    name: "Pepe Token",
    symbol: "BNB",
    price: "0.000002",
    cap: "1000",
    volume: "10",
    day1Vol: "6000",
    hold: 420,
    day1Increase: "12.5",
    ...overrides,
  };
}

describe("fetchFourMemeRanking", () => {
  it("posts the documented search body and normalizes the happy path", async () => {
    const fake = fakeFetch(() => jsonResponse({ code: "0", data: { list: [row()] } }));

    const result = await fetchFourMemeRanking({
      type: "HOT",
      page: 2,
      pageSize: 25,
      fetchFn: fake.fetch,
    });

    const call = fake.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.method, "POST");
    assert.ok(call.url.endsWith("/meme-api/v1/public/token/search"));
    assert.deepEqual(JSON.parse(call.body ?? "null"), {
      type: "HOT",
      listType: "NOR",
      status: "PUBLISH",
      sort: "DESC",
      pageIndex: 2,
      pageSize: 25,
    });
    assert.equal(call.headers["user-agent"], "Mozilla/5.0");

    assert.deepEqual(result.entries, [
      {
        address: ADDRESS.toLowerCase(),
        symbol: "PEPE",
        name: "Pepe Token",
        lane: "meme",
        source: "fourmeme",
      },
    ]);

    const snapshot = result.snapshots[0];
    assert.ok(snapshot !== undefined);
    // usdVolume 6000 / quoteVolume 10 => 600 USD per quote unit.
    assert.equal(snapshot.priceUsd, 0.0012);
    assert.equal(snapshot.marketCapUsd, 600_000);
    assert.equal(snapshot.volume24hUsd, 6_000);
    assert.equal(snapshot.holders, 420);
    assert.equal(snapshot.priceChange24hPct, 12.5);
    assert.equal(snapshot.symbol, "PEPE");
  });

  it("reads a bare array at data and a list at the envelope root", async () => {
    const bare = fakeFetch(() => jsonResponse({ code: "0", data: [row()] }));
    assert.equal((await fetchFourMemeRanking({ type: "NEW", fetchFn: bare.fetch })).entries.length, 1);

    const rootList = fakeFetch(() => jsonResponse({ list: [row()] }));
    assert.equal(
      (await fetchFourMemeRanking({ type: "NEW", fetchFn: rootList.fetch })).entries.length,
      1,
    );
  });

  it("treats a USD-quoted pool as a 1:1 multiplier", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({ code: "0", data: { list: [row({ symbol: "USDT", volume: null })] } }),
    );
    const result = await fetchFourMemeRanking({ type: "CAP", fetchFn: fake.fetch });
    assert.equal(result.snapshots[0]?.priceUsd, 0.000002);
    assert.equal(result.snapshots[0]?.marketCapUsd, 1_000);
  });

  it("does not convert a graduated TRADE row from USD a second time", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({ code: "0", data: { list: [row({
        status: "TRADE",
        progress: "1",
        price: "0.03075362627587370288",
        cap: "30753626.27587370288",
        volume: "235089.047624717259708335",
        day1Vol: "6671094.49",
      })] } }),
    );
    const snapshot = (await fetchFourMemeRanking({ type: "HOT", fetchFn: fake.fetch })).snapshots[0];
    assert.equal(snapshot?.priceUsd, Number("0.03075362627587370288"));
    assert.equal(snapshot?.marketCapUsd, Number("30753626.27587370288"));
  });

  it("leaves price null rather than publishing a non-USD number", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({ code: "0", data: { list: [row({ volume: null, day1Vol: null })] } }),
    );
    const snapshot = (await fetchFourMemeRanking({ type: "VOL", fetchFn: fake.fetch })).snapshots[0];
    assert.equal(snapshot?.priceUsd, null);
    assert.equal(snapshot?.marketCapUsd, null);
    assert.equal(snapshot?.volume24hUsd, null);
  });

  it("tolerates malformed rows without throwing", async () => {
    const fake = fakeFetch(() =>
      jsonResponse({
        code: "0",
        data: {
          list: [
            null,
            "nonsense",
            { tokenAddress: "not-an-address" },
            { tokenAddress: ADDRESS, price: "abc", cap: {}, hold: "many", day1Vol: [] },
          ],
        },
      }),
    );

    const result = await fetchFourMemeRanking({ type: "NEW", fetchFn: fake.fetch });
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]?.symbol, "");
    assert.equal(result.snapshots[0]?.priceUsd, null);
    assert.equal(result.snapshots[0]?.holders, null);
    assert.equal(result.snapshots[0]?.volume24hUsd, null);
  });

  it("returns nothing for a completely unexpected payload", async () => {
    const fake = fakeFetch(() => jsonResponse(42));
    const result = await fetchFourMemeRanking({ type: "NEW", fetchFn: fake.fetch });
    assert.deepEqual(result.entries, []);
  });

  it("raises the upstream message for a non-zero code", async () => {
    const fake = fakeFetch(() => jsonResponse({ code: "40001", msg: "bad request" }));
    await assert.rejects(
      () => fetchFourMemeRanking({ type: "NEW", fetchFn: fake.fetch }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterError);
        assert.equal(error.message, "fourmeme: bad request");
        return true;
      },
    );
  });

  it("reports the status without leaking the URL on an HTTP error", async () => {
    const fake = fakeFetch(() => jsonResponse({}, 503));
    await assert.rejects(
      () => fetchFourMemeRanking({ type: "NEW", fetchFn: fake.fetch }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterError);
        assert.equal(error.status, 503);
        assert.ok(!error.message.includes("four.meme"));
        return true;
      },
    );
  });

  it("rejects a non-JSON body as a sanitized error", async () => {
    const fake = fakeFetch(() => textResponse("<html>maintenance</html>"));
    await assert.rejects(
      () => fetchFourMemeRanking({ type: "NEW", fetchFn: fake.fetch }),
      /invalid JSON in response/u,
    );
  });

  it("strips URLs and long tokens out of transport errors", async () => {
    const fetchFn = throwingFetch(
      new Error("connect ECONNREFUSED https://four.meme/meme-api/v1?key=SECRETKEYSECRETKEYSECRETKEY"),
    );
    await assert.rejects(
      () => fetchFourMemeRanking({ type: "NEW", fetchFn }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterError);
        assert.ok(!error.message.includes("four.meme"));
        assert.ok(!error.message.includes("SECRETKEY"));
        assert.match(error.message, /\[url\]/u);
        return true;
      },
    );
  });
});
