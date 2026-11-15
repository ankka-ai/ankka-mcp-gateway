---
title: GitHub release verification failed right after creation because GitHub had not finished the immutable release
date: 2026-11-15
module: release tooling
problem_type: integration_issue
component: tooling
severity: medium
symptoms:
  - "GitHub Release operation failed: github_release_verification_failed."
  - "A rerun refuses with github_release_exists"
root_cause: race_condition
resolution_type: code_fix
applies_when:
  - a stable or canary cut stops at the GitHub publication step
  - the GitHub release exists but the cut recorded no publication result
tags: [release, github, immutable-releases, retry]
---

**Problem.** `publish-github-release.mjs --publish-output-dir` created the
release, then failed its own check with `github_release_verification_failed`.
The R2 publication had already succeeded, but the cut stopped before either
Worker was activated. A rerun could not continue: the script refused the
now-existing release with `github_release_exists`, and immutable releases cannot
be deleted and created again.

**Cause.** GitHub finishes an immutable release (its `immutable` flag, asset
digests and attestation) shortly after `gh release create` returns. The script
verified once, immediately. The same checks passed a few minutes later without
any change.

**Fix.** Verification after a fresh create now retries up to six times, 15 s
apart. A rerun adopts an existing release only if it passes the full check: tag,
target commit, title, not a draft, immutable, prerelease flag, every asset's size
and digest, `gh release verify` and `gh release verify-asset`. Anything else is
still `github_release_exists`. A tag without a release is still
`github_tag_exists`. Rerun the cut from the stage that failed; do not write the
publication receipt by hand.
