---
title: Several local gates at once make bounded tests time out from CPU load alone
date: 2026-10-09
module: test suites
problem_type: test_failure
component: testing_framework
severity: medium
symptoms:
  - "cloudflare-worker-direct-upload.test.ts times out in the 4194304-byte module case (60 s limit)"
  - "5 s dashboard UI tests time out, and a different set fails on each run"
  - "Every failing file passes when run alone"
root_cause: test_isolation
resolution_type: workflow_improvement
applies_when:
  - tests time out locally but pass alone or in CI
  - several agent sessions or worktrees run npm run check on one machine
tags: [flaky-tests, timeouts, cpu-load, installer-suite, parallel-agents]
---

# Timeouts that only appear when several local gates run at once

## Problem

Five agent sessions each ran the full `npm run check` on one laptop. Load
average stayed between 15 and 35, every run took two to three times longer,
and bounded tests timed out: 5-second dashboard UI tests and the 4 MiB case in
`apps/installer/test/cloudflare-worker-direct-upload.test.ts`. Sessions
reported two or three red runs each and re-ran the gate. Observed 2026-09-19.

## Cause

CPU contention, not a defect. The 4 MiB direct-upload case takes about 49 s
on an idle CI runner against a 60 s limit, so it has little headroom. The
installer suite also runs on one worker (`maxWorkers: 1`) because its
cryptographic and subprocess-heavy tests starve each other under load.

## Fix

Re-run a failing file alone before debugging it. If it passes, the failure
came from load.

## Prevention

Run one full gate per machine at a time. Agents run lint, typecheck, and the
test files they touched, then push and let CI run the full gate on clean
runners. Run the full local gate only for release candidates.
