# Four.meme curve tax: independent audit (2026-10-07)

Target: worktree `D:\4lphaDATA-wt-fourmeme-curve`, branch `fourmeme-curve-tax`, commit `e1ada70` on master `ae08da7` (`git diff ae08da7 e1ada70`: 8 files, +353 / -39). Normative: `FOURMEME-CURVE-PAPER-SPEC.md` Revision 1.2, section 5 and gates G0a-G0d. Claims checked: `FOURMEME-CURVE-TAX-REPLY-2026-10-07.md`. Consumer checked: `D:\4lpha-execution` master `e05c430` (`src/agentic/memeData.ts`, `memeLane.ts`, `memeBrain.ts`).

Auditor: Claude Opus 5.5, independent (did not write the spec, the build or the reply). Read-only on source; no `.env*` read; chain access was `eth_call`, `eth_getCode` and `eth_getTransactionReceipt` on `bsc-dataseed.bnbchain.org` (fallbacks defibit / ninicoin) from scratch scripts outside the repo. Nothing signed or sent. Tree left as found (`git status`: only the three untracked docs plus this file).

## Verdict: SHIP WITH RESIDUALS

0 BLOCKER, 0 HIGH, 1 MEDIUM, 8 LOW. Every section-5 item is built, nothing product-visible beyond it; graduated Four.meme and Flap paths are byte-identical; every published curve tax is either freshly answered or carried for under 10 minutes from an answered read on the same venue; the fail-closed cases all land on `tax: null` or on the lane's `meme-veto:curve-funds`. The proofs re-verify on chain to the wei. The MEDIUM is a gate-tooling gap (G0d cannot be run as written with the shipped script), not a code defect.

## 1. Section 5 coverage (item 1)

| Spec | Built at | Verdict |
|---|---|---|
| 5.1 `FourMemeTemplate.curve`, true on `tax9-7330` and `plain-4686` only | `src/query/fourmemeTax.ts:43` (field), `:53-61` (table) | OK; pinned by `test/fourmemeTax.test.ts:53-55` |
| 5.1 selection `pancake-v2` OR `fourmeme-bonding` | `src/jobs/memeVenues.ts:231-234` | OK |
| 5.1 rate items: curve row only with `curve: true` (and only when due, F15) | `memeVenues.ts:266-272` | OK |
| 5.1 publish: unproven / unread template -> `tax: null`; curve row always `pool: null` | `memeVenues.ts:286-299` (all three curve branches write `pool: null`) | OK |
| 5.1 graduated byte-identical | `memeVenues.ts:301-306` unchanged; `fourMemeTaxPending` graduated branch `:122-124` unchanged; `refreshAfterMs` `:99` unchanged | OK |
| 5.1 docs | `memeVenues.ts:26-37`, `src/query/memeClassify.ts:211-216` | OK |
| 5.1 proof tool, curve mode | `scripts/fourmeme-tax-evidence.ts:22-30`, `:223-315`, `:361-366` | OK, read-only (receipts, `readContract`, `getCode`, `getLogs`; no OKX call, no signer) |
| 5.2 `funds` / `maxFunds` decimal strings of words 9 / 10 | `src/query/eligibility.ts:192-198` (type), `:361-362`; comment `:101` "seven fields" (count checked: words 0, 1, 2, 6, 9, 10, 11) | OK |
| 5.2 every path carries them | `decideEligibility` `:558-560`, `listVenueFrom` `:641`, `:648` pass the whole `fourmeme.state`; `/eligibility` routes `src/server.ts:1001-1017` serialize the result untouched | OK |
| 5.4 F15 constants | `memeVenues.ts:70`, `:72` | OK |
| 5.4 retry before the quiet/dead tier | `memeVenues.ts:100`, `:117-121` | OK (see L3) |
| 5.4 identity order graduated first | `memeVenues.ts:246-251` (stable sort, then the existing cap) | OK |
| 5.5 tests | `test/memeVenues.test.ts:207-309`, `test/fourmemeTax.test.ts:53`, `test/eligibility.test.ts:138-164` | OK (two guards untested, L4) |

Beyond section 5: only `readFourMemeOn` exported for a test (`eligibility.ts:344-345`). The retry reading "identity unread" for any curve row (not only curve-proven ones, `memeVenues.ts:119`) is the only sensible reading of the spec's sentence (an unread identity has no known template) and is documented in the reply section 4.

Flap: no Flap file touched; `fourMemeTaxPending` returns false for `launchpad: "flap"` on both branches (`:118`, `:122`), so the line inserted at `:100` changes nothing for Flap rows.

## 2. Template proof scope and on-chain re-verification (item 2)

Only two ids carry `curve: true` (`fourmemeTax.ts:53`, `:60`); `matchFourMemeTemplate` still requires creator type AND code identity (`:80-83`); an unread identity yields `template === null` and publishes `tax: null` (`memeVenues.ts:241-244`, `:288-289`). `pool` is null on every curve branch even when `pair()` answers non-zero (killed mutation M4 below).

Re-verified independently (own decoder, not the builder's script). Each line: `fee == floor(cost/100)`, tax leg TokenManager2 -> token, and total quote movement:

| Gate | Token (identity read now) | Tx | Result |
|---|---|---|---|
| G0a | `0xcd42...ffff` type 9, `proxy:0x7330...5c94`, BNCB, rates 1/1, `pair()` = 0x0 | buy `0xeaaf3ff2...7872` | cost 1310319736079108019, fee 13103197360791080, tax 13103197360791080 = floor(cost x 1 / 100), into TM2 1336526130800690179 = cost + fee + tax, out = fee + tax: EXACT |
| G0a | same | sell `0x84bd64d3...7a8b` | cost 162757801559926522966, tax 1627578015599265229 = floor(cost/100), to seller 159502645528727992508 = cost - fee - tax: EXACT |
| G0a | `0x6e97...ffff` type 9, `proxy:0x7330...`, HOODB, rates 3/3 | buy `0xa5e34102...a23d`, sell `0x7a3a920a...7b6b` | tax 9999619394825893 = floor(333320646494196464 x 3 / 100) both sides; movements EXACT |
| G0b | `0x2869...4444` type 0, `proxy:0x4686...a986`, BNCB, `feeRateBuy/Sell` revert, `pair()` reverts | buy `0xfefa491d...35a0`, sell `0x4af5634c...b634` | 0 tax legs; in = cost + fee, out = fee (buy); in 0, out = cost, to seller = cost - fee (sell): EXACT |
| G0b | `0xfb87...4444` type 0, `proxy:0x4686...`, SPCXB | buy `0x8f03cbc4...6dd9`, sell `0x4fb81b62...8d67` | 0 tax legs, EXACT |
| G0b | `0x1209...4444` type 0, `proxy:0x4686...`, NVDAB | sell `0xb1021aa0...9bdf` | 0 tax legs, EXACT |

Quote symbols read on chain: `0x4902...` BNCB, `0xbe9d...` SPCXB, `0x02fc...` NVDAB, `0xa394...` HOODB. So G0a (2 tokens, 4 trades) and G0b (3 tokens, 3 quote stocks, both sides; 5 of the 11 claimed trades re-proven here: `0xfefa`, `0x4af5`, `0x8f03`, `0x4fb8`, `0xb102`) hold.

## 3. F15 rates cache (item 3)

Traced `memeVenues.ts:105-107`, `:266-299`:
- Due when `fourmemeTaxReadAt` is undefined or `checkedAt - fourmemeTaxReadAt >= 300 000` (`:106-107`); a not-due row with a curve carry source is left out of the read (`:270`).
- Answered read stamps `fourmemeTaxReadAt = checkedAt` (`:292`); a failed or skipped read never stamps it (`:297`), so the 10-minute limit is measured from the last ANSWERED read and a failure cannot extend it (killed mutation M9).
- Carry only from a previous entry whose venue was `fourmeme-bonding` (`:237-240`) and only while `checkedAt - fourmemeTaxReadAt < 600 000` (`:296`); at exactly 10 min it publishes `null` with the cycle's stamp (test `memeVenues.test.ts:266-270`).
- Graduation: the row takes the graduated branch (`:301-306`), which reads afresh and never consults the carry (test `:284-296`).
- `fourMemeTaxPending` for a curve row (`:118-121`): identity unread, or curve-proven AND (`tax === null` OR due). After a failed due read the cached entry stays due, so `refreshAfterMs` returns `LIVE_REFRESH_MS` before the quiet/dead tier (`:100`); tested "also when quiet" (`:258-261`).

No path publishes a curve tax for longer than the spec allows relative to `checkedAt` (= `venueCheckedAt`). The tax value can only come from an answered read of the same token on the same venue, and the curve rates cannot change (spec D-f), so a wrong tax cannot be published; a stale one is bounded as F10 states. Edge cases are in L3, L6, L8.

## 4. `funds` / `maxFunds` (item 4)

- Words: `helperAbi` declares word 9 `funds`, word 10 `maxFunds` (`eligibility.ts:121-122`). Re-checked on chain: helper `getTokenInfo(0xcd42...ffff)` word 9 = 196030997279104977, word 10 = 2000000000000000000000; TokenManager2 `_tokenInfos` of the same token: `funds` 196030997279104977, `maxRaising` 2000000000000000000000. `0x6e97...ffff`: word 9 = 0, word 10 = 80e18 (matches spec 1.2's HOODB 80e18). So 9 = funds raised, 10 = graduation target.
- Decimal strings via `bigint.toString()` (`:361-362`); the test feeds viem-encoded words above 2^53 (`test/eligibility.test.ts:138-164`).
- Cache tiers: verdict cache `eligibility:<addr>` (30 s eligible, validator checks only `eligible` / `reason`, `:833-837`) and the list-venue cache `list-venue:<addr>` (30 s for a launchpad token, no shape validation, `:618-621`, `:666-669`). Both can serve a pre-deploy Four.meme block without the two fields for at most 30 s.
- Fail-closed at the consumer: `memeData.ts:174-177` parses each field with `^\d{1,78}$` into `bigint | null` (an absent or malformed field does NOT drop the row); `memeBrain.ts:175-176` `memeCurveFundsOk` requires both non-null, `maxFunds > 0`, `funds x 100 < maxFunds x 80`; `memeLane.ts:400` vetoes `meme-veto:curve-funds` on `fourmeme-bonding` only. Shapes match.
- Deploy order claims hold: plane first -> curve rows gain a tax, a pre-deploy eligibility block lacks funds -> `curve-funds` veto for <= 30 s; lane first -> tax null -> `tax-unknown`. The reply names only the verdict cache; the list-venue tier has the same 30 s bound and the same fail-closed outcome.

## 5. RPC load and identity budget (item 5)

- Rates: at most one three-call read per curve-proven type-9 curve row per 5 min (killed mutations M7, M14); plain rows read nothing (`fourmemeTax.ts:206`).
- Identity: one shared `CODE_READS_PER_CYCLE = 100`, stable-sorted graduated first before the slice (`memeVenues.ts:246-251`), so the graduated subset reads exactly what it read before (killed mutation M3).
- Evidence script curve mode: read-only (see section 1).
- Board cycle time before / after (spec 5.4 last line) was not measured by the builder or by this audit. It can be taken today by running the existing `scripts/fourmeme-tax-check.ts` (it prints cycle ms after every cycle, `:20`) on `ae08da7` and on `e1ada70`; it loads the operator's env, so it stays operator-owed.

## 6. Tests and mutations (item 6)

Re-run in the worktree at `e1ada70`:
- Touched suites (`memeVenues`, `fourmemeTax`, `eligibility`, `fourmemeTaxReaders`, `memeBoard`): tests 141 / pass 141 / fail 0 / skipped 0.
- Full suite `npm test`: tests 1021 / pass 1021 / fail 0 / skipped 0 (todo 0, cancelled 0). Matches the reply.
- `npx tsc --noEmit`: exit 0.

Mutations (cp backup to scratch, `sed` one line, run the five suites, cp restore; never git checkout / stash / restore):

| # | Mutation | Result |
|---|---|---|
| M1 | carry limit 10 -> 20 min (spec 5.5) | KILLED (carry test) |
| M2 | `fourMemeTaxPending` graduated-only (spec 5.5) | KILLED (carry test, "also when quiet") |
| M3 | identity order removed (spec 5.5) | KILLED (identity order test) |
| M4 | curve `pool: null` -> `read.pool` (spec 5.5) | KILLED (curve publish test) |
| M5 | `funds` from word 10 (spec 5.5) | KILLED (eligibility words test) |
| M6 | `curve: true` on further templates (spec 5.5) | KILLED (2 tests) |
| M7 | 5-min cadence -> 0 (spec 5.5) | KILLED (rates cache test) |
| M8 | carry `<` -> `<=` 10 min | KILLED |
| M9 | failed read stamps `fourmemeTaxReadAt` | KILLED (2 tests) |
| M12 | pending drops the "due" clause | KILLED |
| M14 | due `>=` -> `>` 5 min | KILLED (2 tests) |
| M15 | pending check removed from before the idle tier (`:100`) | KILLED |
| M10 | carry source ignores the previous venue (`:239` -> `return before`) | SURVIVED (L4) |
| M13 | curve row with unread identity not pending | SURVIVED (L4) |

`git status` after the run: unchanged (three untracked docs).

## 7. Findings

### MEDIUM

**MED-1 G0d cannot be executed as written with the shipped tally.** `scripts/fourmeme-tax-check.ts:15-33` runs N board cycles back to back into a fresh `MemoryStore` and prints the tally once, after the last cycle. The spec's G0d needs "once a minute for 10 consecutive minutes after warm-up" the count of curve-proven curve rows with `tax: null`. Separate runs start cold (every identity unread, every rate due) so they never exercise the 5-min re-read or the carry; one long run reports only its final cycle. Failure scenario: the operator runs the script as the reply suggests, sees a clean final tally, and a flicker that happens on the due cycles (5 and 10 min, all curve rows due together, L2) is never counted, so the exec restart proceeds on an unchecked gate. Smallest fix (operator script, no full chain): the script already prints cycle ms after every cycle (`:20`); move the tally (`:23-33`, or just the "curve-proven, tax null" count) inside the loop so it prints after every cycle too, and run it for at least 12 minutes.

### LOW

**LOW-1 Endpoint rotation coupling (FC5 nuance).** `readFourMemeTaxes` throws (so `withBscClient` tries the next endpoint) only when every view-reading item failed (`fourmemeTax.ts:233`). Curve items now share the call in due cycles. If all graduated reads fail on an endpoint while one curve read answers, there is no rotation and the graduated rows publish `null` for that cycle (then pending, retried next cycle). One-cycle `tax-unknown` flicker on graduated rows, fail-closed, only in a due cycle. Fix if it shows in G0d: read curve items in a separate `readFourMemeTaxes` call.

**LOW-2 Synchronized due cycle.** Curve rows warmed in the same cycle all become due together every 5 min, so up to about 161 x 3 = 483 calls land in one cycle rather than spread across 5 min. Within the spec's per-5-min bound; relevant to the unmeasured board cycle time. No fix required; measure with MED-1's per-cycle output.

**LOW-3 Quiet / dead curve rows lose the single-failure carry.** A quiet row whose last read answered is not pending (`:120`, not due when `checkedAt == fourmemeTaxReadAt`), so it is re-read only at the 10-min idle tier (`:101`); at that read the rates are due and the age is already >= 10 min, so one failed read publishes `null` (`:296`) instead of carrying, contrary to 5.4's "a single transient failure never blanks a curve row". No lane effect (quiet/dead rows are never on the shortlist, F10) but they count in the G0d tally. Fix: count runner/active rows only in G0d, or accept and note it.

**LOW-4 Two guards untested (survived M10, M13).** The venue condition of `carrySource` (`:239`) is unreachable today (a Four.meme state never reports a venue other than the two, and graduation is one-way), and the "identity unread -> pending" clause for curve rows (`:119`) only shortens a quiet cold row's wait from 10 min to one cycle. Fix: one test each (previous entry with `venue: null` carries nothing; quiet curve row with unread identity is re-read next cycle).

**LOW-5 Young curve tokens and a stored `creatorType: null`.** `readFourMemeCodes` stores `{code, creatorType: null}` permanently when `getCode` returns code but TokenManager2 answers a zero struct (`fourmemeTax.ts:152-183`; only `code === "none"` is dropped, `:178`). Curve rows are read minutes after creation, so a lagging backend behind a load-balanced endpoint is more likely than for graduated rows. Result: that token is `tax: null` forever (fail-closed, a missed admission, never a wrong tax). Fix later: do not store an identity whose creator type is null for a `fourmeme-bonding` row.

**LOW-6 Deploy-window nulls.** An old-code instance (Railway overlap, or a rollback then roll-forward) writes curve rows with `tax: null` but keeps `fourmemeTaxReadAt` (spread at `:168` / `:184`); the new code then carries that `null` until the rates are due (up to 5 min, `:270`, `:296-297`). Fail-closed. Run G0d after the overlap ends.

**LOW-7 Venue staleness carries the tax with it.** If a row's venue reads keep failing (`:182`), the cached entry, tax included, is served with its old `checkedAt` (pre-existing for every venue fact). The tax-age bound holds relative to `venueCheckedAt`, not to wall time. Safe: curve rates are immutable (D-f) and the lane requires the shortlist venue to equal the live eligibility venue (`memeLane.ts:398`). No fix.

**LOW-8 Venue-read cap is an unlisted fourth shared resource (FC5).** `VENUE_READS_PER_CYCLE = 400` (`memeVenues.ts:63`, `:177`) is shared by every due row; the board passes up to `MEME_BOARD_CAP = 800` tracked tokens (`src/jobs/memeBoard.ts:68`, `:221`, `:230-237`). The new pending rule makes a curve row of ANY status due every cycle while its identity is unread (`:119`, `:100`), and an out-of-range curve-proven row every cycle (`:120`). The due sort (`:176`) puts only never-read rows first; the rest keep candidate order, so these rows compete with trading Flap and graduated rows for the 400 slots. Failure scenario: in the first cycles after deploy (about 204 cold curve identities, quiet/dead ones included) the due set exceeds 400 and a Flap or graduated row's venue read slips a cycle (its venue/tax stays as cached, `venueCheckedAt` honest). Not a listed FC5 mix effect, but cold-start only (identities persist) and a delay, never a wrong value. Whether the cap binds today was not measurable here (production due-set size unknown). Smallest fix if the per-cycle run (MED-1) shows 400 reads in a cycle: sort rows that are due only because of the curve tax-pending rule after the other due rows.

**Docs.** Data-plane `D:\4lphaDATA-marketplace\CLAUDE.md:125` still says "Curve rows `null`"; update at merge (the reply's suggested line is accurate).

## 8. Residuals owed (operator)

- G0c and G0d after deploy (G0d per MED-1).
- Board cycle time before / after (spec 5.4): run the existing `scripts/fourmeme-tax-check.ts` on `ae08da7` and on `e1ada70` (needs the operator's env); also read whether venue reads hit the 400 cap in the cold-start cycles (LOW-8).
- Deploy order: either order is safe; merge and push of the data plane remain an operator go.
