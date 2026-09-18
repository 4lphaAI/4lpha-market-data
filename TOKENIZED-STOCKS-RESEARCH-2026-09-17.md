# Tokenized stocks on BSC — research, measured 2026-09-17 ~04:00 UTC (00:00 ET, Wednesday)

Three questions from the operator, answered from live data: pool coverage per issuer and
ticker overlap (for the arbitrage product), candles for stock tokens, and trading hours per
issuer. Raw dataset: `data/research/rwa-bsc-pools-2026-09-17.json` (491 rows). Scripts in
the session scratchpad (`rwa-pools.mts`, `rwa-candles.mts`); the reusable signed probe is
`scripts/binance-rwa-probe.ts`.

Sources: Binance `GET /build/api/v1/dex/market/rwa/tokens?binanceChainId=56` (488 rows),
xstocks.com product JSON (811 products, 808 with a BSC address), DexScreener
`tokens/v1/bsc/{addr,...}` (every DEX it indexes, 30 addresses per call, 44 calls),
Binance `GET /build/api/v1/dex/market/candles`, the plane's own `getKlines`.

---

## 1. Pool coverage on BSC, by issuer

| Issuer | Tokens on BSC | Any DEX pool | Pool liq ≥ $10k | ≥ $100k | Traded in last 24h | Total pool liq | Total pool vol 24h |
|---|---|---|---|---|---|---|---|
| **bStocks** (`bstock`) | 46 (API) | 35 | **21** | 16 | 35 | $13.4M | $29.7M |
| **Ondo** (`ondo`) | 442 (API) | 45 | **8** | 2 | 45 | $0.69M | $1.9M |
| **xStocks** (Backed) | 808 deployed | 3 | **0** | 0 | 3 | $737 | $49 |

Pools are PancakeSwap V3 quoted in USDT almost everywhere (bstock best-pool quote: USDT 22,
WBNB 6, bStocks-quoted 4; ondo: USDT 15, then a long tail of meme quotes). A few Uniswap and
Flap pools exist but carry nothing.

**Caveat that changes the reading — AMM pools are not the only venue.** 11 bStocks have *no*
DEX pool at all (LITEB NBISB MRVLB WDCB ARMB PLTRB GLWB AVGOB EWYB KORUB QCOMB) and 14 more
have < $10k, yet all 46 report `TRADING` and Binance's own volume figures. bStocks trade
through Binance's LiquidMesh RFQ inside Binance Wallet (handoff §3.6: `bStock = LiquidMesh
SWAP + PcsXRfq`), and Ondo through Ondo's mint/redeem at reference price (`ondo` routes
RFQ-only in `/quote`). DexScreener cannot see either. So:

- "Has a pool" = **arbitrageable on-chain by anyone** (an AMM price that can diverge from NAV).
- "No pool but TRADING" = tradable only via Binance Wallet / Ondo RFQ at ~reference price —
  the *other leg* of an arb, not a venue that mis-prices.

### bStocks with a real pool (≥ $10k), the arb-relevant set

| Token | Ticker | Pool liq | Vol 24h | Txns 24h | Venue |
|---|---|---|---|---|---|
| NVDAB | NVDA | $2.73M | $1.68M | 10,395 | Pancake v3 / USDT |
| SPCXB | SPCX | $2.25M | $2.68M | 5,723 | Pancake v3 / WBNB |
| GOOGLB | GOOGL | $2.20M | $5.39M | 32,438 | Pancake v3 / USDT |
| QQQB | QQQ | $2.02M | $15.96M | 34,337 | Pancake v3 / USDT |
| SKHYB | SKHY | $536k | $568k | 3,402 | Pancake v3 / USDT |
| INTCB | INTC | $507k | $166k | 994 | Pancake v3 / USDT |
| MSTRB | MSTR | $462k | $498k | 1,882 | Pancake v3 / USDT |
| BABAB | BABA | $451k | $276k | 2,741 | Pancake v3 / USDT |
| TSLAB | TSLA | $428k | $237k | 860 | Pancake v3 / USDT |
| SPYB | SPY | $398k | $1.09M | 4,457 | Pancake v3 / USDT |
| HOODB | HOOD | $289k | $184k | 1,253 | Pancake v3 / USDT |
| MSFTB | MSFT | $252k | $78k | 502 | Pancake v3 / USDT |
| CRCLB | CRCL | $224k | $333k | 2,154 | Pancake v3 / USDT |
| SOXLB | SOXL | $178k | $71k | 1,226 | Pancake v3 / USDT |
| SNDKB | SNDK | $170k | $66k | 630 | Pancake v3 / USDT |
| METAB | META | $104k | $324k | 4,667 | Pancake v3 / USDT |
| TSMB | TSM | $68k | $13k | 79 | Pancake v3 / USDT |
| TQQQB | TQQQ | $65k | $34k | 369 | Pancake v3 / USDT |
| NOKB | NOK | $48k | $26k | 225 | Pancake v3 / USDT |
| SNXXB | SNXX | $35k | $16k | 444 | Pancake v3 / USDT |
| MUB | MU | $22k | $1k | 34 | Pancake v3 / ETH |

### Ondo with a real pool (≥ $10k)

| Token | Ticker | Pool liq | Vol 24h | Txns 24h | Venue |
|---|---|---|---|---|---|
| FXIon | FXI | $273k | $1.88M | 28,687 | Pancake v3 / USDT |
| PDDon | PDD | $101k | $2k | 63 | Pancake v3 / USDT |
| BILIon | BILI | $96k | $4k | 141 | Pancake v3 / USDT |
| DISon | DIS | $48k | $4k | 61 | Pancake v3 / USDT |
| GMEon | GME | $45k | $6k | 71 | Pancake v3 / USDT |
| SQQQon | SQQQ | $42k | $12k | 88 | Pancake v3 / USDT |
| SLVon | SLV | $36k | $0k | 32 | Pancake v3 / USDT |
| NVDAon | NVDA | $13k | $2k | 83 | Pancake v3 / USDT |

Ondo's on-chain pools are China ADRs / ETFs that bStocks does not list (FXI, PDD, BILI) plus
a handful of household names. Everything else Ondo (434 tokens) has no AMM liquidity on BSC.

### xStocks on BSC: deployed, not traded

808 of 811 xStocks products carry a BSC address (Backed deploys the same address on every
EVM chain). Only 3 have any BSC pool and the best is $1k (SPCXx, quoted in a meme token);
the "TSLAx/USDT" pair on Pancake v2 has **$9** of liquidity. xStocks liquidity lives on
Solana and Kraken, not BSC. For this hackathon xStocks is a **list, not a venue** — worth
carrying as `platform: xstock` rows for completeness (the address list is now on disk), not
worth a depth-based dedupe or an arb leg. This answers handoff open question 2.

## 2. Ticker overlap — what the arbitrage product has to work with

Overlap by `underlyingTicker` across the three lists:

| Combination | Tickers |
|---|---|
| bstock + ondo + xstock | 35 |
| bstock + ondo (no xstock) | 5 |
| bstock only | 6 |
| ondo + xstock | 177 |
| ondo only | 225 |
| xstock only | 596 |

**All 40 bStocks tickers except 6 are also issued by Ondo.** But cross-issuer *pool-vs-pool*
arb barely exists: only **one** ticker has ≥ $10k on both sides — **NVDA** (NVDAB $2.73M vs
NVDAon $13k). Every other overlap is a liquid bStock pool against a dead-or-tiny Ondo pool
(SPCX $2.25M vs $3k, TSLA $428k vs $3k, GOOGL $2.2M vs $3k, QQQ $2.02M vs $2k, SPY $398k vs
$1k, CRCL $224k vs $4k, COIN $2k vs $4k).

What that means for the marketplace arb design:

- **The tradable spread is pool-vs-reference, not pool-vs-pool.** Binance hands the reference
  (underlying) price per token; the AMM pool is the thing that drifts. Measured premium
  `tokenPrice/referencePrice − 1` at 00:00 ET: bStocks p50 0 bps, p90 13 bps, max 50 bps
  (36 of 46 within 1 bp); Ondo p50 9 bps, p90 218 bps, max 90,261 bps (thin pools).
- **Same-ticker cross-issuer arb** (buy NVDAon cheap, sell NVDAB rich) is capped by the Ondo
  side's depth — $13k — and only NVDA qualifies today. Treat as a watchlist, not a product.
- **The realistic cross-issuer leg is RFQ.** bStock RFQ (LiquidMesh) and Ondo mint/redeem
  both quote ~reference price around the clock (see §4); the arb is AMM pool ↔ RFQ on the
  *same* token, or AMM pool of one issuer ↔ RFQ of the other on the same ticker. Both need
  the execution plane's `/quote` read (handoff §3.6), which this plane does not yet call.

## 3. Candles for stock tokens

Binance Market API **has candles** and the plane's existing chain **also serves them**; both
were tested on six tokens spanning liquid bStock, liquid Ondo, thin Ondo, pool-less Ondo,
pool-less xStock.

`GET /build/api/v1/dex/market/candles?binanceChainId=56&tokenContractAddress=&bar=&limit=`
— `bar` ∈ `1s 5s 30s 1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M`, `limit` default 100,
`before`/`after` in ms. Rows are arrays `[open, high, low, close, volumeUsd, timestampMs,
tradeCount]`, ascending. Signed, shares the 5 rps bucket. 140–240 ms per call (one 414 ms cold).

| Token | Binance 5m / 1h / 1d rows (limit 50) | Plane `getKlines` 5m / 1h (OnchainOS) |
|---|---|---|
| NVDAB ($2.7M pool) | 50 / 50 / 50 | 50 / 50, close 215.94 vs Binance 215.85 |
| GOOGLB ($2.2M pool) | 50 / 50 / 50 | 50 / 50 |
| FXIon ($273k pool) | 50 / 50 / 50 | 50 / 50 |
| NVDAon ($13k pool) | 50 / 50 / 50 | 50 / 50 |
| ARQQon (no pool) | **22 / 20 / 16** — sparse, last trade 2026-09-11 | 50 / 50 — filled to now, close 18.96 |
| MMMx (no pool) | **2 / 2 / 2** — two trades ever | 50 / 50 — filled to now |

Reading:
- For anything with a pool, the two sources agree and the plane needs **no new kline path**
  for stocks. Order stays OnchainOS → Sintral.
- Binance candles are **trade-derived**: a pool-less token shows the handful of trades that
  happened (RFQ fills included — ARQQon has 22 five-minute candles across three months).
  OnchainOS returns a full window regardless, i.e. it forward-fills. For a "last trade" or
  "is anyone trading this" question Binance's sparse series is the honest one.
- Binance offers sub-minute bars (`1s`, `5s`, `30s`) the plane does not have. Not needed for
  stock tokens at present.
- Decision for handoff open question 3: **do not add Binance candles now.** Revisit only if
  the marketplace needs trade-count / sparse-honest series for the RFQ-only tokens.

## 4. Trading hours per issuer — measured, not assumed

Snapshot at 03:55 UTC Wednesday = 23:55 ET Tuesday, US cash market closed.

| Issuer | `statusInfo` at that moment | Session model |
|---|---|---|
| **bStocks** | all 46 `openState: true`, `marketStatus: null`, `reasonCode: TRADING`, `nextOpenTime/nextCloseTime: null` | **24/7, no session concept.** Confirmed by trades: NVDAB 5-min candles continuous 00:30–04:35 UTC, DexScreener shows 6 trades in the last 5 minutes at 23:55 ET, 10,395 txns/24h. |
| **Ondo** | `marketStatus: "overnight"`; 264 `TRADING`, 177 `openState:false / UNSUPPORTED`, 1 `ASSET_PAUSED` | **Session-based, 24/5, per-asset session support.** Next-open/close times group into four session classes (below). Ondo's own docs: 24/5 Sun 20:00 ET → Fri 19:59 ET, weekends closed except 24/7 mint/redeem on SPYon, QQQon, NVDAon, TSLAon, GOOGLon, CRCLon (July 2026). On-chain transfers and AMM pools are 24/7 regardless. |
| **xStocks** | not in the Binance API | Backed markets them as 24/7 DEX-tradable; on BSC there is nothing to trade (§1). |

Ondo session classes seen in `nextOpenTime`/`nextCloseTime` (UTC, EDT = UTC−4):

| Count | State now (overnight) | Next close | Next open | Reading |
|---|---|---|---|---|
| 255 | TRADING | 07:55 | 08:01 | all sessions: overnight → pre-market → regular → after-hours, ~6-minute gaps |
| 9 | TRADING | 07:55 | 13:31 | overnight + regular, no pre-market |
| 93 | UNSUPPORTED | 13:29 | 08:01 | pre-market + regular (+ after-hours), no overnight |
| 84 | UNSUPPORTED | 19:59 | 13:31 | **regular hours only** (09:31–15:59 ET) |
| 1 | ASSET_PAUSED | 13:29 | 08:10 | paused |

So `UNSUPPORTED` means "this asset does not trade in the current session", not "delisted".
7 of the 8 Ondo tokens with a real pool trade overnight; SQQQon is regular-hours only — and
its AMM pool keeps trading while Ondo's mint/redeem is closed, which is exactly when an
AMM price can drift from NAV with no arbitrageur able to close it. That window is the
tokenized-stock-specific risk the eligibility gate and the arb agent both have to respect.

**Correction to the plane's own assumptions:** `CLAUDE.md` said bStocks "only trade during US
market hours" and `src/universe.ts` tags them `marketHours: "us-equities"`. Measured, that is
Ondo's model, not bStocks'. bStocks are 24/7; the hard-coded `US_EQUITY_HOURS_UTC` on the
execution plane is wrong for bStocks and too coarse for Ondo (four session classes). The
replacement is the per-token `statusInfo` from `/tokens` (bulk, 1 call) refreshed each cycle.

## 5. Consequences for the build (no code yet — operator asked for research first)

1. Lane shape: `bstocks` = 46 rows from the API with the static 25 as floor; `ondo` rows are
   worth carrying (8 have pools, 442 have RFQ) with `platform`, `openState`, session times;
   `xstock` rows only as an address map, no depth work.
2. Eligibility: `openState=false` → deny stands. For Ondo it will flip per session, so the
   verdict must be read live from a fresh `/tokens` snapshot, never cached as a verdict.
3. Arbitrage inputs the marketplace will ask this plane for: `premiumBps` per pool-bearing
   token (bStocks 21 + Ondo 8), the pool address and liquidity behind it, and the session
   state — all derivable from `/tokens` + the pool dataset. The RFQ leg (`/quote`) stays on
   the execution plane.
4. Counts: 77 bStocks in `/platforms` vs 46 in `/tokens` is still unexplained; ask Binance.

---

## 6. Venue split — is Ondo liquidity on Uniswap? (measured 2026-09-17 ~06:30 UTC)

Operator hypothesis: bStocks live on PancakeSwap, Ondo on Uniswap, so the arb agent
should support both venues. Re-measured with **every** pair per token (488
DexScreener `token-pairs` calls, one per token — §1 had used `tokens/v1`, which
returns only the best pair per token, so its liquidity figures are best-pool, not
total), keeping only pairs against a major (USDT/USDC/WBNB/BTCB/ETH) or another
stock token. Dataset: `data/research/rwa-bsc-venues-2026-09-17.json` (173 pairs).
Every `uniswap` row was checked on chain: all are Uniswap **v3** pool contracts
(`slot0()` and `fee()` answer; fees 500/3000/10000).

| Issuer | Pairs | Total liq | Pancake v3 | Uniswap v3 | Pancake v2 | Other |
|---|---|---|---|---|---|---|
| **bStocks** | 113 | $22.4M | **$18.65M (83%)**, 59 pools, 24 tokens, 93% of volume | **$3.52M (16%)**, 14 pools, 8 tokens, 7% of volume | $0.24M (1%) | Topaz $0.02M |
| **Ondo** | 60 | $0.80M | **$0.71M (89%)**, 20 pools, 16 tokens, 98% of volume | $0.04M (5%), 8 pools | $0.05M (6%) | — |

**The hypothesis is inverted.** Ondo on BSC is Pancake v3 almost entirely; Uniswap
carries $40k of Ondo across 8 tokens. It is *bStocks* that have a real second venue:
Uniswap v3 holds $3.5M of bStocks, and for **QQQB the Uniswap v3 USDC pool ($2.64M)
is larger than the Pancake v3 USDT pool ($2.03M)**. NVDAB ($325k), SPCXB ($294k +
$100k), TSLAB ($63k) also have Uniswap v3 depth.

### Same token, two venues ≥ $10k — the cross-DEX spread at one instant

| Token | Venue A | Venue B | Spread |
|---|---|---|---|
| QQQB | Uni v3 $2,643k/USDC @707.99 | Pcs v3 $2,026k/USDT @709.72 | **24 bps** |
| NVDAB | Pcs v3 $2,730k/USDT @215.66 | Uni v3 $325k/USDT @215.97 | 14 bps |
| SPYB | Pcs v3 $398k/USDT @758.77 | Uni v3 $18k/WBNB @760.08 | 17 bps |
| TSLAB | Pcs v3 $428k/USDT @360.78 | Uni v3 $63k/USDT @361.16 | 11 bps |
| GOOGLB | Pcs v3 $2,050k/USDT @345.27 | Uni v3 $28k/USDT @345.04 | 7 bps |
| SPCXB | Pcs v3 $2,763k/USDT @152.19 | Uni v3 $294k/USDT @152.24 | 3 bps |
| SLVon | Pcs v3 $36k/USDT @57.29 | Uni v3 $26k/USDC @57.14 | 26 bps |
| MUB | Pcs v3 $22k/ETH @944.3 | Uni v3 $13k/USDT @929.22 | 162 bps (thin) |
| PDDon / BILIon / FXIon | Pcs v3 | Pcs v2 $10–21k | 36 / 20 / 0 bps |

QQQB is the case that matters: two pools above $2M each, 24 bps apart, quoted in
USDC vs USDT (the USDC/USDT 0.01% leg costs ~1 bp). That is a larger and deeper
spread than any cross-issuer pair (§2) and than the bStocks pool-vs-reference
median (0 bps). Uniswap v3 volume on NVDAB ($1.14M/24h) is 70% of its Pancake
volume — real flow, not dust.

### Decision input

- **Support Uniswap v3 as a second venue for bStocks — not for Ondo.** Concretely
  the 8 bStocks with a Uniswap v3 pool (QQQB, NVDAB, SPCXB, TSLAB, GOOGLB, SPYB,
  MUB, and NVDAB/USDC), of which 4 have ≥ $60k there.
- **Pancake v2 stays out**: ≤ $22k per pool on any stock token; every v2 pool is
  10–100× thinner than the same token's v3 pool.
- Data-plane consequence: the pool lane (`/pools/top`) is Pancake v3 only because it
  reads Pancake's explorer API. Uniswap v3 pools on BSC have the same contract ABI
  (`slot0`, `liquidity`, `fee`) as Pancake v3, so per-pool chain reads already in
  `pancake.ts` (`fetchPancakePoolOnchain`) work unchanged; discovery is the missing
  piece (DexScreener `token-pairs`, keyless, 300 rpm, or the Uniswap v3 factory
  `getPool` for the known fee tiers). A per-token `venues[]` — `{dex, version,
  pool, feeTier, quote, liquidityUsd}` — is what the arb agent needs from this plane.
- Execution-plane consequence (not this repo): a Uniswap v3 router path on BSC in
  addition to Pancake v3. Interfaces are the same family (`exactInputSingle` with
  a fee tier), different router address.

---

## 7. US-hours re-measure (2026-09-17 14:05 UTC = 10:05 ET, regular session) vs §1–§6 (00:00 ET)

Same scripts, same filters. Dataset: `data/research/rwa-bsc-venues-2026-09-17-us-hours.json`.

**Structure did not move.** bStocks 21 pools ≥ $10k (16 ≥ $100k), Ondo 8, xStocks 0 — identical
counts. Venue split identical to the percent: bStocks Pancake v3 84% / Uniswap v3 15%, Ondo
Pancake v3 88%. Big-pool liquidity within ±10% except NVDAB's Uniswap v3 pool ($325k → $147k,
someone pulled) and GOOGLB's second Pancake pool. Volume and txns rose on most pools with the
session open (QQQB Pancake $16.0M → $17.1M / 34.8k → 44.1k txns; BABAB $274k → $745k).

**Sessions.** Ondo: all **442 `TRADING` / `regular`** (from 264 open / 177 `UNSUPPORTED` / 1
paused overnight). bStocks: 46/46 `TRADING`, `marketStatus: null`, as always.

**Pool-vs-reference premium** (deepest priced venue ≥ $10k, vs `referencePrice × ratio`):

| | n | min | p10 | p50 | p90 | max |
|---|---|---|---|---|---|---|
| bStocks 00:00 ET | 21 | −62 | −30 | −7 | 9 | 90 |
| bStocks 10:05 ET | 21 | −55 | −30 | −8 | 9 | 18 |
| Ondo 00:00 ET | 8 | −198 | −198 | −45 | 36 | 36 |
| Ondo 10:05 ET | 8 | −158 | −158 | −70 | 19 | 19 |

bStocks sit within ±30 bps of NAV around the clock (NVDAB −22, SPCXB −16, QQQB −16, GOOGLB −15,
MSFTB −30); the only ≥ 50 bps readings are the $23–37k pools (MUB, SNXXB). **Ondo pools trade at
a persistent discount to NAV even in regular hours** — GMEon −158, SQQQon −121, SLVon −102,
DISon −72, FXIon −70 bps — which is the mint/redeem arb (buy the pool below NAV, redeem at NAV
through Ondo) sitting open for lack of an RFQ leg on BSC. That leg is the execution plane's.

**Cross-venue spreads narrowed with the session open**: QQQB Uni/Pcs 24 → 12 bps, NVDAB 14 → 14,
SPCXB 3 → 17, TSLAB 11 → 16. Same order of magnitude as the pool-vs-NAV premium, on pools ten
times deeper than any Ondo pool.

### Allowlist decision (operator, 2026-09-17 evening)

The tiers from §5 of the first pass hold unchanged after the US-hours read:

- **Tier A — 21 bStocks with a pool ≥ $10k**: NVDAB SPCXB QQQB GOOGLB SKHYB INTCB MSTRB BABAB
  TSLAB SPYB HOODB MSFTB CRCLB SOXLB SNDKB METAB TSMB TQQQB NOKB SNXXB MUB. Eligible today via
  allowlist (14) or `binance_rwa` (7: SKHYB BABAB HOODB TSMB TQQQB NOKB SNXXB); all pass the
  rule-5 veto 24/7.
- **Tier B — 8 Ondo with a pool ≥ $10k**: FXIon PDDon BILIon DISon GMEon SQQQon SLVon NVDAon.
  Eligible via `binance_rwa` only while `TRADING` in a supported session (SQQQon and others
  close overnight). Conditional on the execution plane's tiny live trade proving a 7702 wallet
  can hold Ondo tokens.
- **Not allowed for AMM trading**: 25 bStocks and 434 Ondo with no pool ≥ $10k (RFQ-only
  venues), 808 xStocks.

The plane sets no threshold itself: the `$10k` line is the consumer's, applied to
`venues[0].liquidityUsd` on the lane row; the gate only answers open/trading/known.

---

## 8. Spread history, first ~10 hours (2026-09-17 14:58 → 2026-09-18 00:57 UTC; 585 one-minute samples)

Source: production `GET /spreads?hours=24` from the `spread-history` job (`SPREAD-HISTORY-SPEC.md`):
`slot0` on the deepest two stable-quoted v3 pools per stock, every minute, NAV = `referencePrice ×
tokenToShareRatio`. Window covers 11:00–21:00 ET — end of the regular session, after-hours, start of
overnight. **Interim: the 24 h and 48 h reads follow.**

### Cross-venue (same token, two pools) — effectively dead

| Token | cross p50 / max (bps) | fee round trip | minutes > fee / 585 |
|---|---|---|---|
| QQQB (Uni 0.3% ↔ Pcs 0.01%, $2.7M / $2.0M) | 24 / 36 | 31 | **88** (15%), by 1–5 bps |
| SPCXB (Pcs 0.25% ↔ Uni 0.05%) | 8 / 23 | 30 | 0 |
| NVDAB, GOOGLB, TSLAB, MSFTB (Pcs 0.25% ↔ Pcs 1%) | 10–59 / 39–75 | 125 | 0 |
| SLVon, MUB | 28–36 / 43–52 | 125–200 | 0 |

Only QQQB ever clears the fee, and by less than gas + slippage. Not worth an agent at today's
liquidity; at most a watcher on QQQB.

### Pool vs NAV — real, and persistent through the regular session

| Token | NAV min / p50 / max (bps) | minutes \|NAV\| > pool fee | deepest pool |
|---|---|---|---|
| GMEon | −222 / **−188** / −103 | 585 / 585 | $46k @ 0.25% |
| SQQQon | −209 / **−177** / −119 | 585 / 585 | $41k @ 0.25% |
| DISon | −134 / **−70** / −27 | 585 / 585 | $47k @ 0.25% |
| **FXIon** | −184 / **−61** / −17 | 583 / 585 | **$253k** @ 0.25% |
| SGOVon (entered the watch set mid-window) | −127 flat | 104 / 104 | $104k @ 0.25% |
| NVDAon | −103 / −71 / 9 | 5 (pool fee is 1%) | $13k @ 1% |
| **NOKB** (bStock) | −89 / **−39** / 34 | 403 / 585 | $49k @ 0.25% |
| **QQQB** (bStock) | −37 / **−25** / −11 | 166 | Pcs **$2.0M @ 0.01%** |
| other bStocks | within ±30, p50 ≈ 0 | — | — |

- The Ondo discount is **not an after-hours artefact**: it held through 11:00–16:00 ET and after.
  FXIon is the actionable one — $253k of depth at −61 bps takes tens of thousands of dollars per
  fill; GME/SQQQ/DIS are deeper discounts on $40–50k pools.
- Two bStocks surprised: NOKB sits 39 bps under NAV 70% of the time, and QQQB sits 25 bps under NAV
  all day on a 0.01%-fee, $2M pool — buying under NAV there is nearly free; the question is whether
  a sell-at-NAV leg exists (Binance LiquidMesh RFQ for bStocks).
- Reading note: "minutes beyond fee" uses the deepest pool's own fee tier, so on 0.01% pools (SPYB,
  QQQB) it counts 2 bps deviations; read it with the p50.

### What this decides

1. Pool-vs-pool arb: **drop** (keep QQQB as a watcher at most).
2. Pool-vs-NAV arb is the real one and needs a **redeem/RFQ leg**, which this plane does not
   provide: Ondo redeem for FXIon / DISon / GMEon / SQQQon (60–190 bps, 100% of the window),
   Binance RFQ for QQQB / NOKB (25–40 bps on deep pools). This series is the evidence for the
   execution plane's decision to build that leg.
3. Open until the 48 h read: how the discounts behave across the Ondo weekend close (Fri 20:00 ET)
   — the risk of holding a position over the weekend.
