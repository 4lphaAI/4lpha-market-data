# C1: features for pool-less bStocks, research result (2026-09-23)

Answers §C1 of `TRADFI-AGGREGATOR-HANDOFF-2-2026-09-23.md`. Reproduce with
`node --import tsx scripts/poolless-series-probe.ts`. The script is read-only and keyless for
Sintral. It was run 2026-09-23 at 10:59 and 11:00 UTC, which is 07:00 ET, US pre-market.

## Verdict

- **Can Sintral serve it?** Yes. Sintral answers 15m and 1h bars by **token address** for all 25
  pool-less bStocks.
- **What the price is:** Binance's **own traded price**, not the issuer/reference price.
- **Is it enough for AI Trade?** No. The trades are too sparse for 15m features. Under the
  `indicatorRevision 3` rules, the 15m window clears the 30-real-bar floor most of the time for
  **one token (AMDB)**, and about half the time for one more (KORUB). PLTRB and LITEB, the
  handoff's examples, almost never clear it.
- **No other source helps.** Binance's own signed `/market/candles` returns the identical bars. The
  gap is missing trades, not a missing data source.

**Recommendation:** do not open the "pool-less AI Trade" phase as a general feature. The C2 spec is
therefore not written. A narrow option is at the end, for the operator to decide.

## Pool-less set

A pool-less token is a bStock with no venue at or above the $10k floor that the feature producer
uses (`defaultRwaFeatureSelection`). That is 25 of the 46 bStocks in the live
`/universe?lane=bstocks`:

`INTWB MUUB PLTRB AAOIB MRVLB KORUB CRWVB ORCLB COINB QCOMB LITEB GLWB AMDB AVGOB MVLLB DRAMB AXTIB EWYB RKLBB ARMB QNTB NBISB CBRSB WDCB IBMB`

Several have a pool that is only dust: MRVLB $5.2k, ORCLB $9.8k, COINB $3.0k, the rest ≤ $35.
AMDB has none in the venue lane, although Flash found a thin Uniswap V4 pool
(`TRADFI-AGGREGATOR-REPLY-2026-09-23.md`, A4).

## What the series is

Evidence that it is a trade stream and not the reference price:

- **Every bar carries volume**, across all 25 tokens and both intervals, and no bar is flat
  (O=H=L=C).
- **The number of distinct closes equals the number of bars.** A reference feed would repeat or
  step.
- **Bars exist only where trades happened.** PLTRB has 2 bars in the last 30 h and Binance's
  `/market/candles` reports exactly 2 trades there. AMDB has 68 bars from 147 trades.
- **The last close is not the reference price:**
  - AMDB −318 bps, IBMB −185, INTWB −197, COINB +159 and CBRSB −456, where the last trade was
    55 h old.
  - Pool controls, whose bars come from pool trades: NVDAB −31, SPYB +16, QQQB +21.
- **Same stream as `/market/candles`.** For PLTRB (2/2), LITEB (7/7) and AMDB (68/68), timestamps
  and closes match exactly. That endpoint also returns `tradeCount` per bar.

**Consequences:**

- Indicators computed from this series describe **the token as traded**, which is what AI Trade
  executes against. That part is good.
- But this is a thin trade stream. Under rev 3 forward-fill, a stale last trade is carried forward
  as if it were current: CBRSB's 55-hour-old price would read as "now". The 30-real-bar floor is
  the only thing that stops this.
- This matches handoff C2: the `tokenPriceUsd` on these rows is the issuer price, and the Sintral
  close is a different number.

## Coverage against the rev 3 floor

- **Rule, from `calculateFeatures`.** The window is the trailing 120 closed buckets (FEATURE_HISTORY),
  so 30 h on 15m and 120 h on 1h. A Sintral series is forward-filled from its first real bar, and
  fewer than 30 real bars gives `too_few_real_bars` on every metric.
- **Snapshot vs. rolling.** A single snapshot depends on the hour it is taken. The table therefore
  also slides the window hourly over the deepest pull Sintral allows (600 bars: 6–90 days,
  depending on how sparse the token is). "admit" is the share of those window positions that
  reach ≥ 30 real bars.

| Token | 15m now | 15m admit | 15m median | 1h now | 1h admit | 1h median |
|---|---:|---:|---:|---:|---:|---:|
| **AMDB** | 68 | **68 %** | 50 | 107 | **100 %** | 73 |
| KORUB | 27 | 48 % | 27 | 50 | 80 % | 46 |
| DRAMB | 6 | 30 % | 23 | 17 | 79 % | 55 |
| COINB | 5 | 22 % | 10 | 25 | 43 % | 26 |
| MRVLB | 8 | 11 % | 13 | 46 | 63 % | 37 |
| IBMB | 28 | 9 % | 4 | 90 | 32 % | 15 |
| MVLLB | 10 | 5 % | 7 | 16 | 52 % | 30 |
| MUUB | 15 | 4 % | 12 | 28 | 74 % | 37 |
| AAOIB | 7 | 4 % | 6 | 26 | 39 % | 24 |
| AVGOB | 22 | 2 % | 7 | 54 | 54 % | 36 |
| ORCLB, AXTIB, NBISB | 7–17 | 2 % | 6–8 | 24–34 | 31–47 % | 22–29 |
| LITEB, RKLBB, EWYB | 3–14 | 1 % | 5–6 | 6–32 | 20–36 % | 22–23 |
| **PLTRB** | 2 | **0 %** | 5 | 15 | 21 % | 21 |
| INTWB, CRWVB, QCOMB, GLWB, WDCB, CBRSB | 0–14 | 0 % | 3–7 | 6–33 | 4–23 % | 14–24 |
| ARMB, QNTB | 1–5 | 0 % | 2 | 4–21 | 0 % | 8–11 |
| *controls NVDAB/SPYB/QQQB* | 119 | 100 % | 120 | 119 | 100 % | 120 |

Summary:

- **15m:** 1 of 25 tokens clears the floor most of the time; 23 of 25 are below 31 %.
- **1h:** 7 of 25 clear it more than half the time.
- AI scoring needs **both** intervals, so today 15m is the binding constraint.

Sintral latency is 160–340 ms per call, with no throttling seen across about 170 sequential calls
at about 3 requests/s. This is the same host the pool features already use.

## A narrow option (operator's call, not built)

If AMDB alone, or AMDB and KORUB, is worth it, the change is small, because the rev 3 floor already
decides admission bar by bar:

- Admit a pool-less bStock into the feature index with a synthetic identity:
  `kind: "token-series"`, `source: "sintral"`, `priceCurrency: "usd"`, and the token address.
- Keep the same `pool-features-v2` payload and rev 3.
- Tokens below the floor publish `too_few_real_bars`, which execution already scores as missing
  evidence.

Two points need the operator's decision first:

1. The index would carry about 25 more rows, of which about 1–2 are usable at any time. That adds
   producer load (roughly 50 series of admissions per cycle, against the `DUE_PER_CYCLE = 40`
   rotation) for little benefit.
2. A forward-filled thin series makes RSI/ATR/BB read "quiet" rather than "unknown" between trades.
   The floor stops the worst case, not the whole effect.

If the operator wants it, the next step is the C2 spec in the shape execution proposed, scoped to
tokens that clear the 15m floor, and then the build.
