# Meme shortlist — handoff to the execution plane (2026-10-05)

**Read this, not the board.** `GET /memes/shortlist` is the one meme read the trading agent needs: 20 tradable charts (30 for meme stocks), already screened, ranked and split, one flat row each, ~15 KB. Everything below is live on `https://data-plane-production.up.railway.app` since `8b1e69d` (pushed 2026-10-05).

The full board (`GET /memes`, ~800 tokens, ~1.1 MB, a third dead or unreadable) and the per-stock view (`GET /memes/stocks`) exist for UI and research. Do not run a decision cycle over them.

## Call

```
GET /memes/shortlist                      # memes, all quotes
GET /memes/shortlist?segment=memestock    # memes quoted in a bStock
x-dp-token: <DP_AUTH_TOKEN>               # server-side only, like every other route
```

Measured from a residential IP 2026-10-05: 283–322 ms, 15.0–15.1 KB.

## How fresh it is

- The board behind it is rebuilt **every ~60 s** (the `meme-board` job: 60 s ± 5 s jitter, ~2–5 s per cycle). The shortlist itself is computed **at request time** from the latest board. Two calls in the same minute return the same list; the next minute may differ.
- `meta.asOf` = when the board was built (epoch ms). `meta.staleness` = `fresh` under 3 min, `stale` 3–30 min (the job is failing), `dead` past 30 min.
- **Refuse to trade unless `meta.staleness === "fresh"`.** The shortlist still answers when the board is old and only says so in `meta`; it does not empty itself.
- Each row's `observedAt` is when OKX observed that token's trade numbers.
- Call it **before each decision** (or once a minute). Meme state moves in minutes.

## It is not an eligibility verdict

A row on the shortlist is a *candidate*. Before sending capital, call `GET /eligibility/:address` exactly as today: it is the fail-closed gate (Four.Meme helper `version == 2`, Flap Portal Tradable/DEX) and it returns the **venue** (`fourmeme-bonding` / `flap-bonding` / `pancake-v2`) and the launchpad state the route needs: quote token, Flap `nativeToQuoteSwapEnabled`, Flap buy/sell tax in bps. The shortlist does not repeat those.

## What is on it (defaults)

| screen | default | override |
|---|---|---|
| status | `runner`, `active` | `status=` comma list |
| traded in the last 5 min | ≥ 1 trade | `minTxs5m=` |
| liquidity | ≥ $3,000 | `minLiquidityUsd=` |
| excluded flags | `churn`, `wash_trading`, `smart_exit` | `excludeFlags=` list, or `none` |
| smart money | not required | `minSmartMoney=` |
| age | any | `maxAgeMinutes=` |
| size | 20 (`memestock`: 30), max 100 | `size=` |
| launchpad split | Flap 70% / Four.Meme 30% | `flapShare=` 0..1 |
| category quotas | daily 0.5 / long 0.25 / bluechip 0.25 | `mix=daily_runner:0.4,long_runner:0.3,bluechip:0.3`, or `none` |
| category filter | any | `category=` comma list |

Every value actually used is echoed in `meta.applied`; the defaults are in `meta.defaults`. A bad parameter → 400 `invalid_query` with a message.

**`segment=memestock`** adds gates (`meta.applied.gates`, each overridable, `none` clears one):

| gate | default |
|---|---|
| `minUniqueTraders1h` | 20 |
| `minBuySellRatio1h` | 0.8 (buys ÷ sells over the hour) |
| `minPriceChange1hPct` | −30 (down 30% or more in the hour is out) |
| `requireQuoteOpen` | `true`: the quote bStock must be known open |
| `maxPerQuote` | 5 memes per stock |

The buy/sell split comes from OKX's hot ranking (top 100 per launchpad). A meme outside it has no split: it is judged on `txs1h ≥ 3 × minUniqueTraders1h` and skips only the ratio gate; the price gate still applies. Such rows have `buys1h`/`sells1h`/`uniqueTraders1h` = `null`.

## Order and slots

1. Slots per **category** (`mix`), each split Flap:Four.Meme 7:3. A launchpad short of candidates hands its slots to the other (`meta.backfilled`).
2. Slots a category cannot fill go to the best remaining live charts of any kind (`meta.byCategory.fill`).
3. The list reads category by category: `daily_runner`, `long_runner`, `bluechip`, then uncategorised. Inside each: `runner` first, then 5-minute trades **by doubling band** (1, 2–3, 4–7, 8–15, …), smart money breaking ties **inside a band only**, then exact `txs5m`, then 1h volume. `meta.order` says this in words.

`meta.candidates` = how many passed every screen per launchpad; `meta.picked` = how many made the list.

## Categories

| `category` | meaning |
|---|---|
| `daily_runner` | the `runner` status: ≤ 24 h old, ≥ 20 trades/5 min, ≥ 100 trades/1h, ≥ $10k/1h, price up over the hour |
| `long_runner` | > 1 day old, +30% over 24 h on ≥ $100k volume and ≥ 50 trades/1h, not down 20% this hour |
| `bluechip` | mcap ≥ $5M, liquidity ≥ $250k, ≥ 7 days old, 24 h volume ≥ $100k (e.g. mubarak, TST, 牛来, Broccoli) |
| `null` | live, but none of the above |

Precedence daily > bluechip > long. Thresholds were set on Sunday/Monday-night data (2026-10-04/05) and will be revisited; they live in `MEME_RULES` and the board publishes them at `GET /memes` → `meta.rules`.

## Row

Real row, `segment=memestock`, 2026-10-05:

```json
{
  "address": "0x6e57676bd4953975cb4f0460a2a23f2cf3207777",
  "symbol": "vibe",
  "launchpad": "flap",
  "stage": "graduated",
  "status": "runner",
  "category": "daily_runner",
  "ageMinutes": 4,
  "progress": 100,
  "quote": {
    "kind": "bstock",
    "symbol": "BNCB",
    "address": "0x4902c5ebc598265ed2212b559b042de8a5eeec3f",
    "stock": { "priceUsd": 6.11, "openState": true }
  },
  "priceUsd": 0.0000504513,
  "marketCapUsd": 50451.31,
  "liquidityUsd": 19929.39,
  "holders": 166,
  "txs5m": 451,
  "txs1h": 451,
  "volume5mUsd": 53336.46,
  "volume1hUsd": 53336.46,
  "priceChange5mPct": 902.86,
  "priceChange1hPct": 902.86,
  "buys1h": 291,
  "sells1h": 148,
  "uniqueTraders1h": 214,
  "buys24h": 289,
  "sells24h": 154,
  "smartMoney": 1,
  "flags": ["dev_sold_all", "smart_money", "bstock_quote"],
  "observedAt": 1791134585449
}
```

| field | note |
|---|---|
| `stage` | `new` (< 30 min), `bonding`, `graduating` (progress ≥ 80), `graduated` |
| `progress` | bonding-curve 0–100; 100 once graduated |
| `quote.kind` | `bnb` · `stable` · `bstock` · `other`; `null` if the quote contract could not be read yet |
| `quote.stock` | bStock quotes only: the stock's Binance NAV price and session state; `null` otherwise or when unknown |
| `priceUsd`, `marketCapUsd`, `liquidityUsd` | USD, from OKX (Meme Rush when OKX has none). A bStock-quoted meme's USD price already moves with its stock |
| `txs*`, `volume*`, `priceChange*` | OKX windowed numbers. Percent values are percent (`902.86` = +902.86%) |
| `buys1h`, `sells1h`, `uniqueTraders1h` | OKX hot ranking; `null` when the token is not ranked |
| `buys24h`, `sells24h` | Binance Meme Rush (lifetime for a token under a day old); `null` on tokens only OKX listed |
| `smartMoney` | tagged smart-money holders + smart-money and KOL buy signals in the last 24 h. A count, not a score |
| `flags` | below |

Any number can be `null`. A `null` is unknown, not zero.

## Flags

| flag | meaning | on the default list? |
|---|---|---|
| `churn` | 1h volume ≥ 10 × market cap: churn, not demand | excluded |
| `wash_trading` | Binance dev/insider wash-trading tag | excluded |
| `smart_exit` | the newest smart-money signal's wallets sold ≥ 80% of what they bought | excluded |
| `dev_sold_all` | the creator sold everything | kept (common on Flap) |
| `clone` | a later token with the same symbol as an earlier one; provenance, not a verdict | kept |
| `sniper_heavy` / `bundler_heavy` / `top10_heavy` | holder concentration ≥ 30% / 20% / 50% | kept |
| `smart_money` / `kol` / `whale` | tagged holders or signals present | kept |
| `bstock_quote` | quoted in a bStock | kept |

Flags only Meme Rush supplies (`dev_sold_all`, `wash_trading`, sniper share) cannot be raised on a token that only OKX's hot ranking lists, so their absence there means "unknown", not "clean".

## Meme stocks: routing notes

- **Buying one means acquiring its quote stock first** (or letting the launchpad do it). Flap reports `nativeToQuoteSwapEnabled` on `/eligibility`: when true, the Portal swaps BNB into the quote for you. A graduated meme stock trades on a PancakeSwap V2 pair against the bStock, not against BNB.
- `quote.stock.openState` must be `true` to be on the memestock list by default. A halted stock is not a route.
- Six quote stocks are **not** on Binance's RWA token list (BNCB, HIMSB, GMEB, DJTB, FLNCB, MRNAB). The data plane prices them per address for this view only: they are **not** eligible to trade as stocks in their own right (`/eligibility` does not admit them through the RWA rule), so buying BNCB to reach a BNCB-quoted meme is a route decision for the execution plane, not something the data plane has vetted.
- On 2026-10-05 every meme stock that cleared the gates was on Flap (19/19). Four.Meme launches bStock-quoted tokens too (109 on the board), but none was live at measurement.

## Failure modes

- Board empty or never built: `data: []`, `meta.asOf: null`, `meta.staleness: null`.
- OKX activity failed this cycle: rows keep the previous cycle's numbers; `observedAt` dates them.
- RWA job down: `quote.stock` keeps the last session state for up to 24 h (stock records are used until `dead`), then goes `null`, and the memestock list empties by default (`requireQuoteOpen`); `requireQuoteOpen=false` reads it anyway.
- Meme Rush or OKX hot ranking partly down: the board still publishes from what answered; a total discovery failure keeps the last board, which then ages to `stale`.

## Contact surface

Code: `src/query/memeQuery.ts` (`parseShortlistQuery`, `buildShortlist`, `SHORTLIST_DEFAULTS`, `SEGMENT_GATES`), `src/query/memeClassify.ts` (`MEME_RULES`, categories, flags), `src/jobs/memeBoard.ts`. Tests `test/memeBoard.test.ts`. One live cycle locally: `node --import tsx scripts/meme-board-check.ts`.
