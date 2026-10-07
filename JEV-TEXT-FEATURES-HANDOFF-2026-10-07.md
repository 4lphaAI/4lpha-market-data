# Handoff: Jev text features on meme stocks, measurement only (2026-10-07)

From: execution plane (paper meme lane). Plan: `D:\4lpha-execution\MD here\JEV-MEME-BENCHMARK-PLAN.md` section 4 (operator approved 2026-10-07). Reply in `JEV-TEXT-FEATURES-REPLY-2026-10-07.md`.

## Why

The operator is benchmarking the meme paper agent's LLM arbiter against TypeSafe's Jev (a "System One" model: typed Choice / Noul / Score answers with probabilities, no generated text; docs https://docs.typesafe.ai/llms.txt). The execution plane runs the head-to-head on numbers. This plane adds two **text** judgments, recorded for measurement, so the analysis can test whether they predict which memes run. Nothing is served and nothing trading reads them until the operator rules on the numbers, the same posture as the social-rush recorder.

## Ask

1. **Meme-to-stock relevance (idea 3).** Once per meme-stock token (cache forever, the inputs never change): one Jev **Score**, "how strongly is this meme themed on its quote stock", with concrete levels, e.g. 0 unrelated, 1 loosely (a generic finance or market joke), 2 clearly about the company, its people or its products. Inputs: the meme's `symbol` and `name` when the board has one (hot-only rows carry `name: null`), the quote bStock's symbol and the underlying company name if a stock row you already store carries it. Store the `score`, the `probabilities` and the answering model version.
2. **Topic relevance and tone (idea 4).** Once per (social-rush topic, associated token) pair: a **Noul** "is topic `nameEn` (type, tags) actually about token `symbol`" and a **Choice** for the topic's tone `hype | neutral | warning`. Inputs: the topic's `nameEn`, `type` and `tags` and the token's `symbol` only. The record holds no post text and none is fetched (CLAUDE.md social ruling: never raw post text to a model).
3. **Record both into the `/memes/measure` slots** as extra columns (meme-stock rows get the relevance answer; topic-token rows get the pair answers), so one export carries prices and features together. Keep a slot's columns backward compatible for existing readers of the export.
4. **Flag and key.** `MEME_JEV_ENABLED` default OFF; `TYPESAFE_API_KEY` env on the Railway `data-plane` service (the operator sets it). Missing key or flag off = no request and the columns are null.

## API facts (from TypeSafe's docs, 2026-10-07)

- `POST https://api.typesafe.ai/v1/systemone`, header `Authorization: Bearer <key>`, body `{ model: "jev-latest", state, questions: { <id>: { type, instructions, criteria } } }`. Many questions over one `state` go in one request and run in parallel.
- Answers: Choice `{ choice, probabilities, confidence }`; Noul `{ noul }` (probability of yes); Score `{ score, legend, probabilities }`. The response names the versioned model (`jev-1.13.0` today) and `usage.input_tokens`.
- Price 0.042 USD per million input tokens, output free; 80 requests/s and 100k tokens/s, adjusting without notice; 429 on excess. English is its best language; some meme symbols are Chinese.

## Constraints

- Fail open for the recorder, never for anything else: a Jev failure leaves the columns null for that slot and is retried next cycle; it never fails a measure cycle or touches the board, shortlist, eligibility or any served route.
- A per-token / per-pair answer is written to its cache only after a valid response (an outage is never cached).
- Budget: request only for tokens and pairs not yet answered; batch per cycle. Expected well under 0.05 USD a day.
- Process: this repo's own (Opus build, Opus 5.5 audit). `FakePg` stays schema-aware if a table or column is added.

## Out of scope

No served route, no flag, score or ranking change on `/memes`, `/memes/shortlist` or `/memes/stocks`. No LLM. No fetch of post text, IPFS metadata or any new upstream besides TypeSafe.
