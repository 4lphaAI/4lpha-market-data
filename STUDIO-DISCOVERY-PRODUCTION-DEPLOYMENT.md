# Discovery production deployment — 2026-09-07

Operator explicitly requested deployment and explanation of user/external-agent
effects. Deployed the reviewed MCP + A2A0.3 Agent Card discovery scope only.

## Deployment

- Railway project4lpha-market-data, d9a041d0-7685-47a4-96de-95d92b0e7f3c.
- Service data-plane, ba868d61-7d27-4d6c-8ba7-3d7c526f01bc, production.
- Previous deployment50978694-2345-41d3-a286-560d549b8440, source commit
  beb903ef4c6b42f5eb49d4686373992bdf525a1a, matched local baseline.
- New deployment878c3c84-35f1-43ef-8f8d-9f3be17449d9: SUCCESS; Railway build
  and /health passed. Exact upload was independently staged and built locally.
- Source-only whitelist: src/, data/, package.json/lock, tsconfig files,
  railway.json.59 files; no env, keys, git/agent metadata, node_modules or local
  build output uploaded. Manifest in scripts/tmp/discovery-deploy/.
- No Git commit/push; no web, execution-api, minter or trade/LP worker deploy.

Production settings added (previously absent): STUDIO_DISCOVERY_ENABLED=true,
STUDIO_DISCOVERY_RPC_URL=https://bsc-dataseed.binance.org/,
STUDIO_DISCOVERY_TARGETS_JSON with5 fixed targets. Existing DP_AUTH_TOKEN
was confirmed configured without exposing its value. Code default stays OFF.

| ID | Protocol | Endpoint |
|---|---|---|
|337848|MCP|https://4lpha.tech/mcp|
|337849|MCP|https://4lpha.tech/mcp|
|269223|A2A|https://agents.chainhelix.io/rebalancer/.well-known/agent-card.json|
|269226|A2A|https://agents.chainhelix.io/yieldopt/.well-known/agent-card.json|
|269228|A2A|https://agents.chainhelix.io/healthmon/.well-known/agent-card.json|

## Production verification

Read-only SSH check inside the actual new service (token stays in service):
health200, status200, catalog200, selected ID269223200, unknown ID999999404,
unauthenticated catalog401. All5 connected=true, errorCode=null, cache fresh.
MCP tools: explain_strategy/list_agents/get_hire_link; A2A skills include
strategy/negotiate/notify_funded. These names were listed, not invoked.
Evidence scripts/tmp/discovery-deploy/production-verification.txt.

A second read confirmed the scheduler refreshed asOf from1788761128659 to
1788761249158 (~120s) with all5 still connected/fresh. Public-edge checks:
data-plane /health200, /studio/agents without token401, existing4lpha.tech
/api/pools200. No ongoing monitor was installed.

## Who can do what

- Data plane polls only the configured targets roughly every120s, publishes
  bounded snapshots and marks stale/failing observations unavailable.
- Internal server/operator with x-dp-token can GET /studio/agents or
  /studio/agents/:id. This is not a public BFF/browser credential.
- Ordinary web users get no new controls or UI in this backend-only release.
  Native hire, passkey, funding, sessions and DeFi execution flows are unchanged.
- External agents without the DP token get401. This does not publish an A2A
  task server for 4lpha, expose the catalog via the public MCP, or grant access
  to wallets/private agent state. The existing public MCP remains its prior
  read-only product information surface.
- Sellers can change their own metadata/Card. Discovery may reflect a valid
  change or mark it unavailable; seller content never becomes code/instructions
  to execute. No arbitrary URL submission, tool call, task, quote, funding,
  payment or signing path was added.

## Operational follow-up

Full A2A client/server/paid tasks remain deferred debt in ROADMAP.md.
This was a direct upload; a future GitHub autodeploy from master without these
changes would remove discovery. Sync only reviewed data-plane files into the
repo under separate commit/push authorization before the next source deploy.
Do not sweep unrelated execution/web changes into that operation.

If discovery alone must stop, set STUDIO_DISCOVERY_ENABLED=false and redeploy
the same reviewed source. Full-source rollback can upload the preserved baseline
archive and remove only the3 newly introduced Studio settings. Neither operation
touches agent ledger/session state. No rollback was needed or performed.
