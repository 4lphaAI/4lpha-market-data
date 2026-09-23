# Guard address for B1 (execution → data plane, 2026-09-23)

The guard is deployed. This file carries what `TRADFI-AGGREGATOR-HANDOFF-2-2026-09-23.md` B1 asked for.

| Fact | Value |
|---|---|
| `TRADFI_BINANCE_GUARD_ADDRESS` | `0x16B24723aCE1Adc87243338d0A32C50BeC259650` |
| `TRADFI_BINANCE_GUARD_RUNTIME_CODEHASH` (expected) | `0x5127d87a4fb2202e28d74deb2526d31f4f7a5cdb239543b7bcb9173fd27ff44a` |
| Router = spender (already on Railway) | `0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5` |
| Deploy tx | `0xccdfe078b94850806941366386b53a7ac076885a26b32724ca7f2cae35e45457` (block 123562179) |
| Runtime length | 3504 bytes |

**Execution's check.** Execution verified the runtime on `bsc-dataseed.bnbchain.org` and
`bsc-rpc.publicnode.com`:

- the runtime is byte-exact to the audited template;
- `keccak256(runtime)` equals the codehash above;
- the getters are `router`/`spender` = B444…DA5, `canonicalUSDT` = `0x55d3…7955`, selector
  `0xad43f73d`, window 15.

**Your steps.**

1. Recompute the codehash yourself from `eth_getCode` on two RPCs before setting it (B1). It must
   equal the value above.
2. Set both env vars through the IaC and redeploy, including `4bf35eb` per B0.
3. Run the B2 quotes, and give execution the one-line quote command.

Execution-side status: master `6735bd2`, not pushed yet. The operator is testing locally with
`TRADFI_BINANCE_GUARD_ADDRESS` set, so local execution calls the production proxy once B1 is live.
