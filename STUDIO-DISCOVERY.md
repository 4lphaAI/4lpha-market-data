# Studio discovery backend — local build, default OFF

**Production update2026-09-07:** operator authorized deployment; Railway data-plane
deployment878c3c84-35f1-43ef-8f8d-9f3be17449d9 SUCCESS. Production enabled with
2 MCP +3 A2A targets, all5 connected/fresh; unauthenticated401. Code default
remains OFF. See STUDIO-DISCOVERY-PRODUCTION-DEPLOYMENT.md. Earlier statements
"not deployed" below describe build-time status, superseded by this update.

**Production update2026-09-07:** operator authorized deployment; Railway data-plane
deployment878c3c84-35f1-43ef-8f8d-9f3be17449d9 SUCCESS. Production enabled with
2 MCP +3 A2A targets, all5 connected/fresh; unauthenticated401. Code default
remains OFF. See STUDIO-DISCOVERY-PRODUCTION-DEPLOYMENT.md. Earlier statements
"not deployed" below describe build-time status, superseded by this update.

**2026-09-07 addendum:** A2A0.3.0 Agent Card discovery now also built/audited.
Targets accept either {id,mcpEndpoint} OR {id,a2aCardUrl}, not both. A2A does
GET only, with the same safe transport; no task invocation. See
STUDIO-A2A-DISCOVERY-RESULT.md for tested external sellers, exact rerun command,
limits and remaining full-client work. Earlier MCP-only restrictions below
describe the original branch. No feature was enabled or deployed.

## What exists

Data plane D:/4lphaDATA-marketplace owns src/studio/ and polls operator-selected
BSC identity IDs using @bnbagent/sdk 0.5.5. It checks the exact declared MCP
endpoint with initialize/initialized/tools-list, and writes one snapshot. No
MCP tools/call, A2A messages, payments, NFT operations or wallet material.

Authenticated data-plane GET /studio/agents and /studio/agents/:id read only
that cache. The consumer in this repo is scripts/studio-catalog.ts:

```text
node --import tsx scripts/studio-catalog.ts
```

It requires DATA_PLANE_URL and DATA_PLANE_TOKEN in its process environment;
it does not read .env.local. It never contacts RPC or sellers. No UI/BFF route
or root/web package change was added.

## Explicit operator configuration (not applied)

- STUDIO_DISCOVERY_ENABLED=true: default unset/OFF.
- STUDIO_DISCOVERY_RPC_URL: approved exact HTTPS RPC URL on BSC chain56.
- STUDIO_DISCOVERY_TARGETS_JSON: array, 1..8 unique entries with decimal id and
  exact mcpEndpoint URL. No secret in URLs, query/fragment/userinfo or custom
  port; URLs must use canonical URL serialization (e.g. trailing / at root).
- DP_AUTH_TOKEN must be configured; API returns503 otherwise.

Example shape only: [{"id":"337848","mcpEndpoint":"https://4lpha.tech/mcp"}].
This known 4lpha record is a compatibility test, not evidence of Studio origin.
There are no default live targets. Invalid optional config disables integration
and prints a fixed diagnostic; existing market-data service remains available.

## Limits and results

Cadence120s, concurrency2,8 targets,20s target deadline,90s cycle. Each HTTPS
request5s/256KiB response/64KiB body; aggregate consumer cap4MiB. Public IPv4
only, numeric connection with original TLS name, no redirects or external auth.
Inline base64 metadata only, canonical BSC registry fixed. MCP protocol
2025-06-18 JSON responses, maximum64 tools and no paginated result. IPv6-only,
SSE-only, HTTP/IPFS metadata and authenticated sellers are unsupported in v1.

Before first matching snapshot503 studio_not_ready; config changes invalidate
previous snapshots. Results include checkedAt, source/staleness, connection
status and tool names/descriptions. Failure clears tools. Stale/dead snapshots
report connected=false. studioProvenance is unverified: registration and a
working endpoint confer neither Studio provenance nor execution trust.

## Validation and remaining work

Independent spec review and separate implementation audit cleared scope; see
STUDIO-BACKEND-INTEGRATION-AUDIT.md. Data-plane baseline549/549 pass0skip;
after build558/558 pass0skip, typecheck/build PASS. Consumer4/4 pass0skip.
Web baseline559/559 and typecheckPASS; this task did not edit any web file.

Read-only acceptance used the real bounded SDK/MCP transport with #337848 and
#337849, MemoryStore and local Hono handler, then scripts/studio-catalog.ts.
Both connected=true. Evidence scripts/tmp/studio-backend/live-result.json.
Production MCP then advertised explain_strategy/list_agents/get_hire_link;
the probe only listed them. No production DB/config write was performed.

Root final runner reports 4065 tests / 4044 pass / 19 fail / 1 skip (verbatim
counters); baseline4061 / 4040 pass /19 fail /1 skip. Typecheck exit2 with2351
diagnostic lines identical to baseline after excluding temporary staging
artifacts. No Studio source diagnostic remains. Full logs are in
scripts/tmp/studio-backend/root-final-*.log; do not claim the whole execution repo is green. Transient
staging TS files were renamed .ts.txt so they cannot contaminate root tsc.

Not deployed or enabled. To finish live external Studio-agent acceptance:
select a real Studio-created registered MCP seller, verify it meets this
subset, deploy reviewed DP/backend changes under separate authorization, set
approved config in Railway, and read /studio/agents. Do not invent provenance,
move existing hire flows, mint another NFT or buy a job merely for a green test.
