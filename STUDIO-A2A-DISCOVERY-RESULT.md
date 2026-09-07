# A2A discovery result and remaining full-client work — 2026-09-07

Built and independently cleared, default OFF, not deployed. Data-plane Studio
discovery now accepts an exclusive {id,a2aCardUrl} target alongside unchanged
{id,mcpEndpoint} targets. Same authenticated /studio/agents[/id] cache-only API,
same registry/mainnet/pinned HTTPS/time/size limits. No UI or hire-flow changes.

Public A2A0.3.0 card GET only. Summary retains bounded name/description/version,
invocationUrl, default modes and skill metadata; no schemas/extensions/signatures
or secondary URL resolution. Auth labels are declarations, not access checks.
Same-origin invocation URL is a conservative subset. No A2A tasks, seller tools,
OAuth, payment, minter or execute calls. Failed/stale summaries are cleared.
Config digest includes revision2, so prior snapshots cannot be served as current.

## Independent process

Astra xhigh spec reviewer cleared with precise auth/GET/backward-compatibility
amendments. Separate Astra xhigh audit found one medium auth-validation issue:
String coercion accepted arrays as enum values, and combined declarations could
exceed16KiB. Fixed primitive type checks and combined cap; reproductions added.
Final independent audit CLEARED, no blocker/high/medium remain; independently
ran16/16 focused tests and repair checks. Full suites are builder evidence.

## Actual external acceptance

Final checks: DP565 tests/565 pass/0skip, typecheck/buildPASS. Web559/559 and
typecheckPASS. Root4065 tests/4044 pass/19 fail/1skip (same as previous run);
typecheck exit2,2351 diagnostics identical to pre-change baseline. No product
source was changed in the execution repo or web; new local diagnostic is .mjs.

Final checks: DP565 tests/565 pass/0skip, typecheck/buildPASS. Web559/559 and
typecheckPASS. Root4065 tests/4044 pass/19 fail/1skip (same as previous run);
typecheck exit2,2351 diagnostics identical to pre-change baseline. No product
source was changed in the execution repo or web; new local diagnostic is .mjs.

Live mainnet SDK reads → exact registry-bound Card GET → MemoryStore snapshot →
local Hono API with fixture auth → scripts/studio-catalog.ts:

| ID | Seller | Result |
|---|---|---|
|269223|Portfolio Rebalancer|connected true, A2A0.3.0,3 skills|
|269226|Yield Allocator|connected true, A2A0.3.0,3 skills|
|269228|Health Factor Monitor|connected true, A2A0.3.0,3 skills|

Source evidence: https://github.com/kairovate/chainhelix-agents (Studio runtime
dependency and agent manifests). This is source evidence, not binary attestation;
studioProvenance remains unverified in API results. Public skills were listed,
never called. Evidence scripts/tmp/studio-a2a/live.json.

Re-run from CMD in D:\4lpha-execution:

```cmd
node --import tsx scripts/check-studio-a2a.mjs
```

Needs sibling data-plane checkout/dependencies and internet; no key/token/env
file needed. Fixed three public targets, no writes except local process memory.
Result A2A_DISCOVERY_PASSED/exit0 only if all3 pass; availability can change.
This supersedes the earlier MCP-only diagnostic for these A2A sellers; the
earlier script intentionally still reports them unsupported for MCP.

## Full A2A is separate

For 4lpha as a marketplace CLIENT:
1. Choose a pinned seller/version/transport profile and actual task semantics.
2. Isolated seller authentication and owner-bound access/consent; no shared
   credentials forwarded, no privilege inferred from a registry NFT/Card.
3. Send messages, persist task/context IDs, handle input-required/failed/cancelled
   states and duplicate/retry ambiguity. Add polling/cancel; streaming only where
   advertised. Seller support must be checked, not inferred from Card GET200.
4. Receive bounded artifacts/results, safely handle links, show task status and
   result in a separately approved UI flow. Do not change native DeFi hire.
5. For paid sellers, separately build quote verification and ERC8183/x402 buyer
   settlement/receipt handling. A2A itself does not require payment; the tested
   Studio sellers use negotiate/notify_funded and on-chain delivery references.
6. Independent spec/review/build/audit, offline adverse cases, explicit live
   per-run acceptance, then separately approved deployment/enablement.

Making 4lpha's own agents SERVE A2A tasks is a further direction: public Agent
Card/server plus per-instance authority and action semantics. Reading another
seller's Card does not implement that server.

Official scope reference: https://a2a-protocol.org/v0.3.0/specification/
Deadline reference: https://www.bnbchain.org/en/hackathons/smart-money-era
Page states9 September2026 UTC+0, exact cutoff hour not independently established.
As of7 September roughly2 days remain. Discovery is finished locally; a complete
multi-user paid client plus audit is not a reliable deadline commitment. Prefer
shipping the reviewed discovery evidence and preserving the existing MVP over
promising untested full A2A or adding rushed money-authority paths.
