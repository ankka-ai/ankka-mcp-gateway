---
title: Source actions return 409 lifecycle_pending while a runtime update or other lifecycle action runs
date: 2026-10-09
module: gateway worker
problem_type: runtime_error
component: api_layer
severity: medium
symptoms:
  - "Authorize, apply, resume, or tool selection returns HTTP 409 with error source_action_conflict and reason lifecycle_pending"
  - "A source looks stuck during or just after a gateway update"
  - "The source's OAuth diagnostic records provider_consent as failed after Authorize was pressed during an update"
root_cause: concurrency
resolution_type: workflow_improvement
applies_when:
  - a source operation is refused with 409 and the connector looks stuck
  - an operator pressed Authorize or applied a source while the gateway was updating
tags: [source-actions, runtime-update, lifecycle, 409, oauth]
---

# Source actions return 409 lifecycle_pending while another lifecycle action runs

## Problem

An operator pressed Authorize on a source while a gateway runtime update was
in flight. The request was refused with HTTP 409 and the source's OAuth
diagnostic recorded `provider_consent` as failed. From the dashboard and the
Management MCP the connector looked stuck. After the update finished, the
next Authorize imported the credentials normally. Observed 2026-10-09.

## Cause

This is by design. The gateway keeps one blocking-action pointer. While it
names a non-source action, such as a runtime update, every source action is
refused (`sourceSnapshotConflict` in `payload/worker/index.js`):

```json
{ "schemaVersion": 1, "error": "source_action_conflict", "reason": "lifecycle_pending", "action": { "...": "the blocking action" } }
```

The other reasons from the same check are `source_pending` (another source
action is running) and `recovery_required` (a source action stopped and needs
recovery; see [Source action recovery](../../SOURCE_ACTION_RECOVERY.md)).

## Fix

Read the `action` in the response, or `get_gateway_status`, to see what is
running. Wait for that action to complete, then retry the source operation
once. Retrying while the action is still running only repeats the refusal.

## Prevention

Before diagnosing a "stuck" source, check whether an update, Team action, or
teardown was in flight at the time of the failure.
