# BINANCE-RWA-SPEC — signed Binance Web3 RWA adapter, `binance-rwa` job, stock lanes

Status: SPEC → BUILD → one independent review. Requested by the operator 2026-09-17
for the BNB Hack *Tokenized Stocks Edition* (handoff:
`TOKENIZED-STOCKS-HANDOFF-2026-09-16.md`, research:
`TOKENIZED-STOCKS-RESEARCH-2026-09-17.md`). Build in THIS repo only; the
execution plane keeps reading over HTTP with `x-dp-token`.

**Explicitly out of this spec** (each gets its own): the eligibility rule changes
(`openState=false` → deny, admitting Ondo, liquidity thresholds — money-adjacent,
waits for the allowlist decision after tonight's US-hours re-measure); the joint
`UniverseLane` schema change with the execution plane; the RFQ / `/quote` leg;
`/underlying-market` sweeps; candles (measured: not needed).

## 0. Why (measured 2026-09-16/17, see `DEVEX-NOTES.md`)

- The `bstocks` lane is a static list of 25 (`src/universe.ts`); Binance lists 46
  bStocks and 442 Ondo tokens on BSC, all from **one signed call**:
  `GET /build/api/v1/dex/market/rwa/tokens?binanceChainId=56` → 488 rows, 152 ms,
  no pagination, each row already carrying `tokenPrice`, `referencePrice`,
  `statusInfo.openState/marketStatus/nextOpenTime/nextCloseTime`, `underlyingTicker`,
  `platformId`, `decimals`, `tokenToShareRatio`, `volume24H`, `marketCap`.
- `tokenPrice / referencePrice − 1` is the premium/discount signal the hackathon
  idea list is built around; the plane has no reference price today.
- The API key is rate-limited to **5 rps per key, shared across every endpoint**
  (docs say "per endpoint" — wrong, PITFALL-6), rejects same-millisecond
  duplicates unless `X-OC-NONCE` is sent (PITFALL-5), and 414s a `/price` batch
  above ~80 addresses (PITFALL-7). The adapter has to encode all three.

## 1. Goal

1. `src/adapters/binanceRwa.ts` — the plane's only client of the signed Binance
   Web3 API. Reusable by later jobs (candles, underlying-market) without
   re-learning the pitfalls.
2. `binance-rwa` job — every 60 s, one `/tokens` call → `universe:rwa` snapshot
   with typed rows for all BSC RWA tokens, plus `priceUsd` merged into each
   token's `/tokens/:address` snapshot.
3. `/universe?lane=bstocks` becomes **static 25 ∪ API bStocks**, rows gaining the
   RWA fields; `/universe?lane=ondo` is new. `/status` shows the job and the
   snapshot's freshness.

Non-goals: no threshold, no verdict, no dedupe by ticker, no xStocks rows (808
addresses with ~$700 of BSC liquidity — carried as a data file only).

## 2. Adapter — `src/adapters/binanceRwa.ts`

Pattern: `src/adapters/onchainos.ts` (signed request, credential presence
check, sanitized errors). New file; `src/adapters/binanceWeb3.ts` (undocumented
public bapi, feeds `universe:coins` and `binance-prices`) is **not touched**.

### 2.1 Credentials and env

- `BINANCE_WEB3_API_KEY`, `BINANCE_WEB3_SECRET_KEY` (already in `.env.example`
  as blanks and in the operator's `.env`; add to Railway). Read lazily via
  `readCredentials()`; both missing → `MissingCredentialsError("binance-rwa")`,
  which the job reports as "source unavailable", never as a crash.
- `hasBinanceRwaCredentials()` exported for `/status`-style diagnostics and for
  `src/index.ts` to log once at boot whether the job is armed.
- Never log the key, the secret, the signature, or a full request URL that
  carries them (it does not — they are headers — but the log line for a failed
  request must be `method + path` only, no headers, no body).

### 2.2 Signing

`X-OC-SIGN = base64(HMAC-SHA256(secret, timestamp + METHOD + requestPath + body))`
where `requestPath` **includes the `/build` prefix and the query string exactly
as sent**; `timestamp` is `new Date().toISOString()` (ISO-8601 with ms, `Z`).
Headers: `X-OC-APIKEY`, `X-OC-TIMESTAMP`, `X-OC-SIGN`, **`X-OC-NONCE:
randomUUID()` on every request** (the server keys anti-replay on the nonce and
falls back to the signature when absent — same path in the same ms = duplicate,
`401 40103`). `X-OC-RECV-WINDOW` left at default.

`createSignature()` exported for the test, as in onchainos. Base:
`https://web3.binance.com`; query built once with `URLSearchParams` and reused
for both the signature and the URL.

### 2.3 Rate limiter — one bucket per process, per key

`src/adapters/rateLimiter.ts` (new, small, reusable): token bucket,
`capacity 5`, refill `5 / s`, `acquire(signal)` resolves when a token is
available, rejects on abort. Injectable clock/sleep for tests. Module-level
singleton inside `binanceRwa.ts` (`BINANCE_RWA_LIMITER`), so every current and
future caller of this adapter — including later candles/underlying-market jobs
— shares the one bucket that Binance actually enforces. Requests are therefore
**sequential by construction** at ≤5/s; the adapter never fans out a batch in
parallel.

Why not per-endpoint: measured, the bucket is per key (20/40 ok when two
endpoints ran at 5 rps each).

### 2.4 Errors, retries

- Transport error → `AdapterError("binance-rwa", sanitized)`.
- `401/403` → `AdapterError(.., "authentication rejected", status)`.
  (`40103 Duplicate request detected` would land here; with a nonce it must
  never happen — log the `x-oc-blocked-by` header value when it does, that
  header is the only thing that distinguishes it from a bad key.)
- `429` → **one** retry after `max(Retry-After, 1) s`, then
  `AdapterError(.., "rate limited", 429)`. Bounded so a shared-key collision
  with a local probe run does not spin.
- `414` → `AdapterError(.., "request too long", 414)`; the batch helper must
  never produce it (2.5).
- `!ok` → `upstream responded N`; non-JSON → `invalid JSON`; `code !== 0` →
  `AdapterError(sanitized msg)`. Body of a `code 0` response is `data`.
- All are `AdapterError`s → the job fails that cycle, keeps the last snapshot.

### 2.5 Functions

```ts
fetchRwaTokens({ chainId = "56", platformId?, signal?, fetchFn? }): Promise<RwaToken[]>
fetchRwaPrices({ chainId = "56", addresses, signal?, fetchFn? }): Promise<RwaPrice[]>   // chunks of ≤80, sequential
fetchRwaUnderlyingMarket({ chainId = "56", address, signal?, fetchFn? }): Promise<RwaUnderlyingMarket>
fetchRwaPlatforms({ signal?, fetchFn? }): Promise<RwaPlatform[]>
```

`RWA_PRICE_BATCH_MAX = 80` — measured: 80 addresses (3 697-char URL) → 200,
90 → bare 414. Results keyed by the response's own `tokenContractAddress`,
never by request position (the same rule as OnchainOS `price-info`).

Only `fetchRwaTokens` is used by this spec's job; the other three exist so the
next spec does not re-derive the signing, and each gets a normalizer test.

### 2.6 Normalization → `RwaToken`

All numerics arrive as **strings** (`"215.84"`, `"18"`); `nextOpenTime` etc. as
numbers (ms) or `null`. Normalize with `parseNum`/`parseStr` from `http.js`;
never `Number(undefined)`.

```ts
interface RwaToken {
  address: string;                 // lowercased
  symbol: string;                  // "NVDAB", "NVDAon"
  name: string | null;
  platform: "bstock" | "ondo" | string;   // pass through unknown values, do not throw
  underlyingTicker: string | null; // "NVDA"
  underlyingName: string | null;
  decimals: number | null;
  tokenToShareRatio: number | null;
  tokenPriceUsd: number | null;    // on-chain price Binance observes
  referencePriceUsd: number | null;// underlying's price
  premiumBps: number | null;       // round((tokenPrice/reference − 1) × 1e4); null unless both > 0
  marketCapUsd: number | null;     // of the token supply, per Binance
  underlyingVolume24hUsd: number | null; // NOT token volume — QUIRK-15, named to say so
  openState: boolean | null;
  marketStatus: string | null;     // bStocks: null; Ondo: "overnight" | "regular" | ...
  reasonCode: string | null;       // "TRADING" | "UNSUPPORTED" | "ASSET_PAUSED"
  nextOpenMs: number | null;
  nextCloseMs: number | null;
}
```

Rows without a parseable EVM address or symbol are dropped and counted;
the count goes in the job's return value so a shape change is visible in the
log, not silent.

## 3. Job — `src/jobs/binanceRwa.ts`

```
name       binance-rwa
interval   60 s, jitter 5 s, timeout 20 s
run        fetchRwaTokens({ chainId: "56", signal })
           → if rows.length === 0: throw ("rwa token list returned no BSC rows")   // keep previous snapshot
           → store.put("universe:rwa", { rows, byPlatform: { bstock: n, ondo: n } }, { source: "binance-rwa", freshForMs: 5 min, deadAfterMs: 24 h })
           → for each row with tokenPriceUsd !== null: mergeTokenIntoStore(store, "binance-rwa", { address, priceUsd, marketCapUsd, symbol, ... })
           → return { rows, bstock, ondo, dropped, priced }
```

- **One upstream call per cycle.** 60 s cadence = 1 req/min against a 300/min
  ceiling; the whole product's Binance load stays here.
- **Fail open, like the universe lanes, not like the gate**: any adapter error
  throws → the scheduler records the failure, `universe:rwa` ages through
  `stale` (after 5 min) to `dead` (24 h). The lane read (§4) keeps serving the
  static 25 regardless. Nothing in this job ever writes an empty lane.
- **Token snapshot merge**: `priceUsd` from `tokenPriceUsd`; `marketCapUsd`;
  `symbol`. `volume24hUsd` is **not** written from `volume24H` (it is the
  underlying's volume). `binance-prices` (bapi) keeps running and may also write
  `priceUsd` for the 25 static bStocks — both are Binance's number for the same
  token, last writer wins, and `updatedFields`/`source` on the record say which.
  Accepted; revisit if the two ever disagree by more than the measured premium.
- 488 `mergeTokenIntoStore` calls per cycle = 488 store round trips on
  Postgres. Measured pattern elsewhere (`binance-prices` does 246). Acceptable;
  if a cycle approaches the 20 s timeout, batch the puts — do not lengthen the
  timeout.
- Registered in `src/index.ts` **only when credentials are present**
  (`hasBinanceRwaCredentials()`), with one boot log line either way, mirroring
  how a missing OKX key is handled. `STATUS_SNAPSHOT_KEYS` gains `universe:rwa`.

## 4. Lane read — `src/universe.ts`, `src/core/models.ts`, `/universe`

### 4.1 `UniverseEntry` gains optional RWA fields

```ts
interface UniverseEntry {
  address; symbol; name?; lane; source;
  marketHours?: "us-equities";          // unchanged for now — see 4.4
  platform?: "bstock" | "ondo" | string;
  underlyingTicker?: string;
  tokenPriceUsd?: number | null;
  referencePriceUsd?: number | null;
  premiumBps?: number | null;
  openState?: boolean | null;
  marketStatus?: string | null;
  reasonCode?: string | null;
  nextOpenMs?: number | null;
  nextCloseMs?: number | null;
  decimals?: number | null;
  tokenToShareRatio?: number | null;
  staleness?: Staleness;               // of the universe:rwa snapshot the row came from
}
```

Additive only. Existing consumers see the same fields they see today.

### 4.2 `Lane` gains `"ondo"`

`type Lane = "meme" | "coins" | "bstocks" | "allowlist" | "ondo"`. `LANES` in
`server.ts` gains it; `isLane` follows. `lookupLane()` (used for security TTL)
treats unknown/`ondo` like `coins` — a curated-list token, not a meme.

### 4.3 `buildUniverse`

- Read `universe:rwa`. Split rows by `platform`.
- `bstocks` = static 25 (source `static`, as today) **overwritten by** API rows
  with the same address (source `binance-rwa`, all RWA fields, `staleness`)
  **∪** API bStocks not in the static list. Static rows never disappear: with
  `universe:rwa` missing or dead the lane is exactly today's 25. Precedence in
  the address merge stays `bstocks > coins > meme`; `ondo` sits between
  `bstocks` and `coins` (a curated issuer list beats an Alpha listing, loses to
  bStocks — one token cannot be both, but the rule must exist).
- `lanes.bstocks` reports `count`, `source: "static+binance-rwa"` (or `static`
  when the snapshot is absent), `staleness` = the snapshot's (or `fresh` when
  static-only, as today), `asOf` = the snapshot's `asOf` or `null`.
- `lanes.ondo` = `{ count, staleness, asOf, source: "binance-rwa" }`, `count 0`
  and `staleness null` when the snapshot is absent — the same vocabulary the
  meme lane uses for a contributor that has not run.
- `/universe` with no `lane` returns Ondo rows in the merge (they are real BSC
  tokens the marketplace can price); `?lane=ondo` filters as the others do.

### 4.4 `marketHours: "us-equities"` — kept, flagged

Measured wrong for bStocks (24/7) and too coarse for Ondo (four session
classes). It stays on the static rows untouched in this spec because the
execution plane may branch on it, and a false "closed" is the safe direction.
The replacement is the per-row `openState`/`marketStatus`/`next*Ms` above; the
removal is part of the joint schema change, not this build.

## 5. Tests (offline, `node:test`, no network)

`test/adapters.binanceRwa.test.ts`
- signature: known secret/timestamp/path → expected base64 (computed in-test
  with `createHmac`, like the OKX test); the signed path **starts with
  `/build`** and carries the query string; a nonce header is present and
  differs between two consecutive requests.
- credentials: absent → `MissingCredentialsError`, no fetch call.
- normalizer: fixture row (the real NVDAB and ARQQon rows from
  `data/research`, trimmed) → typed `RwaToken`; string numerics parsed;
  `premiumBps` null when either price is 0/null; unknown `platformId`
  preserved; row without address dropped and counted.
- errors: 429 with `Retry-After: 1` → exactly one retry then success; 429
  twice → `AdapterError` 429; `code !== 0` → `AdapterError` with the sanitized
  msg; non-JSON → `invalid JSON`; 414 → `AdapterError` 414.
- batch: 200 addresses → 3 calls of 80/80/40, sequential (assert no overlap
  with the same start/end bookkeeping used in `holders.test.ts`), results keyed
  by response address (a response missing one row leaves that address absent,
  never shifted).
- limiter (`test/rateLimiter.test.ts`): 12 acquires with an injected clock →
  5 immediately, the rest paced at 200 ms; abort rejects a waiter.

`test/jobs.binanceRwa.test.ts`
- happy path on `MemoryStore` **and** through `FakePg` (bigint/timestamptz
  coercion — the retention bug in CLAUDE.md is why): snapshot written with the
  right TTLs, 488-row fixture → `byPlatform` counts, token snapshots merged
  with `priceUsd` and **without** `volume24hUsd`.
- empty list → throws, previous snapshot untouched.
- adapter error → throws, previous snapshot untouched, no token writes.
- `buildUniverse`: static-only when the snapshot is missing; static row
  overwritten by the API row with same address (fields present, `source`
  `binance-rwa`); API-only bStock appears; Ondo rows under `lane: "ondo"`;
  `lanes.bstocks.source` string; dead snapshot → rows still served with
  `staleness: "dead"`.
- `/universe?lane=ondo` and `?lane=bstocks` through `createServer` with the
  auth header; `?lane=xstock` → 400 `invalid_lane`.

`npm test` must stay green; `npm run smoke` unchanged.

## 6. DevEx capture during the build

Every surprise goes into `DEVEX-NOTES.md` as it is hit — the schema.json field
descriptions vs the rendered page, any `code !== 0` value seen with its `msg`,
the first production `/status` numbers from Railway (latency to
`web3.binance.com` from Railway's egress — the flap-launches finding says
Railway can be 5× slower than local on some hosts; measure, do not assume).

## 7. Review checklist (for the independent reviewer)

- [ ] Secret never appears in a log line, error message, or test fixture output.
- [ ] Signed `requestPath` = `/build` + path + `?` + query, byte-identical to the URL sent.
- [ ] Nonce on every request; limiter is one module-level bucket; no `Promise.all` over Binance calls anywhere.
- [ ] `/price` chunking ≤ 80 and sequential; keyed by response address.
- [ ] Job never writes an empty `universe:rwa`; static 25 survive a dead snapshot.
- [ ] `volume24H` does not reach `volume24hUsd`.
- [ ] `Lane` union extended everywhere it is enumerated (`LANES`, `isLane`, `lanes` record type, `lookupLane` default).
- [ ] `FakePg` path exercised for the new key (bigint TTLs).
- [ ] Nothing in `src/query/eligibility.ts` changed.

## 8. Open items carried forward (not blocking this build)

- 77 vs 46 bStocks (`/platforms` vs `/tokens`) — ask Binance; the lane takes `/tokens`.
- Tonight's US-hours re-measure → allowlist decision → eligibility spec.
- Joint `UniverseLane` change with the execution plane (`ondo`, `platform`, dropping `marketHours`).
- Per-row `poolAddress`/`feeTier` for the execution plane's v3 route — belongs
  with the pool dataset, next spec.
