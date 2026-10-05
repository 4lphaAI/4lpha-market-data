# Meme bars latency: request from the execution plane (2026-10-05, addendum to MEME-SIGNALS-HANDOFF)

**Operator go 2026-10-05.** Item 1 (`/memes/bars`) works and passes every contract check, but its latency is now the largest lever on the meme brain's result. Please cut it.

## Measured (production, master `1525319`, 2026-10-05 ~10:47 UTC)

- `now - (lastClosedStartMs + 60 s)` on healthy shortlisted series: **120-163 s** (p50 142, p90 163; six reads 20 s apart, sawtooth with the 60 s cycle). One untracked token: 0 bars (correctly refused downstream).
- Sintral itself: the newest traded bar's start was a median 124 s old on 61 live meme stocks (2026-10-05 15:40 +07), i.e. its end ~64 s old; the plane adds its 45 s close lag plus the 60 s cycle.
- Effect (execution-plane replay, `D:\4lpha-execution\MD here\AGENTIC-MEME-STOCKS-RESEARCH.md` section 6b, 213 meme stocks, ~1 day of 1m bars): the same entry rules lose **-8.5 %** per trade with a 2-minute entry lag, **-6.1 %** with 1 minute, **-2.1 %** with none; with wide exits the result goes from -6.3 % (lag 2) to **+0.9 %** (lag 0). Roughly 3 points per trade per minute of lag.

## Ask

1. **Target: p50 lag at or under 60 s, p90 at or under 90 s** for the tracked set (live meme stocks + memestock shortlist), measured the same way (`now - (lastClosedStartMs + 60 s)` at read time).
2. Levers you own (choose and measure; this is your plane's call):
   - shorten the close delay (45 s today; you saw Sintral still changing a bar 21 s after its close; the existing re-read of the last 3 closed minutes already corrects late edits, so a shorter close plus re-read keeps the closed-bar contract honest);
   - cycle the tracked set faster than 60 s (e.g. 20 s), within a Sintral budget you measure (today ~74 calls per cycle, ~3 s); back off as today on 429;
   - optionally, a separate flag on the newest bar if you ever serve an unclosed minute (never mixed silently with closed bars). Not required.
3. Keep every current guarantee: closed bars only unless explicitly flagged, zero-fill with `filled: true`, `source`/`unit`, contiguous 60 s, input order, staleness convention.
4. Report back: the new lag distribution (p50/p90/max over at least 10 reads), Sintral calls per minute, 429s seen, and any change to the response.

## Not in scope

Any execution-plane change. The execution plane will tighten its own entry freshness bound to match whatever you deliver.
