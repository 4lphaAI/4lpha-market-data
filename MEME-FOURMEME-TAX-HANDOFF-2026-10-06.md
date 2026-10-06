# Handoff: Four.meme token tax on the meme rows (2026-10-06)

From: execution plane (paper meme lane, Agentic Wallet). Reply in `MEME-FOURMEME-TAX-REPLY-2026-10-06.md`.

## Why

The exec plane now takes **graduated Four.meme memes** (venue `pancake-v2`) in paper mode, beside Flap (exec master `c14ef66`, operator hotfix). It refuses any row whose `tax` is `null` with the code `tax-unknown`, because the round-trip cost rule and the paper PnL both need the buy and sell tax, and a missing tax must never read as zero.

Today every Four.meme row on `/memes/shortlist?segment=memestock` carries `tax: null` (`src/query/memeClassify.ts:210`: "Flap only, the Four.Meme helper does not report one"). So every Four.meme meme is still refused. The operator watched one Four.meme memestock (`0x48d8dfed649c097265680b650c1efbc8af42ffff`) run from about 20k to 300k+ USD market cap while refused.

## Ask

1. Fill `tax: { buyBps, sellBps }` for Four.meme rows, on the shortlist rows and on the board row (`/memes/:address`), at least once graduated (`venue: "pancake-v2"`), with the same freshness stamp as the Flap venue read (`venueCheckedAt`).
2. Keep `venue` set on Four.meme shortlist rows (`pancake-v2` after migration, `fourmeme-bonding` before). The exec screen treats a Four.meme row with `venue: null` as still on its curve and refuses it.
3. Fail closed: a template you do not recognise, a read that reverts or times out, or a unit you have not proven gives `tax: null`, never `0`.

## What we already know (exec side, read-only checks)

- Four.meme v2 tokens seen so far (address suffix `4444` or `ffff`) are EIP-1167 minimal proxies to the implementation `0x7330d8865f4b6800b72bdd73e2007833a5d45c94`.
- That implementation exposes `feeRate()`. It returned `0` on the 3 live tokens we checked.
- `/eligibility` returns `fourmeme: { version: 2, tokenManager: 0x5c95…762b, quote, launchTime, liquidityAdded }` and no tax field.

## What you need to establish (and put in the reply with evidence)

1. **The unit of `feeRate()`.** Find at least one Four.meme token whose `feeRate()` is not zero and compare it with a real swap on chain: the `Transfer` amounts of one buy and one sell (amount leaving the pair vs amount reaching the buyer; amount the seller sent vs amount reaching the pair). Give the tx hashes.
2. **Buy vs sell.** Whether one rate applies to both directions, or the template has separate buy and sell rates.
3. **Other templates.** Whether Four.meme deploys other token templates (a different EIP-1167 target, a non-proxy token, a "tax token" variant). List each implementation address you find and how you read its tax. An unrecognised template stays `tax: null`.
4. **Whether the rate can change after launch** (an owner setter), so we know how often it must be re-read.

## Out of scope

No change to Flap rows. No change to `/eligibility` shape is needed (a tax there is welcome but not required; the exec plane reads the Four.meme tax from the shortlist row).
