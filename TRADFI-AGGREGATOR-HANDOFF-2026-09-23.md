# Handoff from execution: TradFi Binance aggregator activation (2026-09-23)

From: execution plane (`D:\4lpha-execution`), phase `MD here/TRADFI-AGGREGATOR-ACTIVATION-SPEC.md`
(Rev 3). Build is running on branch `tradfi-aggregator` (worktree `D:\4lpha-wt-aggregator`).

## Context

Execution is activating the Binance Flash route through this repo's proxy
`POST /trading/binance/quote-and-swap` (commit `6c4a5bd`) and the guard contract
`contracts/TradFiSwapGuard.sol`. The guard is not deployed yet.

Operator rulings (2026-09-23):

- **Aggregator-first with direct-AMM fallback.** Execution ranks the direct and Flash offers by net
  output and takes the better one.
- **Pool-less bStocks** (PLTRB, LITEB, AMDB, …) can be bought by **Schedule Buy**, and later by Auto
  DCA and Smart Portfolio.
- **AI Trade** only uses the aggregator for bStocks that have a pool. It cannot score pool-less
  tokens, because feature payloads are keyed by pool (see C1).

**No wire change is required from this repo.** Execution accepts the current success envelope,
including the `feeAmountAtomic: null` / `feeToken: null` pair, which execution used to reject.

## A. Now: read-only checks, no guard needed

**A1. Deployment and auth.**
- Confirm that `6c4a5bd` is deployed on Railway.
- Until the guard env is set, the route should answer `aggregator_guard_unavailable` /
  `verified_guard_config_missing`.
- Confirm that execution's `DATA_PLANE_TOKEN` passes the `x-dp-token` perimeter on this route.

**A2. Error envelope.**
- Execution now records every proxy refusal as `proxy:<error.code>:<error.reason>` (sanitized, ≤ 64
  chars).
- Confirm that every error response on this route carries both `code` and a `reason` from the closed
  set (`src/server.ts` ~178-184, ~493-515).

**A3. Make upstream 429s visible.**
- The proxy folds an upstream 429 into `binance_unavailable` / `upstream_unavailable`, with no retry
  (`retryOn429: false`).
- Execution cannot tell a 429 apart from an outage.
- Add one log line per upstream non-2xx or transport failure, with status, `tokenIn`, `tokenOut`,
  amount bucket and latency, so the operator can count 429s during the live gates.

**A4. RFQ mismatch (most important).**
- The adapter requests `enableRFQ=true` (`src/adapters/binanceFlash.ts:288`), but it refuses any
  response whose `rfq` is non-null (`:218`, `invalid("execution_mode")`).
- If Binance returns an RFQ route whenever one is best, the proxy throws away exactly the quotes that
  would beat the AMM pool, and execution silently falls back to direct.
- Measure it with the Binance API directly, read-only: `userWalletAddress` = any EOA, no signing, no
  transaction.
  - Tokens: 3 with a pool (NVDAB, SPYB, QQQB) and 3 without one (PLTRB, LITEB, AMDB).
  - Both sides: USDT → stock and stock → USDT.
  - Amounts: 5 and 50 USDT.
  - Run everything with `enableRFQ=true` and with `enableRFQ=false`.
- Report, for each combination:
  - how often `rfq` is non-null;
  - how often the normalizer would refuse;
  - `toTokenAmount` compared across the two modes;
  - whether `toTokenAmount` is already net of `feeAmount`;
  - `expiresAt − observedAt`;
  - latency.
- The numbers decide whether to keep `enableRFQ=true` or turn it off. Do not change the flag before
  reporting.

**A5. Rate budget.**
- What are the request limits of the Binance Web3 key?
- Execution's worst-case demand:
  - about 66 Flash calls per AI Trade agent per 60 s cycle (at most 10 positions × 3 exit calls, plus
    12 shortlist × 3 entry calls);
  - 1 call per Schedule agent per cycle;
  - server-side, up to 56 calls per hire-pin cache miss (30 s TTL) plus the schedulable refresh every
    25 s.
- If the budget is tight, propose a light per-key limiter that refuses immediately with a distinct
  `reason`, instead of spending the 5 s upstream deadline.

## B. After the guard is deployed (execution will send the address)

**B1. Set all four env vars through the IaC, then redeploy.**

| Variable | Value |
|---|---|
| `TRADFI_BINANCE_GUARD_ADDRESS` | the deployed guard |
| `TRADFI_BINANCE_GUARD_ROUTER_ADDRESS` | `0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5` |
| `TRADFI_BINANCE_GUARD_SPENDER_ADDRESS` | `0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5` |
| `TRADFI_BINANCE_GUARD_RUNTIME_CODEHASH` | see below |

The codehash is `keccak256(eth_getCode(guard))` of the **deployed** runtime. It is **not** the
template hash in execution's `MD here/TRADFI-AI-TRADE-V2-GUARD-BUILD.md`: that one is a SHA-256 with
the immutables zeroed.

**B2. Live quote through the proxy (read-only).**
- Quote NVDAB, SPYB and one pool-less token that execution names, at 5 USDT, both sides.
- Send back the response envelopes, redacting anything sensitive.
- Execution then runs its zero-spend `eth_call` of `[approve(guard), guard.swap(…)]` against those
  quotes before any real trade.

## C. Later (optional, separate phase)

**C1. Features for pool-less bStocks.**
- AI Trade cannot buy a pool-less bStock today. `enrichFeatures` reads pool-keyed payloads, so a
  pool-less token scores ≤ 0.11 against a 0.35 floor.
- Please research whether Sintral can serve 15m/1h series for these tokens keyed by token address
  (they are `usEquity` and have no on-chain pair).
- If it can, that becomes its own phase ("pool-less AI Trade").

**C2. Do not "fix" `premiumBps: null` on pool-less rows.**
- For those rows, `tokenPriceUsd` is the issuer price and equals `referencePriceUsd`. For example, on
  2026-09-23 PLTRB was 185.08 / 185.08 and LITEB 947.09 / 947.09.
- That is not a market price, so a premium computed from it would be a false 0 %.
- Execution handles null by checking the premium on the actual executed Flash quote.

## Reply

Put your answers to A1–A5 in a short file here (for example `TRADFI-AGGREGATOR-REPLY-2026-09-23.md`),
or tell the operator. Nothing here needs a signature, a transaction or a paid call.
