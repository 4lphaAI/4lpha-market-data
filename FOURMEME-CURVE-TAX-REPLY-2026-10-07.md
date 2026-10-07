# Four.meme curve tax: data-plane build reply (2026-10-07)

Spec: `FOURMEME-CURVE-PAPER-SPEC.md` Revision 1.2, section 5 and the data-plane gates (G0a, G0b). Worktree `D:\4lphaDATA-wt-fourmeme-curve`, branch `fourmeme-curve-tax` from master `ae08da7`, commit `e1ada70`. Not merged, not pushed, not deployed.

## 1. Spec item -> file:line

| Spec | Where |
|---|---|
| 5.1 `FourMemeTemplate.curve` | `src/query/fourmemeTax.ts:43` (field), `:53` `tax9-7330` true, `:60` `plain-4686` true, the other seven false |
| 5.1 selection: Four.meme rows read this cycle on `pancake-v2` or `fourmeme-bonding` | `src/jobs/memeVenues.ts:231-234` |
| 5.1 rate items: a curve row joins only with a curve-proven template (and only when due, F15) | `src/jobs/memeVenues.ts:266-272` |
| 5.1 publish: unproven / unread curve template -> `tax: null`; curve row always `pool: null` | `src/jobs/memeVenues.ts:286-300` |
| 5.1 graduated rows byte-identical | `src/jobs/memeVenues.ts:301-309` (unchanged code path) |
| 5.1 docs | header `src/jobs/memeVenues.ts:21-39`; `src/query/memeClassify.ts:211-215` |
| 5.1 proof tool (curve mode) | `scripts/fourmeme-tax-evidence.ts:9`, `:22-31` (criteria), `:223-319` (`readCurveFacts`, `judgeCurve`, `proveCurve`), `:361-366` (dispatch) |
| 5.2 `funds` / `maxFunds` on `FourMemeState` | `src/query/eligibility.ts:192-198` (type), `:361-362` (words 9 and 10), `:101` comment; `readFourMemeOn` exported for the test at `:345` |
| 5.2 every path carries them | no code: `decideEligibility` and `listVenueFrom` / `withListVenue` already pass the whole `fourmeme.state` |
| 5.4 / F15 constants | `src/jobs/memeVenues.ts:70` (`CURVE_RATES_REFRESH_MS` 300 000), `:72` (`CURVE_RATES_MAX_AGE_MS` 600 000) |
| 5.4 rates due | `curveRatesDue`, `src/jobs/memeVenues.ts:105-107` |
| 5.4 carry (never across a venue change) | `carrySource`, `src/jobs/memeVenues.ts:237-240`; carry decision `:293-297` |
| 5.4 retry: `fourMemeTaxPending` extended, checked before the quiet/dead tier | `src/jobs/memeVenues.ts:117-121`, `refreshAfterMs` `:100` |
| 5.4 identity budget ordered graduated first | `src/jobs/memeVenues.ts:246-251` |
| 5.5 tests | `test/memeVenues.test.ts:207` (replaces the old ":207" test), `:239`, `:256`, `:282`, `:297`; `test/fourmemeTax.test.ts:53`; `test/eligibility.test.ts:138` (+ fixture `funds`/`maxFunds` at `:51-52`) |

## 2. Gate G0a (`tax9-7330`), PASSED

`node --import tsx scripts/fourmeme-tax-evidence.ts curve <token> <hashes...>`, receipts from `bsc-dataseed.bnbchain.org` (publicnode refuses old receipts). Each line: one TokenManager2 trade in the tx, `fee = floor(cost / 100)`, tax leg TokenManager2 -> token equal to `floor(cost x rate / 100)` to the wei, quote in/out of TokenManager2 exact.

- `0xcd425e5125976114ba1e24f986a9073c169fffff`, creator type 9, clone of `0x7330d886...5c94`, quote BNCB, rates 1/1:
  - buy `0xeaaf3ff2fae2c3c477dd910d147c76952163b4d4a22f3b230fec4173985d7872` (cost 1310319736079108019, fee 13103197360791080, tax 13103197360791080 EXACT, in 1336526130800690179 = cost+fee+tax)
  - sell `0x84bd64d3af91804d90f463371bf11dde31eee78e449609d554eb7178ff017a8b` (cost 162757801559926522966, tax 1627578015599265229 EXACT, to seller 159502645528727992508 = cost-fee-tax)
  - S3's sell `0xbded1599...aed3` returned no verdict against this token (the cause was not checked: either its single TokenManager2 trade is another token or it has several, or its receipt was not served); not needed, the sell above is proven instead.
- `0x6e97f1c3499fe4d30c5b8a656020904d9681ffff`, creator type 9, same clone, quote HOODB (`0xa394dcea...7c65`), rates 3/3:
  - buy `0xa5e34102da0d8ce469965e3b827245f900a2ea1ce1e35ada8a5615a72f70a23d` (tax 9999619394825893 = floor(333320646494196464 x 3 / 100) EXACT)
  - sell `0x7a3a920a5af4fea01bce5f5c60504b8798707397ae6c6e1e88809f223f097b6b` (same cost, tax EXACT, to seller 319987820634428607 = cost-fee-tax)

## 3. Gate G0b (`plain-4686`), PASSED at the raised floor

Floor: at least 3 tokens, 2 quote stocks, 6 trades both sides, no TokenManager2 -> token quote Transfer, quote movement `cost + fee` in (buy) / `cost - fee` to the seller (sell) to the wei, `fee = floor(cost / 100)`. Met with 3 tokens, 3 quote stocks, 11 proven trades (8 buys, 3 sells). Every token printed creator type 0, code `proxy:0x46862924e2a229170ebd065e24a0da72af58a986`, `feeRateBuy`/`feeRateSell` revert. All three quotes carry the bStock issuer admin role (`DEFAULT_ADMIN_ROLE` member 0 = `0x45e35Fe982F3869221b222Abea372fA97AA7679d`, read on chain).

| Token | Quote | Proven buys | Proven sells |
|---|---|---|---|
| `0x2869612d04f402ef4037420a930c25fa7cfa4444` | BNCB `0x4902...ee3f` | `0xfefa491ddea22a30f67d064c0de59e6c637324dbfc088b4b3ed2ffc5b4f335a0`, `0x5e22ced75bdf7afa3d0e752ffd0036448802f6439ada71bcb3b4271a328c6d3c` | `0x4af5634c0a492e25fc6ddffe510b467eb100da3a507717721ae6574e7838b634` |
| `0xfb87d02a268de24bd651243f4843db03a6b24444` | SPCXB `0xbe9d...03e1` | `0x8f03cbc49944b5911ddc76dad431cc20d4baea8ac694bb7bb5243178f5d36dd9`, `0x482e2ba20e0bd46b1d1cf3019dd064d044a3625615a2bf5be82f885a169b4b5a`, `0xf82568017d7dc41f2f224bcea470de0819da8057c709719248c69a4a7e5ca789` | `0x4fb81b629f39c7ab5237efaf0faa16e8f9d89e2233578ea5e05552cfa6e38d67` |
| `0x1209350e9cdc9eccdcb9e00f1cc16b48b3544444` | NVDAB `0x02fc...7436` | `0xd56433d6b058b06f32b6761e6c903e1435c4546abce553d9a3d8ae589cb658fb`, `0xae8733f10383482ec8472baf3f525257daba534b053bab3c4e109dbef70e3690`, `0x9b571eb232773d57553938ef939595dc316bf9c98a833305dd190d907a91b41e` | `0xb1021aa018e9ec921b753b6ea7e74929bddfcc29d15aa135aa875d6a870e9bdf` |

Example lines: buy `0xfefa...35a0` cost 117677529834644335724, fee 1176775298346443357, into TokenManager2 118854305132990779081 = cost + fee, out 1176775298346443357 = fee (split over two fee recipients), no tax leg. Sell `0x4af5...b634` cost 38548423713496819415, out of TokenManager2 = cost, to seller 38162939476361851221 = cost - fee.

One rejection, recorded: sell `0xd53b37b54a5ba7bdf065d54a00f7120488675b03f36a4213433f3f31f7e0c9b7` (SPCXB token) moved exactly `cost` out of TokenManager2 with no tax leg, but nothing to the event's `account` (the proceeds went to another address), so the strict `to seller` check failed and the trade is not counted. No proven trade shows a shortfall.

How the candidates were found (read-only): the step-0 BNCB set; then the step-0 board census (`fm_measure_tokens.json`, 8 461 tokens) filtered to `...4444` addresses on a non-BNCB quote (17), classified on chain (`_tokenInfos` creator type, `eth_getCode`): 6 are `plain-4686`, 3 of them with funds above 0. Their curve trades were located with `eth_getLogs` on TokenManager2 (`TokenPurchase`/`TokenSale`, token matched locally) from their creation block, through `bsc.api.pocket.network` (500-block ranges; publicnode serves only about the last 10 000 blocks of logs and refuses older ranges as "archive", 1rpc.io hit its daily cap). USDT- and FORM-quoted `plain-4686` tokens exist and trade more, but were not counted: they are not quote stocks.

## 4. Readings of ambiguous points

- **`fourMemeTaxPending` for curve rows** (5.4 "whose template is curve-proven and whose identity is unread, whose tax is null, or whose last read failed while its rates were due"): read as identity unread, OR (template curve-proven AND (tax null OR rates were due at the last venue read and no answer landed)). "Due and not answered" is `checkedAt - fourmemeTaxReadAt >= 5 min` on the stored entry, which is true only when the last due read failed. A curve-proven row whose rates answered out of range (tax null, answered) is therefore re-read for its venue each cycle; its rates still wait the 5 minutes.
- **Carry boundary**: rates due at `>= 300 000 ms`; a carried tax kept while `checkedAt - fourmemeTaxReadAt < 600 000 ms`, so at exactly 10 min with no answer the row publishes `null` (spec test 9:59 / 10:00).
- **Ages are measured at the venue read** (`checkedAt`, equal to the cycle's `now` for rows read this cycle). A row whose venue is not re-read in a cycle keeps its cached entry untouched, as today.
- **Plain templates and the cache**: `plain-4686` curve rows go through the same 5-min / carry rule (their "read" costs no RPC); no separate path.
- **The curve-mode CLI** takes either `[blocks]` (the existing trailing Transfer-log scan) or explicit tx hashes, so the hashes above re-prove with one command each.
- **`readFourMemeOn` exported for tests** (precedent: the "Exported for tests" helpers in `fourmemeTax.ts`); the test feeds it a viem-encoded `getTokenInfo` answer whose words 9 and 10 differ and exceed 2^53.

## 5. Tests

- Baseline (master `ae08da7` in this worktree): tests 1015 / pass 1015 / fail 0 / skipped 0.
- After: tests 1021 / pass 1021 / fail 0 / skipped 0 (+1 replaced, +4 new in `memeVenues.test.ts`, +1 `eligibility.test.ts`, +1 `fourmemeTax.test.ts`).
- Touched suites (`memeVenues`, `fourmemeTax`, `eligibility`, `fourmemeTaxReaders`, `memeBoard`): tests 141 / pass 141 / fail 0 / skipped 0.
- `npx tsc --noEmit`: clean.
- FakePg: no column added (`memes:venues` is one jsonb snapshot; the new data is a field inside it), so FakePg needs no change.

## 6. Mutations (spec 5.5; cp backup, edit, run, cp restore; all killed)

| Mutation | Result | Killed by |
|---|---|---|
| `curve: true` on a third template (`tax9-2812`) | KILLED (2) | `fourmemeTax` exact curve set; `memeVenues` curve publish test |
| curve `pool: null` override removed (`pool: read.pool`) | KILLED (1) | `memeVenues` curve publish test (non-zero `pair()` fixture) |
| `funds` read from word 10 | KILLED (1) | `eligibility` words 9 and 10 test |
| 5-min cadence set to 0 | KILLED (1) | rates cache test (4 min 59 s: no call) |
| carry kept past 10 min (limit doubled) | KILLED (1) | carry test (10 min -> null) |
| a failed read publishing `null` at once | KILLED (2) | rates cache and carry tests |
| same, only on due rows | KILLED (1) | carry test |
| `fourMemeTaxPending` left graduated-only | KILLED (1) | carry test ("due next cycle, also when quiet") |
| identity order removed | KILLED (1) | identity order test |

## 7. Deploy order and operator checks owed

- Either order is safe (spec 5.6): before this deploys, curve rows publish `tax: null` and the lane refuses them; before the lane ships, its old screen refuses them.
- After deploy, eligibility verdicts cached before it (30 s eligible TTL, validator checks only `eligible`/`reason`) are served without `funds`/`maxFunds` for up to 30 s; the lane refuses those as `meme-veto:curve-funds` (5.3).
- First cycles after deploy: about 204 curve rows need identity reads (100 per cycle, graduated first), so curve taxes converge over about 3 cycles; identities persist in `memes:venues`.
- Operator checks still owed after deploy: **G0c** (`/memes?launchpad=fourmeme` curve rows of the proven templates show `tax` set and `pool: null`; `/eligibility` shows `fourmeme.funds`/`maxFunds` matching `getTokenInfo` words 9 and 10) and **G0d** (flicker count with `scripts/fourmeme-tax-check.ts`, once a minute for 10 minutes after warm-up; the script already tallies every Four.meme board row by venue, template id and tax, so `fourmeme-bonding tax9-7330 tax null` and `fourmeme-bonding plain-4686 tax null` are the counts to watch; it runs real board cycles locally and needs the operator's env). Downstream readers (`memeQuery.ts:655`, `memeClassify.ts:487`, `memeBoard.ts:249`) only pass `tax` through; nothing infers graduation from a set tax. The board cycle (6.6 s today) should be measured before and after, as 5.4 asks of the plane's review.
- The data-plane `CLAUDE.md` (gitignored, in the main checkout) still says curve rows are `null` in its Four.Meme tax bullet; not edited here (outside the worktree). Suggested line: "Curve rows carry a tax for curve-proven templates only (`tax9-7330`, `plain-4686`, curve proofs in `FOURMEME-CURVE-TAX-REPLY-2026-10-07.md`), rates every 5 min, carried under 10 min, `pool: null`; `/eligibility` Four.meme block carries `funds`/`maxFunds`."
- Nothing was signed or sent; all chain access was `eth_call`, `eth_getCode`, `eth_getLogs`, `eth_getTransactionReceipt` and block headers on public RPC.
