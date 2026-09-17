# SPREAD-HISTORY-SPEC — minute-by-minute arb spreads on tokenized stocks

Status: SPEC → BUILD (skip-level: read-only telemetry, no gate, no money path).
Requested by the operator 2026-09-17 evening. Source of the question:
`TOKENIZED-STOCKS-RESEARCH-2026-09-17.md` §6–§7 — two point measurements showed
pool-vs-pool spreads of 3–24 bps (below the 30 bps fee round trip) and Ondo
pool-vs-NAV discounts of 70–158 bps (above it). Two samples cannot say how often
either clears cost or for how long. This job answers that with a 48-hour series.

## 1. What it measures, every 60 s, on Railway (`data-plane`, same scheduler)

For every tokenized stock in a fresh `universe:rwa` snapshot whose deepest
**stable-quoted v3 venue** (`quote ∈ {USDT, USDC}`, `feeTier` known) is ≥ $10k:

- **NAV spread**: `poolPriceUsd / (referencePriceUsd × tokenToShareRatio) − 1`,
  in bps, from the deepest such venue. Pool price is read **on chain** (`slot0`,
  the plane's own `priceFromSqrtPriceX96`), not DexScreener's — DexScreener lags
  minutes and this series exists to catch minutes.
- **Cross-venue spread**: when a **second** stable-quoted v3 venue ≥ $10k exists
  (Pancake vs Uniswap, or two fee tiers), `|priceA / priceB − 1|` in bps, and
  `feeBps = (feeTierA + feeTierB) / 100` — the round-trip cost it has to beat.
  Stable-quoted only so USDT≈USDC is the only assumption (the 0.01% USDC/USDT
  pool makes it a ~1 bp one); WBNB/ETH-quoted venues are excluded rather than
  priced through a second pool whose own drift would pollute the series.

One `withBscClient` callback per cycle → one multicall over ≤ ~60 `slot0` reads
(`token0`/`token1` resolved once per pool and cached in the snapshot). Measured
precedent: `majors-prices` does the same read shape at 60 s.

## 2. Storage

Key `spread:history`, one jsonb record, rewritten each cycle:

```ts
{
  byAddress: Record<address, {
    symbol; platform; underlyingTicker;
    venues: Array<{ pool; dex; version: "v3"; feeTier; quote; token0; token1 }>;  // the ≤ 2 watched
    // [tsMs, navBps, crossBps | null, feeBps | null, liqA, liqB | null]
    points: Array<[number, number, number | null, number | null, number, number | null]>;
  }>;
  cursorTs: number;
}
```

Points older than **48 h** are dropped on write (≈ 2 880 per token; ~35 tokens ×
~40 bytes ≈ 4 MB, one read + one write per minute — acceptable, and the cap is a
constant). `freshForMs` 5 min, `deadAfterMs` 24 h — the record is history, so a
dead record still serves its points; staleness only says whether the writer is
alive. Listed in `/status`.

Fail-open per token: a pool that does not answer this minute is skipped (no
point written, no fabricated value); a cycle in which nothing answers throws
without republishing. Reference price/ratio come from the RWA snapshot the job
already reads; a token missing either gets no NAV point.

## 3. Read surface

- `GET /spreads` → for each watched token: `symbol`, `platform`, `venues`, latest
  point, and a 24 h summary: `samples`, `navBps {min, p50, max, last}`,
  `crossBps {max, p50, last}`, `feeBps`, **`minutesAboveFee`** (cross > fee) and
  **`minutesNavBeyondFee`** (|nav| > deepest venue's fee) — the two numbers that
  decide whether either arb is worth an agent. `?hours=` (1–48) changes the window.
- `GET /spreads/:address?hours=` → the raw points for one token.
- Both behind `x-dp-token`, `{ data, meta }` envelope, `meta.asOf`/`staleness`
  from the record.

## 4. Not in scope

No thresholds beyond the $10k venue floor (a constant, reported in `meta`); no
alerts; no trades; WBNB-quoted venues; xStocks; anything on the eligibility gate.
Nothing here is read by the execution plane yet — it is for the operator's
decision and, later, an arb agent's signal.

## 5. Tests (offline)

Point computation from a fixed `slot0` (both orderings of token0/token1, 18/18
and 18/6 decimals); venue selection (stable-quoted v3 ≥ $10k only, deepest two);
48 h trimming; skipped pool leaves no point; empty cycle throws and keeps the
record; snapshot round-trip through `FakePg`; both routes' envelopes and the
24 h summary arithmetic on a synthetic series; `hours` validation.
