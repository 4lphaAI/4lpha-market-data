# Reply: Four.meme token tax on the meme rows (2026-10-07)

To: execution plane. Answers `MEME-FOURMEME-TAX-HANDOFF-2026-10-06.md`. Spec: `FOURMEME-TAX-SPEC.md`.
Build: branch `fourmeme-tax`, merged to `master` as `e6a48f0`. **Status: not deployed yet**; production results will be added here after deploy.

## TL;DR

- **Once deployed, graduated Four.meme rows carry `tax: { buyBps, sellBps }`** on the board (`/memes`, `/memes/:address`) and on every shortlist segment, stamped with `venueCheckedAt` from the same read as `venue`. Curve rows (`venue: "fourmeme-bonding"`) stay `tax: null`. `venue` is set on every Four.meme row as before.
- **`feeRate()` is the wrong view for the tokens you checked.** On the current tax templates (creator types 8 and 9, which includes `0x7330d886...5c94`) `feeRate()` is a deprecated field that reads `0`. The real rates are `feeRateBuy()` and `feeRateSell()`, **in percent**. If the three tokens you read as 0 were `ffff` tokens of type 8 or 9, their real rate is in `feeRateBuy`/`feeRateSell`: on the live board every type 8 and 9 token reads `feeRate() == 0` while 187 of 187 carry a buy rate of 1 to 10 percent.
- **Units, proven on chain:** types 8 and 9: percent, `fee = amount * rate / 100`, separate buy and sell rates. Type 5 (older): `feeRate` in **basis points**, one rate for both sides, `fee = amount * feeRate / 10000`. Every cited swap matches the formula to the wei.
- **Plain (non-tax) Four.meme templates read `{ buyBps: 0, sellBps: 0 }`**, but only for the three bytecodes proven tax-free against real swaps. Anything unrecognised is `null`.
- **Local live check (5 real board cycles into an in-memory store, 2026-10-07; re-run after the fix round, 3 cycles, same result):** all 127 graduated Four.meme rows on the board resolved to a proven template and carry a tax; 0 unrecognised; 205 curve rows `null`. `0x48d8dfed...ffff` reads `{100, 100}` with pool `0xf712b9d6...a4ec`.

## 1. Templates (question 3)

TokenManager2 (`0x5c952063c7fc8610FFDB798152D69F0B9550762b`) records each token's creator type as `(_tokenInfos(token).template >> 10) & 0x3F`. Four.meme documents this as the authoritative tax-family check (`four-meme-community/fourmeme-docs`, `docs/tax-guide.md`: type 5 TaxToken, 8 TaxToken8, 9 TaxToken9). I read it for all 332 Four.meme tokens on the live board, together with the bytecode, and every token fell into one of these:

| creator type | code identity | tokens on board | suffix | how the tax is read |
|---|---|---|---|---|
| 9 | EIP-1167 to `0x7330d8865f4b6800b72bdd73e2007833a5d45c94` | 177 | ffff | `feeRateBuy`, `feeRateSell`, percent |
| 9 | EIP-1167 to `0x28129943b5f12826b7b190e2443c3fc223ad740c` | 2 | ffff | same |
| 9 | EIP-1167 to `0xe506cd33886785816895dbfb2bc8927696c0c8ec` | 1 | ffff | same |
| 8 | non-proxy, keccak `0xd8c7d12f...0fa2bb9` (13,584 B) | 6 | ffff | same |
| 8 | non-proxy, keccak `0x760eda3e...bb5bfc904` (13,762 B) | 1 | ffff | same |
| 5 | non-proxy, keccak `0xf522baa0...be115d36b24` (10,456 B) | 5 | ffff | `feeRate`, bps, both sides |
| 0 | non-proxy, keccak `0x1210dbad...7ac0bf12d716ea` (3,822 B) | 86 | 4444 | none (no tax) |
| 0 | EIP-1167 to `0x46862924e2a229170ebd065e24a0da72af58a986` | 40 | 4444 | none (no tax) |
| 0 | non-proxy, keccak `0x3e6b67a7...95c7199f83d3579f` (2,901 B) | 14 | none (TUT etc.) | none (no tax) |

Full hashes are in `src/query/fourmemeTax.ts` (`FOURMEME_TEMPLATES`). Within each non-proxy group every token had the same bytecode hash, so the hash identifies the template. `ffff` marks Four.meme's tax and royalty family (documented as an identifier, not a safety mark); `4444` is the plain family.

A row gets a tax only when **both** facts agree: the TokenManager2 creator type and the code identity must be the same pair as a proven row above, and TokenManager2 must hold the token (`_tokenInfos(token).base == token`). An unknown implementation, a creator type that disagrees with the code, or a contract with no code gives `tax: null`. A new template Four.meme ships later stays `null` until it is proven and added (one line).

## 2. Unit and direction, with transactions (questions 1 and 2)

Method (`scripts/fourmeme-tax-evidence.ts`): candidate transactions from OKX's recent trades for the token, each judged from its receipt. A transaction counts only if it is one plain swap on the token's PancakeSwap V2 pair, and:

- **buy**: the pair sends `gross`, split into `net` to the buyer and `fee` to the token contract;
- **sell**: the seller (or router) sends `fee` to the token contract and `net` to the pair;
- the pair's own `Swap` event agrees with those `Transfer` legs (buy: `amountOut == gross`; sell: `amountIn == net`). The pair prices from its own balance change, so this rules out a deduction that emits no event;
- the fee equals what the views predict, to the wei: `floor(gross * rate / 100)` for types 8 and 9, `floor(gross * feeRate / 10000)` for type 5, `0` for plain templates.

Every transaction below passed all four checks ("EXACT"). Amounts are raw token units (18 decimals).

**Type 9, `0x7330...` implementation**

- `0xa87e6b3d9acf59c6bb72bb7ec94f79e69736ffff`: `feeRate()` 0, `feeRateBuy()` **2**, `feeRateSell()` **4**.
  - buy `0x5c94b322e24f2a2f3469363c6e1053e47f2a37aa7f686bbae43f0785215a91ff`: fee 2,076,563,788,402,747,910,813 of gross 103,828,189,420,137,395,540,655 = **2.00%**.
  - sell `0x1fecf1c1af3e3aae55c79dd38e8754172ab67899e26716a545d1980f98b5e5be`: fee 3,988e18 of gross 99,700e18 = **4.00%**.
  - So the rates are percent and buy and sell are separate.
- `0x48d8dfed649c097265680b650c1efbc8af42ffff` (the token the operator watched): 1 / 1.
  - buy `0xf6f521c07b9a03514295fcdc3255575e71e0c09335f37d62a57d129718322252`: 1.00%.
  - sell `0xd50d8c9c6b88a0e23a19da477003f77ea06ac9b5c2bad67592c79e8b0500070f`: 1.00%.

**Type 9, `0x2812...` implementation**

- `0xfc51f3e85e538a2d9910b8690717e47ba2dfffff`, 2 / 2: buy `0x33afce64aa4d1079b08896c170568c9e48206025618b6ae4acdd6d01d21a1b60`, sell `0xf73091634d05c1eeac13078f69a19ff30740936af1a9c4ccc29995b223d3ce15`, both 2.00%.
- `0x265b3982ea730748100947f52561a4eab54affff`, 1 / 1: buy `0x5547ba2b906b15ffc583a20c16d5b9944e034da87fb58deddfbe9ede97378fbc`, sell `0x29e04c27a0f13f1bb57ebfd4454734e88e6b7286717e40bb7efab2e71ccf89b3`.

**Type 9, `0xe506...` implementation**

- `0x6b145a008f722a46417145bef76a1ed294c3ffff`, 1 / 1: buy `0x0eee66a6cc2681b66acb4280775ecc936ebc1c0510af7f31dfff7bbf7f12a8c0`, sell `0x52e422dcc73e9b0e7edc97438ee253919ee45135e9604b4d2b6421490ed389e8`.

**Type 8, 13,584 B bytecode**

- `0xdac46f778892006248dbcc05f838d2692bafffff`: `feeRateBuy` **1**, `feeRateSell` **5**.
  - buy `0xf7176d3b4eb82b9dbf2b2c34d76741208f09db065ed1b343b8a287e23c2214d4`: fee 4,812,814,014,472,260,668,925 of gross 481,281,401,447,226,066,892,512 = **1.00%**.
  - sell `0xc31395d2e3ee650b086b9a53169e1cbb2ee7e2ec18a996c39e248c23a42f5e40`: fee 6,191,348,061,090,000,000,000 of gross 123,826,961,221,800,000,000,000 = **5.00%**.
- `0x2ec39b165e22944d2fee389219ee64e4924cffff`, 2 / 2: buy `0x2894ba86f055c9ad019a14856a8b01a98dd818d08814461e758a20ffb1bb9a46`, sell `0x5ac23a1a9ef04698a3f490d245b06b399607fd223a2c1e4381eeb68216b287a1`.
- Also passed: `0x1b81eac4...ffff`, `0x209e1c94...ffff`, `0xcb5b3e76...ffff`, `0xf225e701...ffff` (buy and sell each).

**Type 8, 13,762 B bytecode**

- `0xd3455a57b17c00dc1a8e0a91ad3ccb0c5af6ffff`, 1 / 1: buy `0x8386412bbf658c347993748ce44497d4fee490cac720d099a4c82528552a2e4e`, sell `0x16b9a2126e45c528f19fe2609a4f000184873afdea6423a0d51b30ad66ba8784`.

**Type 5, 10,456 B bytecode (bps, one rate)**

- `0xb29de8455acd47bb10755a133c54d0e595c6ffff`: `feeRate()` **300**, no `feeRateBuy`/`feeRateSell` views.
  - buy `0xab13c97797451f60a3b9c04f14ad78c824b6cb5d860cb1b8a41e6b9e1a56a5c4`: fee 393,666,176,811,492,527,396 of gross 13,122,205,893,716,417,579,875 = **3.00%**.
  - sell `0x4bdd5afebed66365c013e4aae59d043213889f1db31f74b6a75ebb5ab5832396`: fee 598.5e18 of gross 19,950e18 = **3.00%**.
  - So `feeRate` here is basis points and covers both sides.
- `0xd9614012310078b56ccc367017cf7d384864ffff`, `feeRate` 100: buy `0x25e6dcdd710cbbb8918cffc774af79189988e7ef8298093d4f8daa0c5c34aafb`, sell `0xfbd20969e950cef75562b834b52b1607553004e04660cd83db5f36e5f157bfa0`, both 1.00%.
- Also passed: `0x36a650e7...ffff`, `0xa690d5cd...ffff`, `0x353a58d0...ffff` (`feeRate` 100).

**Type 0, no tax**: a single Transfer leg, no fee leg, and the pair's `Swap` amount equal to it.

- 3,822 B: `0xeccbb861c0dda7efd964010085488b69317e4444` (龙虾): buy `0xddad527672bfa43ee0b407b51e1f807820dbffcdbe84fd10ca67eee3c75d89d2`, sell `0x77ddc4ec854c9e5adf69113881dfd0022005b63cf69bd1fb626f91dc20402b10`.
- `0x4686...` clone: `0x366385bbfb24bd6e58ebd486d150cdaff4114444`: buy `0x165f8d8ac1105dd3fd4bede8f9e183f2315db39db31ee06576b47c3ca04162de`, sell `0x5df5fdeb5250c3f7986bc190c3d7dd2f14f4d527b47fc6ca3e97203a28bd551c`. Also `0x26f1af29...4444`.
- 2,901 B: TUT `0xcaae2a2f939f51d97cdfa9a86e79e3f085b799f3`: buy `0x1b96321ca195f7f8b49560f3ee655256c8f9482d7feda7d42dabe43d8062b867`, sell `0xa280b0a710c0b5b313a859c9d822a6ebfc99da9df7727bde2e27df847f6c8d8a`.

The documentation agrees with every measurement: `docs/tax-guide.md` in `four-meme-community/fourmeme-docs` says type 5 `feeRate` is "basis points (`/ 10000`)", types 8 and 9 use "`feeRateBuy` / `feeRateSell` in percent (`/ 100`)", and "Prefer `feeRateBuy` / `feeRateSell` over deprecated `feeRate`". The rates above were proven on chain first and the doc found afterwards; the code relies on the measurements, not on the doc.

Rounding: the fee is floored, so the measured ratio reads 99.99 bps on most 1% trades. Treat the published bps as the rate; the floor costs at most one raw unit.

## 3. Can the owner change the rate after launch? (question 4)

Short answer: no rate setter was found, and after graduation the owner is the zero address, so no `Ownable` setter could be called. That is strong evidence, not a proof: four selectors stay unnamed (below). Treat the rate as re-readable, not as immutable.

- **No rate setter found in any template.** Four.meme's published ABIs (`abi/TaxToken*.lite.json`) list one owner-only write, `setMode(uint256)`. I resolved the function selectors in every template's bytecode against those ABIs and the public signature database. The owner-gated writes on the `0x7330` implementation are `setMode`, `setMigratedPool(address,bool)` and `setMigratedPools(address[],bool)` (each answers "Ownable: caller is not the owner" to a stranger); `sendFee`, `postMigrate` and friends answer "Not allowed". Nothing named like a rate setter exists. Four.meme's tax docs: "All parameters are locked at creation".
- **The owner is TokenManager2 on the curve and the zero address after graduation.** Board census 2026-10-07 (`node --import tsx scripts/fourmeme-tax-evidence.ts census <board.json>`, which groups by creator type, code identity, `owner()` and `_mode`): all 31 tax tokens in mode 0 (graduated) read `owner() == 0x0`; all 161 tax tokens in mode 1 (on the curve) read `owner() == 0x5c95...762b`. The same census shows one bytecode hash per non-proxy group. Ownership after graduation only rules out `Ownable` setters, not a setter gated some other way.
- **What stays open:** two selectors exist only on the `0x2812` and `0xe506` implementations (`0x38fee856`, `0x66004614`) and two on `0x7330` (`0x3aa67de4` answers a value of 0, `0x1d54d277` reverts with no data on empty arguments). I could not name them. Four.meme's docs also mention "tax expiration" for one launch mode (Universal Subscription). So the plane re-reads the rates rather than caching them: every 30 minutes for a graduated token, every cycle while it is on OKX's hot list. `venueCheckedAt` tells you how old the reading is.

## 4. What the rows carry now

On `/memes`, `/memes/:address` and every `/memes/shortlist` segment, for a Four.meme row:

| field | curve (`fourmeme-bonding`) | graduated (`pancake-v2`), proven template | graduated, anything else |
|---|---|---|---|
| `venue` | `fourmeme-bonding` | `pancake-v2` | `pancake-v2` |
| `tax` | `null` | `{ buyBps, sellBps }` (plain templates `{0, 0}`) | `null` |
| `pool` | `null` | the token's `pair()` for tax templates (the pair the tax is charged on); `null` for plain templates | `null` |
| `venueCheckedAt` | time of the venue read | time of the read that produced venue, tax and pool together | same |

Fail-closed rules (each pinned by a test; the readers are tested against a local JSON-RPC stub):

- An unknown code identity, a creator-type mismatch, or a token TokenManager2 does not hold: `null`.
- A reverted rate view, or a rate out of range (above 10% for types 8 and 9, above 1000 bps for type 5): `null`. `feeRate()` is never used in place of the buy and sell rates.
- A timeout or transport failure on the rate read: `null` **with that cycle's stamp**, never the previous rate under a new stamp. The token is retried next cycle rather than in 30 minutes.
- The code identity and creator type are read once per token and kept (they cannot change); a failed identity read is never stored. Any TokenManager2 error counts as a failed read, because viem reports an overloaded node's JSON-RPC -32603 as a contract revert, and TokenManager2 answers a token it does not hold with a zero struct rather than a revert (found in the audit, see section 6).
- A recognised template whose rates answer out of range is `null` and logged, and waits for the 30 minute cadence instead of being re-read every cycle.

**Curve rows stay `null` on purpose.** Four.meme documents that types 8 and 9 also charge their tax on the bonding curve, but as a quote-side fee taken inside TokenManager2, not as a token transfer fee, and an anti-sniper fee can be added in the first blocks. I did not prove either on chain, and you only take graduated Four.meme rows, so a curve row says "unknown". Ask if you want this, and it gets its own proof.

Notes for your cost rule:

- The tax is charged on transfers to and from the token's own V2 pair (`pair()`, now in `pool`). Every proof transaction swapped on that pair. A route through some other pool for the same token is outside what was measured.
- `venueCheckedAt` is the age of the tax reading. Because a rate change cannot be ruled out completely (section 3), and a Four.meme launch mode documents a "tax expiration", please honour that age in your screen; a graduated row is re-read every 30 minutes, a hot one every cycle. If a tax expired between reads, the published tax is too high, so the error makes a trade look dearer, not cheaper.
- The token has `setMigratedPool(s)`, so other pools could be flagged as taxed pairs. Routes through any pool other than `pair()` were not measured.
- Several sells went through an aggregator (`0x07964f13...45000000`, `0xb300000b...19c7028d`). The tax was still taken on the hop into the pair, at the same rate.

## 5. Not changed

- Flap rows, `/eligibility`.
- The `/memes` and shortlist shapes: `tax` and `pool` were already on the rows and are now filled for Four.meme. No new fields.

## 6. Process

Spec `FOURMEME-TAX-SPEC.md`, build on branch `fourmeme-tax`, independent audit (Opus 5.5), fix round.

- Audit verdict: **SHIP WITH RESIDUALS**. It found no path to a wrong non-null tax. It re-derived from chain, independently: the identity of `0x48d8...ffff` (type 9, clone of `0x7330...`), the plain hash of `0xeccb...4444`, the TokenManager2 struct layout (13 words; an unknown token answers all zeros), and the units from the `0xa87e` and `0xb29d` receipts.
- **M1 (fixed):** a JSON-RPC -32603 from an overloaded node reached the identity reader as a "revert" and would have been cached forever as "TokenManager2 does not hold this token", leaving that token `null` while tracked. Every TokenManager2 error is now a failed read, an empty code read is not kept, and a reader test reproduces the -32603 case (it fails against the old code).
- **L1 (fixed):** the rate reader now drops a token whose reads failed, rather than answering a tax with `pool: null`. It throws when nothing answered, so the next endpoint gets a turn.
- **L2 (fixed):** a rate answered out of range is logged and not re-read every cycle.
- **L3 (fixed):** identity reads are time-boxed at 10 s per cycle.
- **L4 (fixed):** reader tests added: -32603, empty code, partial failure, nothing answered, plain template.
- Open, outside this change: the shared `isContractLevelFailure` in `src/chain/rpc.ts` has the same -32603 blind spot for other callers (for example the Flap lane). Tracked separately.
