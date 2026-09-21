# Data-plane handoff: indicator revision 2 for the TradFi AI-trade score (BB, StochRSI, VWAP, gap, ORB, equity regime)

Date: 2026-09-21
Target repository: D:\4lphaDATA-marketplace
Status: **handoff for specification and build; nothing in this repository has been changed by the authoring session.** Operator rulings are recorded in the execution plane (`D:\4lpha-execution\.agents\memory\tradfi-ai-trade-rulings-2026-09-21.md`); the post-mortem that motivates this is `tradfi-live-run-diagnosis-2026-09-21.md` in the same directory.

Implemented (subsequent task, 2026-09-21): indicator revision 2 is built and verified offline — `npm run typecheck` clean, `node --test` **TESTS 658 / PASS 658 / FAIL 0 / SKIPPED 0** (12 new in `test/tradingFeatures.rev2.test.ts`, one rev 1 test updated for the two added watch-set pools). Not committed, not deployed; the execution plane's decoder still needs the `1 | 2` bump before it decodes rev 1 metrics off a rev 2 payload.

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
