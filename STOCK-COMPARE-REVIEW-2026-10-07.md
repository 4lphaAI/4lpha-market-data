# Stock compare (B2), independent review (2026-10-07)

Reviewer: Claude Opus 5 (`opus5-reviewer`), independent of the spec and the build. Branch
`stock-compare`, head `7a83245`, base `945f939`, worktree `D:\4lphaDATA-wt-stock-compare`.
Read: the worktree `CLAUDE.md`, the plan `D:\4lpha-execution\MD here\STOCK-COMPARE-B2-PLAN.md`
(section 7 normative), the step-0 evidence `D:\4lpha-execution\MD here\ISSUER-COMPARE-STEP0-2026-10-07.md`,
the build report `STOCK-COMPARE-BUILD-2026-10-07.md`, and `git diff 945f939..7a83245`.
Nothing was run against the real Binance API. No product file was changed: the two mutated sources
were restored and `git status --porcelain -- src/` is empty.

## Verdict: SHIP WITH FIXES

No BLOCKER, and no HIGH-severity build defect: the data-plane build conforms to plan section 3 and
ruling Q1, and the core safety property the operator asked about holds inside one process, which I
verified by reading the code path rather than by trusting the report.

What makes this "with fixes" rather than a plain ship is three cheap MEDIUM items I would want landed
before `STOCK_COMPARE_ENABLED=true`, each a few lines: the one-writer guard (MEDIUM-1, because the
first cycle fires inside a deploy overlap and this is the operator's stated concern), a
consecutive-failure brake (MEDIUM-2, because nothing today bounds the cost of a degraded upstream),
and a decimals cross-check (MEDIUM-3, the only path I found that produces a confidently wrong
verdict). HIGH-1 is listed above them because it is the most consequential thing in the review, but
it is **not** a build defect: the build follows plan section 3.2 literally and the gap needs an
operator ruling, not a correction. Everything else can ship as a named residual.

## Verification of the budget question (plan section 6, "can the job delay a live agent")

Answer: not within one process. Verified, with evidence:

- **Every send takes exactly one token from the shared bucket.** `gate()` calls
  `limiter.acquire(...)` at `src/jobs/stockCompare.ts:324` before every attempt, and both the buy and
  the sell-back go through `attempt()` -> `gate()` (`src/jobs/stockCompare.ts:335`, `:354`, `:358`).
  The send itself is handed `NO_WAIT_LIMITER` (`:225`), so `signedRequest`'s own
  `await limiter.acquire(operationSignal)` (`src/adapters/binanceRwa.ts:197`) is a no-op: one token,
  one HTTP request. `retryOn429: false` (`:224`) is what makes that one-to-one, because the only
  `continue` in `signedRequest`'s loop is the 429 retry (`src/adapters/binanceRwa.ts:229-236`).
  So the job cannot bypass `BINANCE_RWA_LIMITER`. This is the single most important thing about the
  build and it is correct.
- **The headroom check cannot be raced.** `while (limiter.available() < config.minHeadroom)`
  (`:316`) and `limiter.acquire` (`:324`) are separated only by a synchronous
  `AbortSignal.timeout(...)` (`:322`), with no `await` between them, so no other acquire can
  interleave between the read and the enqueue. Because the limiter serves `acquire` FIFO through a
  promise chain (`src/adapters/rateLimiter.ts:92-97`), the job's turn resolves on its first `take()`
  iteration whenever the bucket really holds 10 tokens, which means a later agent acquire is never
  parked behind a sleeping job turn.
- **Agent bursts starve the job, not the other way round.** With `capacity = refillPerSecond =
  BINANCE_RWA_RPS` (`src/adapters/binanceRwa.ts:96`), a saturating agent burst keeps `available()`
  near zero while the chain drains one waiter per ~56 ms, so the job sits in its 1 s re-check loop
  and gives up the cycle after 30 s (`:318`).
- **The key-level 1 200 / 60 s window is not newly at risk from one process.** The bucket dispenses
  at most `capacity + rps x 60` = 18 + 1 080 = 1 098 tokens in any rolling 60 s, under the ~1 200
  ceiling, and the job draws from that same 1 098 rather than adding to it. It takes a share of the
  plane's existing allowance; it does not raise the plane's total.
- **No in-process overlap.** `tick()` skips a run while the previous one is in flight
  (`src/core/scheduler.ts:119`), and the cycle stops itself at 11 min (`:310`) a minute before the
  12 min scheduler abort.
- Residual, by design and named in the ruling: the job consumes up to 2 tokens/s during periods when
  the bucket is at least 10/18 full. A burst arriving within the following ~56-110 ms sees one or two
  fewer free slots and waits that much longer, inside its own 1 s `BINANCE_FLASH_BUDGET_WAIT_MS`.
  I could not construct a case where that converts into `rate_budget_exhausted` on its own.

Per-cycle volume is bounded by the bStock rows in `universe:rwa` (46 listed plus the per-address
ones), so roughly 40-50 tickers and 480-600 quotes, matching the plan's ~580 and about 5 min at
2 rps. That fits the 11 min self-stop.

## Findings

### HIGH-1. `about_same` cancels the only exit-cost signal, so a 62 % exit reads as a tie

**Not a build defect: the build follows plan section 3.2 literally. This needs an operator ruling
before the skill ships, not a correction to this branch.** It is the reviewer brief's item 5 (build
deviation 6), and it is more consequential than the deviation note says. `avoid` keys off buy cost
only (`src/query/stockCompare.ts:206-208`), which is exactly what the plan defines, but `about_same`
is then computed from shares alone (`:219`) and the build report's own rule is "treat `best` as no
winner whenever `about_same` is true".

Failure scenario, with step-0 numbers: TSLA at 500 USDT measured bStock 1.3331 shares (cost 4 bps,
round trip 3 bps) and Ondo 1.3322 shares (cost 11 bps, round trip **6 236 bps**). The verdict this
code produces is `best: "bstock"`, `edgeBps: 6.8`, `about_same: true`, `avoid: []`, `only: null`.
Round trip is on the row but nothing in the verdict looks at it, and `about_same: true` tells the
consumer to discard `best`. A skill honouring the documented rule says "about the same, pick either",
and a user who picks Ondo loses about 62 % on the way out. The one case in step 0 where the issuer
choice was financially decisive at a small gap is the one case the verdict actively neutralises.

Fix, smallest shape: extend `avoid` with a round-trip rule (an answered version whose
`roundTripBps` exceeds a threshold, 200 bps matching the cost rule, is listed), or suppress
`about_same` when the two versions' `roundTripBps` differ by more than that threshold. The data is
already in the row, so this is read-time only and needs no new quote. The build report itself
suggests it ("Consider adding a round-trip rule"); I would make it a condition of shipping the skill
rather than a consideration, because the skill is the surface a user acts on. Because it changes what
a user sees, it is the operator's call under the exec `CLAUDE.md` confirmation rule, not the builder's.

### MEDIUM-1. No one-writer guard, and the first cycle fires inside the deploy overlap

`src/jobs/stockCompare.ts:415-441` registers the job with `intervalMs` and `jitterMs` only. The
scheduler's `start()` schedules the first run after jitter alone (`src/core/scheduler.ts:162`), so
with `STOCK_COMPARE_JITTER_MS = 30_000` (`:66`) the first cycle begins 0-30 s after boot. Six sibling
job families in this plane take a cross-process lease for exactly this reason
(`src/jobs/memeBars.ts:334`, `src/jobs/memeMeasure.ts:356`, `src/jobs/rwaReferenceBars.ts:253` which
is the recorder pass called from inside the `binance-rwa` job itself,
`src/jobs/tradingFeatures.ts:207`, `src/jobs/tradingUnderlyingFeatures.ts:71`, and four jobs via
`src/jobs/venusCore.ts:236`); `stock-compare` takes none. None of those is itself a signed-request
spender, so the precedent is single-writer correctness rather than key budget, but the primitive is
there and is one line to use.

Scoping this honestly: two processes already means two independent in-process buckets, each able to
dispense up to 1 098 requests per rolling 60 s against one key whose ceiling is about 1 200, so the
live agents plus the existing RWA jobs can breach that window during an overlap **with this flag
off**. The job's own contribution is bounded by its 2 rps pace, about 120 requests per 60 s per
process. So this job does not create the condition; it adds to it, at the worst moment, because its
first cycle starts within 30 s of boot and runs for about 5 minutes. I cannot see from here whether
Railway's deploy actually overlaps the old and new containers or for how long, so the size of the
window is for the operator to confirm.

Failure scenario: a deploy brings up the new container while the old one still serves. The new
process begins a fresh ~580-quote cycle within 30 s; each process's headroom gate reads only its own
bucket and sees plenty of room, so both keep spending while the live agents' Flash proxy runs on
both. The key window tips over, Binance answers HTTP 429, and a live agent's
`POST /trading/binance/quote-and-swap` fails. If the service is ever scaled past one replica the
condition stops being a short window and becomes permanent. `binanceRwa` and `bstockTrending` have
the same gap today but spend one list call and one call a day; this job spends two orders of
magnitude more, which is why it is worth closing here.

Fix: take a lease around the cycle (TTL about one interval), and/or give the job an initial delay of
one full interval through `JobSpec.nextDelayMs` so a deploy never starts a cycle. Two lines either
way, and it is the operator's stated concern, so it is cheap insurance even at MEDIUM.

### MEDIUM-2. In-band failures never stop the cycle, and there is no consecutive-failure brake

An HTTP 200 with a non-zero envelope code becomes an `AdapterError` whose `status` is `undefined`
and whose `upstreamCode` is the code (`src/adapters/binanceRwa.ts:267-271`). In `attempt()` that
falls through the 429 and 401/403 checks (`src/jobs/stockCompare.ts:343-344`) to
`return { ok: false, noRoute: false }` (`:347`), i.e. `quote_failed`, and the cycle continues.
Build deviation 9 names the assumption that throttling is always HTTP 429; nothing bounds the cost
if it is not, and there is no circuit breaker on repeated failures of any kind.

Failure scenario: the aggregator degrades and answers an in-band error for every pair, or Binance
starts signalling the rolling-window limit in band. The job records ~580 `quote_failed` per cycle,
publishes nothing useful, and keeps drawing 2 tokens/s from the bucket the live agents need, every
15 min, indefinitely. The only visible symptom is `ended=complete` with `quotes=580` in the log line
and rows that never refresh.

Fix: stop the cycle after N consecutive failed attempts (N around 10 is already far more than the
largest legitimate run of `no_route` at a single size), and treat `no_route` as the only in-band
failure that does not count toward N.

### MEDIUM-3. The answer's own `toToken.decimal` is trusted over the store, with no plausibility floor

`parseFlashRouterResult` accepts any integer `decimal` in 0..36 (`src/jobs/stockCompare.ts:196`) and
`quoteSize` prefers it over the store's value (`:362`, `buy.raw.decimals ?? tokenDecimals`). Nothing
compares it with `version.row.decimals`, and `costBps` has no sanity band
(`src/query/stockCompare.ts:159`), so no layer can notice the result is impossible.

Failure scenario: the aggregator reports `decimal: 0` for an 18-decimal bStock (a field change, a
UI-scaled amount, or a bad row). `tokensOut` comes back 1e18 times too large, `shares` with it,
`costBps` saturates at -10 000 (100 % cheaper than the real share price), and `computeVerdicts`
awards that issuer `best` with an astronomic `edgeBps` and `about_same: false`. The verdict is
maximally confident and completely wrong, and the published row gives a reader no way to tell.

Fix: when `version.row.decimals` is non-null and the answer's decimal differs, record the size as
`quote_failed` instead of trusting either; and refuse a `costBps` below a floor (for example
-2 000 bps, since no aggregator sells a share at a 20 % discount) rather than publishing it.

### MEDIUM-4. The headroom ruling is an absolute count, so it silently re-interprets if the bucket moves

`readBoundedInt` only caps `STOCK_COMPARE_MIN_HEADROOM` at `BINANCE_RWA_RPS`
(`src/jobs/stockCompare.ts:91-100`). The operator ruled "at least 10 of the 18 budget slots free",
which is 55 % headroom. Nothing records the 18.

Failure scenario: someone lowers `BINANCE_RWA_RPS` to 10 after a Binance change. The config still
validates (10 <= 10), but the gate now demands a completely full bucket and the job effectively
never sends, silently, with no error anywhere. Raise it to 40 instead and the same `10` becomes 25 %
headroom, roughly half the protection the ruling intended, also silently. The present failure mode is
safe only because the default 10 exceeds the unset bucket of 5 and therefore throws.

Fix: derive the default from the bucket (for example `ceil(rps x 0.55)`) or assert the ruling's pair
explicitly and log the effective fraction once at boot.

### LOW-1. `toTokenAmount` is not bounded to uint256, unlike the adapter it mimics

`DECIMAL_UINT` at `src/jobs/stockCompare.ts:82` has no length bound, where
`binanceFlash.canonicalUint` rejects anything above uint256 (`src/adapters/binanceFlash.ts:82-87`).
An absurd amount makes `atomicToNumber` (`src/query/stockCompare.ts:127-129`) return `Infinity`,
`round8` keeps it, and `JSON.stringify` writes `null`, so the store ends up with the documented
impossible state `ok: true` with `tokensOut: null` and `shares: null` next to `costBps: -10 000`.
`computeVerdicts` excludes it correctly (`:204`, `finite(shares)`), so verdicts stay safe, but the
raw size that the route serves reads as a free trade. The same unbounded string is also echoed
verbatim into the signed sell-back URL (`:358`). Add the uint256 bound the adapter already has.

### LOW-2. A timed-out run can still publish after the next run has read `previous`

`runWithTimeout` aborts and rejects without awaiting the body (`src/core/scheduler.ts:74-80`), so
after a 12 min timeout `inFlight` clears while `runStockCompare` is still inside a quote. It stops at
the next `gate()` (`:309`), within one 5 s request, but its `finally` still writes
(`src/jobs/stockCompare.ts:394-403`). If that write lands after the next cycle has read `previous`
(`:300`), the next cycle's own publish overwrites those rows. Bounded to a few seconds and to rows
that would be re-quoted anyway, but it is a silent write-write race. A lease (MEDIUM-1) closes it too.

### LOW-3. `stocks:compare` is not on `/status`, so "job off" and "job broken" look alike

Build deviation 8. The route is registered unconditionally (`src/server.ts:1750`) while the job is
registered only when the flag is on (`src/index.ts:95-96`), so with the flag off the route answers
`{"data":[],"meta":{"staleness":"dead","newestQuotedAt":null}}` forever and a consumer cannot tell
that from a job that has been failing for a day. Job health does appear in `/status`, so this is
reporting polish, not a defect. Worth one line in `meta` or the snapshot key list when the MCP tool
lands.

### LOW-4. The list form normalizes the whole snapshot to return two fields per row

`src/server.ts:1755-1778` runs `normalizeStockCompare` over up to 200 rows x 2 versions x 8 sizes
(roughly 3 000 regex tests) and then keeps only `ticker` and `quotedAt`. Harmless behind the MCP
tool's 60 s cache; worth knowing before anything puts this route on a hot path.

## Items checked and found correct

- **Ticker set from the store only** (`src/jobs/stockCompare.ts:291-302`): `universe:rwa` must be
  `fresh` or the cycle skips, bStock and Ondo only, xStocks and other platforms excluded, rows with
  no usable ratio or no reference price skipped, bStock listed first, least-recently-quoted first.
  Deviation 10 is honest: a per-address bStock whose on-chain `uiMultiplier` read failed has a null
  ratio and the ticker is skipped rather than guessed.
- **Sell-back amount equals the quoted buy amount** exactly, as the atomic string the answer carried
  (`:358`). My own mutation replacing it with the buy input amount failed 2 tests.
- **Share normalisation and the formulas.** `shares = tokensOut x tokenToShareRatio` matches the
  step-0 method and the `navPremiumBps` note in `src/core/models.ts:64-71`. I reproduced step 0
  independently: NVDAB at 500 USDT, 2.1085 shares against a reference of about 237.4 gives -12 bps,
  and SPYon at 500 USDT, 0.0950 shares gives about -57 280 bps, matching the reported 57 286 to the
  rounding of the published share figure. `roundTripBps` matches `(1 - usdtBack / usdt) x 10 000`.
- **Route classification and venues** (`src/query/stockCompare.ts:176-193`): `Rfq ` prefix only,
  names deduplicated in first-appearance order, tight charset, 32 chars, at most 4, no percentages.
  Deviation 5 (named makers such as Metric and Halfmoon counting as `amm`) is a labelling choice, not
  a defect; it is a one-line list if the operator disagrees.
- **Verdict thresholds** (`:198-221`): `about_same` is `edgeBps < 20` so exactly 20.0 is not
  about_same, `avoid` is `costBps > 200` so exactly 200 is not, `only` fires when exactly one version
  answered, an exact share tie goes to the bStock. Matches the plan and the build report.
- **`priceImpactPercent` is never read.** Confirmed by grep over both new files; PITFALL-35 respected.
- **Merge and 2 h expiry** (`:237-251`): a refreshed ticker replaces its row, an untouched one keeps
  it, rows past `STOCK_COMPARE_STALE_MS` drop, the result is bounded to 200 tickers. My mutation
  removing the expiry failed 2 tests.
- **A half-quoted ticker is discarded whole.** `fresh.push` is reached only after every size of every
  version (`:389`), and a `CycleStop` from any `gate()` unwinds past it, so a one-sided comparison
  cannot be published. Completed tickers are still saved in the `finally`.
- **Staleness** is taken from the row's own `quotedAt`, not the record's write time
  (`src/server.ts:1769`), 30 min fresh and 2 h stale, and the list form uses the newest row.
- **Route is store-only and closed.** One `deps.store.get` (`src/server.ts:1755`), no upstream
  reachable from the handler; `^[A-Z]{1,6}$` validation with a 400 `invalid_ticker` (`:1753`) and a
  404 `ticker_not_found` (`:1765`); errors carry a code and no upstream text; the payload is bounded
  by the normalizer; it sits behind the existing `app.use("*")` `x-dp-token` middleware
  (`src/server.ts:593-604`), which is registered before it. Nothing executable (calldata, `tx`,
  approval evidence) is stored or served, even though the request asks for `approveTransaction=true`.
- **Store and FakePg.** One jsonb key, and `test/stockCompare.test.ts:811-819` round-trips the
  snapshot through `PostgresStore` with `FakePg` and asserts it reads back unchanged through the
  normalizer, which is what the plane's `CLAUDE.md` asks for. No value can be rejected by the
  schema: `payload jsonb not null` (`src/core/store.ts:229`), U+0000 is stripped on write (`:352`),
  and the job already bounds every string it writes (symbol, lowercase 40-hex address, market status)
  so a published row always survives a re-read, which is deviation 11 and is correct. Size is
  comfortable: around 290 KB at the 200-ticker cap, far under the other keys this plane stores.
- **Config and flag.** On only for the exact string `"true"` (`:411-413`), registered inside the
  existing credentials block, a malformed knob throws rather than falling back, and the default
  headroom of 10 cannot be met by the unset bucket of 5 so a local run fails loudly instead of idling.

## Tests

| | TESTS | PASS | FAIL | SKIPPED |
|---|---|---|---|---|
| `npm test` on `7a83245` | 1069 | 1069 | 0 | 0 |

`npx tsc --noEmit`: clean, exit 0. The before/after figures in the build report (1021 -> 1069) are
consistent with the 48 new tests.

My own mutations, applied with `sed`, confirmed applied by grep, run against
`test/stockCompare.test.ts`, each restored from a byte copy afterwards:

| Mutation | Result |
|---|---|
| cycle self-stop budget 11 min -> 1 100 min | 1 of 48 fails |
| no-headroom give-up 30 s -> 3 000 s | 1 fails |
| sell-back sends the buy input amount, not the quoted output | 2 fail |
| `best` = fewest shares (ordering reversed) | 4 fail |
| merge keeps rows forever (2 h expiry removed) | 2 fail |
| `avoid` keys off `roundTripBps` instead of `costBps` | 1 fails |

All six killed, including the two the build report did not try (widening a limit rather than removing
it) and the sell-back amount. `git status --porcelain -- src/` is empty afterwards. The test file is
genuinely load-bearing, not decorative.

## Recommendation on the product gap (brief item 5)

Ship the data plane with a round-trip rule added at read time, before the skill. Concretely: list an
answered version under `avoid` when `roundTripBps > 200` as well as when `costBps > 200`, and do not
report `about_same` when the two versions' `roundTripBps` differ by more than 200 bps. Both are pure
functions of a row that is already stored, both are covered by the existing verdict tests' shape, and
together they turn the TSLA case from "about the same, pick either" into "bStock, avoid Ondo at this
size". The alternative, leaving it to the skill's prose, puts the one measured case where the issuer
choice costs 62 % behind a verdict field that says the two are equivalent.

Separately, the step-0 caveat that the absolute cost is untrustworthy below about 20 bps (finding 5
there) is handled correctly by the 20 bps `about_same` band, but `best` is still populated inside that
band. Consider setting `best: null` when `about_same` is true, so the payload cannot be read as naming
a winner the evidence does not support, instead of relying on every consumer to remember the rule.

## Live gates owed (unchanged from the build report)

`STOCK_COMPARE_ENABLED=true` on Railway after the fixes, with `BINANCE_RWA_RPS` confirmed at 18;
watch one cycle's log line (`ended`, `tickers`, `quotes`, `headroomWaits`, `ms`) and the live agents'
Flash proxy for `rate_budget_exhausted` and `upstream_failure` across that window. With MEDIUM-1 open,
also watch the first cycle after the deploy itself, which is when two processes can coexist.
