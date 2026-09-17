# TRADFI-DATA-PLAN — eligibility rule 5 (RWA veto + positive) and RWA token rows

Status: PLAN → BUILD → one independent review (item 1 is fail-closed, money-adjacent).
Contract: `TRADFI-DATA-WORK-ORDER-2026-09-17.md` + `TRADFI-DATA-HANDOFF-2026-09-17.md`.
This file records the decisions the contract leaves open, so the reviewer can check
the build against something written rather than against my memory.

## 0. What production already does (checked 2026-09-17 ~11:30 UTC)

- `/tokens?addresses=` **already returns a row for every RWA address** — the
  `binance-rwa` job merges `priceUsd`/`marketCapUsd`/`symbol` for all 488 tokens
  every cycle (ARQQon, NVDAon, NVDAB all `found`, `source: binance-rwa`, fresh). The
  execution plane's "missing row" observation predates the 06:18 UTC deploy with the
  key. Item 2 therefore reduces to the two fields the order specifies differently
  from what is merged today, and to synthesising a row only in the window between
  a fresh RWA snapshot and the first merge (never observed; handled anyway).
- Two RWA numbers are the **underlying's, not the token's**: `volume24H` (known,
  QUIRK-15) and — new — `marketCap` (NVDAB and NVDAon both report ≈ $5.16T, NVIDIA's
  cap; ARQQon $330M, Arqit's). The order says `marketCapUsd` = "RWA market cap or
  null"; built as ordered, and the field is renamed internally to
  `underlyingMarketCapUsd` so nobody mistakes it later. Recorded as DevEx QUIRK-25.
- `premiumBps` as published equals `tokenToShareRatio − 1` because `tokenPriceUsd`
  is NAV (execution plane's finding, confirmed: NVDAB 8 bps ↔ ratio 1.00078). The
  nicety is taken: `premiumBps` on the universe row becomes
  `deepestVenue.priceUsd / (referencePriceUsd × tokenToShareRatio) − 1`, `null` when
  there is no venue with a price. Same name, same type (`number | null`).

## 1. Item 1 — decisions

**D1. Who is an RWA member.** The union of (a) the static bStocks list in code,
(b) every address in the current `universe:rwa` snapshot, (c) every address ever
seen in one, remembered in a new store key `rwa:members` (`address → {platform,
lastSeenAt}`) that the `binance-rwa` job merges into each cycle and never shrinks
(fresh 30 d / dead 365 d, the `origins:launchpad` precedent). (c) is what makes
acceptance case 3 hold across a restart or an absent snapshot: membership must
outlive the snapshot, or a token would silently regain allowlist/Alpha eligibility
the moment Binance went quiet — the opposite of fail-closed.

**D2. The static 25 are vetoed too.** The order's acceptance names a *non-static*
bStock, but its rule text says "an address in the `universe:bstocks` snapshot", and
the static rows are in that lane. With the RWA snapshot not fresh, every bStock —
static or not — answers `rwa_stale`. This is a new outage mode for the 25 tokens
that were allowlist-eligible before: five failed `binance-rwa` cycles and the TradFi
agent cannot buy any stock. That is the fail-closed answer (a halted bStock the plane
cannot see is exactly the wrong `true`), and the lane itself keeps its ≥ 25 rows for
readiness. **Reviewer: confirm this reading; it is the one call the order does not
make explicitly.**

**D3. Verdict per member, in order.**
1. snapshot missing, unreadable, or not `fresh` (5 min window against a 60 s job) → `rwa_stale`
2. member not in the fresh snapshot (delisted since last seen) → `rwa_stale`
3. platform not `bstock`/`ondo` → `rwa_unsupported` (no lane serves it — review finding; a third issuer or a row that lost its `platformId` cannot pass)
3b. `reasonCode === "UNSUPPORTED"` → `rwa_unsupported` (not on offer in this session — Ondo overnight/pre-market classes)
4. `openState !== true` or `reasonCode !== "TRADING"` (covers `ASSET_PAUSED`, unknown codes, nulls) → `rwa_halted`
5. otherwise → passes the veto.

`ASSET_PAUSED` is `rwa_halted`, not a third reason: the order names three reasons and
the execution plane's parser accepts exactly those.

**D4. Order of evaluation in `isEligible`.** invalid address → **RWA veto** (D3, for
members) → allowlist → Alpha → **binance-rwa positive** (member that passed) →
cache → chain reads. An RWA member never reaches the cache or the chain: a cached
positive from before this build is therefore never served for a member (case 3),
and no RWA verdict is ever written to the cache — it is decided live from the
snapshot on every call, exactly like the Alpha rule, because the snapshot can be
replaced by the next job cycle at any moment.

**D5. Positive shape.** `{ eligible: true, reason: "binance_rwa", source: "binance-rwa",
venue: null, fourmeme: null, flap: null }`. Allowlisted bStocks that pass the veto
still answer `allowlist` (positive order per the contract); only non-allowlisted
members answer `binance_rwa`.

**D6. Batch cost.** `isEligibleBatch` loads the RWA context (snapshot + members +
static set) **once** and passes it to each `isEligible`; a single call loads it
itself. One 488-row snapshot read per batch, not fifty.

**D7. Membership read failure.** `rwa:members` unreadable → members = static ∪
current snapshot only, with a warning. It cannot deny all 222 allowlisted tokens
(most are not stocks), and the static set is in code, so the only exposure is a
non-static bStock/Ondo token during a simultaneous snapshot outage and members-key
outage — which then falls through to `not_listed` (denied) unless it is also on the
allowlist/Alpha list. Accepted and documented.

**D8. Types.** `EligibilitySource` += `"binance-rwa"`; `EligibilityReason` +=
`"binance_rwa" | "rwa_stale" | "rwa_halted" | "rwa_unsupported"`. Nothing renamed.

## 2. Item 2 — decisions

- `binance-rwa` job merge: `priceUsd = tokenPriceUsd` (unchanged), `marketCapUsd =
  underlyingMarketCapUsd ?? null` (as ordered), `volume24hUsd` = deepest venue's
  `volume24hUsd` from `venues:rwa` when present, else untouched (`null` never
  overwrites; `mergeTokenSnapshot` ignores null).
- `/tokens?addresses=` and `/tokens/:address`: when no `token:<addr>` record exists
  but the address is in a fresh `universe:rwa` snapshot, synthesise the row from the
  snapshot (`holders: null`, `priceChange24hPct: null`, `updatedFields: []`,
  `source: "binance-rwa"`, `asOf`/`staleness` of the snapshot). Not written back —
  the job writes the real record within a minute.
- `premiumBps` normalisation on the universe row (§0). `RwaToken.premiumBps` (the
  NAV-vs-reference number) is kept in the snapshot under the name `navPremiumBps`
  so the raw observation is not lost.

## 3. Tests (offline)

- Decision table for D3 (every branch) via an exported `decideRwaVeto`.
- Acceptance 1–4 as named in the handoff, plus: static bStock with snapshot fresh
  and `TRADING` → `allowlist`; static bStock with snapshot absent → `rwa_stale`
  (D2); Ondo `ASSET_PAUSED` → `rwa_halted`; member with `openState:false` that is
  also on the Alpha list → `rwa_halted`; a cached `eligible:true` for a member is
  ignored; no `eligibility:<addr>` key is ever written for a member; batch loads
  the snapshot once (count store reads); `/eligibility/:addr` and batch route
  envelopes; `rwa:members` written through `FakePg` and merged, never shrunk;
  `/tokens` synthesised row shape; `premiumBps` from the deepest venue.

## 4. DevEx captured (for the report)

QUIRK-25 `marketCap` is the underlying's; the `=== 25` readiness incident on the
execution plane (lane grew to 46, trade worker stood down; hotfix `afcfb65`);
`nextCloseMs < nextOpenMs` while `overnight`; `tokenPriceUsd` is NAV not pool
price; `UNSUPPORTED` vs `ASSET_PAUSED`.

## 5. Review outcome (independent, high rigour — 2026-09-17)

No blocking findings; D2 endorsed ("the acceptance naming a non-static bStock
chooses the harder case, it does not exempt the easy one"). Fixed before deploy:
(1) the positive admitted any platform — now only `bstock`/`ondo` pass the veto;
(2) `/tokens` first pass back to one parallel fan-out; (3) a test that pins
"member + cached positive, no list" → vetoed; (4) unknown share ratio → `premiumBps`
null rather than the NAV number. Left as documented: `rwaContext` is an injectable
seam (no production caller passes one); `rwa_stale` is also the answer for a member
Binance delists (three reasons only, per contract); every single `/eligibility` call
parses the 488-row snapshot (batch amortises); `marketCapUsd` on token rows alternates
between the underlying's (this job) and Binance's token-level (`binance-prices`) for
the 25 static bStocks — as ordered, recorded as QUIRK-25.
