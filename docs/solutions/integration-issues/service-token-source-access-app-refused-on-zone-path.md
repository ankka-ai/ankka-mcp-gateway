---
title: A new service-token connector stuck at recovery required because Cloudflare refuses its Access application on the zone path
date: 2026-11-15
module: gateway worker
problem_type: integration_issue
component: api_layer
severity: high
symptoms:
  - "source_action_recovery_required"
  - "detail: source_access_application_create_blocked_http_400_code_12130"
  - "access.api.error.invalid_request: app and token domain mismatch"
  - "canRenew false for every operator; Team saves and other connector changes wait"
root_cause: wrong_api
resolution_type: code_fix
applies_when:
  - installing a new source with authMode access_service_token
  - a source installation stops after its MCP server was created
tags: [cloudflare, access, mcp, service-token, bearer]
---

**Problem.** A new `access_service_token` source created its bearer MCP server,
then stopped while creating its host-less `mcp` Access application. Nothing was
created. Before #327 no one could resume it, and it held back Team saves and
other connector changes.

**Cause.** Cloudflare refuses an `mcp` application whose destination is a
bearer-auth MCP server through `POST /zones/{zone}/access/apps`: HTTP 400, code
12130, `app and token domain mismatch`. Without a destination the zone path
refuses with `domain or destinations must be set`. The same body succeeds
through `POST /accounts/{account}/access/apps`. The zone path then answers 404
for that application, for reads, policies and deletes alike. An application
created for an OAuth server, and later pointed at a bearer server with a
zone-path `PUT` (the token switch), works, which is why older service-token
sources were not affected.

**Fix.** When the zone path refuses the source application with 400/12130, the
gateway creates it through the account path. Zone-path calls on Access
applications and their policies retry once on the account path after a 404:
resource discovery, policy creation, the token switch, source removal and
teardown. Gateway Management now also returns the fixed failure `detail`
(#328), which showed the code.

**Diagnose.** `resume_mcp_source` returns
`source_access_application_create_blocked_http_400_code_12130`. To read
Cloudflare's message without changing anything, compare
`cf zero-trust access applications list` with the MCP server record. Probing a
create changes the account; delete any probe application at once.
