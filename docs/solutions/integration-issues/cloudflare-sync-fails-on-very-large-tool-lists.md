---
title: Cloudflare cannot sync an MCP server whose tool list is several megabytes
date: 2026-10-22
module: source onboarding
problem_type: integration_issue
component: infrastructure
severity: high
symptoms:
  - "Authorization succeeds (stage credential_import succeeded) but the source shows no tools"
  - "get_mcp_source_tools returns state sync_required with an empty tool list"
  - "Cloudflare server status error, \"Failed to sync server.\", error_details {retryable: false, is_upstream: false, cause: internal}"
root_cause: provider_limit
resolution_type: code_fix
applies_when:
  - a signed-in source connects but its tools never appear
  - a provider serves hundreds of tools or includes output schemas
tags: [cloudflare, mcp-server, sync, tool-list, size, klaviyo]
---

# Cloudflare cannot sync a very large tool list

## Problem

Klaviyo's hosted MCP server (`https://mcp.klaviyo.com/mcp`) connected: the
operator authorized it, the credential import succeeded, and Cloudflare
reported `authentication_status: connected`. The source still showed no tools.
Cloudflare's server record said `status: error`, `"Failed to sync server."`,
with `is_upstream: false`, `retryable: false` and `cause: internal`. A manual
`cf mcp servers sync` failed the same way. Observed 2026-10-22.

## Cause

Klaviyo's `tools/list` is very large. Measured with a signed-in client:

| Klaviyo URL options | Tools | Response |
| --- | --- | --- |
| none | 304 | 6.4 MB |
| `include-output-schemas=false` | 304 | 1.7 MB |
| `read-only=true` | 152 | 3.0 MB |
| `include-output-schemas=false&read-only=true` | 152 | 0.4 MB |

The largest list on that account that Cloudflare had synced was Meta Ads, 98
tools and about 0.9 MB. Cloudflare documents no limit and its error names none,
so the exact threshold is unknown; size is the inferred cause.

## Fix

The gateway keeps the saved source URL and OAuth resource as the plain Klaviyo
endpoint, but creates and verifies the Cloudflare server at
`https://mcp.klaviyo.com/mcp?include-output-schemas=false&read-only=true`
(`mcpServerHostname` in the gateway Worker). The same token works on both
URLs. Cloudflare cannot change an existing server's hostname, so a Klaviyo
connector created before the fix must be removed and added again.

## Prevention

When a signed-in source has no tools, read the Cloudflare server's
`error_details` with `cf mcp servers read <id>` before asking for another
sign-in. If the cause is `internal` and not upstream, measure the provider's
tool list and look for provider options that shrink it.
