# A2A Agent Card discovery addendum — 2026-09-07

Independent Astra xhigh review: CLEARED for build with these normative details:
auth alternatives<=16, requirements/alternative<=16, scopes/requirement<=16,
scope/name<=128chars; schemes<=16 and aggregate JSON<=16KiB. Malformed optional
declarations reject; declared means nonempty declarations, not access proof.
MCP output unchanged; failed/stale A2A summary null. GET200 application/json
nonempty object only, no body/MCP/session/auth headers. All secondary URLs
remain descriptive and never resolved/fetched. Same-origin invocation URL is
a conservative subset, not full A2A conformance.

Implementation-audit amendment: enum fields are primitive strings only, never
String(value) coercion; the16KiB auth ceiling covers security+securitySchemes
combined as well as individual schemes. Regression cases pin malformed arrays
and individually bounded declarations whose combined payload exceeds the cap.

Scope explicitly authorized: quickly add Agent Card reads to existing backend,
no UI/hire changes; explain full A2A effort/deadline after delivery. No deploy.
Use short addendum → independent review → build → independent audit, same
approved Astra workflow as Studio backend. Existing backend spec still applies.

1. Preserve existing {id,mcpEndpoint} target and output. Additionally accept
   {id,a2aCardUrl} exclusively (exact2 keys, same unique-ID cap8). No dual-protocol
   fallback or automatic endpoint discovery; operator supplies exact card URL.
   Digest includes target shape and an adapter revision to reject old snapshots.
2. Same SDK BSC registry read; require exactly one services[].name A2A whose
   endpoint equals configured a2aCardUrl. No append/well-known guessing or
   redirects. Inline base64 metadata only, same bounds. No authority added.
3. Add GET-only JSON transport by sharing all existing HTTPS safeguards with
   POST. Existing makePostJson/postJson API remains compatible; new makeGetJson/
   getJson cannot carry body/session/protocol/auth headers. GET accepts200 JSON
   only. Same numeric publicIPv4/TLS name pin,5s/256KiB/abort/redirect restrictions.
4. Parse bounded public A2A0.3.0 Agent Card (the tested Studio sellers' version):
   required protocolVersion0.3.0, name<=200, description<=4000, version<=100,
   URL canonical HTTPS same-origin with card, capabilities object, nonempty
   defaultInputModes/defaultOutputModes<=16 entries(each<=128), skills1..64.
   Each skill id/name<=200, description<=4000,tags0..32(each<=128), IDs unique.
   Optional input/output modes validate if present. Project only bounded plain
   metadata: name/description/version/protocolVersion/invocationUrl, skills
   id/name/description/tags, default modes, authentication: declared|not_declared.
   Optional security if present must be array of bounded record requirements;
   securitySchemes if present must be bounded object (no URLs/credentials followed).
   Neither auth nor signatures/extension content implies verification. Unknown
   optional fields ignored; no signatures, extensions, images or links fetched.
5. An A2A observation adds a2aCardUrl and a2a summary (null on failure). tools
   remains empty; existing connected means discovery successful only, not task
   invocation/paid readiness. Signature verification not claimed. Stale/failed
   A2A observations clear skills by nulling summary, just as tools clear for MCP.
   A2A target runs GET only after on-chain binding; SDK RPC POST reads unchanged.
6. No A2A message/send, tasks/get/cancel, negotiate, notify_funded, OAuth,
   payment, callback, server Agent Card for 4lpha or new public route. Same
   authenticated snapshot API, feature OFF by default and same isolation.
7. Tests cover backward MCP shape, exclusivity/digest, A2A metadata binding,
   version/required fields/skills/auth bounds, no secondary fetch or POST to
   seller, shared GET egress/method/body rules, stale/failure clearing, mixed
   targets. Full DP typecheck/build/tests; root/web regression evidence.
8. Read-only live acceptance: selected ChainHelix mainnet269223/269228/269226,
   exact public cards already observed in STUDIO-EXTERNAL-SELLER-CHECK.md,
   MemoryStore job → existing DP handler → root catalog client. No production
   env change. Supply a reusable local script with fixed targets; exit0 only
   when all observations have successful A2A discovery. Label result discovery,
   not full protocol conformity or task/commerce acceptance.

Deadline context: official hackathon page gives9 September2026 UTC+0, no exact
cutoff hour verified. On7 September, roughly2 days remain. Full marketplace
A2A client means seller selection/version/transport/auth, task state and retries,
result/artifact handling, UI consent/read status, optional commercial buyer rail,
and independent audit/live acceptance. 4lpha-as-A2A-server is a separate direction.
Do not guarantee full paid integration before deadline or conflate read-only
discovery with end-to-end hire. Sources: https://a2a-protocol.org/v0.3.0/specification/
and https://www.bnbchain.org/en/hackathons/smart-money-era .
