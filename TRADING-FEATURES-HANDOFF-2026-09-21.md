# Data-plane handoff: indicator revision 2 for the TradFi AI-trade score (BB, StochRSI, VWAP, gap, ORB, equity regime)

Date: 2026-09-21
Target repository: D:\4lphaDATA-marketplace
Status: **handoff for specification and build; nothing in this repository has been changed by the authoring session.** Operator rulings are recorded in the execution plane (`D:\4lpha-execution\.agents\memory\tradfi-ai-trade-rulings-2026-09-21.md`); the post-mortem that motivates this is `tradfi-live-run-diagnosis-2026-09-21.md` in the same directory.

Implemented (subsequent task, 2026-09-21): indicator revision 2 is built and verified offline — `npm run typecheck` clean, `node --test` **TESTS 658 / PASS 658 / FAIL 0 / SKIPPED 0** (12 new in `test/tradingFeatures.rev2.test.ts`, one rev 1 test updated for the two added watch-set pools). Not committed, not deployed; the execution plane's decoder still needs the `1 | 2` bump before it decodes rev 1 metrics off a rev 2 payload.

Implemented (§8 follow-up, 2026-09-22): coverage and cadence built and verified offline — `npm run typecheck` and `npm run build` clean, `node --test` **TESTS 659 / PASS 659 / FAIL 0 / SKIPPED 0**. Not committed, not deployed.

Implemented (§9 follow-up, 2026-09-22): admission built and verified offline — `npm run typecheck` and `npm run build` clean, `node --test` **TESTS 660 / PASS 660 / FAIL 0 / SKIPPED 0**. Not committed, not deployed.

- Root cause was not `DUE_PER_CYCLE` alone: `src/query/poolOhlcv.ts` had its own process-local in-flight concurrency cap (`r.inFlight.size < 4`), entirely separate from both `DUE_PER_CYCLE` and the `ohlcvTransport` budgets, and it was the dominant source of the measured `admission_limit` denials — most of a cycle's own admissions never reached the transport budget check at all. Renamed to `MAX_IN_FLIGHT_REFRESHES` and raised 4 → 22.
- `DUE_PER_CYCLE` (`src/jobs/tradingFeatures.ts`) raised 10 → 22. Every default-selection entry is `currency: "token"`, which tries `geckoterminal` then falls back to `dexpaprika` (`query/poolOhlcv.ts`'s `refresh`), so combined real capacity is `BUDGETS.geckoterminal (10) + BUDGETS.dexpaprika (12) = 22` — kept 1:1 with that combined number, not padded, same reasoning as §8.
- Separately, and probably the bigger fix: the producer's backoff was conflating "this attempt never reached the provider because our own admission/budget control said not-this-tick" with "the provider answered and something is actually wrong." Both got the same exponential backoff (up to 5 min) and the same `consecutiveFailures` escalation. At 10 pools that rarely mattered; at 36+ pools `admission_limit`/`budget_exhausted` is the *routine* outcome for most of a cycle, so denied candidates were being pushed further and further behind every pass instead of settling into a stable rotation — which is very likely why raising `DUE_PER_CYCLE` in §8 didn't clear the backlog on its own. `admission_limit`/`budget_exhausted` (plus the pre-existing `refresh_lease`) now retry flat at `now + 60_000` with no backoff escalation, and are counted as quiet (not a job failure) when a whole pass is nothing but self-throttling.
- With these three together, worked example for the 36-pool 15m burst (all 36 bars close on the same wall-clock boundary): cycle 1 admits the 22 oldest-due candidates — since 15m candidates are refreshed less often than 5m ones, their `attemptedAt` is systematically older, so the fairness sort favors them at the moment of a compound close — cycle 2 (~60s later, still inside the `close + step + 90s` grace) picks up the remaining 14. Full 15m coverage lands within roughly one cycle-pair, not several.
- **Caveat, stated rather than hidden:** this reasoning does not extend cleanly to the top of the hour, where 5m + 15m + 1h all close at once (108 candidates, 36 each). 1h candidates are refreshed even less often than 15m ones, so they sort *first* under the same oldest-`attemptedAt`-wins fairness rule, which can push 15m coverage behind schedule specifically at `:00` marks. Admission is still purely FIFO-by-age with no explicit interval-priority; fixing that (if `:00`-mark misses are observed live) is a distinct, larger change and was not built here — flagging it now rather than asserting the 90s SLA is met unconditionally.
- New test: `test/tradingFeatures.test.ts` ("handoff §9: self-throttle denials retry next tick without backoff and never fail the job") pins the no-backoff/no-escalation/quiet-not-failed behavior directly. Existing cap-fairness and in-flight-admission tests rescaled for the new constants (10→22, and the in-flight test's pool count 4→22).

- `MAX_POOLS` (`src/jobs/tradingFeatures.ts`) raised 10 → 40. `featureSelection`'s oversize-watchlist error message now names the live ceiling instead of a hardcoded "10".
- `defaultFeatureSelection` is now async and store-backed. New `defaultRwaFeatureSelection` reads `buildUniverse`'s `bstocks`/`ondo` lanes and, per token, keeps the deepest venue at or above the $10k depth floor (`SPREAD_MIN_LIQUIDITY_USD`, the same floor `spread-history` already watches at) — no hand-enumeration, so a new RWA admission is covered the next producer cycle. The two hardcoded NVDAB/TSLAB seeds are gone; the sweep now produces them. SPYB/QQQB stay pinned explicitly (not left to the sweep) so `/trading/regime/us-equity` keeps a known-good pool even on a cycle where the venue sweep hasn't run. If the union of majors + RWA sweep + equity legs ever exceeds `MAX_POOLS`, the lowest-liquidity RWA rows are trimmed with a warning log rather than throwing and starving every series.
- The read route's 10-pool batch bound (`GET /trading/features/v2?pools=...`, `src/server.ts`) was already independent of `MAX_POOLS` — confirmed, not touched.
- Cadence root cause was not the close+lag formula (`refreshAfter = closeTime + step + PUBLICATION_LAG_MS` was already correct) — it was `DUE_PER_CYCLE` (the job's per-60s-cycle admission count) colliding with the **hard, shared** `geckoterminal` transport budget in `src/adapters/ohlcvTransport.ts` (`BUDGETS`, atomic-leased across replicas, also serves `/pools/:address/ohlcv`). The old 4/cycle was already sized exactly to the old 8/minute Gecko budget (4 series × ≤2 HTTP). At the new pool count, steady-state warm demand is `~32*(1/5+1/15+1/60) ≈ 9.07` Gecko requests/minute — already past the old 8/minute budget before counting the RTH-close burst where every session-anchored series across all three intervals goes due at once. Raising `DUE_PER_CYCLE` alone without raising the transport budget would have made this worse: excess admissions get `budgetDenied`, which the job records as a failure and punishes with exponential backoff (up to 5 min). Both moved together: `BUDGETS.geckoterminal` 8 → 10, `DUE_PER_CYCLE` 4 → 10, kept 1:1 with the budget rather than padded. Neither number is a measured GeckoTerminal ceiling — none is documented in this repo — so this is "just enough for today's steady state," not a permanent answer; the RTH-close burst (all three intervals closing simultaneously across every session-anchored pool) still drains over several cycles, not one, and that is expected rather than fixed by this change.
- Tests updated for the new constants/behavior: `test/tradingFeatures.v2.test.ts` (`defaultFeatureSelection` is now async/store-backed; new test for deepest-venue-wins RWA sweep), `test/tradingFeatures.test.ts` (oversize-watchlist message, per-cycle cap fairness test rescaled to 7 pools/cap 10), `test/poolOhlcvFallback.test.ts` (shared-budget assertion 8 → 10).

Route / field additions:

- `parameters.indicatorRevision: 2`; `indicatorWarmupBars` + `{ bb20: 20, stochRsi14: 42, vwapSession: 1, gap: 1, orb: 6 | 2 | 0 }` (per interval); `bbPeriod`, `bbSigma`, `bbDeviation: "population"`, `stochRsiPeriods: [14, 14]`; `sessionClock: { timeZone: "America/New_York", rth: "09:30-16:00", close: "16:00-20:00", holidays: "none" }`.
- `metrics` + `bbMiddle20 bbUpper20 bbLower20 bbPosition20 bbWidthPct20 stochRsi14 lastRthClose gapPct vwapSession vwapDistancePct orbHigh orbLow orbBreakPct`. `lastRthClose` carries `asOf` (bucket close). New reasons: `zero_width zero_range not_us_equity no_rth_close_in_window zero_volume interval_too_coarse orb_not_formed not_rth`.
- `session: { usEquity, reason, state: rth|close|overnight|null, nextBoundaryAt, sessionStart, lastRthCloseAt, evaluatedAt }` on every rev 2 snapshot — `sessionState` lives here rather than as a `Metric`, whose `value` is numeric.
- `input.referenceSession: { underlyingTicker, marketStatus, openState, asOf } | null` retained for replay; surfaced read-side as `identity.referenceSession`. v1 payloads strip it.
- `/trading/features/v2/pools` → each pool carries `usEquity: boolean`.
- `GET /trading/regime/us-equity` (auth, envelope) → `{ asOf, sessionState, nextBoundaryAt, sessionClock, spy, qqq, regime, reasons, rule }`; `meta.staleness` `dead` when `unavailable`.
- Default watch set + SPYB/USDT 0.01% `0x7aa6d92fc369a8c1edc631a3aac44efb0808ddbf` and QQQB/USDT 0.01% `0xe531fcb1f5a195de7608b9f4f9518544c2cdb693` (8 of 10).

Deviations from §3, stated: bStocks report `marketStatus: null` (24/7), so the "US-equity `marketStatus`" qualifier is read as *platform `bstock`/`ondo` with an `underlyingTicker`* — the clock is the underlying's. The reference is read from `universe:rwa` at any staleness (the ticker never changes; `asOf` is carried). Measured on the live SPYB pool during Monday RTH: `gapPct` is unavailable on 5m always and on 15m Mondays (last RTH close ≥17.5 h back, window 10 h / 30 h), available on 1h (+0.98 % vs Friday's close); ORB formed on 15m (768.33 / 767.15, break +0.28 %).

## 1. Why

The first two-day live run of the TradFi v2 AI-trade agent (`tradfi-agent-01`, 100 USDT, 2026-09-19 → 21) closed 26 positions, 0 winners, −1.8 %. The execution-plane diagnosis: the LLM decided every exit on a bare prompt, and the indicators this plane already publishes (EMA12/26, ROC10, ATR14, RVOL20 and the `indicatorRevision: 1` additions RSI14, MACD 12/26/9, momentum10) were pasted into the prompt as JSON but drove **no rule**. The operator ruled that the execution plane adopts a deterministic 13-component score (Neural Alpha's shape: buy ≥ 14 / strong ≥ 38, falling-knife veto, LLM only nudges confidence) and that the missing components are produced **here first**, before the execution phase starts.

Components already served by v2 + rev 1: EMA12, EMA26, emaSpreadPct, ROC10, ATR14, ATR%, RVOL20, RSI14, MACD line, signal9, histogram, momentum10.
Missing, this handoff: **Bollinger 20/2σ, StochRSI 14/14, VWAP, gap vs last NYSE regular close, opening-range breakout (ORB), and an equity-market regime fact.**

## 2. Read first, preserve the architecture

`AGENTS.md`, `CLAUDE.md`, `README.md` ("indicatorRevision: 1" paragraph), `TRADING-FEATURES-SPEC.md`, `TRADING-FEATURES-V2.md`, `TRADFI-DATA-RESULT-2026-09-17.md`, `src/query/tradingFeatures.ts` (the `calculateFeatures` producer; rev 1 lives in the `version === FEATURE_VERSION_V2` branches around lines 160–225), `src/jobs/tradingFeatures.ts`, `src/adapters/binanceRwa.ts` (`openState` / `marketStatus`), `src/core/models.ts` (`referencePriceUsd`, `tokenToShareRatio`, `premiumBps`, `marketStatus`).

Invariants that stay: additive only (a new `parameters.indicatorRevision: 2` on the existing `pool-features-v2` payload; v1 and rev 1 numbers unchanged); each metric carries `available / reason / requiredBars / usableBars / unit`; null is never zero; no synthetic bars, no interpolation, no upsampling; the 120-bucket bounded window; the same one selected observation feeds every metric; replay via the stored `/input` snapshot must reproduce rev 2 exactly (extend the snapshot only with the extra inputs named below). Public BSC RPC posture unchanged; no paid provider.

## 3. What to add

### 3.1 Bar-only metrics (same series, no new inputs)

| Metric | Definition | Required bars | Unit |
|---|---|---:|---|
| `bbMiddle20` | SMA20 of close | 20 | price unit |
| `bbUpper20` / `bbLower20` | middle ± 2 × population σ of the same 20 closes | 20 | price unit |
| `bbPosition20` | (close − lower) / (upper − lower), clamp none; `reason: zero_width` when upper == lower | 20 | ratio |
| `bbWidthPct20` | (upper − lower) / middle × 100 | 20 | percent |
| `stochRsi14` | (RSI14 − min RSI14 over 14) / (max − min) over the last 14 RSI values; needs 14 RSI observations, each needing 29 bars → 42 bars; `reason: zero_range` when max == min | 42 | ratio 0–1 |

Reuse the rev 1 `rsi14` recurrence bar-for-bar (Wilder, SMA seed over 14 deltas, `50` when flat). Publish `stochRsi14` as the raw value; the execution plane smooths if it wants to. Warm-up rows go in `indicatorWarmupBars`.

### 3.2 Session-anchored metrics (need the NYSE clock and the RWA reference)

These exist only for pools whose base token is an RWA row with `underlyingTicker` and a US-equity `marketStatus`. For every other pool they are `available: false, reason: "not_us_equity"`.

The session clock is the one already used in the execution plane (`isUsEquityOpen` in `D:\4lpha-execution\src\trade\universe.ts`: `America/New_York`, Mon–Fri 09:30–16:00, no holiday calendar). Port it here as a pure function; add a NYSE holiday list only if cheap and documented, otherwise state "no holiday calendar" in the metric's `reason` vocabulary. Bucket convention stays UTC-open-ms; the session boundaries are converted to UTC per day.

| Metric | Definition | Inputs | Unit |
|---|---|---|---|
| `sessionState` | `rth` / `close` (16:00–20:00 ET) / `overnight` (all else, incl. weekends) at `calculatedAt`; plus `nextBoundaryAt` | clock | enum + ms |
| `lastRthClose` | close of the last bar whose bucket ends at or before the most recent 16:00 ET, with `asOf` | bars + clock | price unit |
| `gapPct` | (latest close − lastRthClose) / lastRthClose × 100; `reason: no_rth_close_in_window` when the 120-bucket window holds no RTH close | above | percent |
| `vwapSession` | Σ(typical price × volume) / Σ volume over bars since the current session start (RTH start for `rth`, 16:00 ET for `close`, previous 20:00 ET for `overnight`); `reason: unknown_volume_unit` / `invalid_volume` reuse RVOL's rules; `zero_volume` when Σ volume == 0 | bars + clock + volume | price unit |
| `vwapDistancePct` | (close − vwapSession) / vwapSession × 100 | above | percent |
| `orbHigh` / `orbLow` | high / low over the bars whose buckets fall inside 09:30–10:00 ET of the current RTH day; on 15m that is two bars, on 1h it is unavailable (`reason: interval_too_coarse`); before 10:00 ET or outside RTH `reason: orb_not_formed` / `not_rth` | bars + clock | price unit |
| `orbBreakPct` | (close − orbHigh) / orbHigh × 100 when close > orbHigh, (close − orbLow) / orbLow × 100 when close < orbLow, else 0 with `available: true` | above | percent |

Note the pool trades 24/7 while the reference does not: `gapPct` measures the on-chain price against the on-chain last-RTH close, not against Binance's NAV. The NAV-vs-pool relation is already `premiumBps`; do not conflate the two.

### 3.3 Equity regime fact (new small route, not a per-pool metric)

`GET /trading/regime/us-equity` (auth, envelope, staleness as everywhere). One record:

```
{ asOf, sessionState, nextBoundaryAt,
  spy: { pool, interval: "1h", emaSpreadPct, roc10Pct, rsi14, macdHistogram, gapPct, available },
  qqq: { ...same },
  regime: "risk_on" | "risk_off" | "neutral" | "unavailable",
  reasons: string[] }
```

Computed from the SPYB and QQQB pools' 1h rev 2 features that the producer already refreshes. Rule (deterministic, documented, replayable): `risk_off` when both ETFs have `emaSpreadPct < 0` and `roc10Pct < 0` on 1h, or either has `gapPct ≤ −2.5`; `risk_on` when both have `emaSpreadPct > 0` and `roc10Pct > 0`; else `neutral`. `unavailable` when either ETF's 1h evidence is missing or stale. The execution plane will blend this with CoinMarketCap's crypto-wide `get_global_metrics_latest` (that one is a whole-crypto snapshot and only a weak proxy for equities; this route is the equity leg).

If SPYB/QQQB are not in the feature pool set today, add them to the watch set with the same $10k depth floor recorded in `TRADFI-DATA-RESULT-2026-09-17.md`; do not special-case them past the floor.

## 4. Contract additions

- `parameters.indicatorRevision: 2`, `indicatorWarmupBars` extended with `{ bb20: 20, stochRsi14: 42, vwapSession: 1, gap: 1, orb: 2 }`, plus `sessionClock: { timeZone: "America/New_York", rth: "09:30-16:00", close: "16:00-20:00", holidays: "none" | "<list version>" }`.
- Input snapshot (`/input`) gains `referenceSession: { underlyingTicker, marketStatus, openState, asOf }` so replay of the session metrics is exact; bars themselves are unchanged.
- Rev 1 consumers must keep decoding: the execution plane's `decodeFeature` (`D:\4lpha-execution\src\trade\features.ts`) reads `parameters.indicatorRevision === 1` and the five additive metrics; rev 2 must keep those five byte-identical and add the new ones beside them. The execution plane will bump its decoder to accept `1 | 2`.
- `/pools` index: mark each pool with `usEquity: boolean` so consumers know which pools carry §3.2.

## 5. Tests the build must ship

- Fixture bars with a known SMA/σ → BB values by hand; zero-width band → `zero_width`.
- StochRSI at exactly 42 bars available, 41 bars → unavailable with `requiredBars: 42`.
- Session clock: a Friday 15:59 ET bar → `rth`; 16:00 → `close`; Saturday → `overnight`; DST switch week (March/November) → correct UTC boundaries.
- Gap: window with an RTH close → value; weekend-only window → `no_rth_close_in_window`.
- VWAP: volume unavailable → same reason vocabulary as RVOL; Σ volume 0 → `zero_volume`.
- ORB on 15m: two 09:30/09:45 bars → high/low; 1h → `interval_too_coarse`; 09:50 ET → `orb_not_formed`.
- Regime: four cases (risk_on, risk_off by EMA/ROC, risk_off by gap, unavailable) on fixed fixtures.
- Replay: a rev 2 snapshot recomputes to the same `snapshotId` after JSONB key reordering (the existing sorted-hash fixture pattern).
- Rev 1 regression: an existing rev 1 fixture produces byte-identical rev 1 fields under rev 2.

`node --test` offline only; quote TESTS / PASS / SKIPPED.

## 6. Out of scope here

No BUY/SELL logic, no thresholds, no weights (those are the execution plane's score spec); no paid CoinMarketCap calls (the execution plane pays and owns that budget); no changes to chart routes; no holiday-calendar purchase.

## 7. Report back

When done, append a short "implemented" note at the top of this file (like `TRADING-FEATURES-HANDOFF-2026-09-06.md`), list the route/field additions, and leave the execution plane a one-paragraph pointer in `D:\4lpha-execution\.agents\HANDOFF.md`.

## 8. Follow-up 2026-09-22 — coverage blocks the score: features for every pinned bStock pool

Observed on the first V3 cycles of a fresh local hire (`tradfi-trade-agent-01`, 12 routeable candidates): only 4 candidates carried evidence (`active` 1.00 / 0.53); 8 scored `insufficient-evidence` with `active = 0.09` (regime only) because `/trading/features/v2/pools` serves 8 pools (`marketplace_reference_pools`, `MAX_POOLS = 10`, `src/jobs/tradingFeatures.ts:15`) of which 4 are US-equity (two bStocks + SPYB + QQQB). Under the execution plane's 0.35 active-weight floor those 8 tokens can never be bought. The execution plane's `selectFeaturePools` already accepts up to 69 tokens, batched by 10 pools per request.

Ask: (1) raise `MAX_POOLS` (and the watchlist validator at line 70) to cover the whole TradFi pin, today 28 bStock/Ondo pools plus SPYB/QQQB — 32; (2) default the selection to "every pool the RWA allowlist admits at the $10k depth floor" so a new admission is covered automatically (the operator watchlist stays as an override); (3) keep the 10-pool batch bound on the read route so the client's paging is unchanged; (4) producer cadence: recompute each series at `close + publicationLag` rather than up to ~5 min later (observed 16:00 → 16:05:38 on SPYB on 2026-09-21), because readers reject the previous bar after `close + step + 90 s` and a cycle landing in that window scores nothing. Provider budget is the constraint to state: 32 pools × 2 intervals on the current OHLCV source.

## 9. Follow-up 2026-09-22 (afternoon) — measured after the 36-pool deploy

Execution side: the worker's index reader rejected any index over 10 pools, so the wider index produced ZERO evidence until `690fe71` (bound now 69, batches of 10). After that fix, read from the live plane at ~13:30 +07 (overnight session): 28 pinned tokens → 17 with evidence (5 full, 12 partial), 11 none.

Data-plane side, from `/trading/features/v2/pools` `series[].producer` on 15m + 1h (72 series):
- **42 `unavailable: admission_limit` (`cache:admission_limit`)** — the producer admits only part of the pool set per refresh and the rest queue indefinitely; this is now the single biggest gap. Please raise the per-cycle admission (or spread the refresh across the interval) so all 36 × 2 series are computed at least once per bar.
- 7 `unavailable: stale` / `stale_input` beyond the admission ones — same root: never refreshed in time.
- 16 `partial: gap` (1–23 missing bars in the 120 window on thin bStock pools, both Gecko and DexPaprika agree) — expected off-hours; nothing to do unless a filled-bar policy is wanted for illiquid pools (state it explicitly if so; the execution plane treats gapped metrics as unknown).
- `interval_too_coarse` (1h ORB) and `not_rth` are by design.
