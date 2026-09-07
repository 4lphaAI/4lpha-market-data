# Studio backend independent review and audit — 2026-09-07

Scope: reduced backend-only discovery, default OFF. No UI/deploy/paid actions.

## Independent spec review — Astra xhigh

Reviewer studio_spec_review cleared Revision 2 with mandatory amendments:
one-shot SDK callWithRetry override; configured DP auth on new routes;
all-unavailable publication after init/chain failure and cancellation checks;
MCP version/header/notification/response ID validation. Spec incorporates all.

## Independent implementation audit — Astra xhigh

Separate reviewer studio_audit: CLEARED for approved local default-off scope.
No blocker/high/medium remain. The one medium was consumer aggregate-size
mismatch: 256KiB rejected valid multi-agent results. Fixed to bounded 4MiB;
auditor independently verified the eight-full-catalog regression and oversize
rejection, 4/4 consumer tests and 9/9 data-plane Studio tests, DP typecheck PASS.

Auditor confirmed public IPv4/TLS pinning, constrained registry RPC, no wallet,
paymaster or SDK retry, no seller tool execution, cancellation before publish,
authenticated cache-only reads, and stale-result clearing. Reviewer did not
make live calls or edit files. Full-suite results are builder evidence.

Enablement, deployment and external Studio-created seller acceptance remain
outside this clearance. Remote MCP session retention is not bounded by this
client (no DELETE cleanup in this read-only subset).
