# Meme bars retry + board phase - independent review (2026-10-07)

Target: worktree `D:\4lphaDATA-wt-bars`, branch `meme-bars-retry`, commits `b531a0f` + `f4ab71f` on master `4c83719` (`git diff 4c83719 f4ab71f`: `src/jobs/memeBars.ts`, `src/jobs/memeBoard.ts`, two test files). Builder reply: `MEME-BARS-RETRY-REPLY-2026-10-07.md`. Consumer read: `D:\4lpha-execution` `src/agentic/worker.ts`, `memeLane.ts`, `memeData.ts` (read-only).

Reviewer did not write the change. Nothing was edited, committed or deployed, and no upstream was called. The source tree was left as found (sha1 of both mutated files matched the backups after restore).

## Verdict

**SHIP WITH RESIDUALS, on two conditions before merge: fix H1 (health masking) and M3 (job-wrapper test).** Both are small.

Both intents are met as specified:
- A: an empty series for a shortlisted (or recently shortlisted) token is re-asked every minute, and the 429 backoff stays global.
- B: no board write can land in the :20-:25 window of a minute, so the race is closed.

The cost is availability and observability. A slow cycle used to publish late; it now publishes nothing, and the job reports green while doing so. The lane fails closed (paper mode, hold on stale data), so no money is at risk. But `/status` is the judges' "Data status" surface (`D:\4lphaDATA-marketplace\CLAUDE.md:48`) during judging (Oct 12-23), and it would show `meme-board` healthy while the board is dead.

## Verification of the reply's claims

| Claim | Result |
|---|---|
| Line refs memeBars.ts :101 / :133 / :308 / :333 / :369 / :443; memeBoard.ts :346 / :526 / :528 / :531 / :543 / :558 / :564 | All correct. |
| A: re-ask every cycle only while `now - shortlistedAt <= 15 min`; others keep 10 min | Correct (`memeBars.ts:369-370`). `shortlistedAt` is set at `:308` from this cycle's `c.shortlisted`, carried otherwise, and parsed back at `:443`. |
| 429 backoff still global | Correct. The gate at `memeBars.ts:333` runs before selection; a re-asked token's 429 sets `throttled` (`:392`) and the streak (`:418-419`). Covered by a test. |
| Every memestock shortlist row is a bStock-quoted runner/active board row, so only a board write can create an untracked shortlist member | Correct. Default `statuses` is runner/active (`memeQuery.ts:206`), `segment=memestock` requires `quote.kind === "bstock"` (`memeQuery.ts:474`), and `selectTracked` takes every such row as live (`memeBars.ts:282-283`), cap 120 permitting. The exec plane calls the shortlist with the default query (verified via the shared `parseShortlistQuery` path). |
| Board runs at :08 and writes only before :19 | Correct for the write gate: `throwIfAborted` at `memeBoard.ts:346` comes before both puts (`:347`, `:352`). The deadline timer is relative to the minute the run started in (`:545`). |
| `jitterMs` applies to the first run only | Correct. `scheduler.ts:118` uses `nextDelayMs` on every tick; jitter only in `start()` / `register()` (`:154`, `:162`). |
| Off-phase first run past :19 writes nothing | Correct (`ms <= 0` aborts at once, `:546`). |
| "A run past the deadline or the timeout writes nothing" | Overstated, see L1: the venue cache and quote-kind cache are still written before the gate. |
| Board age at :25 about 10-17 s | Correct for `asOf` (put time, `store.ts:118`): 6-17 s while the deadline holds. |
| Miss "needs a cycle about 1.7x slower than anything measured" | Misleading, see M1: a miss depends on the slowest single sequential call, not the mean cycle. |
| A skipped write only hurts at the third consecutive miss | Wrong for the lane's entries, see M1: two consecutive misses already veto every entry. |
| Sintral budget "bounded by the shortlist size (30)" | Loose, see L3. The hard bound is unchanged (120 calls/min). |
| Tests: memeBars 36/36, memeBoard 57/57, full 992/992/0/0, tsc clean | Reproduced (below). |
| Run-level catch untested | Confirmed, and worse than stated: the job wiring of the deadline is untested too (M3). |

## Findings

### HIGH

**H1. A deadline miss, including a total discovery outage, is reported as a healthy run, and nothing on `/status` shows the board's age.**

Evidence:
- `memeBoard.ts:565-571`: the catch rethrows only if `signal.aborted || !write.aborted`; otherwise it warns and returns.
- `scheduler.ts:91-93`: a resolved run sets `lastOkAt` and resets `consecutiveFailures` to 0.
- `server.ts:190-205`: `STATUS_SNAPSHOT_KEYS` does not include `memes:board`.

Failure scenario, a Binance host that hangs:
- **Before:** six Meme Rush calls of 12 s each (`http.ts:17`, sequential at `memeBoard.ts:160-171`) add up to more than the 45 s timeout. The run failed and `consecutiveFailures` climbed.
- **Now:**
  1. The first hung call is cut at :19.
  2. Every later call (OKX hot included) fails at once on the aborted signal.
  3. `no discovery source available` is thrown after :19 (`:188-189`).
  4. The catch swallows it as a deadline miss.

Result: `/status` shows `meme-board` ok with 0 consecutive failures every minute while the board goes stale (3 min) and dead (30 min). Its age appears nowhere on `/status`. The same holds for any recurring slowness (M1).

Smallest fix, both parts small:
- Keep a miss streak in the job closure and throw a `deadline missed N times` error from the second consecutive miss on. Also rethrow when the error raised is not the deadline abort itself (for example, when `listed.size === 0 && hotOnly.size === 0`).
- Add `MEME_BOARD_KEY` to `STATUS_SNAPSHOT_KEYS`.

### MEDIUM

**M1. A run that used to publish late now publishes nothing, and the exec plane stops entering after two misses, not three.**

The window is now 11 s, down from 45 s, and the run is a chain of sequential awaits:
- 6 Meme Rush and 4 hot calls (`memeBoard.ts:160-187`);
- the launchpad state read;
- the venue refresh, whose Four.Meme code phase alone has its own 10 s box (`memeVenues.ts:59`, `:214`), sized for the old 45 s budget ("so a slow RPC day cannot spend the whole board cycle on them");
- activity batches, signals, 2 inflow calls and quote kinds.

Each HTTP call carries a 12 s deadline (`http.ts:17`). One call of about 5-6 s on top of the measured 6.6 s cycle (`MEME-FOURMEME-TAX-REPLY-2026-10-06.md:162`) is a miss. The measured cycle has also grown 2 → 4.6 → 5.5 → 6.6 s in three days as features were added. The rate is unmeasured, as the reply says.

Exec-plane consequence, which the reply misses:
- The lane caches its market work, bars included, by `shortlist.asOf` (`memeLane.ts:221-222`). A missed write leaves `asOf` unchanged, so the bars are not re-read.
- The decision step re-checks bar lag on the cached bars (`memeLane.ts:328-329`; `memeData.ts:14`, `:145`, `:147`, limit 120 s).
- Bars cached at m:25 close at (m-1):00:
  - after one miss, lag at (m+1):25 is 85 s, which passes;
  - after two, lag at (m+2):25 is 145 s, and every entry is vetoed `stale-at-decision`.
- So the lane stalls entries at the second consecutive miss, while the board is still `fresh`. Exits allow 300 s (`memeData.ts:15`) and survive four misses.

The miss does self-heal; it is not a loop:
- The venue cache (`memeVenues.ts:185`) and quote kinds (`quoteKind.ts:147`) are written before the gate.
- Four.Meme code reads keep completed 20-address chunks and break on abort (`fourmemeTax.ts:156-178`).

So a backlog drains across missed cycles, and repeated misses need a persistently slow upstream.

Fail-closed and paper-only, hence MEDIUM.

Smallest fix, pick one:
- **(a) Defer instead of dropping.** Past :19, wait until :26 and write then, inside the 45 s timeout. A write after the lane's :25 read is outside the race window: the bars job selects it at the next :20. The only cost is a later wallet in the same exec cycle seeing new tokens untracked, which is fail-closed.
- **(b) Keep dropping, but measure.** Log every run's latency and miss count, and set a promotion rule.

Correct reply line 40 either way.

**M2. A new token's `tracked` flag flips only when the whole bars cycle ends; the ":25" test does not model that.**

- `readTrackedSet` reads the index (`memeBars.ts:484-486`), and the index is written once, at the end of the cycle (`:424`).
- The exec plane requires `bars.tracked` for entry (`memeData.ts:147`).
- The measured cycle ends about :23 ("20 s + 0-3 s", `MEME-BARS-LATENCY-REPLY-2026-10-05.md:19`), so the margin to :25 is about 2 s. Defect A adds full 182-row requests (`fetchLimit`, `memeBars.ts:241`) for every empty shortlisted token each minute, which lengthens the cycle in a burst.
- The test "serves bars at the :25 read ..." runs the whole bars cycle instantly before setting the clock to :25. It proves only that a board written before :20 is selected at :20, which was already true before this change.
- The reply's latency argument (shortlisted tier done by :22-:23) is about series writes, not the index.

Pre-existing and fail-closed (one minute "untracked"), so MEDIUM only because the reply and the test claim more than they show.

Smallest fix: state it as a residual. Optionally write the index before the fetch loop, which needs a design note.

**M3. The production wiring of the :19 deadline is untested. Four job-level mutations survive with 93/93 green.**

`memeBoardJob(...).run` is never executed by a test (it uses the real fetchers). Surviving mutations in `memeBoard.ts:564-571`:
- **M6:** `throw error` unconditionally (a miss counts as a failure).
- **M7:** `if (false) throw error` (every error swallowed, a timeout included).
- **M8:** `boardWriteSignal` returning `deadline.signal` only (drops the scheduler timeout).
- **M9:** `const write = signal` (the job never applies the deadline at all, which is the core of B).

Smallest fix: give `memeBoardJob` an optional `RunMemeBoardOptions` seam, or extract `runBoardWithDeadline(store, signal, startedAt, options)`. Then test four cases:
- a miss resolves without writing;
- a scheduler timeout rejects;
- a real error before :19 rejects;
- an on-phase run writes.

### LOW

**L1. "Writes nothing" is overstated.** `refreshVenues` writes `memes:venues` (`memeVenues.ts:185`) and `resolveQuotes` writes `quotes:kind` (`quoteKind.ts:147`) before the gate. A zombie body after the timeout can also write them. Only the board reads them, and keeping them is what lets a backlog drain (M1), so this is harmless. Fix: correct the comment at `memeBoard.ts:344-345` and reply line 30.

**L2. About 1 s of write margin.** The gate precedes two awaited puts (`memeBoard.ts:346-356`), each without a signal. A gate passed at :18.9x plus a slow Postgres put of the ~720-row board can land after the bars job's board read at about :20.0 (after `readIndex` and the lease, `memeBars.ts:328-337`). That reopens the race for that minute. The builder lists this. Fix if wanted: put the gate at :18, or abort earlier.

**L3. Budget bound wording.** Extra calls are bounded by the tracked tokens shortlisted at any point in the last 15 min that still have an empty series. Under shortlist churn that can exceed 30. The hard bound is unchanged: one call per tracked token per minute, at most `MEME_BARS_CAP` = 120. Each re-ask is a full-window request (`memeBars.ts:241`).

**L4. Boot and restart gap.** A boot after about :14 gives a first run that is cut or aborted at once, so the first write waits for the next :08 (up to about 68 s). Before, it took 0-5 s plus the run. A boot at :00-:03 runs at once, and the :08 tick then logs `skipped: previous run still in flight` (`scheduler.ts:119-121`). Both are cosmetic with a persisted store.

**L5. Docs left stale.**
- `D:\4lphaDATA-marketplace\CLAUDE.md` "1m bars" does not mention the shortlist retry.
- The "Meme board" section and `MEME-SHORTLIST-HANDOFF-2026-10-05.md:19` still say "60 s ± 5 s jitter".

The builder acknowledged the first and did not edit it.

**L6. Exec-plane residual (confirmed, unchanged).** An exec cycle longer than 60 s that ends between :08 and :20 starts the next cycle at once (`worker.ts:149-155`, `legacy = 0`). That read can see a board written at :08-:19 before the :20 selection, so new tokens read untracked for one minute. This is fail-closed. A cycle that starts at :25 and lasts under 60 s always lands on :25 again.

## Scheduler interaction (checked, no defect beyond the above)

- **Next run.** `msUntilBoardRun` returns a value in (0.5 s, 60.5 s] that lands on :08 (`memeBoard.ts:531-536`); the tick floors it at 100 ms (`scheduler.ts:118`). It is computed at tick start, so a long run does not drift it.
- **Overlap.** A run started at :08 is cut by the deadline at :19 and by the timeout at :53, and the next tick is at :08, so runs cannot overlap. A zombie body after the timeout cannot write the board or its state: the combined signal is aborted.
- **Crossing the minute.** A late timer that crosses the minute measures its deadline from the new minute and still writes before that minute's :19.
- **Partial writes.** None between board and state. Either the gate passes and both puts run in order (state, then board, as before), or neither runs.
- **Other readers of the board.**
  - Routes `/memes`, `/memes/shortlist`, `/memes/stocks` and `/memes/:addr` (`server.ts:1080`, `:1128`, `:1163`, `:1290`) see a board that now always updates at :08-:19. The staleness rules (`BOARD_FRESH_MS` 3 min) are unchanged.
  - `memeMeasure` (5-min drifting phase, requires a fresh board, `memeMeasure.ts:355-356`) and `binance-rwa` quote-stock refresh (`binanceRwa.ts:321`, no freshness requirement) carry no phase assumption.
  - `binance-rwa` can still flip a quote stock's open state between :20 and :25. That changes shortlist membership only among rows that are already live, and so already tracked (cap permitting, as the builder notes).
- **Exec-plane freshness windows.** `shortlistFresh` / `rowFresh` (180 s, `memeData.ts:103-106`) hold through two misses. The bar-lag entry rule does not (M1).

## Tests run (reviewer, on `f4ab71f`)

- `node --import tsx --test test/memeBars.test.ts`: TESTS 36 / PASS 36 / FAIL 0 / SKIPPED 0.
- `node --import tsx --test test/memeBoard.test.ts`: TESTS 57 / PASS 57 / FAIL 0 / SKIPPED 0.
- `npm test` (full suite): TESTS 992 / PASS 992 / FAIL 0 / SKIPPED 0.
- `npx tsc --noEmit`: exit 0, no output.

## Mutation checks

Done with cp backup to the session scratchpad and cp restore; the hashes were verified after. The two test files together give 93 tests.

| # | Mutation | Result |
|---|---|---|
| M1 | Drop `!recentlyShortlisted &&` (`memeBars.ts:370`) | Killed: 3 A tests fail. |
| M2 | `readIndex` drops `shortlistedAt` (`:443`) | Killed: the 15-minute tail test fails. |
| M3 | Tail 15 → 10 min (`:369`) | Killed: the 15-minute tail test fails. |
| M4 | Drop `signal.throwIfAborted()` (`memeBoard.ts:346`) | Killed: the timeout test and the past-deadline test fail. |
| M5 | Deadline 19 s → 21 s | Killed: the phase test fails. |
| M6 | A miss rethrows (counts as a failure) | **Survives** (93/93). |
| M7 | Every error swallowed, timeout included | **Survives** (93/93). |
| M8 | Write signal ignores the scheduler timeout | **Survives** (93/93). |
| M9 | Job never applies the deadline (`const write = signal`) | **Survives** (93/93). |

## Housekeeping

The reviewer's `tsc` output went briefly to `/tmp/tsc_out.txt`, which was then deleted. The untracked `live20.txt` and the builder's reply in the worktree were not touched.
