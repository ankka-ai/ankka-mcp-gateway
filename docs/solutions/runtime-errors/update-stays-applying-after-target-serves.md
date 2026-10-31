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

The lag itself is now removed: at the end of the update pass, after the grant
is revoked and the attempt's end recorded, the management object re-arms its
alarm for now, waits for its writes to reach disk (`storage.sync()`), and
resets itself with `ctx.abort()`. Cloudflare retries the interrupted alarm on
a fresh instance, which runs the target and finalizes the journal about three
seconds after the upload. The release being replaced performs the reset, so
updates from a release without it still wait about five minutes.

## Measurement (2026-10-22)

The lifecycle runner cannot observe this: it runs the management code in
process, and the deployed object of a runner-installed gateway holds no
state. A throwaway Worker with one SQLite Durable Object named like the
gateway's (`v1:management`) isolated the platform behaviour instead. It ran
an 8-second alarm loop like the handover, logged every instance start and
alarm with its code version, and was redeployed 22 times with wrangler
4.127.0, then deleted with its namespace. Times run from the upload's return
(the first batch from wrangler's exit, about 3.5 seconds later).

| Variant | Runs | New code in the object after | Alarm on new code after |
| --- | --- | --- | --- |
| No reset (today) | 5 | 296–302 s | ~300 s |
| One `abort()` from a request right after the upload | 7 | 0.6–3.9 s (first request) | 5.3–5.6 s |
| `abort()` on every alarm pass that still runs old code | 4 | 0.2–0.3 s | — |
| `abort()` in the alarm, alarm re-armed for +8 s | 3 | 2.3–2.7 s | 8.3 s |
| `abort()` in the alarm, alarm re-armed for now | 3 | 2.5–2.9 s | 2.5–2.9 s (Cloudflare's alarm retry) |

No instance that started after an upload ran the old code, in any run. The
unreset object never restarted until Cloudflare replaced it, at a nearly
constant five minutes, which is also the handover deadline. In a local
`wrangler dev` check, a write made right before `abort()` without
`storage.sync()` was lost, while a synced write and an armed alarm survived.
The gateway uses the last variant, after a flush.

## Prevention

Do not treat `applying` as stuck while `journalPending` is true; poll until
`succeeded`. The five-minute handover deadline still applies. If the object
runs the old release that long, the action reads `recovery_required` with
`runtime_update_unconfirmed`, and the first read on the target reconciles it.
Never call `ctx.abort()` without `await storage.sync()` first, or the last
writes before it can be lost.
