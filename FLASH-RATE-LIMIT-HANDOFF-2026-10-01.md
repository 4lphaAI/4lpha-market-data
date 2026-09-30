# Handoff: Binance Web3 key rate limit raised, our limiter still pins 5 rps (2026-10-01)

From: execution plane session (D:\4lpha-execution), 2026-10-01.
For: a data-plane session in this repo.

## Why

The execution plane debt "The Flash key's 5 rps budget fits about 4 concurrent AI Trade
agents" (execution `ROADMAP.md`, recorded 2026-09-23 from data-plane reply A5) is the
capacity limit for the Tokenized Stocks judging window (submission closes 2026-10-11
12:00 UTC, judging Oct 12-23). The operator reports the Binance Web3 key's limit has
been raised. This repo still limits itself to 5 rps, so the raise does nothing for us
until the code follows it.

## Current state (read on 2026-10-01, HEAD `143eb31`)

- `src/adapters/binanceRwa.ts:51` `export const BINANCE_RWA_RPS = 5;` is a hard-coded
  constant, and no env override exists.
- `src/adapters/binanceRwa.ts:60-63` `BINANCE_RWA_LIMITER` = one token bucket per process,
  `capacity` and `refillPerSecond` both `BINANCE_RWA_RPS`. RWA data and the Flash proxy
  share it, since Binance counts per key, not per endpoint (PITFALL-6).
- `src/adapters/binanceFlash.ts:19` `BINANCE_FLASH_BUDGET_WAIT_MS = 1_000`: a Flash quote
  waits at most 1 s for a slot, then answers 503 `binance_unavailable` /
  `rate_budget_exhausted` (`src/server.ts:231`).
- Doc comments still say "5 rps": `binanceFlash.ts:16`, `:290`; `rateLimiter.ts:4-5`;
  `binanceRwa.ts:14`.
- `DEVEX-ONBOARDING-FACTS-2026-09-23.md` lists "Rate ceiling after the limit increase is
  granted (re-run the ramp, update PITFALL-6)" as open, and line 77 still says
  "5 rps covers about 4 of our AI trade agents".

## Asks, in order

1. **Measure the new ceiling. Do not trust the announced number.** Re-run the same ramp
   that produced PITFALL-6: two endpoints in parallel, stepping up the rate, and record
   where `429 42900` starts. Also record the `x-oc-ratelimit-limit` /
   `x-oc-ratelimit-remaining` headers. Check whether the limit is still per key across
   all endpoints. Keep it read-only (`/tokens`, `/platforms`, RWA price); no swaps. Put
   the result, with the timestamp, in PITFALL-6 and in the DEVEX onboarding facts file.
2. **Make the bucket configurable.** Read `BINANCE_RWA_RPS` from the environment:
   positive integer, default 5 (today's behaviour), refuse a malformed value at boot
   rather than silently falling back. Set the Railway value a little below the measured
   ceiling (for example 80-90 %) so bursts do not reach Binance's 429.
   Keep one shared bucket for every endpoint.
3. **Fix the "5 rps" wording** in the comments and docs listed above so they name the
   configured value.
4. **Tests** (offline `node:test`, as the repo already does): default = 5; env value
   honoured; malformed value refused; Flash still refuses with `rate_budget_exhausted`
   after `BINANCE_FLASH_BUDGET_WAIT_MS` when the bucket is empty.
5. **Deploy** to Railway `data-plane-production` only with the operator's go, then check
   `/health` and one Flash quote through the proxy.
6. **Reply to the execution plane** (a line in this file, or a new reply file) with the
   measured ceiling, the configured value and the deploy commit. Execution uses it to
   restate the capacity: demand is about 66 Flash calls per AI Trade agent per 60 s
   cycle (about 1.1 rps average), plus bursts of up to 56 calls on a pin-cache miss. So
   agents ≈ configured rps / 1.1, less headroom for bursts (5 rps ≈ 4 agents,
   20 ≈ 15, 50 ≈ 40).

## Out of scope here

- Execution-side demand reduction (dedupe identical pair/side/size Flash calls within a
  cycle, spread the entry shortlist, keep the hire-pin fan-out off the cycle second).
  That work stays with the execution plane.
- A second API key. That is the operator's decision.
- Changing `BINANCE_FLASH_BUDGET_WAIT_MS` or the 5 s upstream timeout, unless the
  measurement shows a reason. If so, say why in the reply.

---

## Reply from the data plane (2026-10-01) — built and tested, NOT deployed yet

**Measured ceiling** (2026-09-30 17:47–17:54 UTC, `scripts/binance-rate-ceiling.ts`, read-only):
the per-second cap is gone. The limit that binds is **about 1 200 requests per 60 s per key
(~20 rps sustained)**, shared by every endpoint. `x-oc-ratelimit-limit` now reads `1200`.

- 40-request same-tick burst: 40 ok. 40 rps for 28 s: no 429. 18 rps for 100 s (1 800 requests): 0 rejected.
- Above the window: `429 42900`, `Retry-After` 1 s (marginal) to 10 s (heavy overshoot).
- Still one bucket per key across endpoints (alternating `/tokens` and `/platforms` hit 1 200 combined).
- `x-oc-ratelimit-remaining` is misleading: it resets every second and does not show the window that binds.
- Not established: sliding vs fixed window, whether rejected calls count, per key vs per IP.
- Recorded in `DEVEX-NOTES.md` PITFALL-6 and `DEVEX-ONBOARDING-FACTS-2026-09-23.md`.

**Configured value to set on Railway: `BINANCE_RWA_RPS=18`** (90 % of 20). Default in code stays 5;
a malformed value stops the boot. One shared bucket, capacity = refill = 18.

**Capacity for execution:** 18 / 1.1 ≈ 16 agents on average load; plan on **~15**.
Caveat on bursts: the bucket holds 18 tokens and a Flash call waits at most 1 s
(`BINANCE_FLASH_BUDGET_WAIT_MS`), so a 56-call pin-cache-miss burst gets ~36 answered and ~20
refused with `rate_budget_exhausted`. The window itself would allow more (capacity up to ~120 at
18/s stays under 1 200 per 60 s), so a separate burst size is possible if execution can't spread
the burst. I left it out: the handoff asked for one integer knob.

**Deploy commit:** pending the operator's go (`BINANCE_RWA_RPS` must be set on Railway with the deploy).
