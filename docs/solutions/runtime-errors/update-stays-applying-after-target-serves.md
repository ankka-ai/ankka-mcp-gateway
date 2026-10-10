---
title: A runtime update reads applying after its target release already serves, because the management object still runs the old code
date: 2026-10-10
module: gateway worker
problem_type: runtime_error
component: api_layer
severity: low
symptoms:
  - "get_gateway_runtime_action reports status applying, stage assets_uploaded, for minutes after the upload"
  - "review_gateway_update already reports the target release as current while the action is still applying"
root_cause: async_timing
resolution_type: code_fix
applies_when:
  - an unattended or browser-approved update looks stuck at applying
  - the gateway answers on the new release but the action has not reached succeeded
tags: [runtime-update, handover, durable-objects, eventual-consistency]
---

# An update reads applying after its target release already serves

## Problem

The first unattended update through Gateway Management, on 2026-10-10,
answered `running`, and the action reached `assets_uploaded` about 100 seconds
later. About two minutes after that, `review_gateway_update` reported the
target release as current. The action still read `applying` for at least
another 100 seconds before it recorded `succeeded`. To an agent polling
`get_gateway_runtime_action`, the update looked stuck.

## Cause

`review_gateway_update` answers from the release of the stateless entrypoint.
The action record comes from the one management Durable Object. Cloudflare
rolls new code out to Workers and Durable Objects independently. Its Durable
Objects known issues say a request can reach the new Worker and then an object
that still runs the previous version, typically for seconds to minutes. Until
the object restarts on the target, the handover alarm finds the old release
and waits, and a read cannot reconcile the journal. When the object restarts
on the target, the alarm's `finalize`, or the next read, completes the action.

## Fix

Action reads through the entrypoint now also return `servingRelease`, and
`journalPending: true` when the action is `applying`, the object still holds
the handover, and the entrypoint already runs the exact target. The object
reports the handover in a response header. The journal's stages, statuses,
and write rules are unchanged. See
[Update sequence](../../UPDATES.md#update-sequence).

## Prevention

Do not treat `applying` as stuck while `journalPending` is true; poll until
`succeeded`. The five-minute handover deadline still applies. If the object
runs the old release that long, the action reads `recovery_required` with
`runtime_update_unconfirmed`, and the first read on the target reconciles it.
