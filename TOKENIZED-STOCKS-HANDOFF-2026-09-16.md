# Data-plane handoff: Binance Web3 API (RWA Data) for the Tokenized Stocks hackathon

Date: 2026-09-16
From: Fable (execution-plane session, `D:\4lpha-execution`)
Target repository: `D:\4lphaDATA-marketplace`
Status: **handoff for scoping → spec → build. Nothing has been implemented in this repo by the originating session.**

## 1. Why now

Operator ruling 2026-09-16: priority #1 is the **BNB Hack: Tokenized Stocks Edition**
(https://www.bnbchain.org/en/hackathons/tokenized-stocks — build Sep 16 → Oct 11 12:00 UTC,
judging Oct 12–23, $20k). The TermiX Quant grid agent is on hold pending TermiX approval.
The operator wants to start on this repo first: ingest the Binance Web3 API so the
execution plane's trade agent can become a tokenized-stocks agent without adding a
second source of chain truth. Execution-plane CLAUDE.md was updated the same day.

Main-track rules that shape this work: bStocks / Ondo / xStocks central, spot only,
BSC mainnet, cross-asset allowed. Scoring: 30 % technical, 25 % creativity,
**25 % a human-written Developer Experience Report (mandatory — keep notes of every
onboarding pain, doc error with page reference, API pitfall, and tokenized-stock
quirk you hit while building; the operator writes the report from them)**, 20 % UX.
Special prize "BNB Agent Studio" is IN scope later (Studio v2 has an `altana` wallet
provider; the discovery client in `src/studio/` is built, default OFF). Special
prize "Agentic Wallet / Wallet Skills" is OUT (Binance MPC custody — parallel path).

## 2. Credentials — already present, not yet wired

The operator created a Binance Web3 API key on 2026-09-16 (dev portal
`https://web3.binance.com/en/dev-portal/project`) with permissions Trade,
Transaction, Wallet, Market, DeFi; **B402 Payments deliberately unticked** (ruled
2026-09-16: not needed, keep the key minimal; a second key can be made later).

The pair sits in this repo's `.env` (gitignored, `.env*` rule) under
**`Binance_wallet_API`** and **`Binance_wallet_secret`**. `src/config/env.ts` does
not read them yet. Decide the canonical names (suggest `BINANCE_WEB3_API_KEY` /
`BINANCE_WEB3_SECRET_KEY`, matching the `OKX_*` convention); either rename in `.env`
with the operator's go or read both. Add them to `.env.example` as blanks. Never
log or echo the secret; never copy it to the execution plane.

Auth scheme (docs: https://web3.binance.com/en/dev-docs/authentication):
HMAC-SHA256 over `timestamp + method + path + body`, base64, headers
`X-OC-APIKEY`, `X-OC-TIMESTAMP` (ISO-8601 with ms), `X-OC-SIGN`. **The signed path
must include the `/build` prefix** (`/build/api/v1/...`) — the docs call omitting it
the #1 cause of `40102 Invalid signature`. Rate limits: 1 200 req/60 s per key and
per IP, 5 RPS per endpoint default. Pattern to copy: `src/adapters/onchainos.ts`
(signed OKX adapter, credential presence check, sanitized errors).

Note the existing `src/adapters/binanceWeb3.ts` uses **undocumented public `bapi`**
endpoints for the Alpha list; the new signed API is a different adapter. Keep them
separate (new file, e.g. `src/adapters/binanceRwa.ts`) so the coins lane is untouched.

## 3. What to ingest, in priority order

Base: `https://web3.binance.com/build/api/v1/dex/market/rwa/…`
(docs: https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/rwa-data;
full index for the LLM: https://web3.binance.com/en/dev-docs/llms-full.txt).

1. **`/tokens`** (params `binanceChainId=56`, `platformId`, `tabId`) → fields
   `tokenContractAddress`, `tokenSymbol`, `underlyingTicker`, `platformId`
   (`bstock` | `ondo` — **xStocks is NOT a platform in this API**), `decimals`,
   `tokenToShareRatio`, `statusInfo.openState` (halted flag), `statusInfo.marketStatus`,
   `statusInfo.nextOpenTime` / `nextCloseTime` (Unix ms). No pagination documented —
   verify.
2. **`/price`** (batch) → `tokenPrice` (on-chain), `referencePrice` (underlying),
   `tokenPriceUpdatedAt`. This is the premium/discount signal the whole hackathon
   idea list revolves around ("on-chain vs reference price monitor").
3. **`/underlying-market`** → `openState`, `marketStatus` (`regular` | `closed` …),
   `nextOpenTime` / `nextCloseTime`. Replaces the execution plane's hard-coded
   US-hours calendar (`src/trade/universe.ts` `US_EQUITY_HOURS_UTC`, `isUsEquityOpen`).
4. `/platforms`, `/search`, `/underlying-profile` — nice-to-have (P/E, 52-week,
   attestation reports) for tiles; not on any money path.
5. **Market API** (general-data: candles, volume) for stock tokens — the plane
   currently has only Binance spot prices for the 25 static bStocks
   (`src/jobs/binancePrices.ts`).
6. Trading API `/quote` — read-only price cross-check only (Ondo routes RFQ-only there,
   bStock = LiquidMesh SWAP + PcsXRfq, xStock = plain AMM). **Never** use its `/swap`
   calldata: execution signs through the Altana relay, not Binance.

## 4. Product shape the execution plane will ask for

- **Universe lane `bstocks` becomes dynamic.** Today `src/universe.ts`
  `BSTOCK_CONTRACTS` is a static list of 25 (pinned 2026-09-03). Binance has since
  listed at least AAPL, AMZN, GS, PYPL, HOOD, IBM, NOK, BNCB, GPROB, RDDTB — real
  count is ~40+. Keep the static list as the **fail-safe floor** (the file's own
  rationale: a provider outage must never shrink the lane) and union the API list
  on top, same pattern as `binancePrices.ts` falling back to `bstockAddresses()`.
- **Cross-issuer universe with dedupe by `underlyingTicker`** (operator ruling
  2026-09-16): bStocks wins when it lists the ticker; otherwise choose Ondo vs
  xStocks by **measured depth at a real trade size** (a real quote, not pool
  existence — FINDINGS (k) in the execution plane: `getPool` returns addresses for
  zero-liquidity pools and `getAmountsOut` answers happily for drained ones), with
  24 h volume only as tie-break. xStocks must be mapped by hand (not in the API;
  quote asset **USDC**, ~50+ tokens on BSC). Ondo: 430+ on BSC, USDT-quoted on
  Pancake, freely transferable outside the US but Ondo reserves allowlist /
  transfer-control / wallet screening — the execution plane will verify a
  7702-delegated wallet can hold them with a tiny live trade before trusting it.
- New/extended reads the execution plane will consume (shape to be agreed in the
  spec, keep the `{data,error?,meta?}` envelope and `x-dp-token`):
  `/universe?lane=bstocks` rows gaining `underlyingTicker`, `platformId`,
  `referencePriceUsd`, `premiumBps`, `marketStatus`, `openState`, `nextOpenMs` /
  `nextCloseMs`, and per-row `staleness` from the snapshot store — plus a way to
  express Ondo/xStocks rows (new lane values or a `platform` field; the execution
  plane's `UniverseLane` union is closed, so this is a joint schema change).
- A halted token (`openState=false`) must read as **not eligible** in the
  fail-closed gate (`src/query/eligibility.ts`), same as an RPC outage does today.

## 5. Constraints that carry over

- This plane is the only place that talks to Binance; the execution plane reaches it
  via `DATA_PLANE_URL` only. No key ever crosses repos.
- Offline `node:test` only; no test may call Binance. Record measured latencies and
  quirks in this repo's notes (they are DevEx-report material).
- Scale the process to the change: a new signed adapter + jobs + fields on existing
  routes = written plan → build → one independent review. Anything that changes what
  `eligibility` answers is fail-closed money-adjacent: spec → review → build → audit.
- Do not reintroduce the scope the operator closed on 2026-08-12 (wallet-level
  smart money, paid social signal).

## 6. Open questions for the operator

1. Canonical env var names for the Binance Web3 key pair (§2).
2. Confirm xStocks handling: hand-maintained list (like today's `BSTOCK_CONTRACTS`)
   versus dropping xStocks for the hackathon (rules require only one issuer central).
3. Whether to also pull Market API candles for stock tokens now or after the RWA
   fields land.

Sources read on 2026-09-16: hackathon overview/prizes/resources tabs; Binance RWA
Data and authentication docs; BNB Chain "BNB Street 709+" blog (Ondo 430+, xStocks
50+); Ondo and xStocks launch posts; Binance bStocks listing announcements.
