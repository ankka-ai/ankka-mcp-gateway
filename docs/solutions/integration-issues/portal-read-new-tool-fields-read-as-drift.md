---
title: Every source reads Not verified after Cloudflare adds a field to the Portal's tool mappings
date: 2026-11-12
module: gateway worker
problem_type: integration_issue
component: api_layer
severity: high
symptoms:
  - "Every connector on the Sources page shows Not verified"
  - "The Cloudflare configuration differs from this gateway's saved configuration. The connection was not tested."
  - "state unknown, reason configuration_changed"
root_cause: upstream_api_change
resolution_type: code_fix
applies_when:
  - every source turns Not verified at once and nobody edited the Portal
  - Cloudflare still lists the server records as ready and connected
tags: [cloudflare, mcp-portal, drift, connection-check, updated-tools, cf-cli]
---

# Every source reads Not verified after Cloudflare adds a Portal field

## Problem

Every connector on the Sources page showed **Not verified** with
`configuration_changed`, including sources nobody had touched. The sources
kept working for users, and Cloudflare listed their server records as
`ready` and `connected`. Observed 2026-11-12; the last check that tested a
connection ran on 2026-11-10.

## Cause

Cloudflare's Portal read began returning two more keys on each entry of a
mapping's `updated_tools`: `portal_enabled` on every entry, and
`server_enabled` on entries whose server record also selects the tool.
`normalizedPortalMappings` treats an unknown key as drift, so it returned
`null` for the whole Portal. Every caller then refused: the connection check
answered `unknown / configuration_changed` for all sources without testing
any of them. Team and tool edits read the Portal through the same function.

## Fix

The parser accepts both keys. `portal_enabled` repeats the mapping's own
setting, so anything other than `true` is still drift. `server_enabled`
belongs to the server record, like `server_alias`, and must be a boolean.
Any other unknown key is still refused.

## Tell it apart from a real disconnect

Both reads use the `cf` CLI and need no dashboard:

```bash
npx cf mcp servers list
npx cf accounts logs audit list --actor-token-name "<management token name>"
```

The first is Cloudflare's own status per server. In the second, a healthy
check is a server read, a Portal read and a `POST …/sync`. A check refused
as drift stops after the two reads. To find the new key, list the key sets
of the live mappings:

```bash
npx cf mcp portals read <portal-id> |
  jq -r '[.servers[].updated_tools[] | keys | join(",")] | unique | .[]'
```

## Prevention

Refusing unknown keys is deliberate: the gateway cannot tell what a field
it has never seen grants. The cost is that an additive Cloudflare change
stops every check at once, so start with the key sets above whenever all
sources change state together.
