# FOURMEME-TAX-SPEC: buy and sell tax on Four.Meme meme rows

Status: SPEC, then BUILD on branch `fourmeme-tax`, then an Opus 5.5 audit and a fix round.
Asked in `MEME-FOURMEME-TAX-HANDOFF-2026-10-06.md`; evidence and answers in
`MEME-FOURMEME-TAX-REPLY-2026-10-06.md`. This touches data the execution plane
uses to size and refuse trades, so it is not a hotfix.

## 1. Problem

Every Four.Meme row on the board and the shortlist carries `tax: null`
(`MemeVenueInfo.tax` is Flap only). The execution plane refuses a `null` tax
(`tax-unknown`), so no Four.Meme meme can be taken, graduated or not.

## 2. What the chain says (measured 2026-10-07, details in the reply)

Four.Meme deploys several token templates. TokenManager2 (`0x5c95...762b`)
records each token's creator type as `(_tokenInfos(token).template >> 10) & 0x3F`,
which Four.Meme documents as the authoritative tax-family check. On the live
board (332 Four.Meme tokens) every token fell into one of these code identities:

| creator type | code identity | tax views | rate unit |
|---|---|---|---|
| 9 (TaxToken9) | EIP-1167 to `0x7330d886...5c94` | `feeRateBuy`, `feeRateSell` | percent |
| 9 | EIP-1167 to `0x28129943...740c` | same | percent |
| 9 | EIP-1167 to `0xe506cd33...c8ec` | same | percent |
| 8 (TaxToken8) | bytecode hash `0xd8c7d12f...2bb9` (13,584 B) | same | percent |
| 8 | bytecode hash `0x760eda3e...c904` (13,762 B) | same | percent |
| 5 (TaxToken) | bytecode hash `0xf522baa0...6b24` (10,456 B) | `feeRate` | bps, both sides |
| 0 (plain) | bytecode hash `0x1210dbad...16ea` (3,822 B) | none | no tax |
| 0 | EIP-1167 to `0x46862924...a986` | none | no tax |
| 0 | bytecode hash `0x3e6b67a7...579f` (2,901 B) | none | no tax |

Only identities proven against real swaps (the reply lists the transactions)
enter the code; an identity whose proof is missing stays out and its tokens
read `null`.

The trap the execution plane hit: on types 8 and 9 `feeRate()` is a deprecated
field that reads `0`. The real rates are `feeRateBuy`/`feeRateSell`, in percent.

## 3. Rule

A Four.Meme row gets a tax only when all of these hold, else `tax: null`:

1. `venue == "pancake-v2"` (graduated). On the curve, types 8/9 charge their tax
   inside TokenManager2 in the quote asset, and an anti-sniper fee can be added
   in the first blocks; neither is proven here, so curve rows stay `null`.
2. TokenManager2 knows the token (`_tokenInfos(token).base == token`).
3. The pair (creator type, code identity) is one of the proven entries in the
   table. Code identity is the EIP-1167 implementation for a minimal proxy,
   otherwise the keccak-256 of the runtime bytecode. Unknown pair, a creator
   type that disagrees with the code, or no code: `null`.
4. The rate views answer, are integers, and are in bounds:
   - percent family (8, 9): `feeRateBuy` and `feeRateSell` each in 0..10 (the
     documented ceiling); `buyBps = feeRateBuy * 100`, `sellBps = feeRateSell * 100`.
     `feeRate()` is never read for these.
   - bps family (5): `feeRate` in 0..1000; `buyBps = sellBps = feeRate`.
   - plain (0): `{ buyBps: 0, sellBps: 0 }`, no view read.

A revert, a transport failure or a timeout on the rate read gives `null`,
never `0`. A plain template reports `0` only because its bytecode is a proven
no-tax template, never because a view was missing.

`pool` on a graduated Four.Meme row is the token's own `pair()` when the template
has one (the pair the tax is charged on); otherwise `null` as today.

## 4. Freshness

`venueCheckedAt` (`MemeVenueInfo.checkedAt`) stays the time of the read that
produced venue, tax and pool together: the tax is read in the same cycle as the
venue state and the stamp is that cycle's. Cadence is the existing one: a
graduated row every 30 min, a hot-only row every cycle. A graduated Four.Meme
row whose tax is `null` for a reason that can clear (code identity not read
yet, rate read failed) is due again next cycle instead of in 30 min. A row
whose template is known to be unrecognised keeps the 30 min cadence.

## 5. Cost and caching

- Creator type and code identity never change for a contract, so both are read
  once per token and kept on the venue cache entry (`memes:venues`). A failed
  read is never written. At most 100 identity reads per cycle (one `eth_getCode`
  each plus a multicalled `_tokenInfos`), so a cold start converges over a few
  cycles. Matching runs on every read, so adding a template later recognises
  cached tokens without a migration.
- Rate views are read in one `withBscClient` callback (viem multicall) for the
  graduated Four.Meme rows read this cycle.

## 6. Out of scope

Flap rows (unchanged). `/eligibility` shape (unchanged). Curve-phase tax.

## 7. Tests (offline)

Pure: proxy and hash identity; unknown identity, creator-type mismatch, `base`
mismatch, revert, out-of-bounds and non-integer rates give `null`; percent to
bps factor; plain gives `{0,0}`; bonding gives `null`. Job: identity cached and
not re-read; failed identity read not cached and retried next cycle; failed
rate read gives `null` with this cycle's stamp; unrecognised template not retried
every cycle; Flap rows untouched. Mutation: drop the `* 100` and the suite goes red.

## 8. Done when

Production after deploy: `0x48d8dfed...ffff` (graduated, type 9, 1%/1%) reads
`{ buyBps: 100, sellBps: 100 }` with a fresh `venueCheckedAt`; a graduated
plain `4444` token reads `{0,0}`; a bonding Four.Meme row stays `null`.
