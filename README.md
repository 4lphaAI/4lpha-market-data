# 4lpha Data Plane

Standalone data-plane service for a BNB Chain agent marketplace.

Phase 0 built the core: a snapshot store with read-time freshness, a fault-isolated
job scheduler, and a small HTTP surface. Phase 1 adds the market-data layer —
provider adapters, a three-lane token universe, a read-through kline chain, and
thin read endpoints on top of them.

## Architecture

```text
  adapters/            jobs/                    core/
 ┌──────────┐   ┌────────────────────┐   ┌──────────────┐
 │ fourmeme │──▶│ fourmeme-ranking   │──▶│  Scheduler   │──── put() ──┐
 │ binance  │──▶│ binance-universe   │   │  timeout,    │             │
 │          │──▶│ binance-prices     │   │  jitter,     │◀ health ────┤
 │ onchainos│   └────────────────────┘   │  no-overlap  │             ▼
 │ birdeye  │                            └──────┬───────┘      ┌─────────────┐
 └────┬─────┘   query/klines.ts  ────── read-through ─────────▶│ SnapshotStore│
      └────────────────────────────────────────┐               │  Memory | PG │
                                        ┌──────┴───────┐       └─────────────┘
                                        │  Hono app    │  /universe /tokens
                                        │  (server.ts) │  /klines /snapshots
                                        └──────────────┘  /health /status
```

- **Store** (`src/core/store.ts`) — key/value snapshots plus job health.
  `MemoryStore` for dev and tests, `PostgresStore` (tables `dp_snapshots`,
  `dp_job_health`, created idempotently on init) when `DATABASE_URL` is set.
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

## Data sources

| Adapter | Credentials | Used for |
| ------- | ----------- | -------- |
| `fourmeme` | none | meme lane universe + market snapshots |
| `binanceWeb3` | none | coins lane universe, live quotes, Sintral klines |
| `onchainos` | `OKX_*` | preferred klines and price-info |
| `birdeye` | `BIRDEYE_API_KEY` | OHLCV fallback of last resort |

Kline reads (`src/query/klines.ts`) check the store first and only on a miss walk
**OnchainOS → Sintral → Birdeye**, writing the first success back (fresh 5 min,
dead 60 min). If every source fails, a stale stored record is returned rather than
nothing, and `meta.staleness` says so. Interval translation between the three
providers' notations lives in that one file.

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

`binance-prices` reads its address set from the `tracked:addresses` snapshot and
falls back to the bStocks list. Live quotes are range-checked against the stored
price before being merged, so a bapi glitch cannot poison a snapshot.

## API

Every response uses the `{ data, error?, meta? }` envelope.

| Route | Response |
| ----- | -------- |
| `GET /health` | `{ data: { ok: true, uptimeSec } }` |
| `GET /status` | `{ data: { jobs: JobHealth[], startedAt } }` |
| `GET /universe?lane=` | merged `UniverseEntry[]`, `meta.lanes` carries per-lane count and staleness |
| `GET /tokens/:address` | stored `TokenSnapshot` with `meta.asOf` / `meta.staleness`, 404 when unknown |
| `GET /klines/:address?interval=1m&limit=100` | `Candle[]`; may hit upstream on a miss. `interval` ∈ 1m,5m,15m,1h,4h,1d; `limit` 1..500 |
| `GET /snapshots/:key` | raw record; debug only, keys limited to `heartbeat`, `universe:`, `token:`, `klines:` |
| anything else | `404 { error: { code: "not_found" } }` |

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
  Without them the kline chain simply starts at Sintral.
- `BIRDEYE_API_KEY` — enables the final kline fallback.

`.env` is loaded natively by Node at startup; there is no dotenv dependency, and no
environment value is ever logged.
