# 4lpha data plane — agent guide

The **data plane** for the 4lpha BNB-Chain agent marketplace: a standalone service that is the single source of market data for the whole product. Built phase by phase, each part Opus-built and independently audited. GitHub: private `kann420/4lpha-market-data` (branch `master`, linear history).

## What it is (the whole point)

Workers poll each upstream at its own cadence and write into one store; UI and agents read **only** from this store, never from upstreams directly. This turns fragmented sources (measured latencies 90–500ms, one dead) into one uniform-latency internal API. User load rises without upstream load rising — a leaked/slow upstream never reaches consumers.

## Stack

Node 22, TypeScript strict ESM, Hono HTTP, `pg` with an in-memory fallback when `DATABASE_URL` is unset, `node:test` offline-only (Postgres paths tested through a `FakeSqlClient` — no live DB), viem for on-chain reads.

## Source map

- `src/core/` — `DataRecord<T>` with `staleness: fresh|stale|dead` (computed at read time, never stored); `SnapshotStore` (Memory + Postgres); job `scheduler` (each job on its own interval + jitter + AbortSignal timeout; a timed-out run is aborted; failures isolated per-job, never crash the process; health persisted).
- `src/adapters/` — fourmeme, onchainos (OKX HMAC-signed), binanceWeb3 (Binance Alpha token list ~660 + Sintral kline), gmgn, pancake (public explorer API), venus (on-chain via BSC RPC).
- `src/query/` — kline read-through chain and tiered security scan.
- `src/server.ts` — Hono app (pure `createServer(deps)`, no listen).

## Conventions

- `{ data, error?, meta? }` envelope everywhere; parameterized SQL only; sanitize upstream errors; secrets never logged.
- Every route except `/health` requires header `x-dp-token` (constant-time compare; env `DP_AUTH_TOKEN`). Consumers call over HTTP **server-side only**, never the browser.
- Endpoints: `/status` (job health + snapshot freshness — the "Data status" surface for judges), `/universe?lane=meme|coins|bstocks`, `/tokens/:addr` + batch `/tokens?addresses=`, `/klines/:addr`, `/security/:addr`, `/pools`, `/venus/:owner`, `/diag/latency`. `npm run loadtest` — hit 300 rps, 0 errors, p95 ~37ms.

## Deployment

Railway project `4lpha-market-data` — service `data-plane` + a Postgres service, public URL `https://data-plane-production.up.railway.app`, healthcheck `/health`. Env from local `.env`. Dead QuikNode `BSC_RPC_URL*` vars were deleted; code falls back to public BSC endpoints (bsc-dataseed etc.), ~75–80ms from inside Railway.

## Source-latency findings that drove the design (measured — non-obvious)

- OnchainOS ~90–155ms and Four.Meme ~125ms are the fast backbone.
- GMGN HTTP ~500ms with 47KB payloads **and it IP-bans on parallel calls** (`RATE_LIMIT_BANNED`) → enrichment-only, sequential, cached hard.
- **Pokebook is DEAD** — dropped from the kline chain. Birdeye was dropped too (2026-08-11, judged not worth the key). Order is now OnchainOS → Sintral (Binance); when both fail the plane serves the stale record rather than nothing.
- **CoinMarketCap: evaluated and rejected** (2026-08-11). The key in `D:\4lpha-fourmeme-skill\.env.local` is a paid plan that has **expired** — every billable endpoint answers HTTP 402 `1004`, only credit-free metadata (`/v1/key/info`, `/v1/cryptocurrency/map`) still responds. An expired CMC plan does not fall back to free tier, and a fresh Basic key has neither DEX endpoints nor OHLCV historical. Do not re-explore without a renewed paid plan.
- Binance Web3 bapi (`web3.binance.com`, `dquery.sintral.io`) is keyless and ~64–97ms but undocumented/uncommitted → sits behind the plane with fallbacks, never relied on alone.
- bStocks are ordinary BEP-20 on BSC (same adapters serve them); they have live PancakeSwap V3 pools (LP works) but only trade during US market hours.

The write-side counterpart is the execution plane (`D:\4lpha-execution`).
