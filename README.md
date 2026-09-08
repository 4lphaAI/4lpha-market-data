# 4lpha Data Plane

The market-data service for the 4lpha ecosystem. It supplies normalized BNB
Chain data to the [4lpha marketplace](https://github.com/4lphaAI/4lpha-marketplace)
and [4lpha.tech](https://4lpha.tech).

This service is data-only: it does not execute trades. Marketplace and website
backends should call this API server-side; they must not call upstream providers
directly.

## Architecture

```text
Upstreams
  Four.Meme · Flap · Binance Web3 · PancakeSwap · BSC RPC
  OnchainOS · GeckoTerminal · DexPaprika · GMGN · Venus
                         │
                         ▼
              adapters + scheduled jobs
                         │
                         ▼
              SnapshotStore (Postgres | Memory)
                         │
                         ▼
                 Hono HTTP API
                         │
                         ▼
       4lpha marketplace · 4lpha.tech · agents
```

- Each job has its own cadence, timeout and health state. A failed provider
  degrades its own data and does not stop the service.
- `PostgresStore` is used when `DATABASE_URL` is set; otherwise the service uses
  `MemoryStore` for local development and tests. Snapshot freshness is computed
  at read time as `fresh`, `stale` or `dead`.
- Most reads are store-backed. Selected cache-miss paths perform a bounded,
  server-side read-through and cache the result; consumers never access
  upstreams themselves.
- Responses use `{ data, error?, meta? }`. Set `DP_AUTH_TOKEN` in production:
  every route except `/health` then requires `x-dp-token`.

The architecture is suitable for the data-plane role. The important boundary is
that read-through is contained inside this service, so upstream latency and
credentials never reach the marketplace or browser.

## Data surface

| Surface | Routes | Main providers |
| --- | --- | --- |
| Token universe and prices | `/universe`, `/tokens` | Four.Meme, Flap, Binance Web3, bStocks, allowlist |
| Candles | `/klines/:address` | OnchainOS, Sintral |
| Exact pool OHLCV | `/pools/:address/ohlcv` | GeckoTerminal, DexPaprika |
| Security, holders and socials | `/security`, `/holders`, `/socials` | OnchainOS, GMGN, Four.Meme |
| Eligibility | `/eligibility` | Allowlist, Binance Alpha, Four.Meme, Flap, BSC RPC |
| Yield and LP ranges | `/pools`, `/pools/top`, `/pools/:address`, `/pools/:address/range` | PancakeSwap V3, MasterChef V3, BSC RPC |
| Trading indicators | `/trading/features/v1`, `/trading/features/v2` | Exact-pool OHLCV |
| Venus Core | `/venus/core/*` | Venus contracts on BSC |
| Optional agent catalog | `/studio/agents` | BNB Chain Studio registry, MCP/A2A endpoints |

All market data is BSC-focused (`chainId: 56`). Social data is creator-declared
links, not social sentiment. The smart-money field is the GMGN holder/tag count;
wallet-level tracking is outside this service.

## API

All routes below are `GET` unless noted.

```text
/health
/status
/universe?lane=meme|coins|bstocks|allowlist
/tokens/:address
/tokens?addresses=0x...,0x...
/klines/:address?interval=1m&limit=100
/security/:address?lane=meme|coins|bstocks|allowlist
/holders/:address
/socials/:address
/eligibility/:address
/eligibility?addresses=0x...,0x...
/pools?token=0x...
/pools/top
/pools/:address
/pools/:address/ohlcv?interval=1m&limit=300&currency=usd|token
/pools/:address/range?lower=...&upper=...&capital=...
/trading/features/v1[/*]
/trading/features/v2[/*]
/venus/:owner                  # deprecated compatibility route
/venus/core/markets
/venus/core/accounts/:owner
/venus/core/accounts/:owner/rewards
/studio/agents                 # only when Studio discovery is enabled
/diag/latency
/snapshots/:key                # authenticated diagnostics

PUT    /internal/venus/core/tracked-owners/:owner/:reference
DELETE /internal/venus/core/tracked-owners/:owner/:reference
```

`/eligibility` is fail-closed. Security, holders, socials and market-data reads
prefer cached data and may return stale data when an upstream is unavailable.
`/pools/top` is a capped TVL-ordered lane (500 pools); filtering is left to the
caller. `/pools/:address/range` is an estimate based on the current pool state,
fee APR, capital and requested bounds.

## Repository layout

```text
src/adapters/   upstream integrations
src/chain/      BSC RPC rotation and chain helpers
src/core/       store, models, scheduler and shared types
src/jobs/       scheduled snapshot producers
src/query/      read-through queries and calculations
src/studio/     optional Studio agent discovery
src/server.ts   Hono API (pure and testable)
data/           frozen eligible-token snapshot
schemas/        Venus Core response schemas and example
scripts/        diagnostics, smoke tests and data utilities
test/           offline node:test suite
```

## Run locally

Requirements: Node.js 22+.

```bash
npm ci
copy .env.example .env       # Windows; use cp on Unix
npm run dev                  # http://localhost:8080
```

Useful checks:

```bash
npm run typecheck
npm test                     # offline; no DB or network required
npm run build
npm start
npm run smoke                # optional live diagnostic
npm run loadtest             # optional local/API load test
```

## Configuration

Copy `.env.example` to `.env`. Optional providers fail soft when credentials are
missing.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Durable Postgres snapshots and job health; unset uses memory |
| `PORT` | HTTP port; default `8080` |
| `DP_AUTH_TOKEN` | Server-side API authentication |
| `BSC_RPC_URL`, `BSC_RPC_URL1..3` | Preferred BSC RPC endpoints; public fallbacks remain available |
| `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`, `OKX_PROJECT_ID` | OnchainOS data |
| `GMGN_API_KEY` | GMGN security and holder enrichment |
| `DEXPAPRIKA_API_KEY` | Optional exact-pool ratio OHLCV fallback |
| `STUDIO_DISCOVERY_ENABLED`, `STUDIO_DISCOVERY_RPC_URL`, `STUDIO_DISCOVERY_TARGETS_JSON` | Optional Studio catalog |

Never expose provider credentials to a browser or client bundle. The service is
deployed with `railway.json` and uses `/health` as its health check.

Deployment URL: `https://data-plane-production.up.railway.app`.
