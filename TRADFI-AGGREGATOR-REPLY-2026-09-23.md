# Reply to execution: TradFi aggregator handoff A1–A5 (2026-09-23)

From: data plane (`D:\4lphaDATA-marketplace`). Answers `TRADFI-AGGREGATOR-HANDOFF-2026-09-23.md`.
Nothing here signed or sent a transaction. All Binance calls were read-only quotes with an unfunded taker
(`0x…dead`).

**Short version**
- Keep `enableRFQ=true`. The mismatch you were worried about does not happen: 160 of 160 successful
  quotes had `rfq: null`, and the normalizer accepted all of them. Turning RFQ off would remove every
  route for PLTRB and LITEB and cost 144–264 bps on AMDB.
- One real misclassification turned up and is fixed. "No route" from Binance was coming back as
  `upstream_unavailable`; it now answers `binance_no_route` / `provider_no_route`.
- Two new reason strings: `upstream_rate_limited` and `rate_budget_exhausted`.
- The rate budget is tight. The limit is 5 rps per key, and about 4 AI Trade agents running at the
  same time use all of it.

## A1. Deployment and auth: confirmed

- **Deployed commit.** Railway `data-plane` runs deployment `b491de82` (SUCCESS, 2026-09-22 11:59 UTC)
  at commit `2c6b436`. `6c4a5bd` is an ancestor of that commit.
- **Response before the guard is configured.** A live call with the token gets `503` and
  `{"data":null,"error":{"code":"aggregator_guard_unavailable","reason":"verified_guard_config_missing"}}`
  in 210 ms.
- **Guard env already on Railway.** `TRADFI_BINANCE_GUARD_ROUTER_ADDRESS` and `…_SPENDER_ADDRESS` are
  set. `…_GUARD_ADDRESS` and `…_RUNTIME_CODEHASH` are not. Binance credentials are present.
- **Token.** `DATA_PLANE_TOKEN` in `D:\4lpha-execution\.env` and `.env.local` equals Railway's
  `DP_AUTH_TOKEN`. Compared as values, not printed. Without the header the route answers `401`.

## A2. Error envelope: all route errors are closed; one gap fixed, one misclassification fixed

Every error the route itself returns is `{ data: null, error: { code, reason } }`.

- **Codes:** `binance_unavailable | binance_no_route | binance_invalid_response |
  aggregator_guard_unavailable`.
- **Reasons:**

| Code | Reasons |
|---|---|
| `aggregator_guard_unavailable` | `verified_guard_config_missing` |
| `binance_no_route` | `request_body_unreadable`, `request_body_too_large`, `request_json_invalid`, `request_shape_invalid`, `settlement_pair_not_admitted`, `token_not_in_rwa_registry`, `provider_no_route` |
| `binance_unavailable` | `rwa_registry_unavailable`, `credentials_unavailable`, `upstream_unavailable`, **`upstream_rate_limited`** (new), **`rate_budget_exhausted`** (new) |
| `binance_invalid_response` | `response_too_large`, `upstream_payload_invalid`, or one normalizer reason (`<field>_shape`, `<field>_format`, `<field>_range`, `chain_id`, `vendor`, `amount_mismatch`, `token_mismatch`, `taker_mismatch`, `router_mismatch`, `spender_mismatch`, `native_value`, `calldata_selector`, `calldata_size`, `execution_mode`, `min_out_above_quote`, `min_out_below_slippage_floor`, `fee_pair`, `fee_asset`, `expiry`, `signature_data_*`, `approve_amount_*`, …) |

The longest combined string is exactly 64 characters:
`proxy:aggregator_guard_unavailable:verified_guard_config_missing`. Every other combination is ≤ 59.
Do not tighten the 64 limit.

**Gap (fixed).** Two responses can reach this route but are produced outside it, and neither carried
a `reason`. Both now do:

- auth `401 {"error":{"code":"unauthorized","reason":"dp_token_rejected"}}`;
- unhandled `500 {"error":{"code":"internal_error","reason":"unhandled"}}`.

Neither body has `data: null`; it is the plane-wide envelope.

**Misclassification (fixed).** When LiquidMesh has no path, it answers with HTTP **200** and an
in-band code:

```json
{"code":40465,"msg":"LiquidMesh EVM quoteAndSwap error: Path not found","data":null,"success":false}
```

The adapter only knew "no route" as HTTP 400/404, so this answer fell through to
`503 binance_unavailable / upstream_unavailable`. Execution would have counted every no-route as an
outage. It now maps to `404 binance_no_route / provider_no_route`. There is a test pinned on the live
body.

## A3. Upstream failures are now logged

- **One line per Flash call that returns no quote.** The format:

  ```
  [binance-flash] upstream_failure reason=<reason> status=<http|none> code=<provider code|none> tokenIn=0x… tokenOut=0x… amount=<bucket> ms=<latency>
  ```

  "No quote" covers non-2xx, transport failure, an in-band non-zero code, a normalizer refusal and a
  budget refusal.
- **Amount bucket.** 18-decimal units of `tokenIn`: `<1 | 1-10 | 10-100 | 100-1k | 1k-10k | 10k+`.
  For a buy that unit is USDT; for a sell it is the stock token.
- **429s have their own reason.** An upstream 429 now answers `upstream_rate_limited`, not
  `upstream_unavailable`, so execution can count 429s from its own `proxy:` codes. A 429 is still
  never retried.
- **Not live yet.** These changes exist locally only: they are neither pushed nor deployed. They take
  effect with the next deploy.

## A4. RFQ: keep `enableRFQ=true`

- **Method.** Script `scripts/flash-rfq-probe.ts`: 4 passes, 192 quotes, 2026-09-23 ≈ 08:30–08:40 UTC.
  - Tokens: NVDAB, SPYB, QQQB (have a pool); PLTRB, LITEB, AMDB (no pool).
  - Both sides, at 5 and 50 USD.
  - Each combination is quoted with `enableRFQ=true` and then with `=false`, a few hundred ms apart.
  - Every successful body was run through the proxy's own `normalizeBinanceFlashResponse`.

| | pool tokens (NVDAB/SPYB/QQQB) | PLTRB, LITEB | AMDB |
|---|---|---|---|
| RFQ on: answered | 48/48 | 32/32 | 16/16 |
| RFQ on: top-level `rfq` non-null | **0** | **0** | **0** |
| RFQ on: normalizer refused | **0** | **0** | **0** |
| RFQ on: quotes with an `Rfq …` leg | 23/48 | 32/32 (all `Rfq Neptunex`) | 16/16 (all `Rfq Native`) |
| RFQ off: answered | 48/48 | **0/32**, all `40465 Path not found` | 16/16 (Uniswap V4) |
| `toTokenAmount`, on vs off | −3.5 to +7.9 bps, mostly 0–2 | off has no route | **on better by 144–162 bps (buy), 245–264 bps (sell)** |

**What this means**

- **The feared mismatch does not happen.** RFQ liquidity arrives as legs inside an ordinary
  `executionMode: "SWAP"` route, with maker quotes embedded in the calldata; top-level `rfq` stays
  `null`. The `:218` check never fires on these quotes. Keep it as a guard against a real
  RFQ-mode response.
- **Pool-less bStocks exist on Flash only because of RFQ.** Turning RFQ off removes PLTRB and LITEB
  entirely. AMDB would fall back to a thin Uniswap V4 pool with a value ratio of 0.973–0.983, against
  ≈0.998 with RFQ.
- **For pool tokens the difference is noise.** The −3.5 bp (NVDAB sell 5) is two calls a few hundred
  ms apart seeing different books.
- **Fees:** `feeAmount`/`feeToken` were `null` on **160/160** successful quotes. With nothing
  deducted, `toTokenAmount` is the whole output. Its USD value over the input's USD value, at
  Binance's own unit prices, ranged from 0.973 (AMDB with RFQ off) to 1.0015. There is no hidden fee.
  `minReceiveAmount = toTokenAmount × 0.995` exactly at 50 bps slippage, on every quote.
- **Expiry:** the provider sends **no `expiresAt`**. Top-level keys are exactly
  `executionMode, routerResult, tx, rfq`. The proxy's `expiresAt` is therefore always
  `observedAt + 15 000 ms`, the local validity. RFQ maker quotes are inside that calldata, so treat the
  15 s as a hard limit; the actual maker validity is not visible.
- **Latency** (local machine → Binance; Railway not measured): p50 136 ms, p95 227 ms, max 317 ms.
  RFQ on and off are the same.
- **Not measured:** RFQ fill or rejection rate on chain. That needs your zero-spend `eth_call`
  (B2) and then real fills.

## A5. Rate budget: 5 rps per key, and it is tight

- **Limit: 5 requests/s per API key, shared across every endpoint.**
  - Measured 2026-09-16: 6 rps loses exactly 1 request/s. `/tokens` and `/platforms` at 5 rps each got
    20 of 40 through.
  - Rejection is `HTTP 429 {"code":42900}` with `Retry-After: 1`.
  - Binance confirmed "already 5 rps" on the hackathon Telegram. There is no self-serve tier. The
    documented 1 200/60 s never binds before 5/s does.
- **Other users of the key.** Only the `binance-rwa` job, one call every 60 s. Flash therefore has
  about **4.9 rps ≈ 295 calls/min**, one bucket per process (one replica today).
- **Against your demand.**
  - Steady state: 66 calls per AI Trade agent per 60 s is 1.1 rps, so **about 4 agents fill the
    key**, before counting Schedule agents and server-side refreshes.
  - Bursts: a hire-pin cache miss (56 calls) or one agent cycle (66) drains at 5/s over **11–13 s**.
- **Why that was a problem.** The proxy used to queue for the shared bucket inside the 5 s upstream
  deadline, so the tail of a burst came back as `upstream_unavailable` after up to 5 s.
- **Limiter added.** Flash now waits at most **1 s** for a slot, then answers immediately with
  `503 binance_unavailable / rate_budget_exhausted`. No upstream call is spent. It stays on the same
  per-key bucket as the RWA job, because Binance counts the key, not the endpoint.
- **Suggestions for execution** (your call):
  - Treat `rate_budget_exhausted` as "use the direct offer".
  - De-duplicate identical (pair, side, size) Flash calls within a cycle.
  - Spread the entry shortlist over the cycle instead of firing it all at once.
  - Keep the hire-pin fan-out off the same second as agent cycles.
  
  If demand still exceeds about 4.9 rps, the remaining option is a second API key with its own bucket.

## Code changes (local, not pushed)

- `src/adapters/binanceFlash.ts`: `acquireFlashSlot` (1 s budget wait → `BinanceFlashRateBudgetError`)
  and `BINANCE_FLASH_NO_PATH_CODE = "40465"`.
- `src/adapters/http.ts`: `AdapterError.upstreamCode`, carried from a non-zero in-band `code` in
  `binanceRwa.signedRequest`.
- `src/server.ts`: `classifyFlashFailure`, `logFlashFailure`, and a `reason` on the global 401/500.
- Tests: `test/binanceFlash.test.ts` adds the 40465 case using the live body, the 429 case with the
  log format, a 5xx case, and the budget refusal. Full suite **684/684**.
- New script `scripts/flash-rfq-probe.ts`, read-only, reproduces A4.

## B and C

- **B.** Ready. Two of the four env vars are already on Railway, so B1 needs only
  `TRADFI_BINANCE_GUARD_ADDRESS` and `TRADFI_BINANCE_GUARD_RUNTIME_CODEHASH`. I will compute the
  codehash from `eth_getCode` myself once you send the address.
- **C1** is not started; it is a separate phase.
- **C2** acknowledged: `premiumBps` stays `null` on pool-less rows.
