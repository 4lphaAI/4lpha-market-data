# Handoff → data-plane session: build the TradFi work order (2026-09-17, night)

From: Fable, execution-plane session. Read `TRADFI-DATA-WORK-ORDER-2026-09-17.md` (the contract, already amended by five Astra review passes) and this file (status + acceptance). Then `CLAUDE.md`/`AGENTS.md` here as usual.

## Where the execution plane is

- The TradFi execution model is BUILT, audited and merged into master locally (`D:\4lpha-execution` `d336358`); NOT deployed and not pushed until (a) the web sends `tradfi` and (b) THIS work order lands, because gates G4/G5 depend on it. Spec: `D:\4lpha-execution\MD here\TRADFI-MODEL-SPEC.md` (body + Revisions 2–5); audit: `MD here\TRADFI-MODEL-AUDIT.md`.
- What the execution plane now reads from this plane, per agent cycle: `GET /universe?lane=bstocks` and `lane=ondo` once (before exits), then `/tokens?addresses=` and `/eligibility?addresses=` in 50-batches, `/security/:addr` per shortlisted token. It parses per row: `platform`, `underlyingTicker`, `tokenPriceUsd`, `referencePriceUsd`, `premiumBps` (IGNORED for decisions), `tokenToShareRatio`, `openState`, `marketStatus`, `reasonCode`, `staleness`, `venues[]` (`dex`, `version`, `pool`, `feeTier`, `quote{address,symbol}`, `priceUsd`, `liquidityUsd`, `volume24hUsd`, `asOf`). Strict on shape (a present field of the wrong type fails the whole read), lenient on absence. **Do not rename or retype any of these.** `asOf` must stay a finite positive epoch-ms integer (the plane refuses venues older than 30 min or more than 2 min in the future).
- Premium is computed by the execution plane as `deepest fresh venue priceUsd / (referencePriceUsd × tokenToShareRatio) − 1`, because the plane's `premiumBps` equals `tokenToShareRatio` (Binance's `tokenPriceUsd` is NAV, not the pool price — EEMon 137 bps ↔ 1.0137, NVDAB 8 bps ↔ 1.00078). Fixing `premiumBps` here is a nicety, not required.

## What to build (two items, in this order)

**Item 1 — eligibility: RWA negative veto first, then positive `binance-rwa`.** Exactly as the work order §"Item 1" states (veto precedes allowlist, Alpha AND cached positives; reasons `rwa_stale | rwa_halted | rwa_unsupported`; positive `{eligible:true, reason:"binance_rwa", source:"binance-rwa", venue:null}`; fail-closed on an unreadable snapshot). `EligibilitySource` gains `"binance-rwa"`; the execution plane's parser already accepts it.

**Item 2 — `/tokens?addresses=` rows for every RWA address** with no priced `TokenSnapshot`: `priceUsd = tokenPriceUsd`, `marketCapUsd` = RWA market cap or `null`, `volume24hUsd` = deepest venue's `volume24hUsd` (never `underlyingVolume24hUsd`), `holders: null`, `priceChange24hPct: null`, `symbol`. Without this the execution plane aborts a cycle (`data-plane-unavailable`) for any pinned Ondo token.

Process: item 1 changes a fail-closed money-adjacent answer → written plan → build → one independent review (Astra high is enough; xhigh if you widen anything). Item 2 is skip-level. Offline `node:test` only; no test calls Binance. Do not touch the sweep cadence, lane precedence, or the static 25 floor (execution-plane readiness needs ≥ 25 `bstocks` rows).

## Acceptance the execution plane will check (gate G5)

1. An admitted Ondo token (fresh, `openState=true`, `reasonCode=TRADING`, ≥ 1 venue) answers `eligible=true, source=binance-rwa`.
2. An Ondo row with `reasonCode=UNSUPPORTED` answers `eligible=false, reason=rwa_unsupported`.
3. **Restart / static-fallback case:** with the RWA snapshot deliberately absent (static 25 served without `platform`), a previously discovered NON-static bStock that is ALSO in the allowlist / Alpha list or in the eligibility cache answers `eligible=false` with an `rwa_*` reason. Write this as an offline test with the store fixture; it is the one the reviewers insisted on.
4. `/tokens?addresses=` returns a row for every RWA address in one 50-batch, with `priceUsd` non-null when the RWA snapshot is fresh.

Report TESTS / PASS / FAIL / SKIPPED, the review verdict, and the deployed commit in your handoff; the execution-plane session will then run G4 (a tradfi hire end-to-end) against production.

## DevEx notes to keep collecting (25 % of the hackathon score)

The readiness incident (`=== 25` stood the trade worker down when the lane grew to 46 — execution-plane hotfix `afcfb65`), bStocks `marketStatus: null` vs Ondo session strings, `UNSUPPORTED` vs `ASSET_PAUSED`, `nextCloseMs < nextOpenMs` while `overnight`, the NAV-vs-pool-price meaning of `tokenPriceUsd`, and any auth/`/build`-prefix pain from the signed adapter.
