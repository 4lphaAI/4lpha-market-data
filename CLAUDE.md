# 4lpha data plane — agent guide

The **data plane** for the 4lpha BNB-Chain agent marketplace: a standalone service that is the single source of market data for the whole product. Built phase by phase, each part Opus-built and independently audited. GitHub: private `kann420/4lpha-market-data` (branch `master`, linear history).

## Product context (hackathon)

Built for the BNB Chain **Smart Money Era** hackathon — brief and resources: https://www.bnbchain.org/en/hackathons/smart-money-era?tab=resources. The target data surface for the marketplace is: **holders, on-chain activity, price, k-lines, token eligibility, smart money, social**. All built to the extent decided: klines/price/eligibility/security, `/holders/:addr` (GMGN holder + smart-money count), `/socials/:addr` (creator-declared links).

**Scope decision — do not re-propose (2026-08-12):** deeper smart money (wallet-level tracking) and real social *signal* (X/KOL mentions, via Grok or any paid feed) are **out of scope for this plane**. The product will let users buy that data themselves via x402; this plane does not supply it. GMGN smart-money count and Four.Meme social links are the ceiling of what the plane provides.

Repos to port from / learn from:

- `D:\4alpha` — trading agent; source of the live Four.Meme trade path already ported into the eligibility gate.
- `D:\4lpha-0G` — LP agent.
- https://github.com/ClipXonchain/neural-alpha
- https://github.com/yeheskieltame/gridora
- https://github.com/rishu4436/Genesis

## What it is (the whole point)

Workers poll each upstream at its own cadence and write into one store; UI and agents read **only** from this store, never from upstreams directly. This turns fragmented sources (measured latencies 90–500ms, one dead) into one uniform-latency internal API. User load rises without upstream load rising — a leaked/slow upstream never reaches consumers.

## Stack

Node 22, TypeScript strict ESM, Hono HTTP, `pg` with an in-memory fallback when `DATABASE_URL` is unset, `node:test` offline-only (Postgres paths tested through a `FakeSqlClient` — no live DB), viem for on-chain reads.

## Source map

- `src/core/` — `DataRecord<T>` with `staleness: fresh|stale|dead` (computed at read time, never stored); `SnapshotStore` (Memory + Postgres); job `scheduler` (each job on its own interval + jitter + AbortSignal timeout; a timed-out run is aborted; failures isolated per-job, never crash the process; health persisted).
- `src/adapters/` — fourmeme, flap (on-chain: Portal `TokenCreated` logs + lens), onchainos (OKX HMAC-signed), binanceWeb3 (Binance Alpha token list ~660 + Sintral kline), gmgn, pancake (public explorer API), venus (on-chain via BSC RPC).
- `src/query/` — kline read-through chain, tiered security scan, the eligibility gate, holders/smart-money (`holders.ts`), and social links (`socials.ts`).
- `src/server.ts` — Hono app (pure `createServer(deps)`, no listen).

## Conventions

- `{ data, error?, meta? }` envelope everywhere; parameterized SQL only; sanitize upstream errors; secrets never logged.
- Every route except `/health` requires header `x-dp-token` (constant-time compare; env `DP_AUTH_TOKEN`). Consumers call over HTTP **server-side only**, never the browser.
- Endpoints: `/status` (job health + snapshot freshness — the "Data status" surface for judges), `/universe?lane=meme|coins|bstocks`, `/tokens/:addr` + batch `/tokens?addresses=`, `/klines/:addr`, `/security/:addr`, `/holders/:addr`, `/socials/:addr`, `/eligibility/:addr` + batch `/eligibility?addresses=`, `/pools`, `/venus/:owner`, `/diag/latency`. `npm run loadtest` — hit 300 rps, 0 errors, p95 ~37ms.
- The **meme lane is a union of two launchpads**, written by two independent jobs to two keys (`universe:meme` from `fourmeme-ranking`, `universe:flap` from `flap-launches`) and unioned at read time. Separate keys on purpose: one shared key would mean whichever job ran last erased the other's tokens. `lanes.meme.source` reports `fourmeme+flap`, and the lane is only as fresh as its stalest contributor.

## Eligibility gate (`src/query/eligibility.ts`)

The one read path that is **fail-closed**: klines and security fall back to a stale record, this one denies. An RPC outage, an unloadable allowlist, or a stale cache entry all answer "not eligible" — a wrong `false` refuses a trade, a wrong `true` sends capital at an unvetted contract. Never throws, so a caller cannot catch a failure into an allow.

Four rules, unioned. `data/eligible-tokens.json` covers the 222 enumerable tokens. The **Binance Alpha rule** admits any address in the `universe:coins` snapshot (written by `binance-universe` every 6h; the adapter drops `offline`/`fullyDelisted` rows — measured 2026-08-12: 486 BSC rows, 314 live) — read from the **store, fresh-only** (12h window), never from the bapi endpoint directly; a snapshot past fresh silences the rule and the token falls through to the other rules, keeping the gate fail-closed against an undocumented upstream. An Alpha hit is decided live like an allowlist hit (checked before the verdict cache, so a newly listed token overrides a cached `not_listed`) and never stored as a verdict. Launchpad tokens launch continuously and can never be enumerated, so each launchpad gets a factory rule:

- **Four.Meme**: TokenManagerHelper3 `0xF251F83e40a78868FcfA3FA4599Dad6494E46034` → `getTokenInfo(token)`, eligible iff `version == 2`. The same call returns `liquidityAdded`, the graduation flag and therefore the routing answer (`fourmeme-bonding` vs `pancake-v2`). Ported from `D:\4alpha`'s live trade path, which drives real orders through the same helper.
- **Flap** (BSC only): Portal `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0` → `getTokenV8Safe(token)`, eligible iff `status` is Tradable (1) or DEX (4). `status` is the graduation flag (`flap-bonding` vs `pancake-v2`).

Both reads are issued in the same tick inside one `withBscClient` callback, so viem's multicall batching folds them into a single `eth_call` — the second launchpad costs a struct in the response, not a round trip. Measured 113–172ms warm per uncached verdict.

Measured on chain, not assumed (2026-08-11):

- The helper **does not revert** for a token it has never heard of — an EOA and a plain BEP-20 both return a zero-filled struct. So `version == 0` is the ordinary negative answer; the revert branch is the rarer transport-shaped version of it.
- Graduated tokens **stay** in the helper: TUT (`0xcaae2a2f…99f3`) reads `version 2, liquidityAdded true`. Graduation does not evict, so the rule holds across a token's whole life.
- 87 of 88 live meme-lane tokens pass the factory rule. The exception was in Four.Meme's own ranking API but zero-filled in the helper — denied, correctly, since the execution plane has no trade path for it.
- `launchTime` is genuinely `0` for many fresh launches. Do not treat `0` as a decode error.

`D:\4alpha`'s `shouldUseDexTradeRoute` wraps the same read in `catch { return false }`, reading an outage as "not graduated". Same call, opposite default — safe when the question is *which venue*, unsafe when it is *whether at all*. Do not copy that swallow back.

### Flap, measured on chain (2026-08-11)

Flap is an EVM launch protocol (bonding curve → DEX, like Four.Meme) that also supports **tax tokens**; it is on BSC, Monad, xLayer, Robinhood and Toshimart, but only BSC is wired in here. There is no separate lens contract — the `IPortalLens` views live on the Portal proxy itself. `getTokenV8`/`getTokenV8Safe` exist on BNB mainnet/testnet only; other chains cap out at `getTokenV7`. `getTokenV8Safe` is preferred: it returns the four enum fields as `uint8`, so a new enum variant widens a number instead of failing to decode.

- **The negative is a revert, the opposite of Four.Meme.** The Portal answers `TokenNotFound(address)` — selector `0xde6137d1` — for anything it did not launch; a plain BEP-20, a Four.Meme token and an EOA all take that branch. So for Four.Meme `version == 0` is the ordinary negative and a revert is rare; for Flap the revert *is* the ordinary negative. Getting it backwards turns every non-Flap token into a failed read, and this gate denies on failed reads — Four.Meme would go down with it. Verified through viem's Multicall3 batching, where the revert still walks to `ContractFunctionRevertedError`.
- **Graduated tokens stay in the lens** — status flips to DEX (4), `progress` pins at 1e18, `pool` fills in. The rule holds across a token's whole life, same as TUT proved for Four.Meme.
- **After graduation the lens stops pricing**: `price` and `reserve` both read 0, and `pool` is the only price source it hands back. It is a routing/eligibility oracle, not a price oracle.
- **Graduation lands on PancakeSwap V2**, not V3: all 8 graduated tokens sampled carried a `pool` on factory `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73`, despite the lens also reporting `lpFeeProfile` (a V3 concept) and the docs defaulting `migratorType` to `V3_MIGRATOR`.
- **Non-native quotes are routine, not an edge case.** Several graduated tokens are quoted in bStocks — SPYB, QQQB, BABAB — rather than BNB. The lens also returns `nativeToQuoteSwapEnabled`, which is the direct answer to "can this be bought with BNB". The gate reports the quote and does not deny on it, matching how Four.Meme's `quote` is treated.
- **Volume is real.** Measured over blocks 115342469–115343069 (600 blocks, 270s wall, 0.450s/block): 3,637 Portal logs, **132 `TokenCreated` launches** and 209 distinct tokens touched — order of **~40k launches/day**. Two 50-block chunks failed mid-scan, so those are slight undercounts. `TokenCreated` topic0 is `0x504e7f36…9603` = `TokenCreated(uint256,address,uint256,address,string,string,string)` (ts, creator, nonce, token, name, symbol, meta).
- **Near enough everything is a tax token, but not quite.** Of 208 live tokens: `TOKEN_TAXED_V3` 152, `TOKEN_TAXED` 54, `TOKEN_V2_PERMIT` 2 — so 206/208 carry a tax and the non-tax path does occur. Buy and sell rates differ on 23 of them (e.g. 300/400 bps), so slippage has to be sized per direction. The docs' *Inspect A Token* page lists the enum only to 5; the authoritative list is on *Token Version Specification*, which goes to 7.
- **A third of tokens are quoted in something other than BNB** (64/208), and `nativeToQuoteSwapEnabled` was true for **exactly those 64** — every non-native-quote token in the sample lets the Portal swap BNB into the quote. So a non-native quote is a routing detail, not a blocker.
- Public `bsc-dataseed*` refuses `eth_getLogs` outright and `publicnode` refuses historical ranges; `bsc.drpc.org` served both. Only matters for indexing work — the gate itself is `eth_call` only.

### `flap-launches` job (the meme lane's second half)

Flap has no ranking API, so the lane is built from chain logs: `TokenCreated` on the Portal for discovery, the lens's `progress` field for "hot". Every 60s, 150 blocks (~68s at 0.45s/block, so cycles overlap rather than leave a gap), three 50-block `eth_getLogs` chunks. Measured 35 launches per window, ~2–3s per cycle, 0 missed chunks.

- **`TokenCreated` has nothing indexed** — one topic, all seven args in `data`, so address, name and symbol all come out of the payload. topic0 `0x504e7f36…9603`.
- **The server's `topics` filter cannot be trusted.** `bsc-rpc.publicnode.com` — currently the only public endpoint serving `eth_getLogs` at all — returns the identical 157 logs whether or not a topic filter is passed, other events included. The filter is still sent (a server that honours it saves ~30x: only 11 of 338 Portal logs in a window are launches) but the topic match is *always* redone locally, or `decodeEventLog` would be fed the wrong events.
- **Trailing window, not a cursor.** A cursor turns any downtime into unbounded catch-up over a path that public endpoints already refuse past 50 blocks. What keeps the lane wider than one window is that each cycle merges into the stored set rather than replacing it; the lens read then prunes anything no longer Tradable/DEX, and the lane is capped at 100 = newest 50 ∪ hottest 50 by `progress`.
- **The lane fails *open*, unlike the eligibility gate.** If the lens is unreadable the cycle publishes unpruned instead of emptying the lane — a universe lane that blanks on an RPC blink is worse than one carrying a stale row, and the record's own age already says how much to trust it. In the adapter this is why a per-token revert is folded into "absent" but a transport failure is rethrown to rotate endpoints: `isContractLevelFailure` (now in `chain/rpc.ts`, shared with the gate) is what keeps those apart.
- **`eth_getLogs` gets its own endpoint order** (`readLogRpcUrls()`): the default list leads with `bsc-dataseed` and `defibit`, which refuse log reads outright, so a log chunk burned two guaranteed-failed round trips before reaching one that answers. `eth_call` still uses the full list — dataseed is the fastest there.
- **It is much slower from Railway than locally**: 8–19.5s per cycle in production against ~1.7s from a local machine, with every chunk served and no failures. Network is not the cause — `eth_blockNumber` to the same endpoint is 91ms from Railway, *faster* than from a local machine, while a 50-block `eth_getLogs` is ~950ms locally and ~6.5s from Railway. Same endpoint, same few-hundred-KB payload, so the most probable explanation is per-IP throttling of Railway's shared egress. It is variable, not a fixed slowness, which fits.
- **Graduated rows are enriched from OnchainOS**, and only graduated ones. Measured 2026-08-12: OKX indexes a token once it has a DEX pool and **not before** — `price-info` for a Flap token still on its bonding curve returns an empty result, while every graduated one returns price, market cap, volume24H, holders and priceChange24H. So the bonding-curve phase has no third-party data by construction (there is no pool to index), which is exactly why discovery cannot be outsourced off-chain, and the lens is no help either since it stops pricing after graduation. Enrichment never fails a cycle: missing credentials or an OKX outage is a warning on top of a lane that is already published.
- **`price-info` drops tokens it has never indexed** — a batch of four addresses came back with two rows — so results are keyed by the response's own `tokenContractAddress`, never by request position. `fetchOnchainosPrices` batches up to 100 per call.
- Known limitation: the lane is seeded only from the trailing window, so a token that got hot *before* the service started is never picked up. Running continuously it converges, since a token is discovered at launch and then keeps its slot while its progress stays top-50. Observed converging in production from 14 to 85 entries over a few minutes, against a cap of 100.

Flap docs are wired in as an MCP server (`flap`, user scope → `https://docs.flap.sh/flap/~gitbook/mcp`): search/fetch over the docs only, no market-data endpoints.

## Holders / smart money (`src/query/holders.ts`) and socials (`src/query/socials.ts`)

Both are on-demand read-through paths, **fail-open** (serve stale on upstream failure) — telemetry, not gates.

- `/holders/:addr` — GMGN only: holder count + top-10 concentration (`fetchGmgnTokenHolders`) then smart-money count (`fetchGmgnSmartMoney`, tag `smart_degen`), issued **strictly in sequence** (a parallel pair is the easiest way to trip GMGN's per-IP burst limit, whose penalty is a host-wide ban; there is a test asserting no overlap). Cached hard: fresh 15min, dead 24h — wider than every other path because a miss costs ~3 sequential ~500ms round trips. Partial answers merge via `mergeHolderStats`; this is the current "smart money" surface — wallet-level tracking was assessed and deferred (would need log scans the public-RPC policy can't afford).
- `/socials/:addr` — creator-declared links (website/X/Telegram + description), presence not signal; real social signal has no keyless source (decided 2026-08-12). One upstream, measured: Four.Meme `private/token/get/v2?address=` is **keyless despite the path** and answers `webUrl`/`twitterUrl`/`telegramUrl`; the ranking rows do *not* carry these fields. A token Four.Meme never launched answers `code 0` with **no `data`** — a definite negative, cached as all-null links so unknown addresses don't become upstream load. Links are URL-validated (http/https only — creators paste garbage). Fresh 6h, dead 7d.

## Deployment

Railway project `4lpha-market-data` — service `data-plane` + a Postgres service, public URL `https://data-plane-production.up.railway.app`, healthcheck `/health`. Env from local `.env`. Dead QuikNode `BSC_RPC_URL*` vars were deleted; code falls back to public BSC endpoints (bsc-dataseed etc.), ~75–80ms from inside Railway.

### RPC policy: public only — decided, do not re-propose (2026-08-12)

**The plane's own workers run on public BSC endpoints and stay that way.** A paid/keyed RPC in `BSC_RPC_URL` was measured, costed and *declined*: speed beyond what public endpoints give is not the plane's problem to buy. Users who want a faster path get it as an **opt-in x402 QuickNode call** (`https://x402.quicknode.com/bsc-mainnet`, already a `/diag/latency` probe target — answers HTTP 402 in ~236ms from Railway), paid per call by whoever wants the speed.

Accepted consequences, so nobody rediscovers them as bugs:

- `eth_getLogs` has a **one-deep fallback**. `publicnode` is the only public endpoint serving recent ranges; `drpc` is rate-limited even from a residential IP, and dataseed/defibit/llama/meow refuse outright. If `publicnode` blocks us, `flap-launches` stops.
- That failure is bounded and already handled: the lane **goes stale, never empty or wrong**, and `/eligibility` is unaffected because it is `eth_call` only (dataseed, ~79ms). Missed chunks are logged.
- `flap-launches` cycles at 8–19.5s against a 30s timeout. That headroom is the thing to watch; if it starts timing out, shrink the scan window rather than reaching for a paid endpoint.

Note the shape mismatch to think through before building the x402 path: this plane's premise is that consumers read **only** from the store and never touch upstreams, so a per-user RPC does not belong on the worker path. It fits the execution plane or a premium passthrough, not `flap-launches`.

## Source-latency findings that drove the design (measured — non-obvious)

- OnchainOS ~90–155ms and Four.Meme ~125ms are the fast backbone.
- GMGN HTTP ~500ms with 47KB payloads **and it IP-bans on parallel calls** (`RATE_LIMIT_BANNED`) → enrichment-only, sequential, cached hard.
- **Pokebook is DEAD** — dropped from the kline chain. Birdeye was dropped too (2026-08-11, judged not worth the key). Order is now OnchainOS → Sintral (Binance); when both fail the plane serves the stale record rather than nothing.
- **CoinMarketCap: evaluated and rejected** (2026-08-11). The key in `D:\4lpha-fourmeme-skill\.env.local` is a paid plan that has **expired** — every billable endpoint answers HTTP 402 `1004`, only credit-free metadata (`/v1/key/info`, `/v1/cryptocurrency/map`) still responds. An expired CMC plan does not fall back to free tier, and a fresh Basic key has neither DEX endpoints nor OHLCV historical. Do not re-explore without a renewed paid plan.
- Binance Web3 bapi (`web3.binance.com`, `dquery.sintral.io`) is keyless and ~64–97ms but undocumented/uncommitted → sits behind the plane with fallbacks, never relied on alone.
- bStocks are ordinary BEP-20 on BSC (same adapters serve them); they have live PancakeSwap V3 pools (LP works) but only trade during US market hours.

The write-side counterpart is the execution plane (`D:\4lpha-execution`).
