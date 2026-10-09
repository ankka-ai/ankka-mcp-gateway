---
title: Gateway Management tool edits are refused while the source uses individual sign-in, because Cloudflare never holds a connection to sync
date: 2026-10-10
module: gateway worker
problem_type: integration_issue
component: api_layer
severity: medium
symptoms:
  - "update_installed_source_tools on Gateway Management returns source_management_connection_required after a release added management tools"
  - "update_installed_source_tools or rename_installed_source with Company set returns source_context_too_large although the descriptions are tiny"
  - "The dashboard says Gateway Management needs to be reauthenticated in Cloudflare, but offers no Reconnect for it"
root_cause: configuration
resolution_type: workflow_improvement
applies_when:
  - a gateway installed before shared management connections still shows "Individual sign-in (previous setup)" for Gateway Management
  - a new release added management tools and selecting them is refused
  - Company cannot be set or restored on Gateway Management
tags: [gateway-management, individual-sign-in, shared-connection, catalogue-sync, company-context, cloudflare]
---

# Gateway Management tool edits refused in individual sign-in mode

## Problem

After a release added two management tools, selecting them on an older
gateway's Gateway Management source was refused with
`source_management_connection_required`. Clearing Company on that source
succeeded, but restoring it was refused with `source_context_too_large`
although the captured descriptions were a few kilobytes. The dashboard's
wording pointed at a Cloudflare re-authentication, yet the source showed no
Reconnect control. Observed 2026-10-10 on a gateway whose Gateway Management
was installed in individual sign-in mode.

## Cause

In individual sign-in mode every person authenticates to the management
source themselves, so Cloudflare's MCP server record never holds an operator
connection and permanently reports `authentication_status: required`. Two
code paths read that record:

- The management catalogue sync (`syncManagementCatalogue`) maps that status
  to `connection_required` and refuses before Cloudflare can learn the new
  tool names.
- The Company description capture (`captureCompanyDescriptions`) treats the
  same status as a connection failure and returns null, which the callers
  report as `source_context_too_large`.

Reconnect cannot help: the dashboard offers it only for shared connections.

## Fix

Migrate the source to the shared operator connection, then redo the edit:

1. In Sources, expand Gateway Management and choose **Use shared connection**.
   Team assignments, tool selections and overrides are preserved.
2. Choose **Reconnect** on the same source and sign in once as the operator.
3. Clients that were connected re-authorize the management server in their
   Portal session; `portal_toggle_servers` returns the link.
4. Repeat the tool selection or Company change. While a runtime update is
   applying, the edit returns `source_action_conflict`; wait for the update
   action to reach `health_verified` first.

## Prevention

Two follow-ups make this a non-event: pass the connection reason through
instead of reporting every capture failure as `source_context_too_large`, and
capture Company descriptions for gateway-hosted sources from the gateway's own
tool definitions, so adding management tools never depends on Cloudflare's
synced copy. Until then, migrate older installations to the shared connection
before enabling newly released management tools.
