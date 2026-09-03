# ALLOWLIST-PRICE-SPEC — price + market cap for the whole 222-token allowlist

Status: SPEC → BUILD in THIS repo only. Requested 2026-09-03 by the execution
plane's trading-agent spec (`D:\4lpha-execution\MD here\MARKETPLACE-TRADING-AGENT-SPEC.md`
§2.2 / §11). Nothing here touches the execution plane. Small by design: the
mechanism already exists, only its input set is wrong.

## 0. Why (measured 2026-09-03 against production, with `x-dp-token`)

The trading agent's Blue Chip / Mid-Cap execution models filter the
`data/eligible-tokens.json` allowlist by `marketCapUsd` (`> $1B`, `$10M–$1B`).
`GET /tokens?addresses=` answers for the allowlist today:

| Set | Addresses | Rows returned | With `marketCapUsd` | > $1B | $10M–$1B |
|---|---|---|---|---|---|
| 222 allowlist | 222 | 34 | 29 | 26 | **3** |
| of which `bstocks` | 25 | 25 | 25 | 25 | 0 |

Mid-Cap is therefore a three-token universe. The 197 `cmc-top200-bsc` entries
have no snapshot because nothing tracks them: `binance-prices`
(`src/jobs/binancePrices.ts`) reads its set from the store key
`tracked:addresses` and falls back to the STATIC bStocks list when that key is
empty — and it is empty in production.

## 1. Goal

Every allowlist address has a fresh `TokenSnapshot` with `priceUsd`,
`marketCapUsd` and `volume24hUsd`, refreshed on the `binance-prices` cadence.
`fetchBinanceTokenQuote` (`src/adapters/binanceWeb3.ts:164`) already returns
`marketCap ?? fdv` and price per address, so no new adapter is needed.

## 2. Change (complete list)

1. `readTrackedAddresses` fallback becomes **allowlist ∪ bStocks** instead of
   bStocks alone: read `data/eligible-tokens.json` the same way
   `query/eligibility.ts` does (one loader, shared), dedupe by lowercased
   address. The store key, when set, still wins (operator control unchanged).
2. Concurrency: 222 parallel bapi calls in one `Promise.allSettled` is the
   current shape for 25; bound it to batches of 25 with the existing signal.
   Do not add retries.
3. The job's "no tracked prices updated" throw stays; add the counts
   `attempted/updated/rejected/failed` to the job's existing status line.
4. Tests: the fallback returns 222 + bStocks deduped; a bapi miss for one
   address does not fail the others (already the `allSettled` behaviour — pin it).

## 2b. Enumerate the allowlist over the API (added after the trading-agent spec review, B3)

The execution plane's worker cannot obtain the allowlist today: `/universe`
accepts `lane` from the closed set `meme|coins|bstocks` and the 222 entries
are read only inside `decideEligibility`, per address. Add ONE thing:

5. `GET /universe?lane=allowlist` returns the 222 entries as `UniverseEntry`
   rows (`address, symbol, lane: "allowlist", source: <sources[0]>`), served
   from the same loader as step 1; `staleness: "fresh"`, `asOf: null` (static,
   like bStocks). Widen the lane union in `src/core/models.ts` and the route's
   validator by that one member. No other route changes.

## 3. Measure before calling it done

Run one cycle against production bapi and record here how many of the 197
CMC entries bapi actually quotes (it is an undocumented upstream; a token with
no Binance web3 listing will return nulls and must simply stay unpriced — the
consumer is fail-closed). If coverage is below ~150, the fallback for the rest
is the `majors-prices` job's pool-based method (`src/jobs/majorsPrices.ts`),
extended per address — a separate, larger change; do not start it inside this one.

## 4. Out of scope

New endpoints, CMC API keys, schema changes, any change to `/eligibility`,
anything in the execution plane.
