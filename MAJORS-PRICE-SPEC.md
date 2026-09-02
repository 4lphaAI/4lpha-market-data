# MAJORS-PRICE-SPEC — serve USD prices for the major BSC tokens from `/tokens/:address`

Status: SPEC → BUILD, requested by the operator 2026-09-02 for the marketplace
MVP. Build in THIS repo (the read-only data plane) only. Nothing here touches
`D:\4lpha-execution`.

## 0. Why (measured, not assumed)

The execution plane's Account portfolio (`D:\4lpha-execution\src\account\portfolio.ts:209-210`)
prices every asset by calling this plane's `GET /tokens/:address` and reading
`priceUsd`. Measured 2026-09-02 against production
(`https://data-plane-production.up.railway.app`, with `x-dp-token`):

```
GET /tokens/0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c   (WBNB) -> 404 not_found "no snapshot for this token"
GET /tokens/0x55d398326f99059ff775485246999027b3197955   (USDT) -> 404
GET /tokens/0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82   (CAKE) -> 404
```

The `/tokens` surface is fed only by the lane universes (meme / coins /
bstocks), so the majors every wallet actually holds have no snapshot. Result:
the marketplace Account shows `—` for BNB, USDT, CAKE, SOL… and the hackathon
criterion "Data Quality — real-time, accurate data" reads as empty dashes.

## 1. Goal

`GET /tokens/:address` (and the batch `GET /tokens?addresses=`) returns a fresh
`TokenSnapshot` with `priceUsd` for a FIXED majors set, refreshed continuously:

| symbol | address (BSC, chain 56) | decimals |
|---|---|---|
| WBNB | `0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c` | 18 |
| USDT | `0x55d398326f99059ff775485246999027b3197955` | 18 |
| USDC | `0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d` | 18 |
| BTCB | `0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c` | 18 |
| ETH  | `0x2170ed0880ac9a755fd29b2688956bd959f933f8` | 18 |
| CAKE | `0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82` | 18 |

Native BNB has no address; the consumer prices it with WBNB's `priceUsd`, so
WBNB is the one that must never be missing. (All six are 18-decimal on BSC —
verify each `decimals()` on chain once and pin it in the test, do not assume.)

## 2. Source of truth — on-chain, from pools this plane already reads

No third-party price API. The adapter already reads PancakeSwap V3 `slot0`
over the configured RPC (`src/adapters/pancake.ts:686-709`,
`fetchPancakePoolStats`): `sqrtPriceX96` and `tick`. Derive prices from
sqrtPriceX96 of these pools (all are on the `/pools/top` lane already, so the
addresses can be read from the lane rows rather than hardcoded — but pin them
as constants with a comment, and cross-check against the lane at boot):

- WBNB/USDT 0.01% — `0x172fcd41e0913e95784454622d1c3724f546f849` (token0 = USDT, token1 = WBNB)
- BTCB/WBNB 0.05%, ETH/WBNB 0.05%, CAKE/WBNB 0.25%, USDC/WBNB (or USDC/USDT 0.01%) — take from the lane.

Anchor: **USDT = 1.00 USD** (state this as an assumption in code and in
`meta.source`). WBNB price = pool price of WBNB in USDT. Every other major =
its price in WBNB × WBNB price. USDC via its USDT or WBNB pool.

Price math MUST be integer/bigint — no floats, matching repo conventions:
`price(token1 per token0) = sqrtPriceX96² / 2^192`, then decimal-adjust by
`10^(dec0 − dec1)` and INVERT when the wanted token is token0. Emit
`priceUsd` with the precision the existing `TokenSnapshot.priceUsd` field
already uses (read `src/core/models.ts:30` — do not change the wire type).

## 3. Job and snapshot shape

- A new job `src/jobs/majorsPrices.ts`, modelled on the existing job pattern
  in `src/jobs/pancakePools.ts` (same scheduler registration, same
  `deps.store.put(key, data, { source, freshForMs, deadAfterMs })` contract).
  Interval 30–60 s. One RPC batch per tick (multicall if the adapter has one;
  otherwise `Promise.all` over the six pools).
- Writes `token:<address>` snapshots (the same key `GET /tokens/:address`
  reads — find `tokenKey()`), with `source: "pancake-v3-slot0"`,
  `freshForMs ≈ 60_000`, `deadAfterMs ≈ 900_000`, `updatedFields` listing
  `priceUsd` (+ `symbol` if the snapshot carries it).
- MUST NOT overwrite a richer snapshot for the same address that another lane
  produced (e.g. CAKE may already carry volume/holders from a lane): merge
  `priceUsd`/`pricedAt` into the existing record rather than replacing it.
  Read the store API first; if it is put-only, read-modify-write.
- The `{ data, error?, meta }` envelope and `staleness` semantics are
  unchanged. Before the first tick a major may still 404 — acceptable; the
  consumer already treats 404 as "unpriced".

## 4. Bonus, same job, cheap — close the earlier tick gap

The lane rows from `/pools/top` carry `tick: null` and `sqrtPriceX96: null`
(measured 2026-09-02, 0 of 50). Since this job reads `slot0` for the majors'
pools anyway, write `tick` and `sqrtPriceX96` back onto those lane rows (or
onto the `pool:<address>` snapshot) so `/pools/:address` stops answering null
for pools ON the lane. Optional; do it only if it does not complicate §3.

## 5. Tests (offline `node:test`, no network — repo rule)

- Golden math vectors: a known `sqrtPriceX96` for WBNB/USDT (record the real
  value you observe at build time and the price it implies) → exact
  `priceUsd`; both token orderings; an 18/18 pair and a synthetic 18/6 pair
  to prove the decimal adjustment; inversion when the wanted token is token0.
- Job test with a fake RPC/adapter: writes six snapshots with the expected
  keys/source/TTLs; a merge test proving an existing richer snapshot keeps
  its other fields.
- Route tests: `GET /tokens/<WBNB>` returns `priceUsd` after the job ran;
  batch `GET /tokens?addresses=<WBNB>,<USDT>` includes both; unknown address
  still 404.

## 6. Acceptance (the operator verifies from the other repo)

1. `curl -H "x-dp-token: …" $DP/tokens/0xbb4c…095c` → `priceUsd` within ~1 %
   of BNB's market price; `meta.staleness: "fresh"`.
2. The marketplace Account (`D:\4lpha-execution`, local) shows USD values
   for BNB / USDT / CAKE instead of `—`.
3. `npm test`, `npm run typecheck`, `npm run build` clean in this repo; then
   deploy to Railway (`railway up` on the existing `4lpha-market-data`
   project) — this plane is already deployed, the marketplace reads
   production.

## 7. Constraints

- Read-only plane: no new write routes. No new dependencies. RPC through the
  existing `BSC_RPC_URL*` configuration only.
- Do not touch `D:\4lpha-execution`. If the consumer needs a shape change,
  write it down here as a follow-up instead of changing the wire.
- Update `README.md`'s route table if you touch routes (it is already stale
  for `/pools/top`, `/pools/:address`, batch `/tokens` — fix those lines while
  there).

## 8. Build notes (2026-09-02, built)

- Job: `src/jobs/majorsPrices.ts`, registered in `src/index.ts`, 30s ±3s,
  20s timeout. One multicall per tick (`slot0` + `token0` + `token1` × 5 pools);
  measured 452ms for a full live cycle from a local machine.
- **Pool choice deviates from §2 on purpose:** every major is quoted directly
  in USDT, not via WBNB. Measured `liquidity()` across all four fee tiers via
  the V3 factory: BTCB/USDT 0.05% (3.6e23) vs BTCB/WBNB 0.05% (2.8e22),
  ETH/USDT 0.05% (1.8e23) vs ETH/WBNB 0.05% (7.6e22), CAKE/USDT 0.25%
  (6.9e24) vs CAKE/WBNB 0.05% (3.2e23), USDC/USDT 0.01% (4.7e28). Deeper and
  one hop fewer, so WBNB drift cannot compound into the others. The
  composition code still handles a WBNB-quoted pool (tested), so swapping a
  pool is a constant change.
- Pins are re-checked every tick: a pool whose on-chain `token0/token1`
  disagrees with the pin is skipped, never inverted silently.
- **A failed pool read is a skipped write, not a restamp.** The merge helper
  keeps the old price when the incoming one is null, which would have put a
  fresh `asOf` on a stale price; the job never calls it in that case.
- WBNB unpriced fails the run (job health goes red on `/status`); any other
  major missing is a warning.
- §4 (writing `tick`/`sqrtPriceX96` back onto lane rows) was **not** done: the
  lane is one key and the per-pool records carry TVL/APR from a different read,
  so restamping either with a fresh `asOf` would age stale figures into fresh
  ones — the exact thing the pool lane refuses to do. Leaving it for a
  dedicated pass if `/pools/:address` chain state is actually needed.
- All six `decimals()` read on chain = 18, pinned and asserted in
  `test/majorsPrices.test.ts`, which also holds the golden `sqrtPriceX96`
  vectors observed at build time.
