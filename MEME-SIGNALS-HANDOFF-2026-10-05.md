# Meme signals: request from the execution plane (2026-10-05)

**From:** execution plane (`D:\4lpha-execution`), research `MD here/AGENTIC-MEME-STOCKS-RESEARCH.md` there.
**Why:** the operator is adding a **meme-stock option to Agentic AI Trade** (memes quoted in a bStock, bonding and graduated, USDT in/out). Its brain is **volume + smart money + social (measured first)**, not EMA/RSI. Today the plane has no meme time series, a thin buy-only smart-money feed, no 5m buy/sell split on rows, no tax/venue on the board and no social. The operator ruled on 2026-10-05: **the plane does all items below**, and the social measurement runs **inside the plane** (the operator will not run a local recorder for days).

Process: this plane's own build and audit rules apply. Nothing here touches money or keys. Keep every change additive: no existing field, route, verdict or default changes meaning (the execution plane's live Trade and TradFi agents read `/eligibility`, `/memes*`, `/klines`).

Deadline context: BNB Hack Tokenized Stocks closes 2026-10-11 12:00 UTC. **Suggested order: item 5 first** (the measurement needs 1-2 days of data), then 2, 4, 3, 1.

When done, write the contract back as a handoff doc in the style of `MEME-SHORTLIST-HANDOFF-2026-10-05.md` (call, freshness, fields, nulls, failure modes, measured numbers).

---

## 1. One-minute bar series for meme stocks

**Need:** the brain computes a volume burst (1m volume vs the previous minutes) and a dead-chart veto (drawdown from the 60m high, volume decay 10m vs previous 30m, lower highs/lows, flatline minutes, VWAP) from 1m bars, before entry and every cycle while holding.

**Measured 2026-10-05 15:40 +07** (61 live meme stocks = board rows `quote.kind=bstock`, status runner|active):
- Sintral `GET https://dquery.sintral.io/u-kline/v1/k-line/candles?platform=bsc&address=..&interval=1min&limit=60` answered with bars for **61/61**, bonding and graduated Flap tokens alike. The comment in `src/query/klines.ts:15-16` ("Sintral only knows tokens Binance has listed ... fails fast/empty") does not hold for Flap meme stocks today: re-measure and correct it.
- Bars exist **only for minutes with trades**: a missing minute means zero trades. Last bar start age: median 124 s, min 46 s, max 2 106 s. Row = `[open, high, low, close, volume, startMs, count]`.
- **Volume unit unverified:** sum of 60 x 1m volume / OKX `volume1hUsd`: median 1.53, p10 0.87, p90 3.43 (n = 36). Not bStock units (that would be ~1/200). Establish the unit against on-chain swaps (V2 Swap for a graduated token, Portal trades for a bonding one) before calling it USD.
- The OKX fallback in `/klines` uses positional `vol` (token units, `onchainos.ts:174-192`), so mixing sources mixes units.

**Ask:**
- Tracked set: every live meme-stock row (`quote.kind=bstock`, runner|active) plus every row on `/memes/shortlist?segment=memestock`; a token leaves after 30 min dead or off both; a cap (e.g. 120) with the cap logged.
- Keep the last **180 closed one-minute bars** per tracked token (backfill on entry, then incremental each minute). **Zero-fill** missing minutes explicitly (`trades: 0`, OHLC = previous close), so flatline detection sees silence. Closed bars only; say which minute is the last closed one.
- One source per series; if a fallback is ever used, the bar carries its source and unit, never a silent mix.
- Serve: `GET /memes/bars?addresses=a,b,..` (up to 30) and `GET /memes/:address/bars`, `limit` 1..180, fields `startMs, open, high, low, close, volume, trades`, plus per token `asOf`, `lastClosedStartMs`, `source`, `unit`, `staleness` (same fresh / stale / dead convention as the board).
- Budget: about 60-120 Sintral calls per minute today. Bound concurrency, back off on 429, log the call count and failures per cycle.

## 2. Smart-money net inflow (Binance Web3)

**Need:** a fresh, signed smart-money signal (buys AND sells). The OKX feed is ~2.4 buy signals per hour; this one is ranked per 5m / 1h window.

**Source (keyless):** `POST https://web3.binance.com/bapi/defi/v1/public/wallet-direct/tracker/wallet/token/inflow/rank/query/ai`, body `{"chainId":"56","period":"5m"|"1h","tagType":2}` (upstream accepts only `tagType` 2; periods `5m`/`1h`/`4h`/`24h`). Row fields include `ca, inflow` (signed USD), `count, countBuy, countSell, traders, volume, price, marketCap, liquidity, holders, holdersTop10Percent, tokenRiskLevel, tokenRiskCodes, aiNarrativeFlag, launchTime`. This is a different endpoint from the Binance smart-money signal list that `CLAUDE.md` measured as too thin.

**Measured 2026-10-05:** 17 rows (5m), 59 rows (1h); 19 meme stocks across the two lists at 15:35 +07 (e.g. 强叔, GM). It is a rank: **absence means "not ranked", not zero inflow**.

**Ask:** fetch 5m and 1h every board cycle; add to board rows and shortlist rows `smartMoney.inflow5m` / `smartMoney.inflow1h` = `{netUsd, buys, sells, traders, rankedAt} | null`. Keep the existing `smartMoney` count and flags unchanged. Goes through the shared Binance-host limiter (6 concurrent, per-IP throttle).

## 3. Keep the 5m buy/sell split

The OKX hot ranking 5m split is fetched and discarded (`memeBoard.ts:151-160, 355-358`); only `flow1h` is kept and its `inflowUsd` is not on shortlist rows. **Ask:** keep `flow5m = {buys, sells, uniqueTraders, inflowUsd}` like `flow1h`, and put both `flow5m` and `flow1h` (with `inflowUsd`) on shortlist rows. Null when the token is outside OKX's top 100 for that window.

## 4. Tax and venue on the board

The Flap lens read already returns `buyTaxBps, sellTaxBps, nativeToQuoteSwapEnabled, pool` but `launchpadState.ts:46-53` keeps only migrated, progress and quote; today these exist only per token on `/eligibility` (cached 30 s).

**Measured 2026-10-05:** all 21 shortlisted meme stocks had sellTax >= 100 bps, several 200-300 bps each way; Flap curve trades add a 1 % protocol fee each way.

**Ask:** on board and shortlist rows add `venue` (`flap-bonding` | `fourmeme-bonding` | `pancake-v2`), `tax {buyBps, sellBps}`, `pool`, `nativeToQuoteSwapEnabled`, refreshed every cycle while bonding (graduation changes the venue). Optional if cheap: Flap `dividendToken` and `dividendBps` (TaxTokenHelper `getTaxTokenInfoV2`, BNB mainnet `0x53841c73217735F37BC1775538b03b23feFD8346`, fixed at launch so cacheable): a dividend paid in the quote bStock lands in the holder's wallet and the executor must expect it.

Also: `/eligibility` answers allowlist / Binance Alpha tokens before the chain read with `venue: null` (`eligibility.ts:521-528, 636-651`). For Flap / Four.Meme tokens, fill `venue` (and the launchpad state) anyway. **Additive only: `eligible` and `reason` must not change for any address.**

## 5. Social measurement recorder (in the plane, not served for trading)

**Ruling (operator 2026-10-05, `CLAUDE.md` "Revised 2026-10-05"):** social opened narrowly, measure first. One source: Binance Web3 `social-rush` hot topics. Recorded for measurement; **nothing reaches the board, the shortlist or any trading read** until the operator rules on the numbers.

**Source (keyless):** `GET https://web3.binance.com/bapi/defi/v2/public/wallet-direct/buw/wallet/market/token/social-rush/rank/list/ai?chainId=56&rankType=10&sort=10&asc=false` (`rankType` 10 Latest, 20 Rising; on 2026-10-05 20 returned the same list as 10 with `sort=10`: store it only when it differs). Topic fields: `topicId, name.topicNameEn, type, topicTags, topicLink, createTime, risingTime, viralTime, progress, topicNetInflow, topicNetInflow1h, topicNetInflowAth, tokenList[]`; token fields include `contractAddress, symbol, protocol, migrateStatus, netInflow1h, volume1hBuy, volume1hSell, uniqueTrader5m, count5m, marketCap, liquidity, smartMoneyHolders, kolHolders`. Do not store `aiSummary` or other free text beyond the topic name and link.

**Measured 2026-10-05 15:35 +07:** 30 topics, ~100 associated tokens, 9 of them meme stocks on the board (e.g. MJ / NVDAB, runner, topic "Michael Jensen"). Many topic names carry "Uncertain:" or "Alleged": Binance itself flags them.

**Ask:** a job every 300 s (lease, jitter) that stores per cycle:
- the social-rush topics (above),
- the smart-money inflow rows of item 2 (5m and 1h, all ranked rows),
- a compact snapshot of every meme-stock board row **including dead ones**: `address, status, stage, category, priceUsd, liquidityUsd, marketCapUsd, txs5m, volume5mUsd, volume1hUsd, flow1h.buys/sells, smartMoney count, flags`.

Retention 7 days, rolling. Size target about 30 MB/day or less (a naive JSON line was ~217 KB per cycle, ~62 MB/day; topics ~72 KB of it change slowly, dedupe them). Read-only export for analysis: `GET /memes/measure?since=&until=` (token-auth, paged or JSONL), not used by any trading path. The analysis (overlap rate, lead time of topic vs runner status, forward returns topic vs non-topic, the same for smart inflow) is done on the execution side after 1-2 days.

A local version of this recorder exists for reference only: `D:\4lpha-execution\scripts\research\meme-social\record.ts`.

---

## What the execution plane will call (for shaping the contract)

Every ~60 s per Agentic meme-stock agent: `/memes/shortlist?segment=memestock` (with items 2-4 on the rows), `/memes/bars?addresses=` for up to ~30 candidates and held tokens, `/eligibility?addresses=` before any buy. It refuses unless `staleness` is fresh, and treats every null as unknown. It never sees social data until the operator rules.

## Out of scope

Wallet-level tracking (no trigger addresses), X / Grok / paid feeds, serving social to any trading read, CMC calls (the execution plane owns x402), any change in the execution repo.
