# Meme bars retry + selection race - reply (2026-10-07)

Branch `meme-bars-retry` (from master 4c83719), commits `b531a0f` (A, first B shape) and `f4ab71f` (B revised: :08 start, :19 write deadline). Not merged, not pushed, nothing deployed or run against upstreams.

## What changed

### Defect A: 10-minute retry for an empty, shortlisted token

`src/jobs/memeBars.ts`
- :101 `SHORTLIST_RETRY_MS = 15 * MINUTE`.
- :133 `IndexEntry.shortlistedAt?: number`: when the token was last on the memestock shortlist while tracked.
- :308-314 `selectTracked` sets `shortlistedAt = now` for a shortlisted candidate and carries the previous value otherwise.
- :443 `readIndex` parses `shortlistedAt`, so it survives the index round trip between cycles.
- :367-370 the worker skips an empty series for the 10-minute `UNKNOWN_RETRY_MS` only when the token is NOT recently shortlisted (`now - shortlistedAt <= 15 min`). A shortlisted (or recently shortlisted) token with `bars: []` is re-asked every cycle, i.e. every minute.
- :38-43 header doc updated.

The 429 backoff is untouched: the global `backoff` gate (memeBars.ts:333, before selection) still stops every call, re-asks included, for 2/4/8/10 minutes.

### Defect B: selection race (board write between :20 and :25)

Why this is only a board-write race: every memestock shortlist row is a bStock-quoted runner/active board row (`matchesShortlist`, memeQuery.ts:471-474), and `selectTracked` already tracks every such live board row whether or not it is shortlisted (memeBars.ts:282-283). So, while the 120 cap does not bind (about 75 tokens tracked today), a quote stock opening or a shortlist gate flipping between :20 and :25 cannot create an untracked shortlist member. Only a new board write can.

Shape chosen (coordinator revision, commit `f4ab71f`; it replaces the :30 phase of `b531a0f`, which made the board read at :25 about 49 s old on every cycle): the board starts at :08 and may write only until :19 of the minute it started in.

`src/jobs/memeBoard.ts`
- :526 `BOARD_PHASE_MS = 8_000`, :528 `BOARD_WRITE_DEADLINE_MS = 19_000`, :531 `msUntilBoardRun` (same shape as `msUntilNextRun` in memeBars).
- :543 `boardWriteSignal(signal, startedAt)`: the scheduler's signal, also aborted at :19 of the minute `startedAt` falls in, and at once when that is already past.
- :558 `memeBoardJob` has `nextDelayMs: msUntilBoardRun`; `jitterMs` stays and applies to the first run after boot only.
- :564 the run passes `boardWriteSignal(signal, Date.now())` to `runMemeBoard`. If the deadline (not the 45 s timeout) cut the run, it logs `past the write deadline: nothing written this minute` and returns without failing the job, so a deadline miss does not count as a job failure on `/status`. The timeout is unchanged and still fails the run.
- :346 `signal.throwIfAborted()` right before the two writes (state, then board). `runMemeBoard` tolerates each source failing (partial cycle), so without this check an aborted run could still write late. With it, a run past the deadline or the timeout writes nothing. At :19 the in-flight upstream fetches are aborted too.

Resulting timing: a board write lands only between :08 and :19, always before the bars job's :20 selection. The next run is the next :08. Every lane read from :20 up to the next :08 (a 48 s window) sees exactly the board the bars job selected from. That covers the :25 read and also meme wallets that run later in the exec loop, up to :08 of the next minute.

Restart: the scheduler's first run fires at 0-5 s jitter, off phase. If that start is at or past :19 of its minute, the write signal is already aborted and nothing is written. If it is before :19, it is cut off at :19. In both cases no write lands after :19, and after the first run the job is back on :08.

Board age at the :25 read: the write lands at :08 plus the run time. Measured runs are 2-5 s (`MEME-SHORTLIST-HANDOFF-2026-10-05.md:19`), 4.6-5.5 s (`MEME-SIGNALS-REPLY-2026-10-05.md:97`) and 6.6 s (`MEME-FOURMEME-TAX-REPLY-2026-10-06.md:162`), so the write lands at about :10-:15. The board is therefore about 10-15 s old at :25, and at most 17 s while the deadline holds (before: 0-60 s, mean about 30 s).

Deadline-miss estimate: the window is 11 s (:08 to :19), and a run misses it only if it takes more than 11 s. The slowest measured cycle is 6.6 s, so a miss needs a cycle about 1.7x slower than anything measured, in practice an upstream that is slow, throttled or timing out. The repo has no distribution of board cycle times (only the three point figures above), so I cannot give a rate. From what is measured, I expect misses to be rare and tied to upstream incidents, not a steady fraction. The job logs every miss, so the rate can be measured once deployed.

A skipped write leaves the previous minute's board in place. Under the existing staleness rules (`BOARD_FRESH_MS = 3 min`, memeBoard.ts:73) the last write (:08-:19 of minute m) is still `fresh` at the bars selection and the lane read of minutes m+1 and m+2 (age at most 2 min 17 s). Only a third consecutive miss makes it stale. At that point the bars job adds no one (it requires a fresh board) and the lane's own `shortlistFresh` check applies.

Why this shape over a catch-up pass in the bars job: one scheduling line, one deadline signal and one abort check. There is no second pass and no extra Sintral call, and the :20-:25 race closes completely, whereas a catch-up pass at e.g. :24 still leaves a :24 to :25 window.

Worst-case latency for a newly admitted token: the board admits it at a write between :08 and :19, and the bars run at :20 of the same minute selects and fetches it (1 to 12 s after the write). Board candidates all sort as live, with the shortlisted ones first (memeBars.ts:297-303). With at most 30 shortlisted tokens and 4 workers at about 0.2-0.3 s per call (the job's own budget note), that tier is done by about :22-:23, before the :25 read. The per-call figure is the existing estimate, not re-measured here, and a new token's first fetch is the full 182-row backfill. If Sintral's first answer is empty, the Defect A fix asks again at the next :20.

Residuals:
- **The exec-plane read is not always at :25.** Read-only check of `D:\4lpha-execution`:
  - The meme step runs per wallet inside the sequential wallet loop (`src/agentic/worker.ts:170`, step at `:243`) and reads `/memes/shortlist` at its own step (`src/agentic/memeLane.ts:182`).
  - With writes now confined to :08-:19, any read from :20 to the next :08 is safe, so late wallets are covered unless they read after the next :08.
  - `agenticLaneSleepMs` takes `min(legacy, untilSlot)`, so after a cycle longer than about 45 s the next lane start can come before :20. That read sees a board written at :08-:19 whose new tokens the bars job has not fetched yet, so one cycle is untracked.
  - This is exec-plane timing that the data plane cannot close alone.
- When the 120 cap binds, a live token cut by the cap can still be on the lane's shortlist and untracked for one cycle if its quote stock is written as open between :20 and the read (the `binance-rwa` phase is not pinned).
- A timer that fires late (event-loop lag) or a slow store write can land a write a few ms after :19. The bars job reads the board at :20 or later, so there is about 1 s of margin.
- Clock skew between the data-plane and exec-plane hosts shifts :25 against :08-:19, with a margin of about 6 s before the read and about 43 s after it.
- `memeMeasure` and `binanceRwa` read the latest board with no phase assumption; `src/index.ts:80` only registers the job.
- The run-level catch (a deadline miss logs instead of failing) is not covered by a test, because the job uses the real upstream fetchers. `boardWriteSignal` and `runMemeBoard` under it are tested.
- The "1m bars" line in `D:\4lphaDATA-marketplace\CLAUDE.md` does not mention the shortlist retry or the board phase/deadline. I did not edit it (it is outside this worktree).

## Sintral call budget

Unchanged in the steady state: still at most one call per tracked token per minute. Extra calls only for tokens that are shortlisted (or were within 15 min) AND still have an empty series: at most one per such token per minute instead of one per 10 minutes, bounded by the shortlist size (30), and in practice a handful of new tokens for their first few minutes. This stays inside the documented envelope (one call per tracked token per minute, cap 120). The board change adds no calls.

## Tests

New, offline (`test/memeBars.test.ts`, describe "bars retry and board phase (2026-10-07)"; `test/memeBoard.test.ts`):
- An empty first answer for a shortlisted token is asked again the next minute, and its bars are served the minute Sintral has them.
- After it leaves the shortlist it is still asked every minute for 15 minutes and `shortlistedAt` survives between cycles. After that it falls back to the 10-minute retry.
- A 429 on a re-asked shortlisted token still sets the backoff, and the next minute is `skipped: "backoff"` with no call.
- The board starts at :08 for every `now` (250 ms steps over two minutes), and :08 < :19 < :20.
- `boardWriteSignal` (fake timers, every start offset in the minute at 250 ms steps):
  - a start before :19 can still write 1 ms before :19 and is cut off exactly at :19;
  - a start at or after :19 is cut off at once. This is the off-phase restart case: no write after :19.
- `runMemeBoard` started at :19, :25 or :59 (deadline already past) writes neither the board nor its state, even with instant upstreams.
- A board run aborted mid-run writes neither the board nor its state.
- A token the board admits at the latest possible write (just before :19) is on the lane's shortlist at :25 and has fresh, tracked bars, selected at :20 of the same minute.
- The existing "asks only every 10 minutes" test now closes the quote stock, so its token is live but not shortlisted. Its token was shortlisted before, which the fix now correctly asks every minute.

Mutation checks:
- Turning off the shortlist condition fails the three A tests.
- Removing `throwIfAborted` fails the timeout test and the past-deadline test.
- Moving the deadline to :21 fails the phase test.

Results:
- `test/memeBars.test.ts`: 36 / 36 pass / 0 fail / 0 skipped.
- `test/memeBoard.test.ts`: 57 / 57 / 0 / 0.
- Full suite (`npm test`): TESTS 992 / PASS 992 / FAIL 0 / SKIPPED 0 (master baseline 984; +8 new tests).
- `npx tsc --noEmit`: clean.

## Fix round (commit `57057d9`, on the review `MEME-BARS-RETRY-REVIEW-2026-10-07.md`)

This supersedes the "writes nothing past :19" behaviour described under Defect B above. Defect A is unchanged.

### M1: a late run holds its write instead of dropping it
- `src/jobs/memeBoard.ts:531-535`: `BOARD_PHASE_MS = 8_000`, `BOARD_WRITE_DEADLINE_MS = 19_000`, `BOARD_HELD_WRITE_MS = 26_000`.
- `:550` `holdOutsideReadWindow(now, signal)`:
  - when `now` is outside [:19, :26) of its minute, it resolves `false` at once;
  - when inside, it resolves `true` at :26;
  - it rejects at once when the scheduler's signal aborts (the 45 s timeout).
- `:128` and `:347`: `runMemeBoard` gains `holdWrite`, which is awaited right before the abort check and the two writes. `boardWriteSignal` is gone, and nothing aborts the run at :19 any more.
- **Result.** A board write lands only in [:08, :19) or [:26, timeout). An on-phase run times out at :53, before the next :20.
  - A board written at :26 or later is picked up by the next :20 bars selection, so the :20-:25 race stays closed.
  - The `throwIfAborted` before both writes (`:350`) still guarantees that a timed-out run writes neither the board nor its state.
  - A run that crosses into the next minute (an off-phase first run after a restart) obeys the same [:19, :26) hold, measured against the minute it is in.

Board age at the lane's :25 read, per case (measured run 2-6.6 s):

| Case | Board the lane reads at :25 | Age |
|---|---|---|
| Ready before :19 (normal) | this minute's, written about :10-:15 | about 10-15 s, at most 17 s |
| Ready in [:19, :26) (held) | the previous one; this minute's lands at :26 | about 59 s if the previous one was also held to :26; about 66-77 s if it was on time |
| Ready after :26, before the :53 timeout | the board written late in the previous minute | 85 s minus its write offset, e.g. 45 s for a :40 write |
| Timeout | the previous one; nothing written | grows by 60 s per timeout; stale after 3 min |

Effect on the exec plane:
- The lane caches its market work, bars included, by the shortlist `asOf`.
- A held write still changes `asOf` every minute (at :26), so the next :25 read gets a new `asOf` and re-reads bars. The review's two-miss stall of entries (`stale-at-decision`) no longer happens on slow cycles; only on timeouts.
- A meme wallet that reads after :26 in the same exec cycle sees the held board's new tokens without bars until the next :20. That is one cycle, fail-closed.

### H1: no swallowed errors, and the board shows on `/status`
- The catch around `runMemeBoard` is gone. A timeout and a total discovery failure (`no discovery source available`) fail the run on `/status` exactly as before the change. A held write is a normal success.
- Every cycle logs `[meme-board] rows=<n> readyMs=<ms>`, plus `held_to=:26` when the write was held (`:595`). Logging ready time on every cycle measures how often a run misses :19.
- `src/server.ts:204` adds `MEME_BOARD_KEY` to `STATUS_SNAPSHOT_KEYS`, so `/status` shows the board's own `asOf`, source and staleness.

### M3: test seam and job-level tests
- The seam is `memeBoardJob(store, options?: RunMemeBoardOptions)` (`:571`). Production passes nothing; the options flow to `runMemeBoard` with the job's `holdWrite`.
- `test/memeBoard.test.ts`, describe "meme-board job write window (fix round 2026-10-07)", drives `spec.run` with fake upstreams, a fake clock and mocked `setTimeout`:
  - an on-time run writes at once (asOf :12);
  - a run ready at :21 is still unwritten 1 ms before :26, writes at :26 and resolves;
  - a timeout while held rejects at once and writes neither board nor state, even after the clock passes :26;
  - a real total-discovery failure rejects, both on time (:12) and late (:21);
  - `/status` lists `memes:board` with its staleness.
- `test/memeBars.test.ts`:
  - the phase test asserts :08 < :19 < :20, :26 > :25, and :08 + 45 s < the next :20;
  - `holdOutsideReadWindow` is checked at every 250 ms offset: no hold outside [:19, :26), and inside it, still held 1 ms before :26 and released at :26;
  - the integration test still shows a token admitted at the latest on-time write being on the :25 shortlist with fresh, tracked bars.

### Mutations re-run (the review's M6-M9, recast for the new shape)

| # | Mutation | Result |
|---|---|---|
| M6' | A held write counts as a failure (throw when held) | Killed ("a run ready at :21 writes at :26 ... and succeeds") |
| M7' | Every error swallowed (`.catch` on the run) | Killed (timeout test and real-failure test) |
| M8' | The hold ignores the scheduler signal | Killed (the timeout test needs an immediate rejection) |
| M9' | The hold is never applied | Killed (held-to-:26 test and timeout test) |
| M10 | Abort check before the writes dropped | Killed (timed-out-run test) |

Source restored after each mutant; the sha1 matched the backup.

**Incident during mutation testing:** my first attempt at M7' was malformed. It called `runMemeBoard(store, signal, {})` with no fakes, so one test run (the "on-time run" test, about 4.6 s) used the production fetchers. That means read-only requests to the board's public upstreams (Binance Web3 Meme Rush, OKX/OnchainOS reads, and possibly the BSC RPC reads behind them), written only into the in-memory test store. Nothing was written anywhere else, nothing was deployed, and no transaction was involved. I replaced it with a correct mutant (above). This broke the "tests offline only" rule for those few seconds.

### L5: stale timing text
- `MEME-SHORTLIST-HANDOFF-2026-10-05.md:19` is tracked here and was a single sentence, so I updated it in this commit (start at :08, 2-7 s per cycle, no write in [:19, :26)).
- Not edited, for you in the main tree: `D:\4lphaDATA-marketplace\CLAUDE.md`:
  - "1m bars" (`:127`) does not mention the shortlist retry (empty shortlisted series re-asked every minute for 15 min after last shortlisted);
  - the "Meme board" section still describes a 60 s ± 5 s jittered board job; it now starts at :08 with no write in [:19, :26);
  - `/status` now also lists `memes:board`.

### Residuals still open
- **M2 (recorded, not fixed).** `tracked` flips only when the bars cycle writes its index at the end (`memeBars.ts`, index put after the fetch loop). The cycle ends about :23, about 2 s before the :25 read, and Defect A's full-window re-asks can lengthen it in a burst. A new token can read `tracked: false` for one minute. This is fail-closed. The ":25" integration test runs the bars cycle instantly, so it does not model this.
- **L1.** The venue cache and quote-kind cache are still written before the gate, so a timed-out run does write those two. That is harmless and deliberate (they let a slow backlog drain). The code comment now says so.
- **L2.** About 1 s of write margin remains: a gate passed at :18.9x plus a slow Postgres put can land just after the bars job's :20 board read.
- **L6.** An exec cycle that ends between :08 and :20 after running over 60 s starts at once and can read a board the bars job has not yet selected from. This is exec-plane timing.
- The 120-cap and quote-stock-open residual from Defect B is unchanged.

### Results (fix round)
- `test/memeBars.test.ts`: TESTS 36 / PASS 36 / FAIL 0 / SKIPPED 0.
- `test/memeBoard.test.ts`: TESTS 61 / PASS 61 / FAIL 0 / SKIPPED 0.
- Full suite (`npm test`): TESTS 996 / PASS 996 / FAIL 0 / SKIPPED 0 (master baseline 984).
- `npx tsc --noEmit`: clean.
