# Audit: Jev text features on meme stocks (2026-10-07)

Target: branch `jev-text-features`, commit `717d930`, diffed against master `4c83719`. Worktree `D:\4lphaDATA-wt-jev`.
Normative ask: `JEV-TEXT-FEATURES-HANDOFF-2026-10-07.md`. Builder's claims: `JEV-TEXT-FEATURES-REPLY-2026-10-07.md`.
Auditor: Opus 5.5, independent; did not write the code. Read-only on source. No commit, push or deploy. `.env*` not read.

## Verdict

**SHIP WITH RESIDUALS for merge. Do not turn `MEME_JEV_ENABLED` on until H1, H2, M1 and M2 are fixed.**

- Merging is low risk:
  - The flag is OFF by default.
  - With the flag off, no request is sent and no Jev cache key is read.
  - No served route, board, shortlist, eligibility or ranking code changed.
  - The export stays backward compatible.
- Turning the flag on starts a measurement that cannot be cleanly redone, because answers are cached forever. Four issues would bias or freeze that data:
  - H1: valid answers are rejected by a float edge.
  - H2: no backoff on permanent failures.
  - M1: the cache is not tied to the inputs or the wording.
  - M2: the relevance wording and inputs are not neutral across quote stocks.

## Verification run

- `node --import tsx --test test/memeMeasure.test.ts`: tests 29 / pass 29 / fail 0 / skipped 0.
- `npm test` (full suite, worktree): tests 989 / pass 989 / fail 0 / skipped 0 (cancelled 0, todo 0). This matches the reply.
- `npx tsc --noEmit`: exit 0.
- Mutation pass:
  - Run in a scratchpad COPY of `src/`, `test/`, `package.json` and `tsconfig.json`, with a junction onto the worktree's `node_modules`. The junction was removed afterwards.
  - The worktree was never edited. `git status` is unchanged: only the two untracked handoff/reply docs, plus this file. HEAD is `717d930`.
- **Process disclosure.**
  - Two mutants (M3 `if (true)` and M3b) removed the flag gate.
  - Pre-existing tests in `test/memeMeasure.test.ts` call `runMemeMeasure` with no `jevFetch`. Under those mutants the adapter therefore fell back to `globalThis.fetch`.
  - Those runs may have sent unauthenticated POSTs to `api.typesafe.ai`, if this machine had network access. The header was `Authorization: Bearer undefined` or `Bearer `. The bodies held only test fixture symbols (`M10`, `NVDAB`, `Topic 1`).
  - No key was involved and no real data was sent. Any such request would answer 401 and would not be billed.
  - This also shows a test-hygiene gap; see L6.

## Checklist results (items 1 to 8 of the ask)

**1. Ask items, Constraints, Out of scope.**
- The diff touches only `src/adapters/typesafe.ts` (new), `src/jobs/memeMeasure.ts` and `test/memeMeasure.test.ts`.
- `server.ts`, `memeQuery.ts`, `memeClassify.ts`, `memeStocks.ts`, `package.json`, the lockfile and `.env*` are untouched.
- Ask 1 (Score, cached per token): met at `memeMeasure.ts:537`, `:620-640`.
- Ask 2 (Noul + Choice per pair): met at `:548`, `:643-660`.
- Ask 3 (columns appended): met at `:105`, `:117`, `:278-290`, `:305-324`.
- Ask 4 (flag and key): met at `:691-695`, `:804`, `:814`, `:412`.
- Constraints:
  - Fail open is met, with the caveats in L3.
  - "Cache only after a valid response" is met (`:633-638`, `:652-658`).
  - The budget constraint is NOT guaranteed; see H2.
- FakePg: no table or column was added. Cache rows use the snapshot table with a 100-year horizon, the same as `quoteKind.ts:39`, so the bigint retention columns cover it.
- Out of scope respected: no served route changed, no new upstream besides TypeSafe, and no post text, link, summary or IPFS data reaches the request.

**2. Fail-safety.**
- Per-request failures are collected and summed into one line (`:664-683`). The whole step is inside a try/catch (`:413-417`). A Jev failure is excluded from the "no measurement source" check (`:450`).
- 429, thrown, malformed and no-model responses are never cached. This is pinned by test, but see L6 for which checks are actually exercised.
- Key handling:
  - The key appears only in the `authorization` header (`typesafe.ts:52`).
  - Failure strings are scrubbed by value (`:675`).
  - `AdapterError` messages never contain request headers (`http.ts:113-121`).
- Flag off: `memeJev` is never called (`:412`), so there are zero requests and zero cache reads. This is verified by reading the code; the test does not pin the no-cache-read half (L6).
- Timeout: the TypeSafe calls are boxed at 10 s (`:617`). The cache reads before the box are not (L3).

**3. Request and response shape against the saved `api.md`.**
- Matches the saved docs:
  - Endpoint, Bearer header, body `{model, state, questions}` (api.md:13-52).
  - Noul criteria `{true,false}`, Choice criteria as a map, Score criteria as an ordered array (api.md:83-178).
  - Response `{model, answers, usage}` (api.md:184-206).
  - Noul `noul`; Choice `choice` + `probabilities` map; Score `score` + `probabilities` keyed `"0"`.. (api.md:225-323).
- `confidence`, `legend` and `usage` are ignored, which is acceptable.
- Parser strictness is correct in direction, but its probability-sum tolerance is too tight (H1).
- The live API is still unverified, as the reply itself says.

**4. Inputs.**
- The stock request carries exactly `{meme:{symbol, name?}, stock:{symbol, company?}}` (`:628-631`).
- The pair request carries exactly `{topic:{name,type,tags}, token:{symbol}}` (`:647`).
- The question ids are not sent to the model (api.md:36).
- `company` comes from `universe:rwa` `underlyingName` only. The lookup key is lowercase on both sides (`memeStocks.ts:235`; `binanceWeb3.ts:499` normalizes `quote`).
- Pinned by the test at `test/memeMeasure.test.ts` "sends only the symbols..." (mutants M10 and M11 killed).

**5. Export compatibility.**
- The new columns are appended last, so every existing index is unchanged (mutant M12, a column swap, is killed).
- `expandRows` and `dictDecode` use each record's own `columns` and `dictColumns` (`:700-740`), so old slots expand without the new keys. This is pinned by test.
- `v: 1` is correctly kept: `isCycle` requires `v === 1` (`:745`), and the columns are self-describing.
- The execution-plane reader `.agents/pv-replay.mjs:47-48` reads `board.rows[].priceUsd`, `address`, `status` and `flags` by name, so it is unaffected. The plan's section 5 reads the same fields.

**6. Cost and rate.**
- Limits: 60 requests per cycle, 6 in flight, a 10 s box, and a stop on 429.
- Per-item requests are a sound choice. They keep each item's judgment isolated and keep the input set exact. Packing items into one request with structured instructions (the docs' `same_as_record_N` pattern, noul.md) would save the fixed per-request overhead, but would mix items within one state.
- The docs' minimal requests bill 296 to 318 input tokens, so a fixed overhead of roughly 280 tokens per request is likely. Our questions are longer, so expect roughly 400 to 700 tokens per request.
- Cold start: about 300 to 400 requests, about 0.2 to 0.3 M tokens, about 0.01 USD. A warm day is about 0.01 to 0.02 USD.
- That estimate holds only while answers validate. See H2 for the failure-loop ceiling of about 0.2 to 0.3 USD a day.
- Cache growth is one row per answered token and per pair, forever, with no pruning. That is acceptable at this scale; noted in the reply.

**7. Question wording.** See M2. The NVDAB example should go, and the rubric needs fixing for ETFs and for missing company names. Neutral wording is proposed there.

**8. Tests.** They are real for the core rules (cache-after-valid, flag-off-sends-nothing, key scrub, input shape, column order). Many claimed behaviours survive mutation; see L6.

## Findings

### HIGH

**H1. The probability-sum tolerance rejects valid two-decimal answers, and only the uncertain ones.**
- Evidence:
  - `typesafe.ts:77` accepts when `Math.abs(sum - 1) <= 0.01`.
  - In IEEE doubles, `0.33+0.33+0.33` gives a diff of `0.010000000000000009`. So do `0.34+0.33+0.32`, `0.34+0.34+0.33` and `0.5+0.5+0.01`. All are rejected (measured with node). `0.2+0.4+0.39` passes, so the result even depends on order.
  - Every probability in the saved docs is rounded to 2 decimals (api.md:275, :317; choice.md:437-485).
- Failure scenario:
  - Jev returns a tone of `{hype:0.34, neutral:0.34, warning:0.33}`, or a relevance of `{0:0.33, 1:0.34, 2:0.34}`.
  - The parser rejects it, nothing is cached, and the columns stay null.
  - The same answer comes back every cycle and is rejected forever.
  - The nulls concentrate on exactly the ambiguous cases, so the recorded feature is selection-biased toward confident answers. That breaks plan idea 6, which asks whether the features predict outcomes. It also feeds H2.
- Smallest fix:
  - Tolerance `<= 0.02` (or `0.015 + 1e-9`). Optionally renormalize before storing.
  - Add a parser table test containing the vectors above.

**H2. No backoff on a permanently failing key: unbounded re-asks, a budget overrun and queue starvation.**
- Evidence:
  - A key that fails is simply asked again next cycle (`:620-660`). No failure record exists.
  - The queue is always stocks first, in board order, and capped at 60 (`:662`).
  - Only 429 stops the cycle (`:676`). 401, 422 and 529 run all 60. The docs say to back off on 529 too (api.md:334-338).
- Failure scenario A:
  - The live API differs slightly from the saved docs. For example, Score probabilities are keyed by level text, an extra key is present, or (H1) a sum lands on 0.99.
  - Every 200 response is billed and rejected: 60 requests × 288 cycles = 17,280 requests a day.
  - At 300 to 500 tokens each, that is 5 to 9 M tokens, about 0.22 to 0.36 USD a day. The handoff budget is "well under 0.05 USD a day", so this is 4 to 7 times over, indefinitely, with only a `failures` line as the signal.
- Failure scenario B:
  - 60 or more meme stocks hit a deterministic rejection.
  - They take the whole cap every cycle, and no topic pair is ever asked.
- Smallest fix:
  - Keep a per-key retry marker, a separate key such as `memes:jev:v1:retry:<key>` holding `{tries, nextAt}`. This is never an answer, so it is compatible with "an outage is never cached".
  - Use exponential backoff and give up after N tries.
  - Stop the cycle on 401, 422 and 529 as on 429.
  - Optionally add a daily request ceiling, and interleave stocks and pairs in the queue.

### MEDIUM

**M1. The cache is keyed on the token or pair only, not on the inputs or the wording. "The inputs never change" is false.**
- Evidence:
  - Keys are `memes:jev:v1:stock:<address>` and `memes:jev:v1:topic:<topicId>:<address>` (`:510-511`, `:638`, `:658`).
  - A hot-only row is seeded with `name: null` (`memeBoard.ts:386`). The same address later carries the Meme Rush name when Meme Rush lists it (`memeBoard.ts:163-164`, `:205`).
  - `company` exists only while the stock is in `universe:rwa` (`:627`).
  - The question text is not part of the key.
- Failure scenario:
  - A meme first seen hot-only is judged on its symbol alone, and that answer is frozen. A sibling meme first seen through Meme Rush is judged with its name.
  - The feature then depends on which discovery source saw the token first, not on the token.
  - Separately, the operator drops the NVDAB example (the reply's open item 13) after the flag has been on. Every cached answer keeps the old wording under the same `v1` prefix, and the dataset mixes two instruments with no column saying which.
- Smallest fix:
  - Store a short digest of `{state, questions}` in each cache entry, and treat a mismatch as unanswered. That costs one re-ask per change.
  - Or put the digest in the key.
  - Also expose which optional inputs were sent (`hasName`, `hasCompany`) or the digest as a column, so the analysis can stratify.

**M2. The relevance wording and inputs are not neutral across quote stocks (item 7).**
- Evidence: `:537-545`. The instructions name one real company ("for example NVDAB is NVIDIA"). The levels speak only of "this company, its people (founders, executives) or its products".
- Failure scenario (a), the anchor:
  - Only NVDAB-quoted memes get a ticker-to-company mapping in the fixed text itself.
  - NVDAB is a top quote stock (data-plane CLAUDE.md, "/memes/stocks" paragraph: QQQB, BNCB and NVDAB led on live volume).
  - The example primes NVIDIA themes and gives NVDAB memes a redundant second source of the company identity.
- Failure scenario (b), ETFs:
  - QQQB and SPYB are funds, not companies.
  - A Nasdaq-themed meme quoted in QQQB is specific to its quote asset. The rubric still puts it at level 1 ("a generic finance, stock-market or trading joke"), so ETF-quoted memes are systematically under-scored.
- Failure scenario (c), uneven company names:
  - `rwa:quote-stocks` rows carry no name (`jobs/binanceRwa.ts:430`), so BNCB, HIMSB, GMEB, DJTB and others are asked with the ticker only.
  - BNCB quotes about 115 memes, the largest single group (data-plane CLAUDE.md).
  - Information differs by quote stock. An analysis that pools stocks would confound "Jev cannot place BNCB" with "the meme is unrelated".
- Proposed neutral wording.
  - Instructions: "How strongly is the meme token `meme` themed on the asset behind the tokenized stock `stock`? `stock.symbol` is the underlying ticker with the letter B appended. `stock.company`, when present, names the underlying company or fund."
  - Level 0: "Unrelated: nothing in the meme's symbol or name refers to this company or fund, its ticker, people, products or brand; this includes generic crypto or meme-culture names with no finance theme."
  - Level 1: "Loosely related: a generic finance, stock-market, trading or sector joke that is not specific to this company or fund."
  - Level 2: "Clearly about this company or fund: its ticker, brand, people (founders, executives), products, or for a fund its index."
  - This uses no real ticker as an example. Do not use a placeholder ticker either: placeholders like XYZ and ABC are or were real tickers.
- Smallest fix:
  - Apply the wording above before the flag goes on. Under M1, bump the key prefix if the flag was ever on.
  - Record `hasCompany` (see M1) so the analysis can stratify by quote stock and by name source.

### LOW

**L1. Tone is asked per pair, with the token in the state.**
- The handoff asks for tone per pair, and the builder followed it (`:647`). The Choice is about the topic, but the state also holds `token.symbol`.
- Scenario: a topic with four associated tokens can come back with two tones, a measurement artifact, and costs four requests for one judgment.
- Fix (operator choice): ask tone once per topic over `{topic}` only, under its own key, and copy it into each pair row. Or keep it per pair and say so in the analysis.

**L2. The key scrub and sanitization order.**
- The scrub at `:675` runs after `sanitizeMessage` has already cut the message at 200 chars (`http.ts:63`, applied first inside `fetchJson`, `http.ts:113`).
- A key containing characters outside `[A-Za-z0-9_-]` that straddles the cut would leave a prefix the exact-value `split` cannot match.
- The outer catch at `:416` applies no value scrub.
- No realistic path today puts the key in an error message, because fetch errors do not echo headers. This is defensive only.
- Fix: scrub by value before truncating (pass the key into one helper), and use the same helper at `:416`.

**L3. Work outside the box, and the 45 s window.**
- The cache reads (`:611-615`) run before the box, with no signal and no concurrency bound. That is one point read per board meme stock and per pair, every cycle, forever, even when everything is cached: a few hundred concurrent `store.get` on a `pg` pool with the default `max` of 10 (`core/store.ts:331`).
- The Binance calls before it wait on a semaphore with no deadline (`binanceWeb3.ts:49-62`).
- The Jev step now takes up to about 10 s plus those reads out of the job's fixed 45 s (`:810`). If the total ever passes 45 s, the scheduler fails the run (`scheduler.ts:66-83`) and the slot is lost, which the handoff forbids.
- Fix:
  - Derive the box from the remaining budget, e.g. `min(JEV_BOX_MS, started + 30_000 - now())`, and skip Jev when under 2 s remain.
  - Keep a process-level map of answered keys, which never change under M1's digest rule, so a warm cycle reads nothing.
- `durationMs` now also includes Jev time. Note that for anyone trending it.

**L4. Record size.**
- `jevModel` (about 12 bytes) is repeated on every board row and every pair row, and is not dict-encoded. Each probability cell is about 15 to 20 bytes.
- With about 250 to 300 board rows plus pairs, that adds roughly 12 to 18 KB per cycle against the documented ~90 KB, up to about 20 % of the 26 MB/day ring.
- With the flag off, the null cells still add about 4 KB per cycle.
- Fix: add `jevModel` to `BOARD_DICT_COLUMNS`. This is backward compatible, because each record carries its own `dictColumns`.

**L5. Untrusted text in the state has no length cap.**
- Meme `name` and topic `nameEn`/`tags` are creator- or AI-supplied and are sent in full. `boardTuple` caps the symbol at 40 chars (`:311`); the request does not (`:629`).
- Scenario: a long or instruction-laden meme name costs extra tokens once and can skew one score. It has no effect beyond measurement.
- Fix: cap each string (e.g. 80 chars) before building the state.

**L6. Tests do not pin several claimed behaviours (mutation evidence).**
- Killed, so these are pinned:
  - M1 and M1b: caching the raw answer before validation.
  - M3: flag-off sends requests.
  - M6: the key scrub removed.
  - M8f: the score range check removed.
  - M10: name sent when null.
  - M11: topicId in the state.
  - M12: column order.
- Survived, so these are untested:
  - M2: cache re-validation on read removed.
  - M3c: flag off still reads the cache. The test runs on an empty cache.
  - M4: the 429 stop removed. With 5 asks against 6 workers, all are dequeued before the first fails, so the test is vacuous.
  - M5, M5b, M5c: the 60 cap, concurrency 6 and the 10 s box removed.
  - M7: the outer try/catch removed.
  - M8, M8b, M8c, M8d, M8e: each parser rule removed (sum, key count, type, noul range, choice option). The single malformed fixture is rejected by a different check each time.
  - M9: the envelope `model` check removed. The no-model fixture also has empty `answers`, so the parser rejects it first.
- Also, pre-existing tests call `runMemeMeasure` without `jevFetch`, so any regression in the gate reaches the real network (see the process disclosure).
- Fix:
  - A direct parser accept/reject table, including the H1 vectors.
  - A run with at least 7 keys where the first response is 429.
  - A run with 61 keys to check the cap.
  - Flag off over a pre-populated cache, asserting null columns.
  - A planted invalid cache entry.
  - A `store.get` that throws.
  - A no-model envelope with valid answers.
  - A throwing default `fetch` in the harness, e.g. pass `jevFetch` everywhere, or stub `globalThis.fetch` in a `before` hook.

## Confirmed claims (reply)

- All line references in the reply match the commit (checked `:412`, `:519`, `:523`, `:526`, `:537`, `:548`, `:579`, `:585`, `:598`, `:675`, `:676`, `:691`, `:804`, `:814`; `typesafe.ts:81`, `:89`, `:95`).
- The test counts (29/29/0/0, 989/989/0/0) and the clean `tsc` are reproduced.
- "No served route changed", "no new upstream", "no post text" and "the key never reaches a record" are confirmed.
- "Only valid answers are cached" is confirmed. "A 429 stops the rest" and "a cached entry is re-checked" are correct in the code but untested (L6).
- "Expected well under 0.05 USD a day" holds only while answers validate (H1, H2).

## Re-check of dbd1ff1

Target: fix commit `dbd1ff1` on top of `717d930`, branch `jev-text-features`.
- Diff read in full: `git diff 717d930 dbd1ff1`. Three files: `src/adapters/typesafe.ts`, `src/jobs/memeMeasure.ts`, `test/memeMeasure.test.ts`.
- Builder's mapping: "Fix round" in the reply.
- Operator rulings applied: the NVDAB example is dropped, tone is asked once per topic, and there is no daily cap.

### Verdict

**SHIP WITH RESIDUALS for merge. Do not turn `MEME_JEV_ENABLED` on until N1 is fixed, and N2 is either fixed or written into the runbook.**
- Merging stays low risk. With the flag off there are still zero requests and zero Jev cache reads (see below).
- The fix closes every original finding in code. However, the new give-up logic adds a defect (N1) that can permanently void the dataset the flag exists to collect. That changes the go/no-go for the measurement, not for the merge.

### Verification run

- `node --import tsx --test test/memeMeasure.test.ts`: tests 40 / pass 40 / fail 0 / skipped 0.
- `npm test` (full suite): tests 1000 / pass 1000 / fail 0 / skipped 0 (cancelled 0, todo 0).
- `npx tsc --noEmit`: exit 0.
- Mutants and two scenario tests ran in a scratchpad COPY of `src/`, `test/`, `package.json` and `tsconfig.json`, with a junction onto the worktree's `node_modules`.
  - The test file's own `globalThis.fetch` stub (`test/memeMeasure.test.ts:235-243`) was active in every run.
  - Every mutant touched `memeMeasure.ts` only, so nothing could reach the network.
  - The junction was removed with `rmdir`, which removes the link only. The real `node_modules` is intact.
- The worktree was not edited. HEAD is `dbd1ff1`. `git status` shows only the three untracked docs, this file included.

### Closure of the earlier findings

| Finding | Status | Evidence |
| - | - | - |
| H1 sum tolerance | Closed | `typesafe.ts:102` (`<= 0.02`). The audit's vectors, plus `0.2+0.4+0.39`, are in the parser table test (`test:573-582`). A sum 0.03 off is still rejected (`test:592`). |
| H2 backoff | Closed in mechanism, superseded by N1 | Retry marker `{digest, tries, nextAt}` at `memeMeasure.ts:647-655`, written at `:850-857`. Retries after 15 then 30 minutes, give-up at the third failure (`:549-550`, `:655`). Stop on 401, 422, 429, 5xx and transport at `:847-848`. Pinned by `test:801` and `:837`. The give-up classification is the new defect N1. |
| M1 cache tied to inputs | Closed | `jevDigest` at `:636` covers `{state, questions}`. Every read path checks it: `parseEntry` `:641`, memory `:698`, store `:712-720`. `jevHasName` and `jevHasCompany` at `:120`. Pinned by `test:717` and `:736`. Gaps: N2, N4. |
| M2 neutral wording | Closed | `:555-576` is the audit's wording, with no ticker or company in the fixed text. Pinned by `test:928-930` (NVDA, NVIDIA, QQQ and SPY are absent). |
| L1 tone per topic | Closed | The tone item is asked over `{topic}` only (`:804`), under key `tone:<topicId>`. The Noul stays per pair. `jevToneModel` at `:108`. |
| L2 key scrub | Closed | `scrubKey` (`typesafe.ts:47`) scrubs by value before `sanitizeMessage` truncates. It is used inside the fetch wrapper (`:67`), in the worker (`memeMeasure.ts:844`) and in the outer catch (`:427`). Pinned by `test:626`. |
| L3 store reads and box | Closed, residual N5 | A per-store `WeakMap` memory (`:629`, set at `:863`) holds one cycle's items. The box is `min(10 s, deadline - now)` (`:834`), with a skip under 2 s (`:831`). The deadline is 30 s after the cycle start (`:541`, `:423`). |
| L4 record size | Closed | `jevModel` is in `BOARD_DICT_COLUMNS` (`:160`). Old records decode with their own `dictColumns` (`test:933`). |
| L5 text length | Closed for names, residual N8 | The meme name and topic name are cut to 80 characters (`:781`, `:800`). The meme-stock `symbol` is still sent uncapped (`:788`). |
| L6 tests | Closed, residual N4 | File-level fetch stub (`test:235-243`). New pins cover the cap, concurrency, stop codes, flag off over a populated cache, planted entries, a failing store read, the time skip and backoff. |

**Flag off.** Confirmed.
- `memeMeasure.ts:417` gates the whole step.
- The `universe:rwa` read and every Jev key read live inside `memeJev`, and `JEV_MEMORY` is never touched.
- The flag-off test now runs over a populated cache and asserts zero Jev reads and null columns (`test:635-666`). That pins the old M3c survivor.

**Nothing out of scope added.**
- `jevToneModel`, `jevHasName` and `jevHasCompany` follow from L1 and M1.
- The status 200 on an envelope with no model (`typesafe.ts:76`) feeds the H2 classification.
- The new exports are used only by tests: `scrubKey`, `JEV_CONCURRENCY`, `JEV_DEADLINE_MS`, `JEV_MAX_TRIES`, `JEV_TEXT_MAX` and the two prefixes.
- No served route, board, shortlist or eligibility code changed.

### Mutation pass (targeted at the new logic)

- Killed (7):
  - no stop on 422;
  - a flat 15-minute backoff;
  - no retry-marker write;
  - transport failures counted as key faults;
  - a tone state that carries a token;
  - no name cap;
  - give-up after 5 tries instead of 3.
- Survived (5):
  - A: the memory retry path ignores the digest (`:698`).
  - B: `parseRetry` ignores the digest (`:648`).
  - C: A and B together. A given-up key whose inputs change would then stay given up, and no test notices.
  - G: the digest drops `questions`, so a wording change would no longer re-ask.
  - K: the box is a flat 10 s instead of `min(10 s, time left)`. The builder disclosed this one.

### New findings

#### HIGH

**N1. Any 4xx other than 401 and 429 counts against every key and does not stop the cycle. One account-level outage therefore permanently gives up every item it touches.**
- Evidence:
  - At `memeMeasure.ts:847-848`, `keyFault` is true for every status below 500 except 401 and 429. Only 422 also stops the cycle.
  - So 402 (credits exhausted), 403 (key suspended, WAF or geo block), 404 (endpoint moved), 408 and 409 are all treated as the item's own fault.
  - The saved docs list only 401, 422, 429 and 529, so the live status for credit exhaustion or a block is unknown.
  - The give-up never expires (`:655`; `test:853` asserts "still given up days later").
- Scenario, measured in the scratch copy:
  - 8 meme stocks. TypeSafe answers 403 at minutes 0, 15 and 45, then is healthy again.
  - Calls: 8, 16, 24. Then 0 re-asks at +2 h and 0 at +24 h. Every `jevStockScore` stays null.
- In production, one outage of 45 minutes or more:
  - gives up every item seen during it, for good;
  - still sends 60 requests every cycle while it lasts (the reply's "at most 6 per cycle" row does not apply);
  - gives up every new item that arrives during it.
- Recovery takes a `v1` prefix bump plus a process restart, because the in-process memory also holds the give-up markers.
- Smallest fix:
  - Count against the key only answer-level failures (an invalid answer, an unreadable 200) plus 400, 413 and 422.
  - Treat every other non-2xx as global: stop the cycle and count nothing.
  - Optionally let a give-up expire, for example after 7 days, so a misclassified failure heals.
  - Add a test with a 403 for three windows followed by recovery.

#### MEDIUM

**N2. The digest covers only `{state, questions}`, so a fix to the parser or the request envelope never un-gives-up an item.**
- Evidence:
  - `:636` digests the state and the question wording only. `JEV_MODEL`, the request envelope and the parsers are outside it.
  - The reply names its own largest risk: the live response shape may differ from the saved `api.md`.
- Scenario:
  - In the first live hour, Score probabilities come back keyed by level text.
  - Every stock is asked 3 times over 45 minutes and given up.
  - The builder fixes `parseScoreAnswer`. The digest is unchanged, so no stock is ever asked again.
  - The same happens after a fix to `askJev`'s envelope that cures a global 422.
- Smallest fix:
  - Fold a schema version constant into the digest, and bump it with any parser or envelope change.
  - At minimum, write "parser or envelope change: bump `memes:jev:v1:` and restart" into the runbook.
  - Also send the one manual request the reply recommends before turning the flag on.

#### LOW

**N3. An abort or connection error during the body read counts against the key.**
- `http.ts:124-128` turns any `response.json()` rejection into "invalid JSON in response", carrying the response's status (200).
- `:847` then treats it as the key's fault and does not stop the cycle.
- Measured in the scratch copy: a 200 whose body stream errors leaves a retry marker with `tries: 1`.
- So a box or job timeout that fires mid-body burns a try.
- Fix together with N1: do not count when `signal.aborted`, and do not count "invalid JSON".

**N4. No test pins the re-ask after an input or wording change, either for given-up keys or for wording.**
- Mutants A, B, C and G survive (above).
- The code at `:648` and `:698` is correct today. But the reply's claim, "the give-up lasts until the key's inputs or wording change", has no test.
- Fix:
  - A test that gives a key up, changes its name or company, and asserts that it is asked again.
  - A test that changes the question text and asserts one re-ask.
- The box mutant K stays a disclosed gap.

**N5. A cold or restarted cycle makes two unboxed store reads per item.**
- `jevLookup` (`:704-708`) reads both the answer key and the retry key for every item not in memory, with no concurrency bound and before the deadline is checked. That is double the count in L3.
- Mitigations already in place:
  - warm cycles read nothing (pinned);
  - the 2 s guard skips requests when the reads run long.
- What remains:
  - The first cycle after a deploy issues a few hundred to about a thousand point reads at once, on a `pg` pool with `max` 10.
  - A cycle whose board is not fresh drops every stock from the memory, so the next cycle re-reads them.
- Acceptable. A bounded `Promise.all` would remove it.

**N6. The reply's worst-case table understates the refusal case.**
- The row "every request refused: at most 6 per cycle" holds only for 401, 422, 429, 5xx and transport failures.
- Under any other 4xx, the full 60 are sent every cycle until the items are given up (N1).

**N7. Digest churn is invisible and unmeasured.**
- The tone and about states carry `topic.tags` and `type` verbatim, in upstream order (`binanceWeb3.ts:677`).
- If Binance reorders or rewrites a live topic's tags, its tone and every about pair are re-asked, and each churn resets that item's give-up count.
- The cycle record carries no request count when nothing fails, so neither the cost nor the churn rate is visible.
- Fix:
  - Sort the tags before building the state.
  - Record the cycle's request count (for example `jevAsked`) even on success.
  - Check that count during the first day.

**N8. The meme-stock `symbol` is still sent uncapped.**
- `:788` sends `row.symbol` as is. The symbol is creator-supplied, and `boardTuple` caps it at 40 for the record.
- The effect is the same as L5, on one field.
- Fix: `.slice(0, 40)`.

### Before the flag goes on

1. Fix N1:
   - count against the key only answer-level failures plus 400, 413 and 422;
   - stop on everything else;
   - add the outage-and-recovery test.
2. Fix N2 with a version constant in the digest, or write the prefix-bump rule into the runbook.
3. Send one manual request with the exact wording and check it against the parsers, as the reply already advises.
4. Optional and cheap: N3 (together with N1), the N4 tests, N7 (sort the tags, record the request count) and N8.

## Re-check of 05773a6

Reviewer: Opus 5.5 (independent; did not write the code). Scope: `git diff dbd1ff1 05773a6`, read against the builder's "Fix round 2" in `JEV-TEXT-FEATURES-REPLY-2026-10-07.md`. Line numbers refer to `05773a6`.

### Verdict

**SHIP. `MEME_JEV_ENABLED` may be turned on after the one manual live request the reply recommends, with the runbook line under R1 below.**
- N1, N2, N3, N4, N5, N7 and N8 are closed in code. N6 is answered in the reply's new worst-case table, and my outage scenario confirms its "at most 6 per cycle" row.
- No new defect blocks the flag. One MEDIUM residual (R1) remains: a global event that arrives as 400/413/422, or as an unreadable 2xx, still gives up every item it touches for good. Its cost is bounded (at most 3 tries per item and digest), it is measurement only and fail-open, and it can be recovered. A cheap expiry (below) would remove it.
- Flag off: still zero requests and zero Jev cache reads.

### Verification run

- `node --import tsx --test test/memeMeasure.test.ts`: tests 43 / pass 43 / fail 0 / skipped 0.
- `npm test` (full suite): tests 1003 / pass 1003 / fail 0 / skipped 0 (cancelled 0, todo 0).
- `npx tsc --noEmit`: exit 0.
- Mutants and scenario tests ran in a scratchpad COPY of `src/`, `test/`, `package.json` and `tsconfig.json`, joined to the worktree's `node_modules` by a junction.
  - The file-level `globalThis.fetch` stub (`test/memeMeasure.test.ts:235-243`) was active in every run.
  - The junction was removed as a link before the copy was deleted, and the real `node_modules` is intact.
- The worktree was not edited. HEAD is `05773a6`. `git status` shows only the three untracked docs.

### Closure of N1 to N8

| Finding | Status | Evidence |
| - | - | - |
| N1 classification | Closed | `memeMeasure.ts:872-875`: only `invalid answer`, a 2xx, 400, 413 and 422 count against an item; everything else stops the cycle and writes no marker. Pinned by `test:804`, which runs 401, 402, 403, 404, 408, 429, 500, 529, transport and a body read failure. My 403 scenario (60 min, 8 items) sent 78 calls (13 cycles x 6), wrote no marker, and answered all 8 in the first healthy cycle. The scenario that voided the dataset in the last re-check is gone. Residual: R1. |
| N2 schema version | Closed | `typesafe.ts:27` (`JEV_SCHEMA_VERSION`, with a bump rule in its comment), folded in at `memeMeasure.ts:652`. Pinned by `test:860`, with a control under the current version. |
| N3 body read | Closed | `typesafe.ts:76-77` reads the whole body inside the transport wrapper, so a read error or an abort mid-body becomes an `AdapterError` with no status: it stops the cycle and counts nothing. A body read in full but not JSON stays a 200 (`http.ts:127`). Pinned by `test:804` ("body read failed" and the HTML case). |
| N4 re-ask tests | Closed | `test:860` covers a name change, a wording change and a schema change. Last time's survivors A and B are now killed one by one (m12, m13 below), and so is G (m6). |
| N5 bounded cold reads | Closed, no pin | `memeMeasure.ts:721-728` runs at most 6 items at a time. Measured: the peak of Jev store reads in flight was 12 (6 items x 2 keys) on a 40-item cold cycle. That is below the cold burst before and matches the claim. No test pins it (m4). |
| N6 table | Answered (docs) | The reply's new table matches the code. The "at most 6 per cycle" row is confirmed by the 403 scenario above. |
| N7 tags and count | Closed | Sorted tags at `:822`. `jevRequests` is declared at `:139`, written at `:475` and `:891`, and exported at `:929`. Pinned by `test:917` (reorder gives 0 requests; warm gives 0; flag off gives null). |
| N8 symbol cap | Closed | `:803` (`JEV_SYMBOL_MAX` = 40, the same cap as `boardTuple`). Pinned at `test:1046`. Topic token symbols were already capped at 40 by the adapter (`binanceWeb3.ts:653`). |

**`jevRequests` and export compatibility.**
- The field is optional on `MeasureCycle`. It is null with the flag off, and 0 when the Jev step throws: it can only throw on the store reads made before any request, because everything after the first request sits inside a try.
- `expandCycle` exports it as `?? null`. In my scenario, a stored cycle with the field deleted expanded with `jevRequests: null`.
- `format=compact` returns the raw cycle, so old slots simply lack the key.
- The one known consumer, `D:\4lpha-execution\scripts\jev-bench-pull.ts:29`, reads `slot` only and saves the rest verbatim. Unaffected.

**Schema digest.**
- The digest changed shape from round 1 (`{schema, state, questions}` instead of `{state, questions}`).
- Every entry written by `dbd1ff1` is therefore re-asked once. That matters only if the flag was ever on with round 1, and it is harmless either way.

**Flag off.**
- `memeMeasure.ts:421` still gates the whole step, and `memeJev` is the only reader of `universe:rwa` for Jev, of any Jev key and of `JEV_MEMORY`.
- The populated-cache read count is still pinned (`test:650`). m10 (a count where null is expected) is killed.

**Loops at 60 per cycle.** None found.
- A global stop-class failure sends at most 6 per cycle (measured).
- A global item-class failure sends up to 60 per cycle only until every item has used its 3 tries. My scenario sent 24 calls for 8 items, then 0 at +2 h and 0 at +24 h.
- Digest churn that would re-ask every cycle needs an input that flips back and forth. I checked the candidates:
  - Topics are de-duplicated within a list (`binanceWeb3.ts:640`) and across latest/rising, with latest winning (`memeMeasure.ts:389-390`).
  - A hot-only board row keeps its previous name (`memeBoard.ts` `seedFromHot`, which builds on `previous`).
  - Extra `universe:rwa` rows always carry `underlyingName: null` (`binanceRwa.ts:430`), so a missed per-address read does not flip `company`.
- Tags are cut to 10 before they are sorted (`binanceWeb3.ts:677`). A reorder of a topic with more than 10 tags can still change the set, but that is a one-off re-ask, not a loop.

### Mutation pass (scratch copy, 16 mutants)

- Killed (13):
  - m1: 422 stops the cycle again;
  - m5: no full body read;
  - m6: schema dropped from the digest;
  - m7: tags unsorted;
  - m8: symbol uncapped;
  - m9: 403 counted against the item;
  - m10: `jevRequests` not null with the flag off;
  - m11: request count never set;
  - m12: memory retry ignores the digest (last time's A);
  - m13: stored retry ignores the digest (last time's B);
  - m14: 413 dropped from the item class;
  - m15: invalid answer not counted;
  - m16: cached answer ignores the digest.
- Survived (3), all test gaps (R2):
  - m2: the 2xx class narrowed to exactly 200;
  - m3: `expandCycle` without `?? null`;
  - m4: the cold-read pool unbounded.
- The builder's 10 in-place mutants line up with m5 to m16, and none of mine contradicts their result.

### Findings

#### MEDIUM

**R1. A global event delivered as 400, 413 or 422, or as an unreadable 2xx, still gives up every item it touches for good. The only cure also discards every valid answer.**
- Evidence:
  - `memeMeasure.ts:872-874` counts any 2xx failure and any 400/413/422 against the item, without stopping the cycle.
  - `typesafe.ts:88` (`unexpected response shape`) and `http.ts:127` (`invalid JSON`) both carry status 200.
  - A give-up never expires (`:670`).
- Measured in the scratch copy: 8 items, each failure held for 60 minutes and then healthy.

  | Failure | Calls | Re-asks at +2 h / +24 h | Given up |
  | - | - | - | - |
  | `400 {"error":"insufficient credits"}` | 24 | 0 / 0 | 8 of 8 |
  | `200 <html>maintenance</html>` | 24 | 0 / 0 | 8 of 8 |
  | `200 {"error":{"code":"quota"}}` | 24 | 0 / 0 | 8 of 8 |

- These are plausible account-level shapes:
  - Some LLM APIs answer an exhausted credit balance with a 400, and TypeSafe's status for that case is undocumented.
  - A retired `jev-latest` alias would most likely come back as a 400 or 422 on every request.
  - A maintenance or edge page is often a 200.
- The cost is bounded (at most 3 tries per item and digest). But any such event that lasts 45 minutes or more, plus the cold-start spread, silently voids the measurement for every item it touches, and for every new item that arrives during it.
- The cure the code offers is a `JEV_SCHEMA_VERSION` bump. That re-digests the answers as well as the give-up markers, so it re-asks the whole cache against `jev-latest`. If the model version moved in between, that puts a model seam into a benchmark mid-run.
- This matches the classification I recommended last time. The optional give-up expiry I proposed then was not adopted, and that is the source of the residual. It is not a builder error.
- Smallest fix (either one):
  - Let a give-up expire, for example re-ask once after 24 h. This means one extra branch in `jevRetryDue`, plus a test.
  - Or add a retry-only epoch to the retry marker's digest, so bumping it frees the given-up items while keeping the answers.
- Until then, add this runbook line: if a cycle's `failures` shows `jev: N failed of N requests` with `upstream responded 400/413/422`, `unexpected response shape` or `invalid JSON`, `jevRequests` is above 0 and no Jev column fills in, turn the flag off. Fix the cause, then bump `JEV_SCHEMA_VERSION`, accepting the re-ask of every cached answer.
- Not a blocker for the flag: the event is visible in every cycle record, it costs cents, and it is recoverable.

#### LOW

**R2. Three claims have no test pin (mutants m2, m3, m4).**
- The code is right today: the old-slot null export and the 12-read peak were both measured above.
- The schema test's comment at `test:899` says "a give-up marker and an answer written under the previous version are ignored", but it plants only a marker. Last time's m16 equivalent is killed elsewhere, so this is wording only.
- Cheap fixes:
  - assert `jevRequests: null` when expanding a cycle with the field removed;
  - count peak Jev reads on a cold 40-item cycle;
  - optionally add one 204 case.

**R3. A request that reliably outlives the box is never counted against its item.**
- This is a direct consequence of N3, which I asked for: an abort counts nothing.
- If one item's request deterministically takes longer than the box (10 s, or the 12 s request deadline), it is asked again every cycle forever.
- Each time the box fires it also aborts the other requests in flight. Those are asked again next cycle, not lost, but they may be billed.
- Bounded at 6 requests per cycle, and visible as a `jev:` failures line every cycle while `jevRequests` stays above 0.
- No change is needed for a fast model like Jev. Note it in the runbook beside R1.

### Before the flag goes on

1. Send the one manual live request with the exact wording, and check the response against the three parsers.
2. Add the R1 runbook line, or add the 24 h give-up expiry (preferred; small).
3. Optional: the R2 pins.
