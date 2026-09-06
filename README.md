# 4lpha Data Plane

Standalone data-plane service for a BNB Chain agent marketplace.

Phase 0 built the core: a snapshot store with read-time freshness, a fault-isolated
job scheduler, and a small HTTP surface. Phase 1 added the market-data layer —
provider adapters, a three-lane token universe, a read-through kline chain, and
thin read endpoints. Later phases add tiered token security, PancakeSwap V3 yield,
and exact Venus Core Pool v2 observations read straight from BSC.

## Architecture

Trading feature support: [v2 contract and migration](TRADING-FEATURES-V2.md),
[preserved v1 contract](TRADING-FEATURES-SPEC.md).
`/trading/features/v1` serves store-only ROC, EMA, Wilder ATR and relative volume
over existing exact-pool OHLCV, with input provenance and per-feature availability.
The bounded `trading-features` job reuses the existing providers and budgets.
Its default major/equity reference series use token ratios with quality-aware Gecko → DexPaprika fallback;
explicit USD watchlists remain USD. The contract documents base-token selection.

```text
  adapters/              jobs/                     core/
 ┌──────────┐   ┌──────────────────────┐   ┌──────────────┐
 │ fourmeme │──▶│ fourmeme-ranking     │──▶│  Scheduler   │──── put() ──┐
 │ binance  │──▶│ binance-universe     │   │  timeout,    │             │
 │          │──▶│ binance-prices       │   │  jitter,     │◀ health ────┤
 │ onchainos│   │ pancake-pools        │   │  no-overlap  │             │
 │ gmgn     │   │ venus-core-*         │   └──────┬───────┘             ▼
 │ pancake  │   └──────────────────────┘                        ┌──────────────┐
 │          │   query/klines.ts    ───── read-through ─────────▶│ SnapshotStore│
 │ venus    │   query/security.ts  ───── read-through ─────────▶│  Memory | PG │
 └────┬─────┘                                                   └──────────────┘
      │        chain/rpc.ts ── BSC endpoint rotation ──┐
      └────────────────────────────────────────────────┤
                                        ┌──────────────┴┐  /universe /tokens
                                        │  Hono app     │  /klines /security
                                        │  (server.ts)  │  /pools /venus
                                        └───────────────┘  /snapshots /health /status
```

- **Store** (`src/core/store.ts`) — key/value snapshots, job health, durable
  tracking references, and cross-replica scheduler leases.
  `MemoryStore` for dev and tests, `PostgresStore` (tables `dp_snapshots`,
  `dp_job_health`, `dp_tracking_references`, and `dp_scheduler_leases`, created
  idempotently on init) when `DATABASE_URL` is set.
  `createStore()` picks the backend and logs which one, never the URL.
- **Freshness** is derived at read time, never stored: a record's age is compared
  against its `freshForMs` / `deadAfterMs` to yield `fresh | stale | dead`. Readers
  therefore always see honest staleness, even for a long-idle producer.
- **Scheduler** (`src/core/scheduler.ts`) — one timer per job. Each run is wrapped in
  a timeout; a throw or timeout records a failure and scheduling continues. The next
  tick is armed before the run starts, and a tick is skipped while the previous run
  is still in flight, so a slow job cannot pile up.
- **Models** (`src/core/models.ts`) — `UniverseEntry`, `TokenSnapshot`, `Candle`, and
  `mergeTokenSnapshot`, whose conservative rule keeps a weaker provider from erasing
  a stronger one: `null`, `undefined` and implausible zeros never overwrite a known
  price, market cap or holder count, while a real `0` volume or flat price change does.
- **Adapters** (`src/adapters/`) — plain async functions with an injectable `fetchFn`,
  a 12s deadline combined with the caller's `AbortSignal`, and sanitized typed errors
  (`AdapterError`, `MissingCredentialsError`) that never carry a URL or a credential.
- **Server** (`src/server.ts`) — `createServer(deps)` returns a Hono app and never
  binds a port, so tests drive it through `app.request()`.
- **RPC** (`src/chain/rpc.ts`) — `withBscClient(fn)` runs a whole read set against
  one BSC endpoint and replays it against the next if that one fails. Replaying is
  safe because every read is a `view` call, and whole-callback rather than
  per-request keeps a read set internally consistent instead of half-answered by
  two chains at two block heights. Endpoint URLs are never logged.

## Data sources

| Adapter | Credentials | Used for |
| ------- | ----------- | -------- |
| `fourmeme` | none | meme lane universe + market snapshots |
| `binanceWeb3` | none | coins lane universe, live quotes, Sintral klines |
| `onchainos` | `OKX_*` | preferred klines and price-info, primary token-scan |
| `geckoterminal` | none | primary exact BSC pool OHLCV for marketplace charts |
| `dexpaprika` | optional `DEXPAPRIKA_API_KEY` | exact-pool token-ratio OHLCV fallback; not a USD candle feed |
| `gmgn` | `GMGN_API_KEY` | secondary security scan, holder distribution |
| `pancake` | none | V3 pool state; explorer API, on-chain fallback |
| `venus` | none (`BSC_RPC_URL*`) | Core Pool health factors |

Kline reads (`src/query/klines.ts`) check the store first and only on a miss walk
**OnchainOS → Sintral**, writing the first success back. Exact-pool reads use
GeckoTerminal behind the same store. Freshness follows the candle interval (20s
for 1m through 30min for 1d); if an upstream fails, a stale stored record is
returned rather than nothing, and `meta.staleness` says so.

## Security tiering

`src/query/security.ts` reads through the store the same way, but asks **both**
scanners and combines them conservatively: the worse verdict wins and the flag
sets are unioned, so neither scanner can vouch for a token the other flagged.

`unavailable` is a first-class verdict, deliberately ranked *below* every real
one, so a scanner that is down or has never seen the token cannot mask a real
answer — and cannot be mistaken for approval either. `getSecurity` therefore never
throws and never returns null: the worst case is `unavailable`.

TTLs are per lane, because the underlying risk moves at different speeds:

| Lane | Fresh for | Dead after |
| ---- | --------- | ---------- |
| `meme` | 5 min | 60 min |
| `coins`, `bstocks` | 24 h | 7 d |

GMGN has no polling job on purpose: it answers in ~400ms with large payloads and
escalates repeated rate-limit violations into a temporary *IP* ban. It is called
on demand only, and after a 429 the adapter refuses to dial again until the
upstream's own `x-ratelimit-reset` has passed.

## Pools

`pancake-pools` reads PancakeSwap's keyless cached explorer API — the same
service their own web app reads, which is what makes matching the APR a user
sees on pancakeswap.finance a property of the architecture rather than of a
formula kept in sync by hand. BSC V3 only.

A pool's APR is two independent things, and they are never conflated:

- `lpFeeApr24h` / `lpFeeApr7d` — trading fees, taken verbatim from the
  explorer's `apr24h` / `apr7d` and converted from a fraction to a percent. It
  is **not** derived from the `feeUSD24h` in the per-pool payload: that figure is
  gross of the ~33% protocol fee, so annualizing it overstates what an LP
  receives by roughly 1.5x and does not match PancakeSwap's UI.
- `cakeFarmApr` — CAKE emissions, read from MasterChefV3
  (`0x556B9306565093C855AEA9AE92A594704c2Cd59e`) over the public BSC endpoints:
  `cakePerSecond × allocPoint / totalAllocPoint × 31_536_000 × cakePrice / tvl`.
  `0` means the pool earns no CAKE; `null` means nobody asked.

`combinedApr` is their sum — the APR column of PancakeSwap's pool list — and is
`null` unless both components are known, because a sum missing a term reads as a
smaller yield rather than as a gap. `aprSources` names the components that are
actually present. Nothing else is folded in: third-party incentive APRs and
points campaigns are out of scope for this plane.

Pools arrive two ways. `pools/list` pages the lane 50 rows at a time — the
endpoint truncates to 50 whatever `limit` asks for, so `after=<endCursor>` is
the only way to a larger set — and carries aggregates but no chain state, which
is why a lane record leaves `liquidity`, `sqrtPriceX96` and `tick` `null`.
`pools/farming` returns every farmed BSC V3 pool unpaginated in one call, and is
the candidate set for the MasterChefV3 reads.

When the explorer is unavailable the adapter falls back to reading the pool
contract directly (`slot0`, `liquidity`, `fee`, `token0/1`, plus ERC-20 symbols
cached for the process lifetime). That path leaves every USD and APR field
`null`: a node knows the pool's state, not what it is worth, and an invented TVL
is worse than an honest gap.

The job publishes the whole lane as one snapshot, `universe:pools`, capped at
500 pools ingested in TVL order. That order decides which pools the lane has
room for, never which pools deserve to be in it — `/pools/top` carries every
threshold as a query parameter (`minTvlUsd`, `minAprPct`, `aprField`, `feeTier`,
`maxVolTvlRatio`, `token`, `tier`, `orderBy`, `limit`) and applies none of its
own, while `meta.cap` and `meta.ingestOrder` state that the answer is the top of
a lane rather than every pool on the chain. A filter on a field a pool does not
carry excludes it: asking for pools above 20% APR asks for pools *known* to be
above 20%, and an unpriced farm is not evidence of being below the line.

The lane fails open. A paging pass that completes replaces it; one that breaks
part-way is backfilled from what was already stored, so a bad page cannot shrink
it. A cycle that reads nothing at all throws without republishing — restamping
would age the surviving rows into looking freshly read — and every row carries
its own `asOf` next to the snapshot's.

### Tiers

A pool on PancakeSwap is permissionless, so its TVL, volume and APR are all
things anyone can manufacture — the numbers are the thing being faked, which is
why no threshold on them detects it. What cannot be faked is the provenance of
the two tokens, and that is what `tier` reports:

- `core` — both tokens are curated by somebody: the frozen eligible-token
  allowlist, the Binance Alpha snapshot, or PancakeSwap's own Extended list.
- `degen` — both tokens are accounted for and at least one came off Four.Meme or
  Flap. Requiring the other side to be known is what separates a real launchpad
  pair from a pool whose quote token nothing recognizes.
- `unclassified` — anything else, which is where the wash-traded pairs land.

`tokenOrigin` carries the evidence behind the label so it can be argued with.

Curated origins come from state the plane already holds — the frozen allowlist,
the Binance Alpha snapshot and PancakeSwap's token list — three store reads a
cycle whatever the size of the lane. Launchpad origin is read from the launchpad
contracts themselves, using the same two calls the eligibility gate makes, and
cached permanently: a launchpad mints new contracts and never adopts an existing
one, so both `fourmeme` and `none` are final answers. A token is therefore asked
about once, ever. Resolution is capped at 150 tokens per cycle, so a cold start
converges over a few minutes instead of one long burst, and a batch no endpoint
could serve is left unresolved rather than recorded as a negative — the cache
outlives the outage that would otherwise be written into it.

Labels are sticky: provenance does not change, so an `unclassified` verdict on a
pool that was labelled before says a source was unavailable, not that the pool
changed. With the frozen allowlist unreadable the pass is skipped entirely.

### Range economics

`/pools/top` answers which pool, with the APR the pool as a whole earns.
`/pools/:address/range?lower=&upper=&capital=` answers which range, for stated
capital — on a concentrated AMM a different number, and the one an LP actually
receives. The same $10,000 in USDT/WBNB 0.01%, against a pool APR of 9.82%:
±50% projects 2.62%, ±10% 12.75%, ±2% 62.42%, ±0.5% 244.39%.

Fees accrue to whatever liquidity is in range, so a position's share is
`L / (L_active + L)` — the position's liquidity follows from its capital and
bounds, and `L_active` is the pool's own. That makes the arithmetic exact
without scanning the tick array, which would only be needed to model the price
moving across ticks. The projection is then the pool's `lpFeeApr24h` scaled by
how much more liquidity per dollar the position holds than the pool average,
which keeps it anchored to the figure that matches PancakeSwap's UI rather than
drifting into an APR of its own.

What is exact and what is projected stay separate in the response. Exact: the
position's liquidity, the token amounts it needs, its fee share, and whether the
range brackets the current price — out of range it earns a real zero. Projected:
that volume repeats and the price stays put, which `assumptions` states on every
response, while `unavailable` names any missing input so a `null` is always
attributable. Impermanent loss is not modelled; it depends on where the price
ends up, and a number invented for it would sit in the payload looking exactly
like the ones that are real.

Bounds snap outward onto the fee tier's tick grid, so the placeable range always
contains the one asked for. The pool's facts — state, APR and both token prices
— are cached together for a minute, so sweeping twenty candidate ranges over one
pool costs one fetch.

## Venus Core Pool v2

`src/adapters/venusCore.ts` is a read-only, execution-grade view of Venus's BNB
Chain **Core Pool only**. Every observation pins its contract discovery, market
reads and account reads to one block and includes that block number/hash in the
payload. The catalog exposes market identities, caps/headroom, pause flags,
forced-liquidation flags, rates/APYs, oracle prices and E-mode configuration.

Account risk deliberately has two answers. `protocolSnapshot` uses stored vToken
snapshots and exact Solidity truncation, and must reconcile with both deployed
Comptroller checks. `fullyAccruedEstimate` simulates current balances; wake-up
risk uses the more conservative of the two and becomes unavailable if either
answer is incomplete. VAI debt, E-mode overrides, bounded collateral/debt prices,
liquidation thresholds and forced liquidation are all explicit.

Reward observations keep `entitlement`, simulated `payoutNow`, and
`claimAvailable` separate. The simulation is block-pinned and never broadcasts a
transaction. Owner tracking is reference-counted and capped at 1,000 distinct
owners, so one consumer cannot untrack an owner still used by another.

Wire contracts live in `schemas/`; `venus-core-account-v2.example.json` is a
mainnet-observed, no-position payload the execution plane can pin in fixtures.

## Lanes

`meme` and `coins` are discovered by jobs; `bstocks` is a static, verified list of
25 tokenized US equities on BSC (`marketHours: "us-equities"`). An address present
in more than one lane is kept once, with precedence **bstocks > coins > meme**.

## Jobs

| Job | Cadence | Writes |
| --- | ------- | ------ |
| `heartbeat` | 30s | `heartbeat` |
| `fourmeme-ranking` | 30s (±5s) | `universe:meme`, `token:<addr>` |
| `binance-universe` | 6h | `universe:coins` |
| `binance-prices` | 60s | `token:<addr>` for the tracked set |
| `pancake-pools` | 2min | `universe:pools` (the lane), `pool:<addr>` + `pools:index` for the seed set, `origins:launchpad` |
| `majors-prices` | 30s (±3s) | `token:<addr>` for WBNB, USDT, USDC, BTCB, ETH, CAKE |
| `venus-core-markets` | 60s | `venus:core:markets:v1` |
| `venus-core-risk` | 60s | block-pinned account v2 records for up to 1,000 owners |
| `venus-core-risk-hot` | 15s | conservative near-liquidation owner subset |
| `venus-core-rewards` | 5min | simulated XVS/Prime claim observations |

`binance-prices` reads its address set from the `tracked:addresses` snapshot and
falls back to the bStocks list. Live quotes are range-checked against the stored
price before being merged, so a bapi glitch cannot poison a snapshot.

`majors-prices` closes the gap the lanes leave: the majors every wallet holds
are in no universe, so `/tokens/:address` had nothing for them. It reads
PancakeSwap V3 `slot0` on the deepest pool per major (one multicall per tick),
anchors **USDT = 1.00 USD** as a stated assumption, and derives the rest in
bigint from `sqrtPriceX96`. Source is `pancake-v3-slot0`. Writes go through the
same merge path as every other producer, so a richer snapshot keeps its other
fields; a pool that fails to read simply leaves its token's record to age.
Native BNB has no address — consumers price it off WBNB.

Operator-controlled input snapshots, all following that same pattern:

| Key | Default when unset |
| --- | ------------------ |
| `tracked:addresses` | the static bStocks list |
| `pools:seed` | six verified NVDAB/TSLAB V3 pools |
| `tracked:venus-owners` | legacy input, migrated once into reference-counted v2 tracking |

`pools:index` only ever lists pools that actually have a snapshot, and keeps an
entry whose pool failed this cycle, so `/pools` can never advertise a key that
reads back as missing.

## API

Every response uses the `{ data, error?, meta? }` envelope.

| Route | Response |
| ----- | -------- |
| `GET /health` | `{ data: { ok: true, uptimeSec } }` |
| `GET /status` | `{ data: { jobs: JobHealth[], startedAt } }` |
| `GET /universe?lane=` | merged `UniverseEntry[]`, `meta.lanes` carries per-lane count and staleness |
| `GET /tokens/:address` | stored `TokenSnapshot` with `meta.asOf` / `meta.staleness`, 404 when unknown |
| `GET /tokens?addresses=a,b,…` | batch of stored `TokenSnapshot`s, each carrying its own `asOf`/`source`/`staleness`; `meta.found`/`missing`/`invalid`; unknown addresses are omitted, not 404 |
| `GET /klines/:address?interval=1m&limit=100` | `Candle[]`; may hit upstream on a miss. `interval` ∈ 1m,5m,15m,1h,4h,1d; `limit` 1..500 |
| `GET /pools/:address/ohlcv?interval=1m&limit=300&currency=token` | exact-pool closed candles; GeckoTerminal → DexPaprika → old cache for token ratios. Omitting `currency` retains USD (Gecko → old cache). Same interval set, `limit` 1..500; volume may be null |
| `GET /security/:address?lane=` | merged `TokenSecuritySummary`; `meta.sources` carries each scanner's own verdict. `lane` defaults from the universe, falling back to `meme`. May hit upstream on a miss; answers `unavailable` rather than erroring |
| `GET /pools?token=` | stored `PoolStats[]` for the operator-tracked seed set; `token` filters on either side of the pair |
| `GET /pools/top` | the 500-pool V3 lane filtered and ordered by query: `tier`, `feeTier`, `minTvlUsd`, `maxTvlUsd`, `maxVolTvlRatio`, `minAprPct`, `maxAprPct`, `aprField`, `orderBy`, `token`, `limit`; the plane sets no thresholds, `meta.cap`/`meta.ingestOrder` say so |
| `GET /pools/:address` | one `PoolStats`, read-through: lane row, then cached `pool:<addr>`, then a live explorer read; `meta.source` names which answered |
| `GET /pools/:address/range?lower=&upper=&capital=` | position economics for one range: exact `liquidity`/amounts/`feeSharePct`/`inRange`, `positionApr` scaled off the pool's fee APR; `assumptions` and `unavailable` are always stated |
| `GET /venus/:owner` | deprecated compatibility projection; response points to the v2 replacement |
| `GET /venus/core/markets` | pinned Core Pool market/risk-control catalog |
| `GET /venus/core/accounts/:owner` | stored exact protocol risk plus fully-accrued estimate |
| `GET /venus/core/accounts/:owner/rewards` | XVS/Prime entitlement and simulated payout |
| `PUT /internal/venus/core/tracked-owners/:owner/:reference` | idempotently register one consumer reference and warm the owner |
| `DELETE /internal/venus/core/tracked-owners/:owner/:reference` | remove only that consumer reference |
| `GET /snapshots/:key` | raw record; debug only, keys limited to `heartbeat`, `universe:`, `token:`, `klines:`, `security:`, `pool:`, `pools:`, `venus:` |
| anything else | `404 { error: { code: "not_found" } }` |

The `tracked:` keys stay outside the `/snapshots` allowlist: they are operator
configuration, not published data.

### Exact-pool OHLCV v2

`currency=usd` is the default, preserving the previous price denomination. It
uses **GeckoTerminal → old USD cache**. DexPaprika is not a substitute for USD
candles: its OHLCV is a pair ratio. No current USD price is multiplied into
historical candles to manufacture a USD series.

Use `currency=token` to enable **GeckoTerminal → DexPaprika → old ratio cache**.
Price is quote tokens per one base token. Base is always the lower token address
and quote the higher address (token0/token1 ordering), independent of the
provider's preferred direction. Inversion swaps reciprocal high/low as well as
open/close. The route stays exact-pool, never token-wide or another venue.

- `meta.schemaVersion: 2`, `priceCurrency`, `base`, `quote`, `volumeCurrency`,
  `volumeUnavailableReason`, `source`, `asOf`, and `staleness` describe the series.
  DexPaprika volume is **null**, not zero, until its unit can be verified. Gecko
  volume is also null when price inversion would require an inexact volume
  conversion. Consumers must tolerate nullable volume.
- Only **closed UTC candles** are returned (`closedCandlesOnly: true`), including
  for USD requests. Timestamps are epoch milliseconds, ascending and deduplicated.
  Gaps are not forward-filled. DexPaprika `4h` is aggregated from `1h` using
  first open / max high / min low / last close.
- One cache per pool/interval/currency holds the latest **500 time buckets**;
  `limit` slices that history, not another upstream/cache key. Sparse or young
  pools may have fewer candles. Dex pages by time windows of up to 365 native
  intervals, reserving a response slot for an inclusive boundary. A failed page
  discards the whole refresh rather than publishing a partial history.
- Freshness lasts until the next candle can close (minimum 60s). A refresh never
  re-stamps an unchanged latest candle or publishes stale historical data as
  fresh. If all sources fail, the prior v2 record keeps its original `asOf` and
  source; it may be `stale` or `dead`, which callers must check. No cache means
  `404 no pool candles available`, not proof that the pool does not exist.
- Old pre-v2 cache keys are deliberately not imported: they lacked an explicit
  denomination contract. Initial v2 reads are cold; later outages use the v2
  cache. Individual candles from different providers are never spliced together.

Load controls apply to this route, not the separate token `/klines` chain:

- Concurrent reads of the same chart share one refresh, including different
  limits. At most **4 distinct refreshes per process** run at once; overflow
  serves cache or returns unavailable, without an unbounded queue.
- A shared 60s retry floor also covers empty responses and cold-cache failures.
  Refresh leases use 4096 fixed hash stripes to bound control-table growth;
  a collision can delay another chart, but cannot mix its data.
- Fixed rolling slots cap upstream HTTP calls at **8/min Gecko** and **12/min
  DexPaprika**, shared across replicas using the same Postgres store. MemoryStore
  limits are process-local. These are conservative application budgets, not a
  guarantee of either provider's quota; other clients sharing the IP/key count
  against provider limits too. A cold Dex chart costs 3 requests, or 7 for `4h`.
- 429 respects `Retry-After` with a 60s minimum cooldown; 5xx backs off 15s. A 402
  quota response stops that provider until its reported reset, or next UTC month.
  Cooldowns persist through restarts with Postgres. Calls are deadline-bounded,
  with no immediate retry loop. One disconnected consumer does not abort work
  shared by other consumers.
- `/status` includes `data.poolOhlcv`: process-local cache/coalescing/admission
  counters and per-provider request/failure/budget/cooldown/429 counters. Counters
  reset on restart; admission budgets and cooldowns remain shared in Postgres.

This bounds upstream load, not unlimited free coverage of every public chart.
Keep the existing `x-dp-token` server-side authentication; apply per-user limits
at the consumer-facing gateway. HTTP RPM limits also do not eliminate monthly
credit exhaustion: the 402 path intentionally falls back to cache.

Live diagnostic (read-only upstream calls; always an isolated MemoryStore):

```bash
node --import tsx scripts/pool-ohlcv-check.ts --compare --usage
# --compare injects a local Gecko failure for a second run against real DexPaprika.
# --usage prints only HTTP status, key presence and plan, never credentials.
```

Verified locally 2026-09-03 with the configured free key: primary Gecko 300 bars
in ~1.34s; forced Dex fallback 300 bars in ~2.10s, 3 Dex calls; subsequent reads
made no upstream calls. On 300 matching USDT/WBNB 1m timestamps, median close
deviation after direction normalization was ~0.040%, maximum ~0.115%. This is a
single local smoke, not a Railway latency or sustained-load guarantee.

Provider references: [DexPaprika OHLCV](https://docs.dexpaprika.com/api-reference/pools/get-ohlcv-data-for-a-pool-pair),
[official SDK authentication](https://github.com/coinpaprika/dexpaprika-sdk-ts),
[GeckoTerminal API schema](https://api.geckoterminal.com/docs/v2/swagger.json).

## Commands

```bash
npm install
npm run dev        # tsx watch, serves on PORT (default 8080)
npm run typecheck  # tsc --noEmit
npm test           # node:test, no database and no network required
npm run smoke      # live diagnostic against real upstreams; always exits 0
npm run build      # emit dist/
npm start          # node dist/index.js
```

## Configuration

Copy `.env.example` to `.env`; every variable is optional and the service degrades
rather than failing when one is absent.

- `DATABASE_URL` — Postgres connection string. Absent means the in-memory store.
- `PORT` — HTTP port, default `8080`.
- `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`, `OKX_PROJECT_ID` — OnchainOS.
  Without them the kline chain simply starts at Sintral and `/security` loses its
  primary scanner.
- `GMGN_API_KEY` — enables the secondary security scanner and holder enrichment.
- `DEXPAPRIKA_API_KEY` — optional free key, sent only as the raw `Authorization`
  header to `api.dexpaprika.com`. Existing local alias `DexPaprika` is accepted.
  Without a key the same fallback attempts the public quota. `/usage` should
  report the expected plan: a successful data request alone does not prove the
  provider accepted a key. Copy the variable into deployment configuration when
  deploying; a local `.env` is not automatically installed on Railway.
- `BSC_RPC_URL`, `BSC_RPC_URL1..3` — BSC JSON-RPC, tried in that order and then
  falling back to keyless public endpoints. Public endpoints rate-limit and cap
  `eth_getLogs`, so configure at least one real endpoint for production.

`.env` is loaded natively by Node at startup; there is no dotenv dependency, and no
environment value is ever logged.
