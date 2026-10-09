# Solved problems

One file per failure or lesson whose reasoning the code, tests, and other
docs do not record: what it looked like, why it happened, and what fixed it.
Search here for the exact error text or symptom before investigating.

```bash
grep -ril "lifecycle_pending" docs/solutions
```

## Add an entry

Add one after a verified fix when the next person would otherwise rediscover
it. Skip routine fixes whose commit and tests already explain them. This
repository is public: use synthetic names, and leave out customer and account
details, hostnames that are not documented as public, and credentials.

File it under the folder for its `problem_type` (`runtime-errors/`,
`integration-issues/`, `test-failures/`, …; create the folder if needed).
The frontmatter follows the Compound Engineering learning schema, so its
`ce-compound` and `ce-plan` skills write and read these entries:

```yaml
---
title: One sentence naming the failure and its cause
date: 2026-10-09            # date documented
module: gateway worker      # area affected
problem_type: runtime_error # closed list: runtime_error, integration_issue, test_failure, ...
component: api_layer
severity: medium            # critical | high | medium | low
symptoms:                   # what someone sees, error codes verbatim
  - "HTTP 409 source_action_conflict"
root_cause: concurrency
resolution_type: workflow_improvement
applies_when:
  - when this entry is worth reading
tags: [lowercase, hyphenated]
---
```

Then write short sections: **Problem**, **Cause**, **Fix**, and **Prevention**
when there is one.

## Entries

- [Source actions refused while another lifecycle action runs](runtime-errors/source-actions-refused-during-lifecycle-action.md)
- [Cloudflare keeps a stale MCP server status after the origin recovers](integration-issues/cloudflare-mcp-server-stale-status-after-origin-recovers.md)
- [New sources stay hidden from clients that connected earlier](integration-issues/new-source-hidden-from-connected-portal-clients.md)
- [Timeouts that only appear when several local gates run at once](test-failures/load-only-timeouts-from-parallel-local-gates.md)
