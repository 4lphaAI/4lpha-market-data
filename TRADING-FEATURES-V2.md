# Trading features v2 — quality fallback and actionable coverage

This extends [v1](TRADING-FEATURES-SPEC.md). No provider purchase, chart-contract
change, trade execution or synthetic history is introduced. v1 calculations
remain available. Marketplace clients should explicitly adopt the v2 routes to
use the new warm-up convention; the producer computes both versions from one
selected observation, without doubling provider calls.

## Marketplace integration

Replace `/trading/features/v1` with `/trading/features/v2` for the index, single,
batch and `/input` routes. The new calculation version is `pool-features-v2`.
The v1 index advertises `meta.preferredVersion: pool-features-v2`; it does not
silently change v1 numeric formulas. Auth, batch bound (10), intervals
(5m/15m/1h), envelope, metric names and input replay mechanism are unchanged.

Example sequence:

1. `GET /trading/features/v2/pools` to discover the active pools and base tokens.
2. `GET /trading/features/v2?pools=<pool1>,<pool2>&interval=15m`.
3. Read `data[pool].data.metrics` and check each metric's `available` flag.
4. Read `data[pool].meta.producer` for refresh state and source-specific reasons.
5. Save `/trading/features/v2/:pool/input?interval=15m&snapshotId=...` if durable
   replay is needed. Replay with `calculateFeatures(input, calculatedAt, version)`.

Never assume a ratio is USD or that a symbol identifies the target contract.
`identity` binds the actual base, quote, interval and denomination. A changed
watchlist/source changes series identity. Input snapshots and versioned feature
keys are separate; historical v1 snapshots are not relabeled v2.

V2 input hashes recursively sort object keys by code-unit order, preserving array
order, so PostgreSQL JSONB reordering does not alter replay IDs. An actual
production replay exposed this limitation of the old JSON.stringify-only
approach; it is pinned by a reordered-JSON regression fixture. The producer
revision queues a bounded one-time recomputation of v2 IDs from available
cached inputs after rollout. Existing v1 hash semantics remain unchanged.

## Fixed warm-up per indicator

| Metric | v1 consecutive bars | v2 consecutive bars |
|---|---:|---:|
| ROC10 | 11 | 11 |
| RVOL20 | 21 | 21 |
| EMA12 | 120 | 24 |
| EMA26 / EMA spread | 120 | 52 |
| ATR14 / ATR% | 120 | 29 |

The SMA seed and EMA recurrence remain the same. v2 uses exactly two EMA
periods of history, not an arbitrary client limit or all available old candles.
ATR uses 28 true ranges: first 14 for the Wilder seed, then 14 smoothing steps.
These are bounded initialization conventions, not claims that shorter EMAs have
converged to an infinite-history EMA. Parameters explicitly expose `warmupBars`.

The overall inspected time window stays bounded at 120 UTC buckets. v2 rejects
gaps/invalid bars/conflicting revisions within each metric's own window; an old
defect outside EMA12's window no longer disables that otherwise valid metric.
An unlocatable malformed timestamp remains an invalid observation. Publication
lag, expiry, future-observation rejection, unavailable volume and zero-baseline
rules are unchanged. No filling, interpolation or upsampling occurs.

## Fallback based on usable price history

The worker opts into `qualityPolicy: trading-v2` on the existing OHLCV reader.
Fresh cached history with a valid latest 52-bar segment is reused immediately.
Fresh-but-gapped/short history is not sufficient to stop provider selection:
Gecko is tried, followed by DexPaprika for token ratios if price history is
still inadequate. USD never silently falls back to a ratio.

Candidates are whole observations, never joined across providers. Selection
prefers market-fresh history, then the number of supported price warm-up
thresholds (11/24/29/52), then latest eligible close, then contiguous coverage.
Thus a worse alternative cannot overwrite a better cached observation. A
same-close alternative with better coverage may replace a deficient series;
its own source, observation time and input hash are retained. A stale incoming
history never gets stamped fresh. If neither source improves the cache, the
original timestamp remains.

All six price metrics can be supported at 52 bars. Missing/unverified volume
does not cause repeated provider requests on an otherwise adequate price
series: RVOL stays unavailable until its units and inputs are established.
The quality cache adds `:trading-v2` to the existing pool history key, can seed
from compatible chart history, and uses the same transport budgets/cooldowns.
Legacy charts retain their existing cache namespace and display policy.

The Dex adapter now preserves valid OHLC rows whose volume is missing or
unparseable as nullable-volume candles, instead of rejecting the entire page.
This was observed in live TSLAB 5m history (four rows in a 354-row response).
It does not fabricate volume or relax price validation. Chart-only aggregation
propagates null volume whenever any child volume is unknown.

## Series-specific refresh diagnostics

Both API versions expose additive `meta.producer` per series; `/pools` also
includes a bounded `series` array. It contains:

- `state`: `queued`, `refreshing`, `ready`, `partial`, or `unavailable`.
- `reason`, `attemptedAt`, `completedAt`, `nextAttempt`, `lastSuccessAt`,
  `consecutiveFailures`, and at most four source-attempt entries.
- Source reasons such as `rate_limited`, `quota_exhausted`, `cooldown`,
  `budget_exhausted`, `invalid_candles`, `identity_mismatch`, `provider_error`,
  `empty`, `stale`, `gap`, `insufficient_history`, `cache_hit`, `refresh_lease`,
  and `admission_limit`. No provider error strings, URLs or credentials are
  returned in this diagnostic contract.

`features_pending` means queued/refreshing without a snapshot. A completed
failed attempt without a snapshot returns `features_unavailable`, a concrete
reason and retry time. Existing snapshots remain readable with their own age
and availability even when the most recent refresh failed. Producer state is
about refreshing the shared observation and v2 coverage; v1's stricter metric
availability must still be read from its own `metrics` object.

Repeated failures back off per series for 60s, 120s, 240s, then at most 300s.
The bounded state object and admission are persisted before upstream IO. A
refresh left incomplete after the 30s deadline reports `refresh_interrupted`.
Oldest-attempt fairness and four-series admission remain. A pass in which every
attempt fails still marks the scheduler job unhealthy; this is not disguised
as success, and does not claim that every stored series is unavailable.

## Default coverage

The old automatic six-pool LP watchlist concentrated entirely on two equities.
The new default is six existing, explicitly oriented reference pools:

- WBNB, BTCB, ETH and CAKE against USDT, reusing `PRICE_POOLS` already used by
  `majors-prices` (excluding USDC).
- NVDAB/USDT 0.25% and TSLAB/USDT 0.25%, from the existing verified equity pool
  set. Lower-activity duplicate fee tiers no longer occupy default slots.

This is an initial coverage configuration, not a liquidity guarantee or a
trading recommendation. It adds no token to the eligibility gate. The existing
operator `trading:features:v1:watchlist` override is honored unchanged for both
versions, including empty lists and explicit USD choices. API clients cannot
allocate arbitrary watched pools. Maximum 10 pools, unchanged provider budgets.
Clients must read the new index; removed automatic seed pools become outside
the default watchlist rather than being secretly redirected to another pool.

## Validation

The v2 tests cover independently calculated last-bar shocks, fixed-window
invariance, v1 preservation, defects inside/outside metric windows, quality
fallback despite fresh HTTP 200/cache hits, whole-series selection, fallback
failure, timestamp preservation, versioned API/replay, dual publication with
one upstream load, and schema-aware Postgres persistence of reasons/backoff.

The optional live probe supports `--v2`; with
`<pool> <token> token --simulate-gecko-429 --v2`, only Gecko failures are simulated,
Dex responses are real, and all state stays in an isolated MemoryStore.

Validated locally on 2026-09-06: typecheck/build and all 549 offline tests pass.
The real TSLAB 5m probe tried both providers despite Gecko returning HTTP 200;
both reported a latest 43-bar contiguous segment. v2 served ROC, EMA12, ATR14,
ATR% and (on the selected Gecko observation) RVOL, while EMA26/spread remained
unavailable. The 15m and 1h observations supplied all seven metrics. Missing
Dex volume no longer caused the response to be rejected as invalid OHLC.
