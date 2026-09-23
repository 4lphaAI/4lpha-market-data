# Reply to execution: B0–B2 done, Flash proxy live (2026-09-23)

Answers `TRADFI-AGGREGATOR-HANDOFF-2-2026-09-23.md` §B and
`TRADFI-AGGREGATOR-GUARD-ADDRESS-2026-09-23.md`.

## B0: deployed on the operator's go

- `4bf35eb` and `25ef4bd` are pushed to `master` and deployed on Railway (`24720511`, SUCCESS).
- They add:
  - in-band `40465` → `provider_no_route`;
  - `upstream_rate_limited`;
  - the 1 s `rate_budget_exhausted` refusal;
  - the `[binance-flash]` failure log;
  - a `reason` on the global 401/500;
  - `server-timing: binance;dur=N` on the route.

## B1: guard verified independently, env set, redeployed

- **Code check.** `scripts/guard-codehash.ts 0x16B24723aCE1Adc87243338d0A32C50BeC259650` read
  `eth_getCode` from `bsc-dataseed.bnbchain.org` and `bsc-rpc.publicnode.com`. Both returned the same
  runtime, **3504 bytes**, and `keccak256` =
  `0x5127d87a4fb2202e28d74deb2526d31f4f7a5cdb239543b7bcb9173fd27ff44a`, which **equals** the value you
  sent.
- **Getters, read on chain:** `router()` and `spender()` both return
  `0xb44446b0c8e56988c34f7ff73ae904982b5fdda5`.
- **Railway env, `data-plane` service:**

| Variable | Value |
|---|---|
| `TRADFI_BINANCE_GUARD_ADDRESS` | `0x16b24723ace1adc87243338d0a32c50bec259650` (new) |
| `TRADFI_BINANCE_GUARD_RUNTIME_CODEHASH` | `0x5127d87a4fb2202e28d74deb2526d31f4f7a5cdb239543b7bcb9173fd27ff44a` (new) |
| `TRADFI_BINANCE_GUARD_ROUTER_ADDRESS` | `0xb44446b0c8e56988c34f7ff73ae904982b5fdda5` (unchanged) |
| `TRADFI_BINANCE_GUARD_SPENDER_ADDRESS` | `0xb44446b0c8e56988c34f7ff73ae904982b5fdda5` (unchanged) |

- **How they were set.** The two new variables went in through the Railway CLI (`railway variables
  --set`). That triggered redeploy `444a3897` at commit `25ef4bd`, which finished SUCCESS at
  12:16 UTC.
- **"The IaC".** This repo's only Railway config is `railway.json`, and it carries no variables. The
  CLI warns that Config as Code is deprecated in favour of `.railway/railway.ts` (existing files keep
  working until 2026-12-01). Migrating is a separate task.
- **Route now live.** It no longer answers `aggregator_guard_unavailable`, and the boot line
  "verified guard configuration absent" is gone from the logs.

## B2: live quotes through the proxy

- **Setup:** 6 quotes at 5 USDT, `slippageBps: 100`, through
  `POST https://data-plane-production.up.railway.app/trading/binance/quote-and-swap` with
  `x-dp-token`, 12:17:31–12:17:41 UTC.
- **Full envelopes**, with calldata and nothing redacted (there are no secrets in them), are in
  `TRADFI-AGGREGATOR-B2-QUOTES-2026-09-23.json`. They have expired; use them as reference shapes and
  re-quote for the `eth_call`.

| Token | Side | HTTP | taker = guard | amountIn | quotedOut | minOut | calldata | Binance from Railway | round trip (local → Railway) |
|---|---|---|---|---|---|---|---|---:|---:|
| NVDAB | buy | 200 | yes | 5 USDT | 0.021969 NVDAB | 0.021749 | 2692 B | 135 ms | 351 ms |
| NVDAB | sell | 200 | yes | 0.021962 NVDAB | 4.99953 USDT | 4.94953 | 2468 B | 123 ms | 306 ms |
| SPYB | buy | 200 | yes | 5 USDT | 0.006458 SPYB | 0.006394 | 1636 B | 136 ms | 318 ms |
| SPYB | sell | 200 | yes | 0.006459 SPYB | 5.00031 USDT | 4.95031 | 1956 B | 113 ms | 348 ms |
| PLTRB | buy | 200 | yes | 5 USDT | 0.027073 PLTRB | 0.026803 | 2564 B | 155 ms | 338 ms |
| PLTRB | sell | 200 | yes | 0.027118 PLTRB | 4.98988 USDT | 4.93998 | 2564 B | 146 ms | 362 ms |

**On every quote:**

- `taker` is the guard; `router` = `spender` = B444…DA5; `value: "0"`; the calldata selector is
  `0xad43f73d`.
- `minOutAtomic = floor(quotedOut × 0.99)`, so the 100 bps are applied exactly.
- `expiresAt − observedAt = 15 000 ms`, the local validity. The provider sends no expiry.
- `feeAmountAtomic`/`feeToken` are `null`/`null`.
- `estimatedGasUnits` is `450000`, a fixed limit and not an estimate (DEVEX-NOTES 2026-09-23).
- **Latency.** Binance's own latency, measured on Railway via `server-timing`, was **113–155 ms**. The
  round trip from a local machine through Railway was 306–362 ms. A quote reached the caller with
  14.80–14.83 s of validity left, as measured by `msLeft`.
- **Logs.** There were no `[binance-flash]` lines: none of the 6 calls failed.

## One-line quote command for G5b

Run it from `D:\4lphaDATA-marketplace`. It reads `DP_AUTH_TOKEN` from this repo's `.env`, or pass
`DATA_PLANE_TOKEN`. Setting `TRADFI_BINANCE_GUARD_ADDRESS` adds the `takerIsGuard` check.

```bash
TRADFI_BINANCE_GUARD_ADDRESS=0x16b24723ace1adc87243338d0a32c50bec259650 node --import tsx scripts/flash-proxy-quote.ts NVDAB buy 5 100
```

- **Arguments:** `<SYMBOL|0xtoken> <buy|sell> <usdt> [slippageBps=100]`. A sell is sized as
  `usdt / tokenPriceUsd` shares, read from the plane's bStocks lane.
- **Output:** the request body, `http`, `serverTiming`, `roundTripMs`, `takerIsGuard`, `msLeft`, and
  the raw envelope.
- **Timing:** the quote expires 15 s after `observedAt`, so run the `eth_call` straight after it.

## Still open, and for whom

- **Execution:** the zero-spend `eth_call` of `[approve(guard), guard.swap(…)]` (G5b), then real
  fills.
- **Operator:** the C1 narrow option (AMDB-only token series), per
  `POOLLESS-FEATURES-C1-2026-09-23.md`.
- **Operator:** migrating `railway.json` to `.railway/railway.ts` before 2026-12-01.
