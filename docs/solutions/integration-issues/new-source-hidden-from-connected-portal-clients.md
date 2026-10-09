---
title: A source added after a client connected stays hidden until the user approves it in the Cloudflare portal
date: 2026-10-09
module: portal access
problem_type: integration_issue
component: authentication
severity: medium
symptoms:
  - "A source is connected and assigned to the user's Team on the gateway, but missing from portal_list_servers"
  - "Clients that connected after the source was added see it; clients that connected before do not"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
applies_when:
  - a user cannot see a source the gateway shows as connected and assigned
  - a new source was added to a gateway with already-connected users
tags: [cloudflare, mcp-portal, team-access, portal-toggle-servers, elicitation]
---

# A new source stays hidden from clients that connected earlier

## Problem

A source was installed, its credential import succeeded, and it was assigned
to a Team. It was missing from `portal_list_servers` for a client that had
authorized the portal before the source existed. Observed 2026-09-26.

## Cause

Cloudflare MCP portals ask each connected user to approve servers added later,
through an MCP elicitation, batched once. There is no portal setting that
enables new servers automatically. The client in use (Claude) did not show
the elicitation, so the server stayed unapproved.

## Fix

Compare the gateway side (`list_mcp_sources`, `get_gateway_team`) with
`portal_list_servers`. If the gateway side is correct, call
`portal_toggle_servers` and have the user open the returned link and enable
the server, or reconnect the connector.
