# Meme signals — reply to the execution plane (2026-10-05)

Answer to `MEME-SIGNALS-HANDOFF-2026-10-05.md`. All five items are built, each independently audited with a fix round. Same base URL and auth as every other route (`x-dp-token`, server-side only). Every change is additive: no existing field, route, verdict or default changed meaning.

| item | what you call | live on production |
|---|---|---|
| 5 social / smart-inflow measurement | `GET /memes/measure` (analysis only) | yes, since `c9e69b3` (2026-10-05 09:43 UTC) |
| 1 one-minute bars | `GET /memes/bars?addresses=`, `GET /memes/:address/bars` | after the next deploy |
| 2 smart-money net inflow | new fields on `/memes`, `/memes/shortlist` rows | after the next deploy |
| 3 5m buy/sell split | new fields on `/memes`, `/memes/shortlist` rows | after the next deploy |
| 4 tax and venue | new fields on board/shortlist rows; `venue` on `/eligibility` list hits | after the next deploy |

## 1. One-minute bars

```
GET /memes/bars?addresses=0xa,0xb,...&limit=60     # 1..30 addresses, answered in input order
GET /memes/0xa/bars?limit=60                        # one token; 404 not_tracked if no bars are kept
```

`limit` = newest closed minutes, 1..180, default 60. Measured cycle: 74 tokens tracked, 74 Sintral calls, ~3 s.

**Tracked set.** Every live meme stock on the board (quote is a bStock, status `runner`/`active`) plus every `segment=memestock` shortlist row. A token stays 30 min after it was last live; at most 120 are tracked (live first, shortlisted first, then by 5-min trades; logged when the cap binds). `tracked` = the job keeps the token now. A token that left keeps serving its last series for 30 min with `tracked: false` and its staleness ageing, then has no bars. A token never tracked answers `tracked: false`, `bars: []` — never an error in the batch.

**Per token:**

```json
{
  "address": "0xd7c8c310afd0e453ab307834ae36e202b0517777",
  "tracked": true,
  "symbol": "BIBI",
  "source": "sintral",
  "unit": "usd",
  "asOf": 1791193981000,
  "staleness": "fresh",
  "lastClosedStartMs": 1791193920000,
  "bars": [
    { "startMs": 1791193860000, "open": 0.000125779, "high": 0.000136469, "low": 0.000124434, "close": 0.000136469, "volume": 934.67, "trades": 11, "filled": false },
    { "startMs": 1791193920000, "open": 0.000136469, "high": 0.000136469, "low": 0.000136469, "close": 0.000136469, "volume": 0, "trades": 0, "filled": true }
  ]
}
```

- **Closed bars only.** A minute is closed 20 s after it ends and read once, right then (see `MEME-BARS-LATENCY-REPLY-2026-10-05.md`). `lastClosedStartMs` is the newest closed minute; bars are contiguous up to it, oldest first. The last 3 closed minutes are re-read every cycle, so a trade Sintral publishes late corrects its bar (and the flat minutes after it) within 3 minutes. Measured: the only later change is Sintral narrowing a wick (high/low back toward open/close, 0.5–6 %, 1–4 min after the close); `trades`, `volume` and `close` were final at first read.
- **Zero-fill.** A minute with no trade is a bar with `filled: true`, `trades: 0`, `volume: 0`, and open = high = low = close = the previous close (`filled` is an extra field beyond the ask, so a fill is never confused with a reported bar). Flatline detection sees silence; there are no gaps. A token's series starts at its first traded minute if that is inside the 180-minute window (so a fresh launch has fewer than 180 bars).
- **Units, measured against the chain (2026-10-05):** price and `volume` are **USD**. On a graduated V2 pair (MJ/NVDAB, three minutes of `Swap` logs) volume ÷ (token amount × close) was 0.98–1.02 and volume ÷ quote amount was 235.4–235.7 = NVDAB's price; on a Flap curve (bibi/NVDAB, Portal `TokenBought`/`TokenSold`) volume ÷ quote amount was 235.2–235.5. Volume is gross, both directions. The 1.53 median ratio you saw against OKX `volume1hUsd` is OKX's side.
- **`trades` is Sintral's count, not a log count:** 0.77–0.87 of the V2 `Swap` events and 0.49–0.84 of the Portal trade events in the same minutes. Use it relatively (burst vs previous minutes), not as an absolute number of swaps.
- **One source, no fallback.** Every bar is Sintral. If a fallback is ever added, bars will carry their own source and unit.
- `asOf`/`staleness` = when the token's series was last written: `fresh` < 3 min, `stale` 3–30 min, `dead` past 30 min (same convention as the board). Gate on `fresh` **and** on `now − lastClosedStartMs`: in normal running it is 20–82 s old at read time (p50 54 s, p90 73 s); while the series is still `fresh` it could be up to ~4 min old if the job stalls.
- Failure modes: a 429 from Sintral stops that cycle's remaining reads and backs the job off 2, 4, 8, then 10 min while it keeps happening (those tokens go stale, nothing is invented); a cycle where every read failed shows as a failing `meme-bars` job on `/status`, and `memes:bars:v1:index` there carries the last cycle's calls, failures, throttling and cap. A glitch row with a non-positive price is dropped (that minute reads as a fill). `meta` repeats the units, the close rule (`closedAfterMs`) and the zero-fill rule on every answer.

The comment in `src/query/klines.ts` that Sintral "only knows tokens Binance has listed" is corrected. Note `/klines` still falls back to OnchainOS, whose `vol` is in token units.

## 2. Smart-money net inflow

Board rows: `smartMoney.inflow5m`, `smartMoney.inflow1h`. Shortlist rows (where `smartMoney` is already a number): `smartInflow5m`, `smartInflow1h`.

```json
"smartInflow1h": { "netUsd": -1199.19, "traders": 2, "rank": 17, "rankedAt": 1791190856960 }
```

- `netUsd` signed USD from tagged smart-money wallets; `traders` = how many of them. Read every board cycle (~60 s), keyless, through the shared Binance limiter.
- `null` = not ranked (or unread). **Absence is not zero inflow.** Lists measured 3–15 rows for 5m, at most 50 for 1h; ~9 / ~27 board tokens carried one in a live cycle.
- **`rank` is Binance's position, and the ordering is opaque — not by net inflow** (a live 1h list had +$169 at 1 and −$27,966 at 5). Read `netUsd`, not `rank`.
- **Deviation from the ask: no `buys`/`sells`.** The upstream's `count`/`countBuy`/`countSell` are the token's **whole-market** trades over the window (MJ 1h: 11,175 vs OKX `txs1h` 11,817; BNCB carried 21,197 buys on the 5m list next to `traders: 1`). Putting them under `smartMoney` would mislabel them; the market split is already on the row as `flow5m`/`flow1h`.
- If a read fails, last cycle's value is kept while it is younger than 3 min (its `rankedAt` still dates it), then `null`. The existing `smartMoney` count and the `smart_money`/`kol`/`whale`/`smart_exit` flags are unchanged; inflow never raises a flag.

## 3. 5-minute buy/sell split

Board rows gain `flow5m`; shortlist rows gain `flow5m` and `flow1h` objects:

```json
"flow5m": { "buys": 30, "sells": 10, "uniqueTraders": 40, "inflowUsd": 250 },
"flow1h": { "buys": 300, "sells": 200, "uniqueTraders": 40, "inflowUsd": 1000 }
```

From OKX's hot ranking (top 100 per launchpad per window); `null` when the token is outside it for that window (~200 of ~740 board tokens had a 5m split in a live cycle). The flat `buys1h`/`sells1h`/`uniqueTraders1h` fields are unchanged.

## 4. Tax and venue

Board and shortlist rows gain:

```json
"venue": "pancake-v2",
"tax": { "buyBps": 0, "sellBps": 100 },
"pool": "0xe88701d7f67bd8f020cdf0f3bfda36b53c5200d0",
"nativeToQuoteSwapEnabled": true,
"dividend": { "token": "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", "bps": 10000 },
"venueCheckedAt": 1791193400000
```

(MJ, quoted in NVDAB.) Read from the launchpads on chain — the same Portal lens and Four.Meme helper `/eligibility` uses, plus Flap's TaxTokenHelper `getTaxTokenInfoV2` for the dividend.

- `venue`: `flap-bonding` | `fourmeme-bonding` | `pancake-v2`, the same rule as `/eligibility`. `null` = not read yet, or a Flap status the Portal will not trade.
- Refresh: a token on its curve that is trading is re-read **every cycle** (graduation moves the venue); a quiet/dead one every 10 min; a graduated one every 30 min (a Flap tax runs for a `taxDuration` set at launch, so it can drop to 0). `venueCheckedAt` dates the read.
- `tax`, `pool`, `nativeToQuoteSwapEnabled`: **Flap only**. Four.Meme rows carry `tax: null`, `pool: null` — the helper does not report them; `null` is unknown, not zero.
- `dividend` (Flap): reward token (zero address = BNB) and the share of tax routed to holders; `bps: 0` = no automatic payout. Fixed at launch, read once. **53 of 57 live meme stocks in a live cycle route 100% of their tax to a dividend paid in their own quote bStock** — a holder's wallet will receive the bStock; the executor should expect it.
- Live: 737/737 board rows placed; the board cycle went from ~4.6 s to ~5.5 s.

**`/eligibility`:** an allowlist or Binance Alpha hit on a Flap/Four.Meme token now carries `venue` and the launchpad state (`flap`/`fourmeme`) too, plus `venueCheckedAt`. **`eligible`, `reason` and `source` are unchanged for every address** (tested across every chain outcome, a throw and a hang). The read has a 1.5 s deadline and its own cache (30 s for a launchpad token, 6 h for "not a launchpad token"); a failed read answers `venue: null`. Cost: the first call for a listed address in a 6 h window now makes one `eth_call` (~100–170 ms) where it used to be a local lookup.

## 5. Social measurement (not a trading read)

`GET /memes/measure?since=&until=&limit=&format=` — export only; nothing on the board, the shortlist or any trading read consumes it until the operator rules.

- One cycle per wall-clock 5-minute slot: Binance social-rush topics (`latest`; `rising` stored only when it differs — today it is identical) with their tokens, the smart-money inflow rank (5m and 1h, every ranked row), and every meme-stock board row **including dead ones** (address, symbol, status, stage, category, quote symbol, flags, price, liquidity, mcap, txs 5m/1h, volume 5m/1h, price change 5m/1h, activity age, 1h buys/sells/inflow/unique traders, smart-money holders/KOL/signals, and whether it is on the memestock shortlist).
- Text kept: topic English name, type, tags and post link only. No AI summary, no other free text.
- 7-day rolling retention; ~90 KB per cycle on a 346-row board, ~26 MB/day.
- Paging: `since`/`until` as epoch ms or ISO with a zone; `limit` slots per page (default 12 = 1 h; max 24 expanded, 48 with `format=compact`); `meta.next` is the next page's `since`, `null` at the end. Pages cover closed slots only. `format=compact` returns the stored tuples with their column names.
- `meta.latest` summarises the newest cycle (counts of topics, topic tokens, meme stocks in topics, inflow rows, meme stocks in inflow).

## What did not change

`/eligibility` verdicts, every existing `/memes*` field and default, `/klines`, the shortlist's order and screens. Wallet-level tracking, X/Grok/paid feeds and serving social to a trading read remain out.
