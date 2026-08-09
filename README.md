# 4lpha Data Plane

Standalone data-plane service for a BNB Chain agent marketplace.

Phase 0 is the core only: a snapshot store with read-time freshness, a fault-isolated
job scheduler, and a small HTTP surface for health and job status. There are no data
source adapters yet — later phases register them as jobs against these primitives.

## Architecture

```text
                 ┌──────────────┐
   jobs ────────▶│  Scheduler   │──── put(key, payload, ttl) ──┐
 (per-interval)  │  timeout,    │                              │
                 │  jitter,     │◀─── putJobHealth(health) ────┤
                 │  no-overlap  │                              ▼
                 └──────┬───────┘                       ┌─────────────┐
                        │ healthSnapshot()              │ SnapshotStore│
                        ▼                               │  Memory | PG │
                 ┌──────────────┐                       └─────────────┘
                 │  Hono app    │  GET /health
                 │  (server.ts) │  GET /status
                 └──────────────┘
```

- **Store** (`src/core/store.ts`) — key/value snapshots plus job health.
  `MemoryStore` for dev and tests, `PostgresStore` (tables `dp_snapshots`,
  `dp_job_health`, created idempotently on init) when `DATABASE_URL` is set.
  `createStore()` picks the backend and logs which one, never the URL.
- **Freshness** is derived at read time, never stored: a record's age is compared
  against its `freshForMs` / `deadAfterMs` to yield `fresh | stale | dead`. Readers
  therefore always see honest staleness, even for a long-idle producer.
- **Scheduler** (`src/core/scheduler.ts`) — one timer per job. Each run is wrapped in
  a timeout; a throw or timeout records a failure (bumping `consecutiveFailures`,
  error trimmed to 300 chars) and scheduling continues. The next tick is armed before
  the run starts, and a tick is skipped while the previous run is still in flight, so
  a slow job cannot pile up. No job can affect another job or crash the process.
- **Server** (`src/server.ts`) — `createServer(deps)` returns a Hono app and never
  binds a port, so tests drive it through `app.request()`. Port binding and signal
  handling live in `src/index.ts`.

## API

Every response uses the `{ data, error?, meta? }` envelope.

| Route     | Response                                            |
| --------- | --------------------------------------------------- |
| `GET /health` | `{ data: { ok: true, uptimeSec } }`             |
| `GET /status` | `{ data: { jobs: JobHealth[], startedAt } }`    |
| anything else | `404 { error: { code: "not_found" } }`          |

## Commands

```bash
npm install
npm run dev        # tsx watch, serves on PORT (default 8080)
npm run typecheck  # tsc --noEmit
npm test           # node:test, no database required
npm run build      # emit dist/
npm start          # node dist/index.js
```

## Configuration

Copy `.env.example` to `.env`. Both variables are optional:

- `DATABASE_URL` — Postgres connection string. Absent means the in-memory store,
  which is fine for dev and tests but loses state on restart.
- `PORT` — HTTP port, default `8080`.
