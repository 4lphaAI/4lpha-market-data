# TRADFI-DATA-RESULT — work order delivered (2026-09-17)

To: Fable, execution-plane session (`D:\4lpha-execution`). Re:
`TRADFI-DATA-WORK-ORDER-2026-09-17.md` / `TRADFI-DATA-HANDOFF-2026-09-17.md`.
Decisions: `TRADFI-DATA-PLAN-2026-09-17.md` (D1–D8 + §5 review outcome).

**Deployed commit: `01ca7f1`** (Railway `data-plane`, SUCCESS, process up 10:59:46 UTC).
Commits: `1bc5391` build, `01ca7f1` review fixes. Both pushed to `master`.

## TESTS

`npm test`: **624 tests / 624 PASS / 0 FAIL / 0 SKIPPED** (offline, no Binance calls).
`npx tsc --noEmit`: clean. New: `test/eligibility.rwa.test.ts` (18 tests) covering
the D3 decision table, acceptance 1–4, D2, halted member on allowlist + Alpha +
cache, member with only a cached positive, unserved platform, batch loads the
snapshot once, both `/eligibility` routes, `rwa:members` through `FakePg`
(bigint TTLs), `/tokens` synthesis, venue-derived `premiumBps`.

## Review verdict

Independent review (high rigour): **no blocking findings; D2 endorsed.** Four
should-fix/nit items fixed in `01ca7f1`: the positive rule now admits only
`bstock`/`ondo` rows (any other platform → `rwa_unsupported`); `/tokens` first
pass restored to one parallel fan-out; a test isolating "member + cached positive,
no list → vetoed"; `premiumBps` null when the share ratio is unknown. Left as
documented: `rwaContext` is an injectable seam no production caller uses;
`rwa_stale` is also the answer for a member Binance delists (three reasons only).

## Acceptance (gate G5), verified against production after deploy

| # | Case | Production answer |
|---|---|---|
| 1 | Admitted Ondo token (fresh, `openState=true`, `TRADING`, ≥ 1 venue) | GOOGLon → `eligible=true`. **Note:** `source=binance-alpha`, not `binance-rwa`, because GOOGLon is also on the Binance Alpha list and the contract's positive order is allowlist → alpha → binance-rwa. An Ondo token on no other list answers `binance_rwa` (offline test; live earlier today: GOOGLon answered `binance_rwa` before the Alpha snapshot listed it). Your parser accepts both. |
| 2 | Ondo `UNSUPPORTED` | ARQQon → `eligible=false, reason=rwa_unsupported, source=null` |
| 3 | Snapshot absent + non-static bStock on Alpha + cached positive | Offline test `acceptance 3` → `rwa_stale`; plus D2: a static bStock with no snapshot → `rwa_stale`; plus "cached positive only" → `rwa_halted`. Not reproducible on production without taking the job down. |
| 4 | `/tokens?addresses=` row for every RWA address | GOOGLon + ARQQon → `found 2, missing 0`, `priceUsd` non-null; synthesised only when no token record exists (never on production so far — the job writes all 488 every minute). |

Also live: NVDAB (static, allowlisted) → `allowlist`; PLTRB (static, no pool) →
`allowlist` (it is `TRADING`; the veto passes, the allowlist answers); USDT → `allowlist`.

## What changed in the shapes you parse (nothing renamed or retyped)

- `EligibilitySource` += `"binance-rwa"`; `EligibilityReason` += `"binance_rwa" |
  "rwa_stale" | "rwa_halted" | "rwa_unsupported"`.
- `UniverseEntry.premiumBps` (same name, `number | null`) is now **the deepest priced
  venue's `priceUsd / (referencePriceUsd × tokenToShareRatio) − 1`** in bps — the
  number you compute yourself — and `null` without a priced venue, a reference price
  or a share ratio. You can keep computing it; the two should agree. Live sample:
  GOOGLon −57, QQQon −53, SQQQon −151 bps overnight; thin bStock pools read −200 to
  −1000 bps (QNTB, AAOIB — $0 liquidity, price stale), which your "deepest fresh
  venue" rule already excludes.
- `venues[].asOf` untouched (finite positive epoch ms).
- `/tokens` rows: `marketCapUsd` = Binance's RWA `marketCap`, which is the
  **underlying's** (NVDAB ≈ $5.16T); `volume24hUsd` = deepest venue's on-chain
  volume when swept, else `null`; never the underlying's volume.

## Decision you should know about (D2)

The static 25 bStocks are vetoed like every other member: **if `universe:rwa` is not
fresh (5 failed `binance-rwa` cycles), every bStock — static or not — answers
`rwa_stale`** and the TradFi agent cannot buy any stock until the next good cycle.
Before this build they were allowlist-eligible with no halt check. The `/universe`
lane keeps its ≥ 25 rows regardless (readiness unaffected). The reviewer endorsed
this as the fail-closed reading of the order; if you want the static 25 exempt when
the snapshot is merely stale, say so and it is a one-line change with a test.

## Costs and telemetry

- `binance-rwa`: 4.2 s per cycle on this boot (2.6 s earlier), 488 rows + 488 token
  merges + `rwa:members`. `stock-venues`: 23.5 s per 75-token cycle on this boot
  (6.3 s earlier — variable, within the 60 s timeout). Both on `/status`.
- Every single `/eligibility/:addr` call now parses the 488-row snapshot; the batch
  route parses it once per 50. Use the batch, as you already do.

## DevEx notes added (for the report)

QUIRK-25 `marketCap` is the underlying's and `tokenPrice` is NAV; QUIRK-26
`UNSUPPORTED` vs `ASSET_PAUSED` and `nextCloseMs < nextOpenMs` while `overnight`;
ONBOARD-27 the `=== 25` readiness incident (`afcfb65`); OK-24 Railway numbers and the
`40101` config incident. Full list in `DEVEX-NOTES.md`.

G4 can run against production now.
