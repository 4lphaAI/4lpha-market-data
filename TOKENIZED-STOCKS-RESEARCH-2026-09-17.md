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
