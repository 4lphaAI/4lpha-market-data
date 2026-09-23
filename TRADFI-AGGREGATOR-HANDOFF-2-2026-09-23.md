# Handoff 2 from execution: TradFi aggregator, parts B and C (2026-09-23)

Follows `TRADFI-AGGREGATOR-HANDOFF-2026-09-23.md` and your reply
`TRADFI-AGGREGATOR-REPLY-2026-09-23.md`. Thank you. A1–A5 are accepted as written:

- keep `enableRFQ=true`;
- the 64-char reason cap stays;
- `rate_budget_exhausted` is fine.

Execution already falls back to the direct offer on any Flash refusal, so a budget refusal becomes a
direct trade, or no trade when there is no direct route.

## Execution state (for context)

- **The phase is built, audited and merged on execution `master` as `6735bd2`.** It is **not
  pushed**: the operator is testing locally first.
- **What execution now does:**
  - It accepts your null fee pair.
  - It binds every quote to the request and to its configured guard.
  - It clamps the guard deadline to now+14 s and refuses a quote with less than 6 s left.
  - It clamps Flash slippage to ≤ 300 bps.
  - It logs `proxy:<code>:<reason>`.
  - Without `TRADFI_BINANCE_GUARD_ADDRESS` set, the worker makes **zero** Flash calls.
- **The guard is NOT deployed yet.** Deploying it is an operator-run mainnet step on the execution
  side. Execution will send you the address.

## B. Activation (the operator decides each go)

**B0. Deploy `4bf35eb`, only when the operator says go.**
- Your A2/A3/A5 fixes (in-band 40465 → `provider_no_route`, `upstream_rate_limited`, the 1 s budget
  refusal, the failure log) are local only.
- The live gates need them on Railway, because execution's local test points at the production data
  plane.
- Please get the operator's go before pushing or deploying.

**B1. When execution sends the guard address:**
1. Read `eth_getCode(guard)` from two public BSC RPCs and check both return the same non-empty
   runtime.
   - Runtime length must be **3504 bytes**.
   - Set `TRADFI_BINANCE_GUARD_RUNTIME_CODEHASH = keccak256(runtime)`.
2. Set `TRADFI_BINANCE_GUARD_ADDRESS` to the address. Router and spender are already on Railway.
3. Redeploy.
4. Confirm the route no longer answers `aggregator_guard_unavailable`.

**B2. Live quotes through the proxy, read-only.** Once B1 is live:
- **What to quote:** NVDAB, SPYB and PLTRB, at 5 USDT, both sides, with `slippageBps: 100`, through
  the real route (`x-dp-token`).
- **Send back:**
  - the envelopes (redact nothing but secrets);
  - whether `taker` equals the guard;
  - the `[binance-flash]` log lines, if any;
  - latency from Railway, not the local machine.
- **Why:** execution uses these exact quotes for its zero-spend `eth_call` of
  `[approve(guard), guard.swap(…)]` (gate G5b) before any real trade.
- **Timing:** quotes expire in 15 s, so also give execution a one-line command it can run itself.
  For example, adapt `scripts/flash-rfq-probe.ts` into a `scripts/flash-proxy-quote.ts <token> <side> <usdt>`
  that calls the deployed route and prints the envelope.

**B3. Rate-budget follow-through.** Your A5 numbers go into execution's ROADMAP as a debt. The
de-duplication of identical Flash calls within a cycle and the spreading of the shortlist are
execution-side work. Nothing is owed from you unless demand reaches about 4.9 rps; the answer then is
a second API key, the operator's call.

## C. Features for pool-less bStocks (a new data-plane phase: research, then spec)

**Why.** AI Trade cannot buy a pool-less bStock (PLTRB, LITEB, AMDB, …).
- Execution ruled on 2026-09-23 that AI Trade pins **direct-venue tokens only** until this exists.
- The reason is that AI scoring needs 15m and 1h evidence, and a pool-less token scores ≤ 0.11 against
  a 0.35 floor.
- Schedule Buy already works without features.

**C1. Research.**
- Can Sintral serve 15m and 1h OHLCV for these tokens keyed by **token address** (they are
  `usEquity`, with no on-chain pair)?
- Measure the real-bar coverage over 30 h for PLTRB, LITEB and AMDB (and every other pool-less
  bStock), with the same forward-fill rules as `indicatorRevision 3`.
- Find out what the price series represents: Binance's own trade stream, or the issuer/reference
  price. If it is the reference price, indicators computed from it describe the underlying stock, not
  the token.

**C2. Spec, only if C1 says yes.** The consumer contract execution needs, in its preferred shape:
- **No new endpoint.**
  - The pool-less token appears in the `trading/features/v2/pools` index with an identity execution
    can tell apart from an AMM pool. Example: `kind: "token-series"`, a synthetic id, the token
    address, `priceCurrency: "usd"`, `source: "sintral"`.
  - `trading/features/v2?pools=…` returns the same `pool-features-v2` payload for that id, with the
    same metric names, `indicatorRevision` and staleness semantics.
- **Execution reads it today through:**
  - `selectFeaturePools(index, tokens)`, which maps an index row to its `tokenAddress`;
  - `decodeFeature(row, pool, interval, now)`, which checks the identity and freshness.
- **Execution-side follow-up after you ship (not your work):**
  - lift the AI-mode "direct-venue only" pin rule;
  - give AI Trade the deferred-premium path Schedule has.
- **Put the spec in this repo.** Execution then writes its consuming phase against it.

## Reply

Answer B1/B2 in a short reply file when they happen, and C1 findings (plus the C2 spec if it goes
ahead) as their own document. Nothing here needs a signature, a transaction or a paid call.
