---
title: Cloudflare keeps a stale 503 on an MCP server after its origin recovers, until the server is synced
date: 2026-10-09
module: source onboarding
problem_type: integration_issue
component: infrastructure
severity: medium
symptoms:
  - "The upstream MCP origin answers again, but Cloudflare still reports the server with a 503 failure"
  - "resume_mcp_source does not proceed after the origin came back"
root_cause: async_timing
resolution_type: workflow_improvement
applies_when:
  - a source's origin was down or not yet deployed when the gateway first contacted it
  - a source stays failed after its origin is confirmed healthy
tags: [cloudflare, mcp-server, sync, origin, resume, cf-cli]
---

# Cloudflare keeps a stale MCP server status after its origin recovers

## Problem

A new source's origin crash-looped on its first deploy, so Cloudflare's MCP
server record stored a 503. After the origin was fixed and answered again,
the server record still showed the 503 and `resume_mcp_source` did not
proceed. Observed 2026-10-09.

## Cause

Cloudflare's MCP server record keeps the result of its last capability sync.
It does not re-check the origin by itself when the origin recovers.

## Fix

Sync the server, then resume the source:

```bash
npx cf mcp servers sync <cloudflare-mcp-server-id>
```

With several Cloudflare accounts configured, set `CLOUDFLARE_ACCOUNT_ID` to
the gateway's account first; non-interactive runs otherwise stop at the
account choice. After the sync, `resume_mcp_source` proceeded.

The gateway calls the same sync endpoint after an OAuth credential import,
while refreshing a source's tool catalogue, and in the Sources page
connection-health check. Whether that health check alone clears this state
is unknown; it was not tried.
