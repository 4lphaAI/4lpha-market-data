# Data-plane handoff: real candles and deterministic trading features

Date: 2026-09-06  
Target repository: D:\4lphaDATA-marketplace  
Status: **handoff for scoping/specification; no feature implementation or API change has been made by this task.**

Implementation update (subsequent authorized task, 2026-09-06): data-plane v1 is
implemented and verified locally. See [implemented contract and coverage](TRADING-FEATURES-SPEC.md).
The original handoff below remains the research/scoping record; deployment and
execution-plane strategy integration are separate from this implementation.

## 1. User request and intended outcome

The user requested that this handoff live in the data-plane repository, not the execution-plane repository:

> Add real candles, relative volume, momentum/EMA, ATR, and provenance through the data plane.

The goal is to give the existing 4lpha trading worker verifiable historical inputs. Its current doctrine requests volume expansion, orderly continuation, and pullback/reclaim, but the inspected entry prompt only receives a point-in-time price, market cap, rolling 24-hour volume/change, holders, source, and scan flags.

Primary research reference is **Neural Alpha (#1)**, then **Genesis (#2)** and **Gridora (#3)**. Use their code for design evidence, not as dependencies or as proof of future returns. The user explicitly asked not to clone/download or execute those repositories.

English research report: [Trading-agent winners code research](../4lpha-execution/MD%20here/TRADING-AGENT-WINNERS-CODE-RESEARCH-2026-09-06-EN.md).  
Vietnamese original: [Research report](../4lpha-execution/MD%20here/TRADING-AGENT-WINNERS-CODE-RESEARCH-2026-09-06.md).

This request creates a handoff, not blanket approval to deploy new routes, buy provider access, change trading behavior, or run transactions. The next data-plane session should turn the findings below into the repository's appropriately reviewed implementation plan/spec.

## 2. Read first and preserve the existing architecture

Read AGENTS.md, CLAUDE.md, README.md, ALLOWLIST-PRICE-SPEC.md, MAJORS-PRICE-SPEC.md, and the current source before implementation. Code inspected below is local source on 2026-09-06; deployed behavior was not tested.

The data plane owns market facts and deterministic features, not BUY/SELL decisions, position sizing, stop policies, or custody. Consumers reach it server-side over HTTP; preserve the data-plane auth and response-envelope conventions.

The brief describes store-backed consumption, while some existing query paths deliberately perform read-through upstream refreshes on a miss. Do not silently remove those paths or assume that a new per-agent fan-out is acceptable. Specify how the feature surface reuses cached history, coalesces refreshes, and respects upstream budgets.

Keep existing provider/RPC constraints:
- Public BSC RPC posture remains unchanged.
- Do not revive rejected/dead sources or assume paid CMC OHLCV is available.
- This work does not add social/KOL signals, wallet-level smart-money tracking, or paid feeds.
- Do not change chart fail-open behavior merely to make new trading consumers stricter. Trading usability can be explicit while old charts retain stale display data.
- Keep null/unknown distinct from observed zero, and errors sanitized.

No .agents/memory/MEMORY.md or .agents/HANDOFF.md was found in this repo during inspection. Do not create a duplicate execution-style memory system just for this work; this root-level handoff is the requested artifact.

## 3. Existing code to reuse and gaps to resolve

### A. Token-level klines already exist

[src/query/klines.ts](src/query/klines.ts):
- getKlines, KlineResult, KlineInterval, interval mappings, cache key and freshness rules.
- Supports 1m, 5m, 15m, 1h, 4h and 1d; max limit 500.
- Current key includes lowercased address, interval and requested limit.
- Cache first; OnchainOS → Sintral; old record returned if refresh fails.
- Result includes source, asOf and staleness.

[src/server.ts](src/server.ts) exposes GET /klines/:address. Its current metadata includes address, interval, limit, source, asOf, staleness and count. Preserve the old contract unless an explicitly reviewed versioning/migration plan says otherwise.

[src/core/models.ts](src/core/models.ts) defines Candle with timestamp at bar open, OHLC numbers and a non-null numeric volume. It does not itself carry bar-close status, volume denomination, source confirmation, per-bar quality or a series definition.

### B. Adapter normalization needs a trading-quality review

[src/adapters/onchainos.ts](src/adapters/onchainos.ts), normalizeKlines:
- Comments describe positional [ts, o, h, l, c, vol, volUsd, confirm].
- Current normalizer retains ts/OHLC/vol, but not volUsd/confirm.
- Missing/unparseable numeric values can become zero.

[src/adapters/binanceWeb3.ts](src/adapters/binanceWeb3.ts), normalizeSintralKlines:
- Positional [open, high, low, close, volume, timestamp].
- Current normalizer also uses numeric-zero fallbacks.
- Volume semantics and closed-bar guarantees must be established from source evidence, not inferred from the shared TypeScript shape.

**Implication:** a successful read and a recently written cache record do not by themselves prove that a complete, valid, closed trading series is available. Do not compute features from malformed values converted to zero or from rolling volume mislabeled as interval volume.

### C. Exact-pool OHLCV has stronger machinery already

[src/query/poolOhlcv.ts](src/query/poolOhlcv.ts), [src/adapters/ohlcvTransport.ts](src/adapters/ohlcvTransport.ts), and GET /pools/:address/ohlcv in src/server.ts:
- Versioned pool:ohlcv:v2 namespace.
- Shared history across request limits, currency-specific key, base/quote identities.
- PoolCandle permits null volume.
- priceCurrency, volumeCurrency, volumeUnavailableReason and schemaVersion.
- Closed-bucket filtering and latest-bar-aware staleness.
- In-flight coalescing, shared refresh leases, bounded concurrent refreshes.
- Provider budgets and 402/429/5xx cooldown handling.
- Gecko source; DexPaprika fallback for token-ratio charts.
- Volume is deliberately unavailable where provider units are unverified or inversion prevents an exact conversion.

Reuse these patterns where appropriate. Do not reverse the deliberate null-volume decision just to obtain a relative-volume feature. Do not silently substitute a token aggregate series for an exact pool, or an exact pool for a token aggregate.

The inspected source tree did not reveal an existing general-purpose trading-feature/indicator module. Recheck before adding one; another session may have progressed.

### D. Relevant tests

- [test/klines.test.ts](test/klines.test.ts)
- [test/poolOhlcv.test.ts](test/poolOhlcv.test.ts)
- [test/poolOhlcvFallback.test.ts](test/poolOhlcvFallback.test.ts)
- Adapter tests and the schema-aware PostgreSQL fake used by this repo.

Do not claim the existing tests already prove trading-quality candles. Existing fixtures were designed for their present contract.

## 4. Required capabilities to specify

The following are acceptance objectives. Exact endpoint names, field names, limits, freshness tolerances, and migration details remain to be specified and reviewed; they are not a finalized API.

### 4.1 Real, closed, identifiable candle series

Each feature must derive from one explicitly identified series:
- Chain and token contract identity.
- Pool/venue identity where the series is pool-specific.
- Base/quote orientation and price denomination.
- Interval and UTC bucket convention.
- Provider/source scope: exact pool, token aggregate, or other documented scope.
- A bounded evaluation time and the latest eligible closed candle.

For trading features, reject or exclude malformed OHLC, non-finite/non-positive prices, invalid ordering, invalid timestamps, future buckets, and unclosed candles. Enforce high >= max(open, close), low <= min(open, close), and high >= low.

Establish the provider's confirm/open-time semantics. Apply bucket-close cutoffs and a documented publication-lag policy. Do not blindly remove the last array element, because a provider can already return only closed bars.

Normalize order and duplicate timestamps deterministically. Distinguish identical duplicates from conflicting revisions. Document late corrections rather than pretending every closed provider bar is immutable forever.

### 4.2 Gaps, sparse trading and aggregation

A missing bar is not automatically a zero-volume bar. A zero may be accepted only with source evidence that the interval was observed and had no trades.

Do not random-walk, interpolate, forward-fill prices, or fabricate volume to satisfy warm-up. If a presentation layer needs synthetic display points, they must not enter the trading-feature history.

Track required versus available bars, time coverage, latest close, and gaps. For the initial trading contract, recommend requiring a contiguous valid warm-up window; any sparse-series policy needs explicit definition.

If deriving 15m/1h from smaller real bars, require all expected child intervals, consistent identities/units, and closed children. OHLC aggregation is first open/max high/min low/last close; volume is summed only when every required child has valid volume of the same denomination. Mark the result as aggregated and retain its source lineage.

Do not upsample coarse candles into finer history.

### 4.3 Relative volume

Suggested first definition for review:
- rvol20 = volume of the latest closed candle / arithmetic mean of the preceding 20 closed candles.
- Exclude the target candle from its own baseline.
- All 21 candles must use the same series identity, interval and volume unit.
- Zero/unknown baseline produces unavailable with a reason, never Infinity or an invented large signal.
- Unknown target volume produces unavailable. Observed target zero with a positive baseline may correctly produce zero.

Expose baseline period, actual usable count, baseline value, latest volume and evaluation close time, with documented units. Rolling volume24h must never be accumulated into a five-minute bar or compared directly with interval turnover.

A ratio can use consistent base-token or quote-token volume; cross-token absolute volume ranking additionally needs a common denomination. Do not claim accurate historical USD volume by multiplying total base volume by a single closing price.

### 4.4 Momentum and EMA

Suggested initial feature set, subject to spec:
- Ten-period rate of change: (close[t] / close[t-10] - 1) * 100.
- EMA12 and EMA26, plus normalized spread: (EMA12 / EMA26 - 1) * 100.
- Optionally price distance from an EMA if the consumer actually needs it.

Use completed bars from the same series. Define minimum history, EMA seed, recurrence, precision and rounding. A possible seed is the SMA of the first N prices and alpha = 2 / (N + 1), but that choice must be pinned.

EMA depends on earlier history and initialization. Different request limits must not silently produce different values for the same advertised feature version/evaluation time. Specify bounded history or persistent seed state and how restart/provider changes affect it.

Label numeric facts, not “bullish,” “buy,” “safe,” or model confidence. Strategy thresholds remain in execution.

### 4.5 ATR and normalized volatility

Suggested initial definition:
- TR[t] = max(high[t] - low[t], abs(high[t] - close[t-1]), abs(low[t] - close[t-1])).
- ATR14 uses 14 true ranges and a pinned Wilder seed/smoothing convention.
- ATR% = ATR14 / latest closed close * 100.

Under that definition, initial calculation needs at least 15 candles to obtain 14 true ranges. Missing previous close, gaps, invalid prices, or incomplete warm-up produce unavailable. Zero ATR on a genuinely flat, valid observed series is distinct from unavailable.

ATR units follow the price denomination; ATR% is a normalized statistic for that exact interval, not an annualized or daily volatility estimate. Explicitly label the interval.

Do not choose position sizes, stops, leverage, or trading budgets in this module.

### 4.6 Provenance and feature availability

Make it possible for execution to answer:
- Which provider, token/pool, currency and interval produced the inputs?
- When were the underlying bars observed/closed, when were they fetched, and when was the feature calculated?
- What calculation version, parameters and warm-up history were used?
- Are all required inputs complete, valid and fresh?
- What is unavailable and why?
- Did the provider or series definition change?

Recommend a stable feature-version identifier and an input-snapshot identifier/hash or equivalent reproducible reference, with bounded metadata. No keys or credential-bearing URLs in provenance.

Distinguish cache write time from market-data time. Returning stale data must retain the original observation age. A recent HTTP 200 carrying old candles must not become a fresh trading feature merely because it was fetched now.

Per-feature availability is preferable to a single opaque confidence number. For example: valid price series can support momentum/EMA/ATR while volume units remain unverified, leaving relative volume unavailable.

Illustrative reason categories, not a committed wire enum: insufficient history, gap, stale input, unclosed data, invalid bar, unknown volume unit, zero baseline, identity/source discontinuity, provider unavailable.

### 4.7 Bounded delivery

Prefer shared, cached feature computation over per-agent repeated upstream calls. Determine whether the final surface is an additive versioned feature endpoint, a bounded batch endpoint, or an extension of existing metadata after checking consumers.

Document:
- Batch size, series/history caps and payload bounds.
- Refresh cadence tied to candle closure.
- Shared leases/coalescing across replicas.
- Negative-cache and cooldown behavior.
- Partial batch failures keyed by requested identity, never response position.
- Cache key including every semantic parameter.
- Feature expiry derived from input age, not only calculation time.
- Behavior when a provider cannot serve long enough history under the existing 500-bar bound.

Preserve one unavailable token as a local failure where the contract permits it. Do not let arbitrary client addresses create unbounded keys, queues, fetches or paid usage.

## 5. Initial scope and explicit non-goals

Recommended first evaluation scope: 5m, 15m and 1h closed history for a bounded existing BSC token universe with source coverage. Existing supported chart intervals remain unchanged.

Included:
- Strengthen or reuse real-candle normalization for trading use.
- Deterministic relative volume, momentum/EMA, ATR.
- Complete provenance, units, availability, coverage and freshness.
- Versioned/shared storage and bounded delivery.
- Offline tests and a consumer-readable contract.

Not included:
- New BUY/SELL signals or “expected edge” conversion.
- LLM/model changes, stop/trailing/rotation/sizing behavior.
- Session grants, token-universe widening, transaction execution.
- Net-PnL accounting or trade journaling in the data plane.
- Social/news/KOL/whale features.
- New paid APIs or paid RPC.
- CEX history as a silent substitute for the actual BSC asset/venue.
- Full-chain trade indexing or fabricated bonding-curve OHLCV.
- Enabling/deploying services in this handoff task.

Coverage gaps for newly launched, pre-graduation, thin, or unindexed tokens must be reported honestly. Do not turn lack of history into permission to trade or alter eligibility rules.

## 6. Test and acceptance checklist for the implementation session

Use offline fixture tests, including adversarial cases, not tests that merely repeat the implementation.

1. Known valid closed-bar sequences with independently computed expected rvol, ROC, EMA and Wilder ATR.
2. Boundary time exactly at close, publication lag, future/open bars, clock skew.
3. Missing numeric fields, NaN/Infinity, malformed OHLC, invalid/duplicate/conflicting timestamps.
4. Missing bars versus source-confirmed zero-volume bars.
5. Warm-up failures, zero baseline, unknown volume and real flat-market ATR.
6. Target candle excluded from relative-volume baseline.
7. Different client limits return consistent advertised feature values.
8. Base/quote inversion, price/volume denominations, duplicate symbols on different contracts.
9. Source switch and pool switch cannot silently splice incompatible history.
10. Partial or stale aggregation cannot become a complete fresh bar.
11. Provider errors/empty responses/old successful responses retain stale or unavailable status without restamping observation time.
12. Volume-unavailable pool fallback keeps relative volume unavailable while valid price-only features remain explainable.
13. Concurrency, restart and cross-replica lease/budget behavior; no burst amplification under many agents.
14. Bounded batch partial failures and response identity association.
15. Existing /klines and pool-OHLCV contracts/tests remain compatible.
16. Real PostgreSQL semantics represented by the repo's schema-aware fake; migrations tested if introduced.
17. No secrets in errors, metadata, snapshots or logs.
18. No future data in an as-of replay: event time alone is insufficient if the source revision was not available until later.

Run npm run typecheck, npm run build and npm test as appropriate for the implementation and report actual totals/failures. Do not infer a passing baseline from old documentation. Live provider probes, if later authorized, are read-only and separate from automated tests; record provenance without storing credentials.

## 7. Decisions the specification must settle

The user has authorized the handoff objective, not an exact schema. The implementation session should recommend and resolve:
- Token-aggregate versus exact-pool feature series and deterministic selection when multiple pools exist.
- Which current provider can prove closed-bar and volume semantics at the needed history depth.
- Additive API/versioning and preservation of existing chart clients.
- Strict contiguous warm-up policy, sparse-trading handling and correction/revision policy.
- Calculation parameters/seed/rounding, history retention and request-limit invariance.
- Freshness/publication tolerances by interval and source.
- Initial coverage, bounds, scheduling and operational cost.
- How execution consumes unavailable features without silently changing trading behavior.

These are not reasons to stop the documentation task; they are the unresolved design choices to carry into the next spec/review.

## 8. Why the winning-agent research leads to this handoff

- **Neural Alpha:** feature-first pipeline and ATR sizing are useful references, but synthetic history and rolling-volume accumulation show why the source contract must be stricter. [Signals](https://github.com/ClipXonchain/neural-alpha/blob/2b4d334e5be3c6e3ce64979bcea3c73c3e8bd983/neural-alpha/src/strategy/signals.ts), [market history](https://github.com/ClipXonchain/neural-alpha/blob/2b4d334e5be3c6e3ce64979bcea3c73c3e8bd983/neural-alpha/src/data/market.ts#L269).
- **Genesis:** multiple signal categories and replay metrics do not establish quality; its backtest “win” is based on conviction rather than prices. Features must be reproducible facts, not self-reported performance. [Backtest](https://github.com/rishu4436/Genesis/blob/372bc91d3cc318c42fd35cec1ab182a5511004e2/genesis/strategy_skill/backtest.py#L112).
- **Gridora:** the domain classifier supports previous bias, but its CMC caller omits it and substitutes zero funding. Preserve missingness and ensure every claimed input actually reaches the consumer. [Provider](https://github.com/yeheskieltame/gridora/blob/10828432f1e182b0fa02095a1cf6970542fabcf1/backend/src/gridora/adapters/signals/cmc.py#L49).

## 9. Exact next step and delivery back to execution

Start with a short inventory of existing token/pool OHLCV semantics and a written feature-contract proposal. Reuse the strong pool-OHLCV machinery where suitable; do not rebuild the service from scratch. Follow the data-plane repository's applicable review process.

After an independently checked implementation, hand back:
- Final endpoint/schema/version and example complete/partial/unavailable responses.
- Calculation definitions and units.
- Supported coverage, intervals, warm-up and data-age guarantees.
- Source/provenance and discontinuity behavior.
- Bounds/caching/budget policy.
- Test/build results and any measured read-only source evidence.
- Deployment status explicitly distinguished from local implementation.

Execution will need a separate reviewed consumer change in D:\4lpha-execution to add these facts to its prompt/rules. This data handoff does not authorize that change.

**Session record:** authored by Codex after remote winner-code research and read-only inspection of the local data-plane code. Only this handoff document is to be created in this repository by the current task; no implementation, config, credentials, commit or deployment changes. No application tests were run for this documentation-only delivery.
