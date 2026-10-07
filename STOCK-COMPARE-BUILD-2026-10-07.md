# Stock compare (B2), data-plane build report (2026-10-07)

Branch `stock-compare`, base master 945f939. Plan: exec repo `MD here/STOCK-COMPARE-B2-PLAN.md` section 3
(section 7 rulings normative). Nothing was run against the real Binance API; offline tests only.

## What was built

- `src/query/stockCompare.ts`: row, size, verdict types; the pure maths (shares, costBps, roundTripBps, route
  type, venue names); `computeVerdicts`; `stockCompareStaleness`; `mergeStockCompareRows`; a defensive
  `normalizeStockCompare` for the stored payload. Imported by both the job and the route.
- `src/jobs/stockCompare.ts`: job `stock-compare` (15 min + 30 s jitter, 12 min timeout), `runStockCompare`
  (injectable limiter, quote function, clock, sleep), the default quote (`createFlashQuote`), config reader,
  registration helper `stockCompareJobIfEnabled`.
- `src/server.ts`: `GET /trading/stock-compare` (store-only, behind the existing `x-dp-token` middleware).
- `src/index.ts`: registers the job when `STOCK_COMPARE_ENABLED === "true"` (inside the existing
  `hasBinanceRwaCredentials()` block; off or no credentials = not registered).
- `test/stockCompare.test.ts`: 47 tests.

Store contract unchanged: one jsonb key `stocks:compare`, payload `{ rows: { [ticker]: row } }`. `test/fakePg.ts`
needs nothing new (one test round-trips the snapshot through `PostgresStore` + `FakePg`).

## Env vars and defaults

| Var | Default | Rule |
|---|---|---|
| `STOCK_COMPARE_ENABLED` | off | on only for the exact string `true`; off = job not registered |
| `STOCK_COMPARE_MIN_HEADROOM` | 10 | integer 1..`BINANCE_RWA_RPS`; the default is checked too |
| `STOCK_COMPARE_RPS` | 2 | integer 1..`BINANCE_RWA_RPS` |

A malformed value throws (like `readBinanceRwaRps`), it never falls back. The config is read at the start of
every run: a bad value makes the run fail visibly in `/status` job health (and logs once at boot), it does not
crash the process. `available()` is capped at `BINANCE_RWA_RPS`, so with the bucket unset (5) the default
headroom 10 can never be met: that throws instead of idling. **A local run needs `BINANCE_RWA_RPS >= 10`;
production is 18.**

## Budget behaviour (plan 3.1, ruling Q1)

For each send, in order: (1) own pace: wait until `ceil(1000 / STOCK_COMPARE_RPS)` ms since the previous send;
(2) headroom: while `BINANCE_RWA_LIMITER.available() < STOCK_COMPARE_MIN_HEADROOM`, sleep 1 s and re-check; after
30 s of continuous no-headroom the rest of the cycle is given up; (3) take one slot from the shared limiter with
`acquire`, bounded to 1 s (`BINANCE_FLASH_BUDGET_WAIT_MS`), a failure there ends the cycle (`rate_budget`);
(4) send the signed request through a no-wait limiter (the slot was already taken, one token per send).

The cycle ends at once on HTTP 429 (`rate_limited`), on `BinanceFlashRateBudgetError` (`rate_budget`), and on
401/403 (`auth_rejected`, see deviations). It also stops by itself at 11 min (`time_budget`) and on abort.
Ticker order is least recently quoted first, so a cycle that ends early still rotates through every ticker.
A ticker's row is replaced only when every one of its 12 quotes was attempted; a ticker cut off mid-way keeps its
previous row (never a one-sided comparison). Completed tickers are published in a `finally`, so a 429 or abort
still saves what finished. A cycle that completed no ticker does not publish. If `universe:rwa` is missing or not
`fresh` the cycle is skipped (`universe_not_fresh`). Job log line per cycle:
`[stock-compare] ended=... tickers=q/p quotes=n headroomWaits=n ms=n`.

## Quote path

Per ticker (every `underlyingTicker` matching `^[A-Z]{1,6}$` with a bStock row and an Ondo row; xStocks and any other
platform excluded; open or closed rows alike; rows with no share ratio, or a ticker with no reference price, skipped),
per issuer (bStock then Ondo), per size 100 / 1 000 / 5 000 USDT: one buy USDT -> token; if it answered, one sell of
exactly the quoted atomic `toTokenAmount` string back to USDT. Query = the adapter's and the probe's:
`enableRFQ=true`, `vendor=LiquidMesh`, `slippagePercent=0.50`, `approveTransaction=true`, taker
`0x000000000000000000000000000000000000dead`. `priceImpactPercent` is never read (a test greps the source).

shares = tokensOut x `tokenToShareRatio`; costBps = ((usdt / shares) / referencePriceUsd - 1) x 10 000;
roundTripBps = (1 - usdtBack / usdt) x 10 000; both rounded to integers. Checked against the step-0 file:
NVDAB 500 -> -12 / 2, NVDAB 5000 -> -12 / 3, SPYon 500 -> 57286 / 8537.

Route type: `rfq` when every leg name starts with `Rfq `, `amm` when none does, `mixed` otherwise (null when the answer
had no legs). Venues: leg names only (no percentages), deduplicated in order of first appearance, at most 4, charset
`[A-Za-z0-9 ._-]`, 32 chars.

## Route shape (verbatim from a run of the real handler on a seeded store)

`GET /trading/stock-compare?ticker=NVDA` (the 5000 bStock size is a `no_route` example):

```json
{
 "data": {
  "ticker": "NVDA",
  "quotedAt": 1791392309931,
  "referencePriceUsd": 237.40985268157382,
  "versions": [
   {
    "issuer": "bstock", "symbol": "NVDAB", "address": "0x02fca66c1d1afb4e2a7884261eb00f63598a7436",
    "ratio": 1.0007782237528078, "openState": true, "marketStatus": null,
    "sizes": [
     { "usdt": 100, "ok": true, "tokensOut": 0.4213, "shares": 0.42162787, "costBps": -10, "roundTripBps": 2, "route": "rfq", "venues": ["Rfq Neptunex"] },
     { "usdt": 1000, "ok": true, "tokensOut": 4.2137, "shares": 4.2169792, "costBps": -12, "roundTripBps": 2, "route": "rfq", "venues": ["Rfq Neptunex"] },
     { "usdt": 5000, "ok": false, "tokensOut": null, "shares": null, "costBps": null, "roundTripBps": null, "route": null, "venues": [], "code": "no_route" }
    ]
   },
   {
    "issuer": "ondo", "symbol": "NVDAon", "address": "0xa9ee28c80f960b889dfbd1902055218cba016f75",
    "ratio": 1.0017152487959897, "openState": true, "marketStatus": "regular",
    "sizes": [
     { "usdt": 100, "ok": true, "tokensOut": 0.4214, "shares": 0.42212281, "costBps": -22, "roundTripBps": 3, "route": "amm", "venues": ["Metric", "Uniswap V4"] },
     { "usdt": 1000, "ok": true, "tokensOut": 4.2139, "shares": 4.22112789, "costBps": -21, "roundTripBps": 5, "route": "mixed", "venues": ["Metric", "Elfomofi", "Rfq Neptunex"] },
     { "usdt": 5000, "ok": true, "tokensOut": 21.0643, "shares": 21.10043052, "costBps": -19, "roundTripBps": 9, "route": "amm", "venues": ["Metric"] }
    ]
   }
  ],
  "verdicts": [
   { "usdt": 100,  "best": "ondo", "edgeBps": 11.7, "about_same": true,  "avoid": [], "only": null },
   { "usdt": 1000, "best": "ondo", "edgeBps": 9.8,  "about_same": true,  "avoid": [], "only": null },
   { "usdt": 5000, "best": "ondo", "edgeBps": null, "about_same": false, "avoid": [], "only": "ondo" }
  ]
 },
 "meta": { "staleness": "fresh", "quotedAt": 1791392309931, "ageMs": 240012,
           "sizesUsdt": [100, 1000, 5000], "aboutSameBps": 20, "avoidCostBps": 200 }
}
```

(The example is pretty-printed for reading; the route returns compact JSON.)

- Row fields (types): `ticker` string; `quotedAt` epoch ms; `referencePriceUsd` number; `versions` array of 2 (bStock
  first); version `issuer` `"bstock"|"ondo"`, `ratio` number, `openState` boolean|null, `marketStatus` string|null
  (Ondo: `regular`, `overnight`, ... ; bStock: null); size `usdt` number, `ok` boolean (the buy answered),
  `tokensOut`/`shares`/`costBps`/`roundTripBps` number|null, `route` `"rfq"|"amm"|"mixed"|null`, `venues` string[],
  optional `code`.
- `code` (closed): `no_route` (buy: aggregator 40465 "Path not found"), `quote_failed` (any other buy failure),
  `sell_no_route` / `sell_failed` (buy answered, selling back did not: `ok` stays true, `roundTripBps` null).
- Verdict per size present in the row, ascending by `usdt`: `best` = issuer with the most shares among versions whose
  buy answered (null if none; a single answered version is its own `best`, with `only` set); `edgeBps` =
  `round((sharesBest / sharesOther - 1) x 10 000, 1 decimal)`, null unless two versions answered; `about_same` =
  `edgeBps < 20` (so exactly 20.0 is not about_same); `avoid` = issuers whose answered buy has `costBps > 200`
  (exactly 200 is not); `only` = the issuer when exactly one version has a route at that size. An exact share tie goes
  to the bStock. Treat `best` as no winner whenever `about_same` is true.
- `meta.staleness` comes from the row's own `quotedAt`: `fresh` <= 30 min, `stale` <= 2 h, `dead` beyond. Rows are
  served whatever their age.
- No `ticker`: `GET /trading/stock-compare` ->
  `{"data":[{"ticker":"NVDA","quotedAt":1791392309931},{"ticker":"SPY","quotedAt":...}],"meta":{"count":2,"staleness":"fresh","newestQuotedAt":...,"retentionMs":7200000,"sizesUsdt":[100,1000,5000],"aboutSameBps":20,"avoidCostBps":200}}`
  sorted by ticker; `meta.staleness` is that of the newest `quotedAt`; empty store = `data: []`, `staleness: "dead"`,
  `newestQuotedAt: null`.
- Errors: `?ticker=` present and not `^[A-Z]{1,6}$` (including empty, lowercase) -> 400
  `{"data":null,"error":{"code":"invalid_ticker"}}`; well-formed but not stored -> 404
  `{"data":null,"error":{"code":"ticker_not_found"}}`; missing/wrong `x-dp-token` -> 401 (existing middleware).

## Tests

Data-plane suite (`npm test`):

| | TESTS | PASS | FAIL | SKIPPED |
|---|---|---|---|---|
| before (base 945f939) | 1021 | 1021 | 0 | 0 |
| after | 1068 | 1068 | 0 | 0 |

`npx tsc --noEmit`: clean. New file: 47 tests (maths against step-0 numbers, route classification and venue names,
verdict edges 19/20/21 bps and 199/200/201 bps, single version, none answered, per-size verdicts, staleness
boundaries, merge and 2 h expiry and bound, normalizer, planner, the cycle with a fake limiter and scripted
aggregator, the default quote path with a fake fetch, config, registration flag, the route, Postgres-fake round trip).

## Mutation results

Each mutation was applied with `sed` to a copy-restored source and confirmed applied; the new test file was run.

| Mutation | Result |
|---|---|
| headroom gate removed (`available() < 0`) | 2 tests fail |
| headroom boundary `<` -> `<=` (exactly 10 free must pass) | 1 fails |
| 429 stop removed | 2 fail |
| 30 s no-headroom give-up removed | 1 fails |
| own pace (500 ms spacing) removed | 4 fail |
| shared limiter `acquire` removed | 2 fail |
| `about_same` `<` -> `<=` | 1 fails |
| `about_same` threshold 20 -> 25 | 3 fail |
| `avoid` `>` -> `>=` | 1 fails |
| `avoid` threshold 200 -> 300 | 2 fail |

All ten killed; sources restored byte-for-byte afterwards (checked with `cmp`).

## Deviations and things to know

1. **Not `fetchBinanceFlashQuote`.** It returns the closed wire the live agents execute: no `dexRouterList` (so no
   route type or venue names), taker bound to the guard config, calldata selector and approval evidence required.
   The job uses the adapter's own lowest-level signed request (`signedRequest`) with the adapter's path, timeout,
   size cap, `slippagePercent` and `redirect: "error"`, and parses only `routerResult.toTokenAmount`,
   `toToken.decimal` and `dexRouterList[].dexProtocol.dexName` (plus a `fromTokenAmount` equality check when
   present). No hand-rolled signing. I could not test an Ondo answer against the adapter's normaliser offline;
   this path is the probe's request shape.
2. **401/403 also ends the cycle** (`auth_rejected`). Not in the ruling; otherwise a rejected key would burn ~580
   quotes against it per cycle. One line, easy to drop.
3. Config validation is stricter than asked: the headroom and pace defaults are also held to `BINANCE_RWA_RPS`
   (see above).
4. Cycle order is least-recently-quoted first and a cut-off ticker is discarded whole (not in the plan; both prevent
   starvation and one-sided rows).
5. Route classification is by the `Rfq ` prefix only. The step-0 legs also include `Metric`, `Elfomofi`, `Kipseli`,
   `Genius`, `Tessera V` (apparently makers or pools, not marked `Rfq`); they count as `amm`. If the operator wants
   those named makers treated as rfq, it is a one-line list in `classifyRoute`.
6. `avoid` follows the plan literally: `costBps > 200` only. The step-0 TSLA Ondo 500 USDT case (cost 11 bps, round
   trip 6236 bps) would not be listed under `avoid`, though `best` still names the bStock by shares. Consider adding a
   round-trip rule if the skill should warn on exit cost.
7. Closed-session Ondo versions are quoted and stored with `openState` / `marketStatus` (ruling Q2); a quote that
   fails there is `quote_failed` (an unfamiliar envelope code is not distinguishable from "session closed").
8. `stocks:compare` was not added to `/status` snapshot keys (flag-gated key); job health is in `/status` anyway.
9. Live check owed to the operator: `STOCK_COMPARE_ENABLED=true` on Railway after review, watch one cycle's log line
   (`ended`, `quotes`, `headroomWaits`, `ms`) and the live agents' Flash proxy for `rate_budget_exhausted`.

## Paragraph for the data plane CLAUDE.md (gitignored; paste when merging)

```
## Stock compare (`src/jobs/stockCompare.ts`, `src/query/stockCompare.ts`, `GET /trading/stock-compare`)

Built 2026-10-07 (`STOCK-COMPARE-BUILD-2026-10-07.md`, plan in the exec repo `MD here/STOCK-COMPARE-B2-PLAN.md`). Flag `STOCK_COMPARE_ENABLED=true` (default off, then not registered). Every 15 min the job quotes each ticker that has both a bStock and an Ondo row in `universe:rwa` through Flash `quote-and-swap` (`enableRFQ=true`, unfunded taker) at 100/1 000/5 000 USDT: a buy, then a sell-back of exactly the quoted amount. Stored as one key `stocks:compare` (rows per ticker, own `quotedAt`, rows older than 2 h dropped, a ticker is replaced only when all its quotes were attempted): shares of the underlying, costBps against the reference share price, roundTripBps, route type (`rfq`/`amm`/`mixed` by the `Rfq ` leg prefix) and up to four venue names. The route is store-only; verdicts (`best`, `edgeBps`, `about_same` under 20 bps, `avoid` for costBps over 200, `only`) are computed at read time; `meta.staleness` is from the row's `quotedAt` (30 min / 2 h). It never reads `priceImpactPercent` (a fraction, PITFALL-35). Budget, live agents first: it sends only while the shared `BINANCE_RWA_LIMITER` holds at least `STOCK_COMPARE_MIN_HEADROOM` (10) free slots, at most `STOCK_COMPARE_RPS` (2) a second, gives up after 30 s without headroom, and ends the cycle on HTTP 429, a rate-budget error or 401/403. Both knobs must be <= `BINANCE_RWA_RPS` (18 in production) or the config throws. It uses `signedRequest` directly, not `fetchBinanceFlashQuote`, because it needs the route legs.
```
