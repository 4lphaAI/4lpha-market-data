# Raw facts for the DevEx report (NOT the report)

Facts only, each with where it comes from. The organisers do not accept AI-written reports, so the
report itself is the operator's to write. This file follows the form's sections 1 to 5:
onboarding, documentation, API pitfalls, AI stack, tokenized-stock specifics. Sections 6
(redesign) and 7 (features we want) are opinion and are left to the operator; the facts below
are what those sections can point to.

All times are UTC unless marked. "Measured" means we ran it. "Read" means we read it on a page
and did not test it.

Sources: `DEVEX-NOTES.md` (IDs such as ONBOARD-1), `TOKENIZED-STOCKS-RESEARCH-2026-09-17.md` (§),
`TRADFI-AGGREGATOR-REPLY-2026-09-23.md` (A1–A5), `TRADFI-AGGREGATOR-REPLY-B-2026-09-23.md` (B2),
`POOLLESS-FEATURES-C1-2026-09-23.md` (C1), execution `FINDINGS.md` (bt), execution
`MD here/TRADFI-AI-TRADE-V2-EVIDENCE.md` (V2-EVIDENCE), and the Claude Code session transcripts
of 2026-09-16 for exact times ("transcript").

Pages cited below:
- Auth: https://web3.binance.com/en/dev-docs/authentication
- Agent Native: https://web3.binance.com/en/dev-docs/agent-native/overview
- RWA Data: https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/rwa-data
- Market Data: https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/general-data
- Trading API: https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/trading-api

---

## 1. Onboarding

### Part A: keyless, up to the first signed call (2026-09-16)

| Time | What happened | Source |
|---|---|---|
| 13:49 | Opened the hackathon Resources tab and followed its links into the docs. | transcript |
| 13:51 | Read the RWA Data page. The rendered page was fine. | transcript |
| 13:53 | Claude Code's WebFetch tool read `llms-full.txt` with no trouble. | transcript |
| ~14:09 | Created the key on the dev portal. The form has a b402 checkbox and does not say what it grants; the operator had to stop and ask what b402 was. Left it off to keep the key read-only. | transcript |
| 14:15 | Key and secret in the data plane's `.env`. | transcript |
| 14:26 | `curl -s …/llms.txt`, exactly as the Agent Native quick start says: `HTTP 202`, 0 bytes, `x-amzn-waf-action: challenge`. Same with a browser User-Agent. | ONBOARD-1 |
| 14:29:22 | First signed call, `GET /build/api/v1/dex/market/rwa/platforms`: `HTTP 200 code 0` in 304 ms. The HMAC signature worked first time. | OK-4 |

- **Docs opened → first successful call: about 40 minutes.** Key created → first call: about
  20 minutes. Not all of the 40 minutes was friction; part of it was reading the brief and
  deciding what to build.
- The one thing that failed before the key was reading the docs from a script: `curl` of
  `llms.txt` got the WAF challenge, while WebFetch had read `llms-full.txt` half an hour earlier.
  We did not test whether the difference is the client or the IP.
- Found later, but they are keyless problems too:
  - `llms-full.txt` (426 KB) carries the "SDKs & Tools" document as raw React/MDX, and none of
    the RWA Data endpoints. (DOC-2)
  - The OpenAPI schema (65 paths, sidebar link "Download schema") sits behind the same WAF, so
    `curl` gets 202 and 0 bytes. (ONBOARD-14, found 09-17)
  - The MCP server says "Coming soon", with no install command and no repo. (ONBOARD-3)
  - There is no way to check a key without a signed call; the first real request is the test.
    (OK-24, 09-17)
- What was fine: the rendered pages. The auth page warns that the signed path needs the
  `/build` prefix, calling it the #1 cause of `40102`. It is right, and it saved us that error.

### Part B: with a key, up to the first on-chain trade (09-16 → 09-23)

| When | What happened | Source |
|---|---|---|
| 09-16 14:29 | Same probe run as the first call: `/price` with 100 addresses (the documented max) → bare `HTTP 414`, empty body. The real cap is about 80, set by a URL limit of about 4 KB. | PITFALL-7 |
| 09-16 14:30 | First rate ramp: 239 of 288 requests failed with `401 40103 "Duplicate request detected"` before a single 429 appeared. Reproduced with a burst of 5 parallel `/tokens`: 1 to 3 got through. Fix: a UUID in `X-OC-NONCE` on every request. The auth page calls the nonce optional; only the OpenAPI schema says the anti-replay key falls back to the signature. | PITFALL-5, DOC-13 |
| 09-16 14:31 | Rate limit measured: 5 rps per key, shared by all endpoints, not per endpoint as the auth page says. Rejection is `429 42900` with `Retry-After: 1`. | PITFALL-6 |
| 09-30 17:47–17:54 UTC | Rate limit raised; ceiling re-measured. `x-oc-ratelimit-limit` now 1200, the per-second cap is gone (40-request burst and 40 rps for 28 s all ok), and the binding limit is about 1 200 requests per 60 s per key, shared by all endpoints (~20 rps sustained; 18 rps for 100 s, 0 rejected). `429 42900` with `Retry-After` 1–10 s above it. The `remaining` header resets every second and does not show that window. | PITFALL-6 |
| 09-16 23:11 → 09-17 00:34, ICT (UTC+7) | Asked for a higher limit through the hackathon Telegram form. Reply: requests go to Binance in a daily batch, and "the rate limit is already 5 requests per second". No self-serve tier, no quota shown on the dev portal. The reply landed at 17:34 UTC. The operator had also said at 14:24 UTC that an increase was already requested, so 23:11 may be the Telegram message and not the first request; operator to confirm. | ONBOARD-12, transcript |
| 09-17 06:18 | First production boot on Railway. `401 40101`: the env var had been set from cmd.exe, which stored the literal text `$(grep …)` as the key. The `x-oc-blocked-by: AuthenticationFilter/40101` header pointed at config straight away. | OK-24 |
| 09-19 ~09:50 | First read-only `/aggregator/quote` calls, six bStocks. | §7 |
| 09-19 | First `quote-and-swap` (Flash) probe. The router and selector were not the ones we had read from a historical PLTRB swap on chain (wrapper `0xb300…028d`, selector `0x810c705b`); the API now returns router `0xB444…DA5` and selector `0xad43f73d`. The calldata is opaque, so a session key cannot safely call the router directly. We decided to put our own guard contract in front. | execution HANDOFF 09-19, V2-EVIDENCE |
| 09-19 → 09-23 | Guard contract, data-plane proxy, execution routing, reviews. Most of this was our own custody work, not API friction. | execution specs |
| 09-23 morning | Flash measured: `tx.gas` is 450,000 on every quote whatever the route (1 to 6 legs). No expiry field in the response. RFQ fills come as legs inside a normal `SWAP` route with `rfq: null`. Pool-less bStocks (PLTRB, LITEB) have a route only with RFQ on; with `enableRFQ=false` they get `40465 Path not found`. | DEVEX-NOTES 09-23, A4 |
| 09-23 | "No route" comes back as HTTP 200 with `code 40465` in the body. Our adapter read it as an outage until we fixed it. | A2 |
| 09-23, before 12:40 | Guard deployed (`0x16B2…9650`) and verified on BscScan (Exact Match). A zero-spend `eth_call` of 6 live quotes through it: 6 of 6 pass. | FINDINGS (bt) |
| **09-23 15:56** | **First real trade through the aggregator**: 5 USDT → 0.0052635 LITEB, tx `0x6871efbd…7769`. | FINDINGS (bt) G7 |

Where we got stuck, on the Binance side:
- **Nonce.** Needed in practice, documented as optional.
- **Rate limit.** Per key, not per endpoint. Measured 5 rps until the raise; on 09-30 re-measured at about 1 200 requests per 60 s (~20 rps), and the data plane is set to 18 rps, which covers about 15 of our AI trade agents. (A5, PITFALL-6)
- **Batch limit.** The documented 100 fails with a bare 414.
- **No route = HTTP 200 + 40465.** Looks like success at the HTTP layer.
- **Flash has no quote expiry, and `tx.gas` is a fixed 450,000.**
- **Opaque calldata, no published router or selector list.** Hard to allowlist from a session
  key, so we added a contract.

Where we got stuck, on our side (not the API's fault):
- The server's capability probe called the Flash client as a detached method. It threw before
  sending anything, so pool-less stocks never showed up until we read the data-plane log.
- A 28-slot schedule list filled up with pooled tokens, so pool-less stocks could not get in.
- Rows we had retired by hand kept an old session key and blocked the wallet.
- We misread "aggregator-first" once and had to rebuild route selection.

What worked first time:
- **Signing.** HMAC right on the first try. (OK-4)
- **`userWalletAddress`.** Accepts an unfunded address and a contract address, so read-only
  comparisons and quoting with the guard as taker both worked.
- **Latency.** Flash p50 136–160 ms from a local machine, 113–155 ms from Railway.
- **Fees.** `feeAmount` was `null` on 160 of 160 quotes. The Trading API page says it is only
  filled when a custom fee is set, which matches.

Numbers someone will ask for:
- Docs opened → first successful call: about 40 minutes (09-16 13:49 → 14:29:22).
- First signed call → first real trade: 7 days 1.5 hours (09-16 14:29 → 09-23 15:56), mostly
  spent on our guard and execution path.
- First aggregator quote → first real trade: about 4 days 6 hours (09-19 ~09:50 → 09-23 15:56).
- Cost of the first trade:
  - our platform fee, 0.05 USDT (1%);
  - gas, 1,004,975 units at 0.05 gwei = 0.0000502 BNB;
  - the relay (Altana, not Binance) priced the native cost at 0.1307 USDT, about 2.6% of a
    5 USDT buy.
- Careful with the gas comparison. The 1,004,975 covers the 7702 relay batch, our guard, the
  router and our fee transfer, not the router alone, so it does not prove 450,000 is too low
  for a plain wallet calling the router. What is solid: the same 450,000 on every route from
  1 to 6 legs, and 590k–1.25M from `estimateGas` on our guard path.

---

## 2. Documentation issues (page → where on it → what)

The Trading API rows were read on 2026-09-23 through a fetch tool, not a browser. Check the
exact wording in a browser before quoting it.

### Authentication
- **Headers table, `X-OC-NONCE`: listed as optional.** Without it, two requests in the same
  millisecond on the same path carry the same signature, and the second is rejected with
  `40103`. It should say "required for concurrent requests". (PITFALL-5)
- **Error table, `40103` = "Timestamp expired or replayed request".** The cause was
  concurrency, not the clock. (PITFALL-5)
- **Rate limits, "Per Endpoint: 5 RPS (default)".** Measured as one 5/s bucket per key across
  all endpoints: `/tokens` and `/platforms` at 5 rps each for 4 s got 20 of 40 through.
  (PITFALL-6) After the 09-30 raise the limit is a per-minute window (about 1 200 requests per
  60 s) and the docs page still says nothing about it.
- **Not documented anywhere:** the response headers `x-oc-ratelimit-limit`,
  `x-oc-ratelimit-remaining`, `x-oc-used-weight` and `x-oc-blocked-by`. The last one was the
  most useful header we got. (PITFALL-6, OK-24)
- **Credit:** the `/build` prefix warning is right and worth keeping. (OK-4)

### OpenAPI schema (sidebar → "Download schema")
- The only place that says the nonce "falls back to X-OC-SIGN if omitted". That one sentence
  explains PITFALL-5 and belongs on the auth page. (DOC-13)
- Behind the WAF: `curl` gets 202 and 0 bytes. (ONBOARD-14)

### Agent Native overview
- **Quick Start block:** `curl -s …/llms.txt` returns the WAF challenge (202, empty). (ONBOARD-1)
- **MCP:** "Coming soon", no install command, no repo. (ONBOARD-3)

### llms-full.txt
- The "SDKs & Tools" document is raw MDX (`import { Link, Typography, LanguageIcon } from
  "zudoku/components"`), so a model reading it gets JSX instead of package names. (DOC-2)
- No RWA Data endpoints (`/api/v1/dex/market/rwa/*`) anywhere in its 426 KB. (DOC-2)
- Its Trading section says Ondo "may be unavailable outside US market hours (error 40367);
  BStock similarly (40369)". We have never seen 40369: bStock quotes answered at 02:40 and
  04:30 ET on a weekday. Weekends not tested. (transcript 09-16, A4, DEVEX-NOTES 09-23)

### RWA Data
- **`/price`, `tokenContractAddresses`: "comma-separated, max 100 per request".** 100 gives
  `HTTP 414` with an empty, non-JSON body. 80 addresses (3,697-char URL) work, 90 (4,147) fail.
  (PITFALL-7)
- **`/tokens`, `volume24H`:** it is the underlying stock's volume. SPYB and SPYon both show about
  $44B, while NVDAB's pool did $1.68M that day. (QUIRK-15)
- **`/tokens`, `marketCap`:** the underlying company's. NVDAB and NVDAon both show about $5.16T.
  (QUIRK-25)
- **`/tokens`, `tokenPrice`:** it is NAV (reference × `tokenToShareRatio`), not a market price.
  `tokenPrice / referencePrice − 1` equals `ratio − 1` on every row, so a premium monitor built
  on those two fields measures the share ratio. (QUIRK-25)
- **`statusInfo`:** does not say that bStocks leave `marketStatus` null (it means "always open"),
  and does not define `overnight`, `UNSUPPORTED` or `ASSET_PAUSED`. We worked out that
  `UNSUPPORTED` means "not offered in this session" from how `nextOpenTime` clusters.
  (QUIRK-16, QUIRK-28)
- **`nextCloseTime` / `nextOpenTime`:** while `overnight`, close (07:55) comes before open
  (08:01). They mean "end of this session" and "start of the next one". Without a sentence
  saying so they read as swapped. (QUIRK-26)
- **`assetType`:** the enum is not listed. We only ever saw `1`. (QUIRK-10)
- **`/platforms` vs `/tokens`:** bStock `tickerCount 77` against 46 rows; Ondo 458 against 442.
  Nothing says which count is "listed" and which is "tradable". (QUIRK-9)
- Numbers (`decimals`, `tokenPrice`, `marketCap`) arrive as strings. Not wrong, just not stated.
  (QUIRK-8)

### Market Data, "Get Candles"
- The page does list the 7 values in order. It does not say `volume` is in USD, does not give the
  sort order (ascending), and does not say bars exist only where a trade happened. That last one
  matters: a pool-less token returns 2 to 22 candles over months. (QUIRK-17, §3)

### Trading API
- **`tx.gas` = "Gas limit estimate".** 450,000 on every Flash quote, from 1 to 6 legs. It behaves
  like a fixed limit, not an estimate. (DEVEX-NOTES 09-23, B2)
- **`/quote-and-swap`: no quote lifetime on the page, and no expiry field in the response**
  (the top-level keys are exactly `executionMode, routerResult, tx, rfq`). `/quote` gives its
  `quoteId` a "TTL ~30s", and nothing says whether that applies here. Maker RFQ quotes sit inside
  the calldata, so their real lifetime cannot be seen. (A4)
- **Errors:** the page has no error-code list. `40465 "LiquidMesh EVM quoteAndSwap error: Path
  not found"` is undocumented and comes with HTTP 200. (A2)
- **`/quote`: "Equity / RWA tokens always return RFQ".** On 09-19 all six bStocks we quoted came
  back `SWAP` via LiquidMesh, and none used the `PcsXRfq` leg the docs describe. On Flash, RFQ
  shows up as `Rfq …` legs inside a `SWAP` route, with top-level `rfq: null` on 160 of 160
  quotes. (§7, A4)
- **`priceImpactPercent` = "Estimated price impact percentage".** At $200k, NBISB came back at
  2.9x reference (+194%) and COINB at 4.3x (+331%) while this field said 0.57% and 0.79%. It
  cannot be used as a safety check. (§7)
- **Router and selector: not published.** Each call returns `approveTarget` /
  `dexContractAddress`, and that is all. The router and selector changed between a historical
  PLTRB swap on chain and 09-19, and there was nowhere to look it up. (V2-EVIDENCE, execution
  HANDOFF 09-19)
- **Rate limit:** not mentioned on this page. Flash draws on the same per-key bucket as
  RWA Data (5 rps until the raise, about 1 200 requests per 60 s after it). (A5, PITFALL-6)

---

## 3. API pitfalls

### Error messages that misled us
- `401 40103 "Duplicate request detected"` on concurrent requests. It reads like a clock problem;
  the real problem is a missing nonce. (PITFALL-5)
- `414` with an empty body from `/price` at the documented batch size. Nothing to parse: no
  `code`, no `msg`. (PITFALL-7)
- `HTTP 200` with `{"code":40465,"msg":"LiquidMesh EVM quoteAndSwap error: Path not
  found","data":null,"success":false}`. A client that checks the HTTP status first sees success;
  ours counted it as an outage. (A2)
- `"Insufficient liquidity"` once on LITEB at $10k, then 5 of 5 fine on retry. A temporary error
  that reads like a final answer. (§7)
- The good one: `x-oc-blocked-by: AuthenticationFilter/40101` (also `TimestampFilter/40103`,
  `RateLimitFilter/42900`) names the filter that said no. It turned a bad-key deploy into a
  two-minute fix. (OK-24)

### Edge cases that bit
- The same underlying's `referencePrice`, read 300 ms apart: 19.14 from `/underlying-market`,
  19.24 from `/tokens`. Separate caches. (OK-11)
- The aggregator does not refuse a bad fill; it prices it (the $200k case above). The caller has
  to compare `toTokenAmount` with `referencePrice` itself. (§7)
- Pool-less bStocks exist on Flash only with RFQ on. PLTRB and LITEB: 0 of 32 routes with
  `enableRFQ=false`. AMDB falls back to a thin Uniswap V4 pool, 144–162 bps worse on buys and
  245–264 bps worse on sells. (A4)
- `minReceiveAmount` is exactly `toTokenAmount × (1 − slippage)` on every quote, so it adds no
  information of its own. (A4, B2)
- `userWalletAddress` accepts an unfunded address and a contract. Useful to us, but the page
  should say so. (A4, B2)
- The bStock list keeps growing: 25 on 09-03, 46 by 09-17. Our execution plane had `=== 25` in a
  readiness check and stood its workers down for a few hours. Our bug, but it is an onboarding
  fact about tokenized stocks: nothing downstream may pin the list's size. (ONBOARD-27)

### Latency

| Call | From | Numbers | Source |
|---|---|---|---|
| RWA Data, at ≤ 5 rps | local, Vietnam (CloudFront HAN51) | p50 107–150 ms, p95 ~155–240 ms; first call 304 ms cold | PITFALL-6, OK-4 |
| `/rwa/tokens`, 488 rows in one call | local | 152 ms | QUIRK-8 |
| `/market/candles` | local | 140–240 ms, one 414 ms cold | §3 |
| `/aggregator/quote` | local | 120–1,250 ms | §7 |
| Flash `quote-and-swap` | local | p50 136 ms, p95 227, max 317 (192 quotes) | A4 |
| Flash `quote-and-swap` | local | p50 160 ms, p95 255, max 440 (60 quotes) | DEVEX-NOTES 09-23 |
| Flash `quote-and-swap` | Railway (`server-timing`) | 113–155 ms (6 quotes) | B2 |
| For comparison: PancakeSwap V3 QuoterV2 over public RPC | local | p50 216 ms, p95 819, max 9,103 | DEVEX-NOTES 09-23 |
| `binance-rwa` job cycle (1 call + 488 rows into Postgres) | Railway | 2.6 s | OK-24 |

---

## 4. AI stack (Wallet Skills, Agentic Wallet, CLI)

- **We did not use Wallet Skills, the Agentic Wallet or its CLI.** We also skipped the official
  SDK connectors (npm `@binance-web3/wallet`, PyPI, Maven): signing by hand is 6 lines, and the
  data plane already had a pattern for signed adapters. (ONBOARD-3)
- **What we read, and when:** 09-16, 13:51–13:53, the Agentic Wallet stock-trading use case, the
  Wallet Skills overview and the Agentic Wallet welcome page, all linked from the hackathon
  Resources tab. (transcript)
- **What those pages told us** (our reading on 09-16; check before quoting):
  - The stock-trading page shows chat-style examples ("Buy AAPL with 100 USDT") and needs the
    `binance-tokenized-securities-info` skill, but has no API calls, contract addresses or venues.
  - The Wallet Skills overview lists 8 skills in `binance/binance-skills-hub` (for example
    `binance-agentic-wallet`, `query-token-info`, `query-token-audit`,
    `binance-tokenized-securities-info`). It does not say how a skill is wired in (MCP, CLI,
    HTTP) or who holds the keys when a third-party agent uses it.
- **Why we did not use it: custody.** Our agents trade from the user's own EIP-7702 wallet
  through a scoped Altana session key (a per-token allowlist, caps, an expiry, revoke by the
  owner only). The Agentic Wallet is a different custody model; our reading on 09-16 was MPC keys
  with a QR login in the Binance app. Using it would have put a second custody path next to ours,
  for a shallow integration. We ruled out the Agentic Wallet special prize the same day.
  (transcript 09-16 13:56)
- **The AI tool we did use was our coding agent.** We built with Claude Code, and the
  agent-facing docs were where it struggled:
  - `llms.txt` behind a WAF challenge for `curl`;
  - `llms-full.txt` with raw MDX and no RWA endpoints;
  - the OpenAPI schema behind the same WAF;
  - MCP "coming soon".

  In practice the agent read the rendered pages through WebFetch or a browser. (ONBOARD-1,
  DOC-2, ONBOARD-14, ONBOARD-3)
- **b402:** a checkbox on the key form with no word on what it grants. We left it off. BNB Agent
  Studio's docs say its `altana` wallet provider does not support paid B402 selling.
  (transcript 09-16 14:09)
- **Open, operator's call:** right now this section can only say "we did not use it, and here is
  why". About an hour of read-only use would give firsthand notes: install from the Resources
  tab (`npx skills add binance/binance-skills-hub/skills/binance-web3/binance-agentic-wallet`),
  ask `query-token-info` and `binance-tokenized-securities-info` about NVDAB, LITEB and SPYB, and
  compare the answers with the RWA API.

---

## 5. Tokenized-stock specifics

### Liquidity depth (09-17, 00:00 ET) (§1)

| Issuer | Tokens on BSC | Any DEX pool | Pool ≥ $10k | Pool ≥ $100k | Total pool liquidity |
|---|---|---|---|---|---|
| bStocks | 46 | 35 | 21 | 16 | $13.4M |
| Ondo | 442 | 45 | 8 | 2 | $0.69M |
| xStocks | 808 deployed | 3 | 0 | 0 | $737 |

- Deepest bStock pools: NVDAB $2.73M, SPCXB $2.25M, GOOGLB $2.20M, QQQB $2.02M. The smallest
  above $10k is MUB at $22k.
- 25 of 46 bStocks have no venue at or above $10k, and 11 have no DEX pool at all. They still
  show `TRADING` and trade through the Binance aggregator's RFQ makers, which DEX indexers cannot
  see. (§1, C1, QUIRK-18)
- Those pool-less tokens barely trade on chain: PLTRB had 2 trades in 30 hours, and CBRSB's last
  trade was 55 hours old when we looked. Only AMDB trades often enough to fill 15-minute bars most
  of the time. (C1)
- Fee tiers are not one per pair: NVDAB's main Pancake pool is 0.25%, QQQB's is 0.01%, and
  QQQB's larger Uniswap pool is 0.3%. (QUIRK-22)
- Liquidity moves: NVDAB's Uniswap V3 pool went from $325k to $147k between 00:00 and 10:05 ET.
  (§7)
- xStocks: 808 addresses on BSC, $737 of liquidity in total, and the best "TSLAx/USDT" pair holds
  $9. On BSC they are a list, not a venue. (QUIRK-19)

### Price against size (slippage)

Aggregator `/quote` against `referencePrice`, 09-19 (§7):

| Token | Buy $1k | Buy−sell spread | $10k | $50k | $200k |
|---|---|---|---|---|---|
| PLTRB | +0.16% | 0.25% | +0.17% | +0.23% | insufficient liquidity |
| NBISB | +0.21% | 0.44% | +0.24% | +0.28% | +194% |
| COINB | +0.15% | 0.30% | +0.15% | +5.8% | +331% |
| MRVLB | +0.22% | 0.57% | +0.22% | +0.24% | insufficient liquidity |
| LITEB | +0.16% | 0.31% | +0.11% | +0.14% | insufficient liquidity |

- Flash against direct PancakeSwap V3, same pair and size fired together, 09-23 at 02:40 ET:
  Flash was as good or better on 59 of 60 quotes; the one exception was 0.1 bp worse. SPYB and
  NVDAB buys were within 2 bps at every size. $10k sells were 39–45 bps better on NVDAB, GOOGLB
  and TSLAB, and TSLAB was 17–40 bps better at every size. The edge came from venues a direct path
  cannot see (Pancake V4, Uniswap V4, Metric, Elfomofi, Tessera V, RFQ makers), not from a fee.
  (DEVEX-NOTES 09-23)
- Our first real fill: 5 USDT → LITEB at 949.9 USDT per LITEB, about +0.3% over a reference read
  earlier that day, inside our 1.5% limit. We did not record the quote at that moment, so we do
  not know the slippage against the quote. One $5 trade is not a sample. (FINDINGS (bt) G7)

### Outside US market hours
- **bStocks have no session.** All 46 show `openState: true`, `marketStatus: null` and null
  next open/close, at 00:00, 06:00 and 10:05 ET. Trades on chain carry on through the night
  (NVDAB 5-minute candles 00:30–04:35 UTC). (QUIRK-16, QUIRK-28, §4)
- **Ondo runs sessions, per asset.** At 00:00 ET: 264 of 442 `TRADING`, 177 `UNSUPPORTED`,
  1 `ASSET_PAUSED`. At 10:05 ET: 442 of 442. Four session classes, inferred from `nextOpenTime`:
  255 trade in every session, 9 overnight plus regular, 93 pre-market plus regular, 84 regular
  only. A list taken once a day is wrong for about 40% of Ondo for most of the day. (QUIRK-28, §4)
- **Ondo at the weekend:** after Fri 20:00 ET the Ondo pools stopped trading (SQQQon, GMEon and
  DISon flat for 265 minutes), and `referencePrice` stayed at Friday's close. The discounts held;
  nothing blew out. (§8.4, item 6)
- **bStocks through the aggregator at night:** it answered every time we asked on a weekday
  night. 60 of 60 at 02:40 ET; at 04:30–04:40 ET, 96 of 96 with RFQ on, including PLTRB and
  LITEB 32 of 32 through RFQ. llms-full.txt says bStocks may be unavailable outside US hours with
  error 40369; we never saw it. (DEVEX-NOTES 09-23, A4)
- **Not measured: bStocks at the weekend.** We have nothing yet on RFQ availability, or on pools
  against a reference frozen for about 2.5 days. That is the exact case the brief names. Measure
  on Sat 09-26 with `scripts/flash-rfq-probe.ts` and `scripts/flash-vs-amm.ts` (both read-only).

### On-chain price against reference price

bStock pools against reference × ratio, deepest pool ≥ $10k, in bps (§7):

| | n | min | p10 | p50 | p90 | max |
|---|---|---|---|---|---|---|
| bStocks, 00:00 ET | 21 | −62 | −30 | −7 | 9 | 90 |
| bStocks, 10:05 ET | 21 | −55 | −30 | −8 | 9 | 18 |

- Deep pools stay within ±30 bps round the clock (NVDAB −22, QQQB −16, GOOGLB −15, MSFTB −30).
  Readings of 50 bps or more come only from $23–37k pools (MUB, SNXXB).
- **24 hours at one-minute resolution** (09-17 14:58 → 09-18 14:21, 1,369 samples): 19 of 21
  bStocks had a median between −0.09% and +0.07%; QQQB −0.22%, NOKB −0.39%. (§8.2)
- **The Ondo "discount" is not a mispricing.** TLTon sits at −4.51% against NAV (median), GMEon
  −1.86%, SGOVon −1.43%, yet every pool prices one token as one share (±0.2%). The gap is exactly
  `tokenToShareRatio − 1`, i.e. reinvested dividends. Ondo shows the ratio in the wallet balance
  ("Scaled UI"), not in the price, and the RWA Data page mentions none of this. (§8.2)
- **Pool-less bStocks:** the last on-chain trade can sit far from reference: AMDB −318 bps,
  INTWB −197, IBMB −185, COINB +159, CBRSB −456 (55 hours old). Their live price is really the
  RFQ quote (about +0.15% at $1k), not the last trade. (C1, §7)
- **Pool against pool:** over 48 hours only QQQB (Uniswap 0.3% against Pancake 0.01%) ever
  cleared the round-trip fee, for 353 minutes and never by more than 0.07%. No arbitrage there.
  (§8.1, §8.4)
- **Fields that mislead a price-gap check:** `tokenPrice` is NAV, `volume24H` and `marketCap`
  belong to the underlying. See section 2. (QUIRK-15, QUIRK-25)

---

## Still open
1. **bStocks at the weekend** (Sat 09-26): RFQ availability, and pools against a frozen
   reference. Read-only, existing scripts.
2. **Section 4:** about an hour of read-only use of Wallet Skills, or write "not used" with the
   reasons above.
3. **Trading API wording:** read it in a browser before quoting (we read it through a fetch tool
   on 09-23).
4. **ONBOARD-12:** confirm when the rate-limit increase was first requested.
5. **Is the rate bucket per key or per IP?** Not tested; it needs a second key or a second host.
6. **Slippage on a real fill:** on the next trade, log the quote next to the fill.
