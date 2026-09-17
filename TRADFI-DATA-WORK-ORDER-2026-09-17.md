# Data-plane work order — TradFi execution model (from `D:\4lpha-execution\MD here\TRADFI-MODEL-SPEC.md` §9)

Date: 2026-09-17. Source: execution-plane spec Revision 1 (under Astra review). These two items block the execution plane's live gates G4/G5, not its build. Scope the process here: item 1 changes what `eligibility` answers → fail-closed money-adjacent → written plan → build → one independent review at least.

## What the execution plane observed on the deployed plane (2026-09-17 11:00 UTC)

- `/universe?lane=bstocks` 46 rows (25 static + 21 RWA), `lane=ondo` 442 rows; RWA fields and `venues[]` present; the 75-token/min sweep had reached 25 bStocks and 12 Ondo rows.
- **Every non-allowlisted RWA token answers `eligible=false`.** `src/query/eligibility.ts` has four rules (allowlist 222, Binance Alpha, Four.Meme, Flap); none admits an RWA lane row. The execution plane turns that into an `eligibility-route` refusal, so the 21 new bStocks and all Ondo tokens can never be bought.
- `/tokens?addresses=` has no row for a token the lane price jobs never priced; a missing row aborts the execution plane's whole cycle (`data-plane-unavailable`).
- Also seen (DevEx notes material): bStocks `marketStatus: null` with `reasonCode: TRADING` while Ondo reports `overnight`; Ondo 177 rows `openState=false` + `reasonCode: UNSUPPORTED` (not on chain 56 in this session, not a halt) and 1 `ASSET_PAUSED`; Ondo `nextCloseMs < nextOpenMs` while `overnight`.

## Item 1 — eligibility rule 5: RWA lanes (amended by the execution-plane spec's R2.6, R3.10, R4.5 after four Astra review passes)

**Negative veto FIRST.** For an address that is in the `universe:bstocks` or `universe:ondo` snapshot (or was, in the last fresh snapshot): if NOT (RWA snapshot fresh ∧ `openState === true` ∧ `reasonCode === "TRADING"`) ⇒ `eligible: false`, `source: null`, reason `rwa_stale | rwa_halted | rwa_unsupported`. This veto precedes the allowlist hit, the Alpha hit AND any cached positive entry (a cached `eligible=true` for an RWA address is re-checked against the current RWA snapshot before being served). Then the positive rules: allowlist → binance-alpha → **binance-rwa** (`{ eligible: true, reason: "binance_rwa", source: "binance-rwa", venue: null }`) → launchpad chain reads (an RWA row never reaches the chain reads). Fail-closed: an unreadable snapshot ⇒ not eligible. Cache TTL as for the Alpha rule.

**Acceptance (the execution plane's gate G5 depends on it):** with the RWA snapshot deliberately absent (the static 25 served without `platform`), a previously discovered NON-static bStock that is ALSO in the allowlist / Alpha positive lists or in the eligibility cache must answer `eligible: false` with an `rwa_*` reason. An `UNSUPPORTED` Ondo row refusing is necessary but not sufficient.

**Later nicety, not a dependency:** publish a ratio-normalised premium. Measured 2026-09-17 by the execution plane: the current `premiumBps` equals `tokenToShareRatio` (EEMon 137 bps ↔ 1.0137; NVDAB 8 bps ↔ 1.00078), i.e. Binance's `tokenPriceUsd` is the token's NAV, not the pool price. The execution plane now computes `deepest venue priceUsd / (referencePriceUsd × tokenToShareRatio) − 1` itself and reads `venues[].asOf` (must stay a finite positive epoch-ms integer; it uses a 30-minute maximum age).

Wire: `EligibilitySource` gains `"binance-rwa"`. The execution plane adds the same literal to its parser (its item U1) and routes it as `pancake-discovery` (venue chosen by its own quotes).

## Item 2 — `/tokens?addresses=` rows for every RWA address

For an address in an RWA lane that has no priced `TokenSnapshot`, synthesise the row from the RWA snapshot: `priceUsd = tokenPriceUsd`, `marketCapUsd` = the RWA market cap or `null`, `volume24hUsd` = the deepest venue's `volume24hUsd` (never `underlyingVolume24hUsd`), `holders: null`, `priceChange24hPct: null`, `symbol`. Same envelope and batch limits as today. Staleness follows the RWA snapshot.

## Keep

- `marketHours: "us-equities"` on the static bStocks rows (legacy execution-plane agents still read it).
- The lane precedence and the static 25 floor (execution-plane readiness requires ≥ 25 `bstocks` rows; it was `=== 25` until hotfix `afcfb65` today, which is why the trade worker stood down for a few hours after the RWA union deployed — record it in the DevEx notes).

## Not asked

xStocks, any change to the sweep cadence, quote-leg pool tiers (execution plane probes `{100, 500}` on the WBNB/USDT and WBNB/USDC legs itself; if that proves insufficient the spec's Q2 will come back as a separate order).
