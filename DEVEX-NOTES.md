# Developer Experience notes — Binance Web3 API (Tokenized Stocks hackathon)

Raw material for the mandatory Developer Experience Report (25 % of the score).
Every entry is something actually hit while building, with the doc page it
contradicts or extends, and the number measured. Append as you go; do not
tidy — the operator writes the report from this.

Hackathon: https://www.bnbchain.org/en/hackathons/tokenized-stocks
Docs root: https://web3.binance.com/en/dev-docs/introduction
Probe script: `node --import tsx scripts/binance-rwa-probe.ts` (`--shape` for the
endpoint shapes only, `--rps 3,5,8 --secs 5` for the ramp, `--burst` / `--no-nonce`
to reproduce the failure modes below).

Legend — **DOC**: documentation error or gap · **PITFALL**: API behaviour that
bites · **QUIRK**: tokenized-stock-specific oddity · **ONBOARD**: onboarding
friction · **OK**: something that worked first time and deserves credit.

---

## 2026-09-16 — first contact, RWA Data endpoints, rate limits

### ONBOARD-1 · `curl llms.txt` from the docs' own quick start returns an empty HTTP 202
- Page: https://web3.binance.com/en/dev-docs/agent-native/overview (the
  "Quick Start" block literally says `curl -s https://web3.binance.com/en/dev-docs/llms.txt`).
- Measured: `HTTP/1.1 202 Accepted`, `Content-Length: 0`, header
  `x-amzn-waf-action: challenge`, `X-Cache: Error from cloudfront`. Same with a
  browser User-Agent. The file is behind an AWS WAF JavaScript challenge, so the
  one documented way for an LLM/agent to fetch it does not work from a script.
- Works only from a real browser (the challenge sets an `aws-waf-token` cookie).
- Impact: the "Agent Native" feature is unusable for the audience it is for.

### DOC-2 · `llms-full.txt` ships raw MDX/JSX, and the RWA Data endpoints are not in it
- Page: https://web3.binance.com/en/dev-docs/llms-full.txt (426 KB, 56 documents).
- The "SDKs & Tools" document is unrendered React source (`import { Link, Typography,
  LanguageIcon } from "zudoku/components"`, `export const CardLink = ...`) — an LLM
  reading it gets a component tree, not the package names.
- No document in the file covers `/api/v1/dex/market/rwa/*`. The RWA Data reference
  exists only as the rendered page
  https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/rwa-data.

### ONBOARD-3 · MCP server is "coming soon"; official connectors exist
- Page: https://web3.binance.com/en/dev-docs/agent-native/overview — MCP "Coming
  soon", no install command, no repo.
- Page: https://web3.binance.com/en/dev-docs/sdks-tools/overview — connectors:
  npm `@binance-web3/wallet` (https://github.com/binance/binance-web3-connector-js),
  PyPI `binance-web3-wallet`, Maven `io.github.binance:binance-web3-wallet`.
  Not adopted here: the plane already has its own signed-adapter pattern
  (`src/adapters/onchainos.ts`) and the signing scheme is 6 lines.

### OK-4 · Signature scheme worked first try
- Page: https://web3.binance.com/en/dev-docs/authentication.
- `base64(HMAC-SHA256(timestamp + METHOD + requestPath + body))` with the `/build`
  prefix inside `requestPath`, ISO-8601 ms timestamp, headers `X-OC-APIKEY`,
  `X-OC-TIMESTAMP`, `X-OC-SIGN`. First call `GET /build/api/v1/dex/market/rwa/platforms`
  → `HTTP 200 code 0` in 304 ms cold. The "#1 cause of 40102" warning about the
  prefix is accurate and worth its place.

### PITFALL-5 · Two identical requests in the same millisecond → `401 40103 "Duplicate request detected"`
- Page: https://web3.binance.com/en/dev-docs/authentication — `40103` is documented
  as "Timestamp expired or replayed request"; `X-OC-NONCE` is listed as *optional*.
- Measured: a burst of 5 parallel `GET /tokens` (same path, same ms timestamp, hence
  the same signature) gets 1–3 through and the rest rejected with
  `x-oc-blocked-by: TimestampFilter/40103`. 239 of 288 requests in the first ramp
  died this way before a single 429 was seen.
- Fix: send `X-OC-NONCE: <uuid>` on every request. With the nonce, zero duplicate
  rejections across 215 requests. The nonce is not part of the signed prehash.
- Why it matters: any batching client (Promise.all over a token list) trips this
  immediately, and the error reads like a clock problem, not a concurrency one.
  The header should be documented as *required* for concurrent use.

### PITFALL-6 · The 5 RPS limit is per **key**, shared across endpoints — not per endpoint
- Page: https://web3.binance.com/en/dev-docs/authentication — "Per Endpoint: 5 RPS (default)".
- Measured (staggered sends, nonce on):
  - `/tokens` alone: 3 rps → 15/15 ok; 5 rps → 25/25 ok; 6 rps → exactly 1 rejected
    per second; 8 rps → 3/s rejected; 12 rps → 7/s rejected. Hard ceiling of 5/s.
  - `/tokens` at 5 rps **and** `/platforms` at 5 rps concurrently for 4 s: 20 ok of 40
    (tokens 12/8, platforms 8/12). One shared bucket of 5/s for the key.
- Rejection: `HTTP 429`, body `{"code":42900,"msg":"Rate limit exceeded","data":""}`,
  `Retry-After: 1`, `x-oc-blocked-by: RateLimitFilter/42900`. The response headers
  `x-oc-ratelimit-limit: 5`, `x-oc-ratelimit-remaining`, `x-oc-used-weight` are
  present on 200s and also decrement across different endpoints (platforms → tokens
  → underlying-market read remaining 4, 3, 2). None of these headers are documented.
- Budget arithmetic for this plane: 5 rps = 300/min, well under the 1 200/60 s key
  limit, so the per-second bucket is the only one that binds. A rate-limit increase
  has been requested; re-run `--rps 5,8,12,20` after it lands and record the new ceiling here.
- Latency at ≤5 rps: p50 107–150 ms, p95 ~155–240 ms from a residential connection
  in Vietnam (CloudFront PoP HAN51). Comparable to OKX OnchainOS (~90–155 ms).

### PITFALL-7 · `/price` batch of 100 → bare `HTTP 414`, cap is really ~80 addresses
- Page: https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/rwa-data —
  `tokenContractAddresses`: "comma-separated, max 100 per request".
- Measured: 100 addresses → `HTTP 414` with an **empty non-JSON body** (no `code`,
  no `msg`). Scan: n=80 (URL 3 697 chars) → 200, 80 rows; n=90 (4 147 chars) → 414.
  The gateway's URL limit (~4 KB) is hit before the documented batch limit.
- Practical cap: 80 addresses per call (45 chars each incl. comma). A client that
  trusts "100" gets an error it cannot parse as an API error.

### QUIRK-8 · `/tokens` needs no pagination and already carries prices and status
- Measured: `GET /tokens?binanceChainId=56` → 488 rows in one 152 ms response,
  top-level keys `code, msg, data, timestamp, success` — no cursor, no page fields.
- Split: `ondo` 442, `bstock` 46. Row fields: `tokenContractAddress, platformId,
  assetType, tokenName, tokenSymbol, decimals, underlyingTicker, underlyingName,
  underlyingNameZh, tokenToShareRatio, tags, statusInfo{openState, marketStatus,
  reasonCode, reasonMsg, nextOpenTime, nextCloseTime}, tokenPrice, referencePrice,
  volume24H, marketCap, peRatioTTM`.
- So one call per cycle covers universe + premium/discount + halted flag for all
  488 tokens; `/price` is only needed for a faster price cadence on a subset.
  Numeric fields (`decimals`, `tokenPrice`, `marketCap`) arrive as **strings**.

### QUIRK-9 · Platform counts disagree between `/platforms` and `/tokens`
- `/platforms` says bstock `tickerCount 77`, `chainDistribution[56].tokenCount 77`;
  `/tokens?binanceChainId=56` returns 46 bstock rows. Ondo: 458 vs 442.
- Undocumented which set is "listed" vs "tradable"; needs the `tabId` / status
  semantics before the lane can claim a count. Open question for Binance.

### QUIRK-10 · Ondo symbol suffix is `on`, bStock suffix is `B`; `assetType` undocumented
- Symbols come as `AAPLon` / `AAPLB`, `TSLAon` / `TSLAB` — the same underlying is
  listed by both issuers, so dedupe by `underlyingTicker` (handoff §4) is required.
- `assetType: 1` on every row seen; the enum is not in the reference page.

### OK-11 · `/underlying-market` is the market-hours oracle the handoff wanted
- 119 ms; `statusInfo.marketStatus: "regular"`, `reasonCode: "TRADING"`,
  `nextOpenTime` / `nextCloseTime` in Unix ms; `marketData` adds `high52W`, `low52W`,
  `volumeShares24H`, `avgDailyVolume1Y`, `totalShares`, `turnoverRate`, `amplitude`.
  Replaces a hand-written US-hours calendar. Note the `referencePrice` here (19.14)
  differed from the `/tokens` row read 300 ms earlier (19.24) — separate caches.

---

## 2026-09-17 — rate-limit increase request

### ONBOARD-12 · Rate-limit increase goes through a Telegram form, answered the next day with "it is already 5 rps"
- Channel: BNB Chain hackathon Telegram (pinned "BNB HACK: TOKENIZED STOCKS — READ THIS FIRST"),
  form submitted 2026-09-16 23:11, reply 2026-09-17 00:34: requests are batched to
  the Binance team once a day; "the rate limit is already 5 requests per second btw".
- No self-serve tier, no per-key quota visible on the dev portal
  (https://web3.binance.com/en/dev-portal/project), no stated turnaround.
- Decision: **not needed for this plane.** Budget at a dense cadence — `/tokens`
  every 30 s (1 call, 488 rows) + `/price` for all 488 every 10 s (7 calls) +
  `/underlying-market` sweep every 30 min — is ~60 req/min ≈ 1 rps, 20 % of the
  ceiling, and it is the whole product's Binance load because consumers read only
  from the store. If the increase lands anyway, re-run the ramp and update PITFALL-6.
- What 5 rps *does* force in the design: one shared throttle across every Binance
  job (bucket is per key, PITFALL-6), sequential sends, nonce on every request.

## 2026-09-17 — research pass (pools, candles, trading hours)

### DOC-13 · `X-OC-NONCE` "falls back to X-OC-SIGN if omitted" — the root cause of PITFALL-5, documented only in the OpenAPI schema
- The rendered auth page calls the nonce optional. The schema
  (`/en/dev-docs/catalog/web3-wallet/api/rest-api/1.0.0/schema.json`, parameter description)
  says the anti-replay key falls back to the signature — so two same-ms requests with the same
  path *are* one request to the server. That sentence belongs on the authentication page.

### ONBOARD-14 · An OpenAPI 3 schema exists (65 paths) but is behind the same WAF challenge as llms.txt
- Linked from the sidebar as "Download schema"; `curl` gets `202` / 0 bytes. Readable only via
  a browser `fetch` on the docs origin. It is the best artefact they publish (enums, response
  shapes, Chinese `x-description-cn` fields) and the only place some semantics live (DOC-13,
  QUIRK-17).

### QUIRK-15 · `/rwa/tokens` `volume24H` is the **underlying stock's** volume, not the token's
- SPYB and SPYon both report ≈ $44B; QQQB/QQQon ≈ $25B; NVDAB $17.4B. Those are NYSE/Nasdaq
  figures. On-chain, NVDAB's pool did $1.68M in 24h and SPYon has no pool at all. A client
  ranking "most traded tokens" by this field ranks Wall Street, not BSC. Field is undocumented
  beyond its name.

### QUIRK-16 · `marketStatus` is `null` for every bStock; the session vocabulary is Ondo-only
- bStocks: `openState:true, marketStatus:null, nextOpenTime:null, nextCloseTime:null` on all 46,
  at 23:55 ET. Ondo: `marketStatus:"overnight"`, `reasonCode` ∈ `TRADING | UNSUPPORTED |
  ASSET_PAUSED`. None of `overnight`, `UNSUPPORTED` or the session boundaries are documented;
  `UNSUPPORTED` turned out to mean "asset not offered in the current session" (177 of 442 at
  night), inferred from `nextOpenTime` clustering (08:01 / 13:31 UTC), not from any page.

### QUIRK-17 · `/market/candles` rows are 7-element arrays, USD-denominated — schema says so, the rendered page does not make it obvious
- `[open, high, low, close, volumeUsd, timestampMs, tradeCount]`, ascending. Bars down to `1s`.
  Trade-derived: a token with no pool returns only the candles where a trade happened (ARQQon:
  22 five-minute candles in three months; MMMx: 2 ever). Good — but a charting client that
  expects a dense series will draw gaps.

### QUIRK-18 · The two on-chain venues DexScreener cannot see
- 11 of 46 bStocks have no DEX pool anywhere on BSC yet report `TRADING` and real volume; they
  trade via Binance's LiquidMesh RFQ inside Binance Wallet. 434 of 442 Ondo tokens likewise
  trade only through Ondo mint/redeem. "Is it tradable" has three different answers (AMM pool /
  bStock RFQ / Ondo RFQ) and only the first is visible to a generic DEX indexer.

### QUIRK-19 · xStocks: 808 BSC deployments, ~$700 of total BSC liquidity
- xstocks.com lists 811 products; 808 carry a BSC address (same address on every EVM chain).
  DexScreener finds 3 BSC pools, best $1k, the "TSLAx/USDT" Pancake v2 pair holds $9. The
  hackathon brief names xStocks alongside bStocks/Ondo; on BSC it is not a venue.

### OK-20 · `/platforms` `chainDistribution` and `/rwa/tokens?binanceChainId=` make the cross-chain picture cheap
- Ondo: 457 tokens on Ethereum, 458 on BSC, 451 on Solana (`CT_501`) — three calls, no auth
  beyond the key, ~150 ms each.

## 2026-09-17 — build pass (adapter + jobs)

### OK-21 · The full adapter + job went live against the API on the first run
- `binance-rwa` cycle: 538 ms for 488 rows (46 bstock, 442 ondo), 0 rows dropped by the
  normalizer, 488 token prices merged. Nonce + one shared 5 rps bucket: no 40103, no 429.
- What the build had to encode that the docs did not say: `/build` in the signed path
  (documented, good), nonce falling back to the signature (schema only), the bucket
  being per key (measured), the `/price` 414 at ~80 (measured), `volume24H` being the
  underlying's volume (measured). Five facts, one of them on the page.

### QUIRK-22 · Pancake v3 fee tiers on stock pools are all over the map; Uniswap v3 pools read the same ABI
- Read `fee()` on chain for every v3 pool the sweep found: NVDAB's main Pancake pool
  is **2500** (0.25%), its second $489k pool **10000** (1%), QQQB's Pancake pool **100**
  (0.01%) while its larger Uniswap v3/USDC pool is **3000** (0.3%). A router that
  assumes one fee tier per pair will quote the wrong pool. The tier has to travel
  with the pool address, which is why `Venue.feeTier` comes from the chain and is
  never defaulted.
- Uniswap v3 pools on BSC answered the Pancake v3 `fee()` selector unchanged, so
  one ABI covers both venues.

### QUIRK-23 · DexScreener `token-pairs` is ~300 ms per call, not the 210 ms rate floor
- 100 tokens sequentially: 31.7 s. The 300/min limit is not the binding constraint
  from a residential connection; per-call latency is. Sweep lowered to 75 tokens per
  60 s cycle. Not a Binance item, but it is what the venue data costs.

### OK-24 · Production numbers from Railway (2026-09-17 06:18 UTC, first boot with the key)
- `binance-rwa`: 2.6 s per cycle end to end (one signed `/tokens` call + 488 rows written
  to Postgres), 0 failures. `stock-venues`: 6.3 s per 75-token cycle from Railway against
  31.7 s per 100 locally — DexScreener is ~5× faster from Railway's egress, the opposite
  of the `eth_getLogs` finding for `flap-launches`. Lanes served: `bstocks` 46 rows
  (from 25 static), `ondo` 442 rows, 264 open during the overnight session.
- First error seen in production was `401 40101 (AuthenticationFilter/40101)`: the
  variables had been set from `cmd.exe`, which passed the literal text
  `$(grep ...)` as the key. The `x-oc-blocked-by` header the adapter surfaces
  named the filter, which is what made it a config error rather than a code hunt.
  Onboarding note for the report: the API gives no way to validate a key without a
  signed call, so the first real request is the test.

## 2026-09-17 — TradFi work order (eligibility rule 5, /tokens rows)

### QUIRK-25 · `/rwa/tokens` `marketCap` is the underlying's too, and `tokenPrice` is NAV
- NVDAB and NVDAon both report `marketCap` ≈ $5.16T — NVIDIA's — and ARQQon $330M,
  Arqit's. Nothing on the page says whose cap it is. Renamed internally to
  `underlyingMarketCapUsd` beside `underlyingVolume24hUsd` (QUIRK-15).
- `tokenPrice` is the token's NAV, not a pool price: the naive premium
  `tokenPrice / referencePrice − 1` equals `tokenToShareRatio − 1` on every row
  (EEMon 137 bps ↔ ratio 1.0137, NVDAB 8 bps ↔ 1.00078 — the execution plane's
  finding). A premium/discount monitor built on these two fields alone measures the
  share ratio. The pool-vs-reference spread needs a venue price; the plane now
  publishes `premiumBps` from the deepest venue and keeps the NAV number as
  `navPremiumBps`.

### QUIRK-26 · Ondo session fields: `UNSUPPORTED` vs `ASSET_PAUSED`, and `nextCloseMs < nextOpenMs` while `overnight`
- `openState:false, reasonCode:UNSUPPORTED` on 177 of 442 rows overnight means "this
  asset is not offered in the current session", not a halt — it flips to `TRADING`
  at 08:01 or 13:31 UTC by asset class. `ASSET_PAUSED` (1 row) is the real halt.
  The gate maps them to `rwa_unsupported` and `rwa_halted` respectively.
- While `overnight`, a TRADING row carries `nextCloseTime` (07:55 UTC) *earlier*
  than `nextOpenTime` (08:01 UTC): "next close" is the end of the current session,
  "next open" the start of the following one. Read as a pair they describe the
  6-minute gap; read as "opens at X, closes at Y" they look inverted.

### ONBOARD-27 · Readiness incident on the execution plane: `=== 25` bStocks
- The execution plane's readiness check required exactly the 25 static bStocks;
  when this plane's lane grew to 46 after the RWA union deployed (06:18 UTC) the
  trade worker stood down for a few hours until hotfix `afcfb65` made it `>= 25`.
  Not a Binance fault, but a tokenized-stock onboarding fact: the bStock list grows
  weekly (25 pinned 2026-09-03 → 46 by 2026-09-17), so nothing downstream may pin
  its size.

### QUIRK-28 · One endpoint, two clocks: bStocks and Ondo answer `statusInfo` under different models, and the buyable Ondo set breathes with the session
- Same call, `GET /rwa/tokens?binanceChainId=56`, same `statusInfo` shape. bStocks fill it
  as `{openState:true, marketStatus:null, reasonCode:"TRADING", nextOpenTime:null,
  nextCloseTime:null}` — every row, every hour we looked (00:00 ET, 06:00, 10:05) — i.e.
  no session concept at all, 24/7. Ondo fills the same fields as a session machine:
  `marketStatus` ∈ `overnight | regular | …`, `nextOpenTime`/`nextCloseTime` set, and
  `openState` flipping per asset class.
- Measured: overnight (00:00 ET) **264 of 442** Ondo rows `TRADING`, **177**
  `openState:false / UNSUPPORTED`, 1 `ASSET_PAUSED`; regular session (10:05 ET)
  **442 of 442** `TRADING`. So "which Ondo tokens can I buy" is not a list, it is a
  function of the clock — 255 all-session, 9 overnight+regular, 93 pre-market+regular,
  84 regular-only (inferred from `nextOpenTime` clustering; no page documents the
  classes). A client that snapshots the list once a day gets it wrong for ~40% of Ondo
  for most of the day.
- Nothing on the RWA Data page says the two issuers use the field differently, that
  `marketStatus` can be `null`, or what `null` means (it means "always open", not
  "unknown"). We learned it by diffing the same call at three times of day.
- Consequence built here: the eligibility gate re-reads the live snapshot on every call
  and never caches a stock verdict (`rwa_unsupported` overnight → `binance_rwa` at 08:01
  or 13:31 UTC for the same address); the execution plane must not pin the "open"
  set at startup.

## Open items to measure next
- Rate ceiling after the limit increase is granted (re-run the ramp, update PITFALL-6).
- Whether the 5 rps bucket is per key or per IP (needs a second key or a second host).
- `/tokens` `tabId` semantics and the 77-vs-46 bstock discrepancy (QUIRK-9).
- ~~Market API candles for stock tokens~~ measured 2026-09-17 (QUIRK-17): exists, plane chain already serves stocks, not adopting now.
- `/quote` read-only cross-check for Ondo (RFQ-only) vs bStock vs xStock routing.
- ~~xStocks~~ measured 2026-09-17 (QUIRK-19): 808 BSC addresses, no liquidity — carry as an address map only.
