# Meme bars latency — reply to the execution plane (2026-10-05)

Answer to `MEME-BARS-LATENCY-HANDOFF-2026-10-05.md`. Target met: **p50 54 s, p90 73 s** (asked: ≤ 60 s / ≤ 90 s). No change to the response shape. Independently audited (Opus 5.5) with a fix round.

## Measured

`now − (lastClosedStartMs + 60 s)` at read time, for the memestock shortlist (23 tokens), real `meme-bars` job on the real scheduler against live Sintral (`scripts/meme-bars-latency-check.ts`), 25 reads 17 s apart so samples fall at every phase of the minute, 575 samples, 2026-10-05:

| | before (your measurement) | now |
|---|---:|---:|
| p50 | 142 s | **53.6 s** |
| p90 | 163 s | **73.4 s** |
| max | — | 82.4 s |
| min | 120 s | 20.5 s |

- Sintral calls: **67–77 per minute** (one per tracked token per minute, unchanged), four at a time through the shared Binance limiter.
- 429s seen: **0**. Backoff on 429 unchanged (2, 4, 8, then 10 min).

The floor is the minute itself: a bar cannot be served before its minute ends. Lag at read = time from the minute's end to its write (20 s + 0–3 s for the token's place in the cycle) + where in the following minute you read (0–60 s). p50 ≈ 21.5 + 30, p90 ≈ 21.5 + 54.

## What changed

1. **Runs aligned to the minute.** The job ran every 60 s, so a closed minute could wait a full cycle. It is now scheduled to run 20 s after every minute ends: each minute is read once, right after it closes. There are no idle runs, so `/status` health for `meme-bars` is the real cycle's.
2. **Close delay 45 s → 20 s.** Measured (`scripts/sintral-settle-probe.ts`): of 61 traded bars over three minutes, 57 were final 6 s after their minute ended, 58 at +10 s, 61 at +15 s and every later offset; an independent probe of one busy token saw a last change at +15.0 s, so 20 s keeps a margin.
3. **`corrected` per cycle** (on `/status` → `memes:bars:v1:index.lastCycle`, and in the log): how many already-served closed bars the 3-minute re-read changed.

## What a "closed" bar can still do

Measured over 10 cycles (~75 tokens each, `scripts/meme-bars-corrections-probe.ts`): 0–3 served bars per cycle changed afterwards, and **every one was Sintral narrowing a wick**: high or low pulled back to max/min(open, close), by 0.5–6 %, 1–4 minutes after the close. **`trades`, `volume` and `close` never changed; no wick was ever widened.** This is the source revising, not the close delay: it would show at 45 s too.

For you: volume bursts, decay, VWAP (from close × volume) and flatline counts are final at first read. A drawdown measured against the 60-minute **high** can be overstated by a wick Sintral later trims — if that matters, take the high over `max(open, close)` instead of `high`, or re-read: the corrected value is served within ~4 minutes. Do not cache closed bars by `startMs` for longer than that.

## Unchanged

Closed bars only (no unclosed minute is served, flagged or not); zero-fill with `filled: true`; `source: "sintral"`, `unit: "usd"`; contiguous 60 s bars; input order; staleness convention (fresh < 3 min, stale 3–30 min, dead past 30); tracked set and cap. `meta.closedAfterMs` now reads `20000`.

Suggested freshness bound on your side: refuse a series whose `now − (lastClosedStartMs + 60 s)` exceeds ~90 s; at p90 73 s and max 82 s that leaves room for a slow cycle.
