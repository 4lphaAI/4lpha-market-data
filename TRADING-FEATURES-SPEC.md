# Trading features v1 — implemented contract

Update: [v2 quality fallback, per-indicator warm-up and producer diagnostics](TRADING-FEATURES-V2.md)
is available additively. Its default marketplace watchlist supersedes the old
automatic LP-seed default described below; explicit operator lists are preserved.

Implements the data-plane scope of `TRADING-FEATURES-HANDOFF-2026-09-06.md`.
Reuses exact-pool GeckoTerminal OHLCV, its store, refresh coalescing, replica
leases, rate budgets and token-ratio DexPaprika fallback. No new provider,
paid access, RPC indexer or execution policy is introduced.

## Series and coverage

The initial surface is **BSC exact-pool**, with native **5m, 15m, 1h** candles.
It is not a token aggregate. Each response identifies pool, base token, quote
token, source, denomination and interval. A caller must match the base address
to the asset it intends to analyze; matching symbols is insufficient. For USD,
the existing chart's provider base is retained unless the operator specifies
`tokenAddress` in the watchlist. The same Gecko adapter then requests actual USD
candles for that token and verifies pool membership; it does not reciprocate
the other token's USD price. Separate token-address keys preserve old chart
clients. For token ratios, an explicit `tokenAddress` selects the base token;
otherwise the existing sorted-address orientation is retained. Both providers
are requested in their native ratio orientation and normalized locally to the
same target (reciprocal OHLC with high/low exchanged when necessary). No automatic pool switching, USD
conversion, cross-provider candle splicing or token-wide claim is made.

The producer defaults to **token-ratio** history for the existing tracked pool
seeds, capped at 10, enabling Gecko → DexPaprika fallback from the first read. The
operator can set `trading:features:v1:watchlist` in SnapshotStore to an array of
`{ "pool": "0x...", "currency": "usd" }` entries. `token` is the other allowed
currency. One denomination per pool, at most 10 distinct pools; invalid config
fails the job without replacing the existing index. An explicit empty array
disables this producer's watchlist. These are data coverage choices, never
eligibility, safety or investment recommendations. HTTP has no registration or
mutation route: arbitrary clients cannot allocate keys, queues or upstream work.

Example explicit ratio target with fallback:

```json
[{"pool":"0x172fcd41e0913e95784454622d1c3724f546f849","currency":"token","tokenAddress":"0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"}]
```

This requests WBNB/USDT from either provider. Setting `currency: usd` explicitly
still requests WBNB/USD from Gecko and preserves USD cache fallback only.
Existing operator watchlists retain their selected denomination (omitted
currency in an explicit watchlist retains USD for compatibility). The automatic
seed default changes to token ratios, using separate cache keys from old USD
observations. The index exposes the selection; each result reports the actual
base and quote contracts. Consumers must recheck denomination and series ID.
Ratio returns and ATR% describe relative performance, not USD performance.
Unknown Dex volume remains unavailable; six price metrics can continue when
the fallback supplies sufficient valid closed history.

This bounded initial subset deliberately does not cover every eligible token.
Young pools need real history; sparse pools can fail contiguous warm-up. Tokens
without an indexed pool, including pre-graduation tokens, remain outside this
surface. No synthetic bonding-curve history is constructed. Consumers can list
the current coverage before querying it.

## Closed-bar quality and time

Timestamps are UTC bar-open milliseconds. Eligible bars must end no later than
`floor((evaluationTime - 15 seconds) / interval) * interval`. This is a pinned
publication-lag policy based on open time and duration, **not** a provider finality
flag or a guarantee of immutability. A provider that already returns only closed
bars does not lose its last bar. Future/open bars are excluded. Fractional,
unaligned or invalid timestamps and non-finite/non-positive/inconsistent OHLC
are rejected from feature inputs. The Gecko adapter rejects fractional provider
timestamps before its existing milliseconds conversion.

Provider evidence:
- [GeckoTerminal public API](https://api.geckoterminal.com/docs/index.html)
- [CoinGecko on-chain pool OHLCV contract](https://docs.coingecko.com/reference/pool-ohlcv-contract-address)
- [DexPaprika pool OHLCV](https://docs.dexpaprika.com/api-reference/pools/get-ohlcv-data-for-a-pool-pair)

Gecko requests explicitly disable empty-interval filling. Its positional
OHLCV and selected USD/quote denomination are reused. Missing intervals stay
missing. An observed zero volume is different from an absent bar or null volume.
The existing unverified Dex volume and volume after price inversion remain null.
No rolling `volume24h` field is used here.

Identical duplicates are harmless; conflicting duplicates quarantine their
timestamp and make affected observations unavailable. The chart keeps its
existing display behavior but now carries internal conflict evidence. Dex
conflicts reject the refresh before deduplication. Inputs are sorted before
calculation, with contiguous warm-up required separately for each metric.

The first version only uses native intervals, so it does **not** invoke the old
chart-only 1h-to-4h aggregation helper. That helper can serve partial display
buckets and is not trading input. 4h is rejected by the new API. There is no
upsampling or synthesized history. Any future aggregation extension must prove
every expected child is valid, closed and from identical units/series before
using first-open/max-high/min-low/last-close and complete-volume sums.

## Formulas and initialization

All values are unrounded IEEE-754 doubles. Non-finite results are unavailable,
never Infinity. The window is anchored to eligible closed UTC buckets, bounded
to the latest 120 buckets. No client `limit`, custom period or historical `asOf`
is accepted by v1.

| Output | Definition | Required consecutive bars |
|---|---|---:|
| `roc10Pct` | `(C[t]/C[t-10]-1)*100` | 11 |
| `rvol20` | `V[t] / mean(V[t-20..t-1])` | 21 |
| `ema12`, `ema26` | SMA of first N closes, then `alpha*C + (1-alpha)*previous`, `alpha=2/(N+1)` | 120 |
| `emaSpreadPct` | `(EMA12/EMA26-1)*100` | 120 |
| `atr14` | TR=`max(H-L,abs(H-prevC),abs(L-prevC))`; average first 14 TRs, then `previous*13/14 + TR/14` | 120 |
| `atrPct` | `ATR14/latestClose*100` | 120 |

ATR mathematically needs at least 15 bars to initialize; **v1 deliberately uses
120** for its fixed seed/warm-up contract, like the EMAs. It does not shorten
the window for new tokens. Every invocation starts from the same bounded
window: restarts, earlier retained history and client request limits cannot
change an advertised version at the same input/evaluation time. Changing the
history/seed policy requires a new feature version.

RVOL excludes its target from the baseline. Zero baseline, invalid volume or
unknown units return null with a reason. Observed target zero with positive
baseline produces zero. RVOL's usable count requires valid volume; price
features can remain available when RVOL is unavailable. ATR zero on a fully
observed flat series is valid. ATR follows price units; ATR% labels the actual
interval and makes no daily/annual volatility claim.

## Observation, corrections and reproducibility

Each result includes `seriesId`, `snapshotId`, `calculatedAt`, `evaluationClose`,
`refreshAfter`, `expiresAt`, parameters, coverage and per-metric availability.
`identity.observedAt` is the existing OHLCV store observation time, not the
feature write time. A recent HTTP response containing old bars cannot renew
their market age.

The input snapshot ID hashes the exact bounded input observation, version and
evaluation cutoff. Series identity includes provider, pool, both contracts,
denominations and interval. A source or pool change produces a different
identity, and the entire new observation is computed independently. Consumers
can compare series IDs; they must not splice histories across them.

The existing OHLCV refresh only publishes when its latest bar advances. A
same-latest-bar correction therefore becomes visible at the next advancing
provider refresh. The feature retains the exact input used, not a claim that
historical provider bars never change. The current input and calculation can be
retrieved by snapshot ID; subsequent updates replace it. Retention is **latest
observation per configured series**, not a backtest archive. Consumers needing
long-term replay must save the returned evidence when consuming a feature.
Missing/superseded IDs return 404, never today's revision under an old ID.

`calculateFeatures(input, evaluationTime)` refuses observations captured after
evaluation. Replay at the original `calculatedAt` reproduces the stored result.
Bars that were still open when their observation was captured stay excluded,
even if replay occurs after their nominal close.
No API accepts arbitrary historical as-of requests: provider event time alone
cannot establish when a corrected history was known. No credentials or
provider request URLs enter the evidence.

## Delivery and scheduling

All routes use the existing `x-dp-token` middleware and `{data,error?,meta?}`
envelope. They read the store only, including cache misses.

| Route | Behavior |
|---|---|
| `GET /trading/features/v1/pools` | Current watchlist, denominations, intervals and index age |
| `GET /trading/features/v1/:pool?interval=5m` | Latest feature snapshot without raw candles; pending/outside watchlist is 404 |
| `GET /trading/features/v1?pools=0x...,0x...&interval=5m` | Maximum 10 input addresses; results keyed by lowercase pool, local failures retained |
| `GET /trading/features/v1/:pool/input?interval=5m&snapshotId=...` | Exact retained input plus calculation for reproducibility |

Unknown query parameters are rejected. A batch with valid syntax is 200 even
when some pools are unavailable. Duplicate addresses are deduplicated after
enforcing the 10-input bound. An unknown pool never causes a fetch. A known pool
whose observation has expired still exposes provenance, with every metric
unavailable and `stale_input`. A backwards clock cannot expose a future
observation as usable.

The `trading-features` job runs every 60 seconds with up to 2 seconds jitter,
30-second timeout, and one shared 60-second producer lease. It admits at most
four due series per pass, oldest-attempt first. One bounded producer-state
object persists admission before IO, so failures/restarts do not starve unseen
series. Failures retry no sooner than 60 seconds; provider cooldowns and budgets
remain enforced by the existing OHLCV transport. Partial failures do not erase
other results; complete upstream failure marks the job unhealthy. The job and
feature index appear on `/status`.

Refresh is due at `latestClose + interval + 15 seconds`. Usability expires at
that time plus a **75-second scheduling grace**. During this explicit grace,
the preceding completed observation can still be usable; `evaluationClose`
makes this visible. This accommodates one scheduler tick, not an indefinite
stale fallback. A chart can continue displaying older prices after trading
metrics expire. Empty/failed responses never restamp an existing feature.

At the maximum 10 pools across these intervals, ideal warm demand is about
`10*(1/5+1/15+1/60) = 2.83` Gecko requests/minute, before failures. The producer
admits at most 4 series/minute; shared Gecko budget is still 8 HTTP/minute.
Charts, retries, provider throttling, and multi-request Dex fallbacks compete
for these budgets. Coverage/freshness is reported, not guaranteed. Initial
30-series admission takes at least eight passes; failed sources can extend it.
No new paid feed or full-universe polling is implied.

Features use `trading:features:v1:<pool>:<interval>:<currency>[:<tokenAddress>]` keys. Calculation
parameters are fixed by v1; raw histories reuse `pool:ohlcv:v2` keys independent
of requested limits. Feature evidence uses a 30-day dead-after TTL in existing
bigint columns; there is no schema migration. Postgres coordinates replicas;
MemoryStore is process-local. Operator watchlist changes may leave historical
keys, but public requests cannot allocate any.

## Consumer integration boundary

The existing execution client has no feature method yet. This change supplies
the data-plane contract; it does not change prompts, BUY/SELL logic, stop rules,
eligibility or transaction behavior in the execution repository.

Consumer sequence: list coverage; select the intended pool and verify base/
quote/currency; fetch batch snapshots server-side; use only metrics with
`available: true`; retain their IDs/evidence if audit replay is required.
Unavailable is unknown, never zero or permission to trade. Strategy thresholds
and any decision on missing features belong to execution.

## Verification

`test/tradingFeatures.test.ts` covers independent shock arithmetic, fixed-window
initialization, boundaries/publication lag, observation-time replay, unordered
and conflicting duplicates, invalid OHLC/timestamps, gaps, missing/zero volume,
flat ATR, overflow, source identity, inversion/fallback, bounded/fair scheduling,
cancellation, replica leases, Postgres persistence/replay, clock reversal,
authentication and store-only partial batch APIs. Existing chart and token
kline tests continue to exercise their unchanged contracts.

Run `npm run typecheck`, `npm run build`, and `npm test`. Automated tests stay
offline. Passing fixtures do not establish live provider coverage or that this
version is deployed.

Optional read-only live diagnostic (isolated MemoryStore, three USD requests,
no dotenv or trading): `node --import tsx scripts/trading-features-check.ts`.
An optional positional pool address overrides the existing USDT/WBNB reference.
A second optional positional token address selects the actual USD base token.
A third optional positional argument selects `usd` (default) or `token`.
For an isolated fallback test append `token --simulate-gecko-429` after pool and
token address: only Gecko requests are locally replaced by 429; Dex requests
are real. Production cooldowns and stores are never changed by this probe.

Fallback update validation: typecheck/build and **537 offline tests** pass,
including opposite provider orientations, explicit ratio targets, forced 429,
all six price metrics, unavailable RVOL, shared cache hits, and default/explicit
watchlist compatibility.
Live isolated fallback probe (2026-09-06): locally simulated Gecko 429, real
DexPaprika WBNB/USDT responses, 120 contiguous bars on 5m/15m/1h. All six price
metrics available; RVOL reports `unknown_volume_unit` as intended.

Validated 2026-09-06: typecheck/build and all **535 offline tests** pass. A read-only
probe of `0x172fcd41e0913e95784454622d1c3724f546f849` returned 120 contiguous valid
bars and all seven available metrics for 5m, 15m and 1h. Both the default
USDT/USD series and explicit WBNB/USD series were checked. This is local live
provider evidence, not a deployment or a coverage guarantee for other pools.
