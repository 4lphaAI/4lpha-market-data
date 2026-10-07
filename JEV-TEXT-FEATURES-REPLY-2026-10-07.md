# Reply: Jev text features on meme stocks, measurement only (2026-10-07)

To: execution plane. Answers `JEV-TEXT-FEATURES-HANDOFF-2026-10-07.md`.

Status: built offline on branch `jev-text-features` (worktree `D:\4lphaDATA-wt-jev`), commit `717d930`.
- The audit (`JEV-TEXT-FEATURES-AUDIT-2026-10-07.md`, SHIP WITH RESIDUALS) was answered by a fix round, commit `dbd1ff1`.
- The audit's re-check was answered by fix round 2, commit `05773a6`.
- Nothing is merged, pushed or deployed, and no request has been sent to TypeSafe.

**"Fix round 2" supersedes "Fix round" on what counts against an item and on the worst-case table.**

**The "Fix round" section supersedes the earlier sections wherever they differ:**
- the relevance wording;
- tone, now asked once per topic;
- the cache keys;
- the retry behaviour;
- the columns;
- open item 13, now resolved;
- the test numbers.

## Files changed

- `src/adapters/typesafe.ts` (new): one POST plus strict answer parsers.
- `src/jobs/memeMeasure.ts`: the flag and key, the Jev step, the new columns.
- `test/memeMeasure.test.ts`: five new tests in `describe("Jev text features")`.

No table or column was added: the caches are ordinary `SnapshotStore` keys, so `FakePg` needed no change. No served route changed, and `server.ts` is untouched: the export carries the new columns through each record's own column list. `package.json`, the lockfile and `.env*` are untouched.

## Item by item

**1. Meme-to-stock relevance (Score)**
- Question constants: `JEV_STOCK_LEVELS` and `JEV_STOCK_QUESTIONS` at `src/jobs/memeMeasure.ts:526` and `:537`.
- One request per meme-stock token, with state `{ meme: { symbol, name? }, stock: { symbol, company? } }`, built in `memeJev` at `src/jobs/memeMeasure.ts:598`:
  - `name` is the board row's `name`, sent only when it is not null. Hot-only rows carry none.
  - `stock.symbol` is the row's `quote.symbol`.
  - `company` is `underlyingName` from the stored `universe:rwa` row of the quote address, read with the existing `rwaRowsByAddress`. It is sent only when present.
- Stored: `score`, the three level probabilities and the answering `model`.
- Parser: `parseScoreAnswer` at `src/adapters/typesafe.ts:81`. It needs `type == "score"`, a finite `score` in [0, 2], and `probabilities` with exactly the keys "0", "1" and "2", each in [0, 1] and summing to 1 within 0.01.

**2. Topic relevance and tone (Noul + Choice)**
- Question constants: `JEV_TOPIC_QUESTIONS` at `src/jobs/memeMeasure.ts:548`.
- One request per (topicId, token address) pair, with both questions over the state `{ topic: { name: nameEn, type, tags }, token: { symbol } }`.
- Parsers at `src/adapters/typesafe.ts:89` and `:95`:
  - `parseNoulAnswer`: `type == "noul"` and `noul` in [0, 1].
  - `parseChoiceAnswer`: `type == "choice"`, `choice` one of hype, neutral or warning, and probabilities for exactly those three that sum to 1.
- No post text, summary, link, topicId or address is ever in the body. The test pins this.

**3. Columns in the `/memes/measure` slots**
- New columns are appended at the end of the existing lists:
  - Board rows (`BOARD_COLUMNS`, `src/jobs/memeMeasure.ts:117`): `jevStockScore`, `jevStockProbabilities`, `jevModel`.
  - Topic-token rows (`TOPIC_TOKEN_COLUMNS`, `:105`): `jevAboutToken`, `jevTone`, `jevToneProbabilities`, `jevModel`.
- Filled by `boardTuple` (`:305`) and `topicTokenTuples` (`:278`).
- Existing column positions, `v: 1` and the dictionary encoding are unchanged.
- `expandCycle` and `format=compact` carry the new columns with no code change, because both read the record's own `columns`.
- Old slots still expand. Their rows simply do not have the new keys; they are absent, not null.

**4. Flag and key**
- `memeJevApiKey` (`src/jobs/memeMeasure.ts:691`) returns the key only when `MEME_JEV_ENABLED` is exactly `true` and `TYPESAFE_API_KEY` is non-empty after trimming. Anything else returns `null`.
- `memeMeasureJob` (`:804`, `:814`) reads it once at boot and passes it to `runMemeMeasure` as `jevApiKey`.
- With no key, the Jev step is skipped entirely (`:411`). That means no request and no cache read, and every Jev column is null.

**Constraints**
- **Fail open.** The whole Jev step sits in a try/catch (`:411`-`:418`). Each request failure is collected, and the cycle gets one sanitized line: `jev: <n> of <m> requests failed (...)`. A Jev failure never counts toward the "no measurement source available" check, and it never touches the board, shortlist, eligibility or any served key.
- **The key never reaches a record or a log.** `sanitizeMessage` already redacts long opaque tokens, and the failure text is also scrubbed of the key's exact value (`:675`).
- **Only valid answers are cached** (the `store.put` sits after the parser check in each ask). A cached entry is re-checked with the same parsers when read (`cachedStock` and `cachedTopic` at `:579` and `:585`), so an entry that fails the check is asked again.
- **Budget.** Only unanswered tokens and pairs are asked:
  - At most `JEV_MAX_REQUESTS` = 60 requests per cycle (`:519`), 6 in flight at a time.
  - The whole step runs inside a 10 s box (`JEV_BOX_MS`, `:523`) combined with the job's own signal.
  - A 429 stops the cycle's remaining requests (`:676`).

## Exact question wording

Meme-to-stock relevance, `type: "score"`. Instructions:

> How strongly is the meme token `meme` themed on the stock `stock`? `stock.symbol` is a tokenized stock: the company's ticker followed by B (for example NVDAB is NVIDIA).

Criteria, in level order 0, 1, 2:

0. "Unrelated: nothing in the meme's symbol or name refers to this company, its people or its products"
1. "Loosely related: a generic finance, stock-market or trading joke that is not specific to this company"
2. "Clearly about this company, its people (founders, executives) or its products"

Topic about token, `type: "noul"`, question id `about`. Instructions:

> Is the social-media topic `topic` actually about the token `token.symbol` (its name, meme, community or launch), rather than about something else the token is only listed beside?

Criteria:

- `true`: "The topic is about this token"
- `false`: "The topic is about something else; the token is only associated with it"

Topic tone, `type: "choice"`, question id `tone`. Instructions:

> What is the tone of the social-media topic `topic`?

Criteria:

- `hype`: "Excitement, promotion or a push to buy"
- `neutral`: "Plain news or description with no push either way"
- `warning`: "A warning: scam, rug pull, exploit, dump or another risk"

Question ids (`relevance`, `about`, `tone`) are not sent to the model, per the API reference.

## Ambiguities and the reading chosen

1. **Where the API shape came from.**
   - The handoff does not say where answers sit in the response or how `criteria` is shaped. No network call was allowed, so this build read the copy of `docs.typesafe.ai/api.md` that the operator's session saved on 2026-10-07 (its scratchpad `api.md`).
   - That copy gives: request `{ state, model, questions }`; Noul criteria `{ true, false }`; Choice criteria as a map from option to description; Score criteria as an ordered array.
   - The response is `{ model, answers: { <id>: Answer }, usage }`, where every answer carries `type`, Choice and Score probabilities are maps (Score keyed by level index as a string), and errors are 401/422/429/529.
   - The parsers follow that copy exactly. If the live API differs, nothing gets cached and the columns stay null. No wrong value is written.
2. **One request per token or pair, not one shared state per cycle.**
   - A single state holding many items, with one question per item, may bill the whole state for every question, and that cannot be checked offline.
   - It would also let one item's text sit in another item's judgment. Per-item states also keep the "inputs are only these fields" property exact.
   - "Batch per cycle" is therefore read as: all of a cycle's unanswered keys are asked in that cycle, up to 60 requests, 6 at a time.
3. **Cache layout: one store key per token or pair.**
   - Keys are `memes:jev:v1:stock:<address>` and `memes:jev:v1:topic:<topicId>:<address>`, kept for 100 years (`quotes:kind`'s horizon, already proven against FakePg's bigint columns).
   - This deliberately does not use one map key as `quotes:kind` does. A forever map of every meme-stock token and pair would grow by roughly 100 KB a day and be rewritten whole every cycle.
   - The cost of this layout is one store read per board meme stock and per pair each cycle while Jev is on (a few hundred point reads every 5 minutes), and none when it is off.
4. **Flag off also means no cache read.** Answers cached while it was on do not appear in slots recorded while it is off. The columns are null, as the handoff says.
5. **Tone is stored per pair, as the handoff asks**, even though it describes the topic. The same topic is therefore asked once per associated token.
6. **Company name.**
   - It comes only from `universe:rwa` (`RwaToken.underlyingName`).
   - `rwa:quote-stocks` rows (BNCB, HIMSB, GMEB and others) carry no name, so those memes are asked with the bStock symbol only.
   - `StockInfo` was not extended: its typed literal in `groupMemesByStock` would have pushed a new field onto `/memes/stocks`.
7. **Nothing to judge means never asked.**
   - A pair whose topic has no `nameEn`, or whose token has no symbol, is never asked, and neither is a meme stock whose quote has no symbol. Their columns stay null.
   - A null topic `type` is sent as null.
8. **Cell format.**
   - Records hold scalar cells only, so probabilities are stored as one string joined with `|`, the same way `tags` is: `jevStockProbabilities` = "p0|p1|p2" in level order, and `jevToneProbabilities` = "hype|neutral|warning" in that order.
   - Numbers are rounded to 4 significant digits, as for USD amounts.
   - Choice and Score `confidence`, the Score `legend` and `usage.input_tokens` are not stored. The handoff asks for score, probabilities and model only.
9. **Inline, not a separate job.**
   - The measure cycle records once per 5 minutes inside a 45 s timeout. Its other work is four Binance calls (each with a 12 s deadline) and a few store reads.
   - Inline with a 10 s box therefore fits and needs no new job, lease or key. It also lets the slot carry the answers obtained in the same cycle.
   - This follows the Four.Meme tax precedent: a bounded number of reads per cycle inside a box, and failures never stored.
10. **Cold start order.**
    - Meme stocks are asked before pairs. With a few hundred meme stocks on the board, the first cycles spend their 60 requests on relevance, and pairs fill in after.
    - Expect about 25 to 30 minutes to work off a cold start.
11. **A 429 stops new requests only.** Up to 5 requests already in flight still complete. Unanswered keys are asked again next cycle.
12. **No boot warning** is printed when the flag is on but the key is missing. The columns simply stay null.
13. **Open item for the operator: the example in the relevance question.**
    - The instructions use "for example NVDAB is NVIDIA" to explain the ticker-plus-B naming. That is a company name in fixed text, not taken from the stock row.
    - NVDAB is a common quote stock, so the example could nudge NVDAB-quoted memes slightly.
    - The wording should be fixed before the run (benchmark plan, section 7), so please confirm it or drop the example before turning the flag on.

## Operator: env vars on the Railway `data-plane` service

- `TYPESAFE_API_KEY=<key>` (secret).
- `MEME_JEV_ENABLED=true` to switch it on. Leave it unset or set any other value to keep it off (the default).
- `.env.example` was not edited: the build rules forbid touching `.env*` files. Add both lines there if wanted.

Before turning it on, it is worth sending one manual request with the exact wording above and checking the response against the parsers. The API shape was read from a saved copy of the docs, not checked live.

## Cost

Expected cost is about 300 input tokens per request (the docs' small examples run 296 to 318). A cold start of about 300 requests costs well under 0.01 USD, and a warm day asks only for new meme stocks and new pairs (a few hundred), which is also under 0.01 USD a day.

## Tests

- `node --import tsx --test test/memeMeasure.test.ts`: tests 29 / pass 29 / fail 0 / skipped 0 (it was 24 before).
- `npm test` (full suite): tests 989 / pass 989 / fail 0 / skipped 0. The baseline on master 4c83719 in this worktree was 984 / 984 / 0 / 0.
- `npx tsc --noEmit`: clean (exit 0).

New tests in `test/memeMeasure.test.ts`, starting at line 535:

- **Flag gate:** off or key missing sends nothing, and every Jev column is null.
- **Asked once:** 5 requests for 3 meme stocks plus 2 pairs, with the right URL, bearer header and model. Columns are filled, and the next slot sends 0 requests and reads from the cache.
- **Failures:**
  - Four failures are each recorded but never cached: a 429, a thrown fetch whose message contains the key, a malformed answer (score 3, an unknown tone) and a response envelope with no `model`.
  - In each case the cycle is still recorded with its board, and every key is asked again the next cycle.
  - The key appears nowhere in the record.
- **Inputs:** the exact state of each request, the top-level body keys, and no `0x`, `http`, topicId, summary text or key in any body.
- **Old slots:** a slot written with the pre-Jev column lists still expands with its existing fields and without the new keys.

## Not built

- No served route, flag, score or ranking change on `/memes`, `/memes/shortlist` or `/memes/stocks`.
- No new upstream besides TypeSafe, and no fetch of post text or IPFS metadata.
- No `/status` or `latest.counts` field for Jev.
- No retry inside a cycle.
- No pruning of the forever cache rows (one store row per answered token or pair).
- No `.env.example` line.
- No live call, deploy, merge or push.
- No audit yet (Opus 5.5 is owed). Now done; see the Fix round below.

## Fix round (2026-10-07, commit `dbd1ff1`)

Every finding in `JEV-TEXT-FEATURES-AUDIT-2026-10-07.md` is answered. Line numbers refer to `dbd1ff1`.

| Finding | Fix | Where |
| - | - | - |
| H1 probability-sum tolerance | A distribution now passes when its sum is within 0.02 of 1, so 0.33/0.33/0.33, 0.34/0.33/0.32, 0.34/0.34/0.33 and 0.5/0.5/0.01 are accepted. The audit's vectors are in a parser table test. | `src/adapters/typesafe.ts:102`; test `test/memeMeasure.test.ts:573` |
| H2 backoff and give-up | A per-key retry marker `memes:jev:v1:retry:<item>` = `{digest, tries, nextAt}`. It is never an answer. A key's own failure (see below) retries after 15 minutes, then 30 minutes, and is given up after the third failure. The give-up lasts until the key's inputs or wording change. 401, 422, 429, 529, other 5xx and transport failures stop the cycle's remaining requests. 422 also counts against the key, so a request the API always refuses as malformed backs off and stops consuming cycles. A 400 or 404 counts against the key but does not stop the cycle. | `src/jobs/memeMeasure.ts:549-550`, `:647`, `:837-862` (classification `:847-848`); tests `:801`, `:837` |
| M1 cache tied to inputs and wording | Each entry is `{digest, model, answer}`, where `digest` = sha256 of `{state, questions}` cut to 16 hex characters. A cached or remembered answer counts only while its digest matches the current request, so a name or company name that appears later, or any change of wording, is asked again once. Board rows gain `jevHasName` and `jevHasCompany`: which optional inputs the recorded answer was asked with. | `src/jobs/memeMeasure.ts:636`, `:641`, `:120`, `:327`; tests `:717`, `:736` |
| M2 neutral relevance wording | The audit's wording, with the NVDAB example dropped (operator ruling). No real ticker or company appears in the fixed text, and a test pins that for NVDA, NVIDIA, QQQ and SPY. | `src/jobs/memeMeasure.ts:555-576`; test `:890` |
| L1 tone once per topic | The tone Choice is asked once per topic over `{topic}` only and cached at `memes:jev:v1:tone:<topicId>`. The Noul stays per pair at `memes:jev:v1:about:<topicId>:<address>`. Topic-token rows gain `jevToneModel`; `jevModel` is now the Noul's model. | `src/jobs/memeMeasure.ts:593`, `:798-818`, `:282`, `:108`; test `:668` |
| L2 key scrub | `scrubKey` removes the key by value and only then sanitizes and truncates. It runs on the transport error inside `askJev` (before `fetchJson` truncates), in the worker, and in the outer catch. | `src/adapters/typesafe.ts:47`, `:67`; `src/jobs/memeMeasure.ts:427`, `:844`; test `:626` |
| L3 store reads and time box | A per-store in-process memory (a `WeakMap` keyed by store) holds the last cycle's answers and retry markers, and only for that cycle's items, so it stays bounded. A warm cycle reads no Jev key; the one `universe:rwa` read per cycle remains. The request box is `min(10 s, 30 s after the cycle start - now)`, and with less than 2 s left nothing is asked (cached answers are still recorded). | `src/jobs/memeMeasure.ts:629`, `:684`, `:863`, `:541-543`, `:828-834`; tests `:668`, `:875` |
| L4 record size | `jevModel` is added to `BOARD_DICT_COLUMNS`. Old records keep their own `dictColumns`, so they decode unchanged (pinned). | `src/jobs/memeMeasure.ts:160`; tests `:668`, `:933` |
| L5 untrusted text length | The meme name and the topic name are cut to 80 characters (`JEV_TEXT_MAX`) in the request. | `src/jobs/memeMeasure.ts:552`, `:781`, `:800`; test `:890` |
| L6 tests | The measure test file replaces `globalThis.fetch` with one that throws for the whole run, so no test (or mutant) can reach the network. New pins: (a) flag off over a populated cache reads no Jev key; (b) stop on 401/422/429/529/transport with 12 keys (6 sent), and no stop on 400 (12 sent); (c) the 60 cap (70 keys: 60 sent, 10 the next cycle); (d) concurrency peak 6; (e) the parser rules one by one; (f) an envelope with valid answers but no model; (g) a planted mismatched cache entry; (h) a failing Jev store read; (i) the time box; (j) backoff and give-up. | `test/memeMeasure.test.ts:235`, `:572-960` |

**What counts against a key.** An invalid answer, an unreadable 200 (no `model` or `answers`, or invalid JSON), or a 4xx other than 401 and 429. Those failures come from the key's own request or answer. Everything else (401, 429, 5xx, timeout, network) is not the key's fault: it is retried next cycle without counting, and it stops the rest of that cycle.

### Exact relevance wording (replaces the earlier one)

Instructions:

> How strongly is the meme token `meme` themed on the asset behind the tokenized stock `stock`? `stock.symbol` is the underlying ticker with the letter B appended. `stock.company`, when present, names the underlying company or fund.

Criteria, in level order 0, 1, 2:

0. "Unrelated: nothing in the meme's symbol or name refers to this company or fund, its ticker, people, products or brand; this includes generic crypto or meme-culture names with no finance theme"
1. "Loosely related: a generic finance, stock-market, trading or sector joke that is not specific to this company or fund"
2. "Clearly about this company or fund: its ticker, brand, people (founders, executives), products, or for a fund its index"

The topic wording is unchanged. The Noul is now asked alone over `{ topic, token }`, and the tone Choice alone over `{ topic }`.

### Columns after the fix round

Columns are appended at the end; the columns from 717d930 were never shipped, so their order could still change.
- Board rows end with `jevStockScore, jevStockProbabilities, jevModel, jevHasName, jevHasCompany`. `jevModel` is dictionary-encoded.
- Topic-token rows end with `jevAboutToken, jevTone, jevToneProbabilities, jevModel, jevToneModel`.

### Worst-case requests per day

Let N be the number of new items a day: new meme stocks, plus new topics with tokens, plus new (topic, token) pairs, plus re-asks after an input appears.

| Case | Requests | Notes |
| - | - | - |
| Normal (answers validate) | N per day | Each item is asked once. |
| Every answer is rejected (H1/H2 scenario A) | At most 3N per day | 3 tries per item and digest. |
| Every request refused (401, 429, 5xx, transport) | At most 6 per cycle, 1,728 per day | The requests already in flight when the first failure arrives. These are refusals, not answered requests. |
| Absolute ceiling | 60 × 288 = 17,280 per day | Unchanged. Reachable only if 60 or more new items arrived every cycle. |

The old failure loop (60 rejected requests every cycle, 17,280 a day indefinitely) is gone.

I did not measure N. If it is 500 to 1,000, then at about 500 input tokens a request:
- normal: about 0.01 to 0.02 USD a day;
- every answer rejected: at most 1,500 to 3,000 requests, about 0.03 to 0.06 USD a day.

The top of that rejected-answer range is slightly above the handoff's "well under 0.05 USD a day", so I did not add a daily cap. The handoff's budget is an expected figure, and the rejection case now stops after 3 tries per item. If the operator wants a hard ceiling, a daily request cap is a small addition.

### Tests (fix round)

- `node --import tsx --test test/memeMeasure.test.ts`: tests 40 / pass 40 / fail 0 / skipped 0.
- `npm test` (full suite): tests 1000 / pass 1000 / fail 0 / skipped 0 (cancelled 0, todo 0).
- `npx tsc --noEmit`: clean (exit 0).

**Quick mutation check** (run in place; each mutant was restored from a byte copy, with no git restore):
- Killed (9):
  - the 0.02 tolerance set back to 0.01;
  - the 401/422/5xx stop narrowed to 429 only;
  - the 60 cap removed;
  - the flag gate removed;
  - give-up removed;
  - the memory hit disabled;
  - the state dropped from the digest;
  - the too-little-time skip removed;
  - the key scrub removed.
- Survived (2):
  - the box sized from the time left, replaced by a flat 10 s. Pinning it needs a slow-fetch timing test.
  - the blank-model check (`model: "  "`). The missing-model case is pinned; a blank one is not.

### Still not built

- A daily request cap.
- Interleaving meme stocks and pairs in the queue: a cold start spends its first cycles on meme stocks. That no longer starves pairs indefinitely, because failing keys back off.
- Pruning of the forever answer and retry rows.
- A live call.
- The `CLAUDE.md` "Measurement recorder" line. That file exists only in the main tree.

## Fix round 2 (2026-10-07, commit `05773a6`)

This round answers the "Re-check of dbd1ff1" section of the audit. Line numbers refer to `05773a6`.

| Item | Fix | Where |
| - | - | - |
| N1 (HIGH) what counts against an item | Only three failures count against an item: an invalid answer, a 2xx body that was read in full but is unreadable (not JSON, or no `model`/`answers`), and HTTP 400, 413 or 422. Those three do not stop the cycle. Every other non-2xx (401, 402, 403, 404, 408, 429, 5xx...) and every transport or abort failure stops the cycle's remaining requests and counts nothing against any item. Test: 403 then 402 on every cycle for an hour (13 cycles, 6 requests each). No retry marker is written, and after recovery all 8 items are answered in one cycle. | `src/jobs/memeMeasure.ts:869-875`; tests `test/memeMeasure.test.ts:804`, `:837` |
| N2 schema version in the digest | `JEV_SCHEMA_VERSION = 1` lives in the adapter, next to the request body and the parsers. Its comment says when to bump it by hand: any change to `askJev`'s body or envelope check, or to any `parse*Answer` rule. It is folded into `jevDigest`, so a bump re-asks every cached and given-up item. | `src/adapters/typesafe.ts:27`; `src/jobs/memeMeasure.ts:651-652`; test `:860` |
| N3 body read failure | `askJev` reads the whole body inside its transport wrapper. A read that fails or is aborted is therefore a transport failure: it stops the cycle and counts nothing. A body that was read in full but is not JSON stays an item failure (`fetchJson` reports it as a 200). | `src/adapters/typesafe.ts:76-79`; test `:804` (the "body read failed" and "not json" cases) |
| N4 re-ask tests | One test covers three changes. An item is given up after 3 invalid answers, then: its name changes (asked again); the question wording changes (asked again; the test edits and restores `JEV_STOCK_QUESTIONS`); a give-up marker written under `JEV_SCHEMA_VERSION - 1` is ignored (asked again), while the same marker under the current version is honoured (control). | test `:860` |
| N5 bounded cold reads | Each item missing from memory still needs its answer key and its retry key read. Those reads now run at most `JEV_CONCURRENCY` (6) items at a time. | `src/jobs/memeMeasure.ts:719-728` |
| N7 tags and request count | Topic tags are sorted before they enter the request and the digest, so an upstream reorder asks nothing again (pinned). Every cycle record carries `jevRequests`: the number of requests sent, 0 on a warm cycle, `null` with Jev off. `expandCycle` exports it, as `null` for older slots. | `src/jobs/memeMeasure.ts:822`, `:139`, `:475`, `:891`, `:929`; test `:917` |
| N8 symbol cap | The meme symbol is cut to 40 characters (`JEV_SYMBOL_MAX`, the same cap the record applies). | `src/jobs/memeMeasure.ts:560`, `:803`; test `:1018` |

N6 (the worst-case table) is answered below; nothing in the code changed for it.

**Reading I chose.** The brief says "every other non-2xx stops". I read that as 400, 413 and 422 counting against the item without stopping the cycle. This reverses round 1, where 422 also stopped the cycle. A 422 that the API returns for every request (say, a wrong envelope) is therefore bounded by each item's 3 tries, and is fixed with a `JEV_SCHEMA_VERSION` bump.

### Worst-case requests per day (replaces the round 1 table)

N is the number of new items a day, as before.

| Case | Requests |
| - | - |
| Normal (answers validate) | N per day |
| Every answer is rejected, or every request answers 400/413/422 | At most 3N per day: 3 tries per item and digest, up to 60 per cycle while items are new. |
| Every request refused (any other non-2xx: 401, 402, 403, 404, 408, 429, 5xx) or transport failure | At most 6 per cycle (the requests already in flight), 1,728 per day. Counts nothing, so recovery is immediate. |
| Absolute ceiling | 60 × 288 = 17,280 per day, unchanged. |

### Tests (fix round 2)

- `node --import tsx --test test/memeMeasure.test.ts`: tests 43 / pass 43 / fail 0 / skipped 0.
- `npm test` (full suite): tests 1003 / pass 1003 / fail 0 / skipped 0 (cancelled 0, todo 0).
- `npx tsc --noEmit`: clean (exit 0).

**Mutation check** (in place; each mutant was restored from a byte copy). All 10 were killed:
- 403 and other 4xx counted against the item again;
- the stop narrowed to 429 only;
- the schema dropped from the digest;
- the in-memory retry marker no longer checks the digest;
- the stored retry marker no longer checks the digest (the audit's survivors A and B);
- tags no longer sorted;
- the request count no longer recorded;
- the symbol cap removed;
- the full body read removed;
- an unreadable 2xx no longer counted against the item.

The two survivors disclosed in round 1 are unchanged: the box sized from the time left, and a blank model.
