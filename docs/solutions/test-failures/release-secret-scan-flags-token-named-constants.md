---
title: A constant named after a token or credential makes the release candidate unsignable
date: 2026-10-27
module: release tooling
problem_type: test_failure
component: tooling
severity: medium
symptoms:
  - "ReleaseCandidateError: output_not_signable"
  - "offline-two-release-origin-lifecycle.test.mjs fails in app-tests (installer-rest) while every worker test passes"
root_cause: logic_error
resolution_type: code_fix
applies_when:
  - a payload or dashboard change adds a constant or object key whose name contains TOKEN, SECRET, CREDENTIAL or PASSWORD
  - the installer's release-candidate build fails with output_not_signable
tags: [release-signing, secret-scan, payload, naming]
---

# A constant named after a token or credential makes the release candidate unsignable

## Problem

After a gateway change, `app-tests (installer-rest)` failed in
`offline-two-release-origin-lifecycle.test.mjs` with
`ReleaseCandidateError: output_not_signable`. The worker and dashboard tests
all passed.

## Cause

`loadVerifiedPublicRelease` in `apps/installer/scripts/sign-gateway-release.mjs`
scans every payload file before signing. `containsCredentialLiteralAssignment`
refuses an identifier with a credential word as a segment (`TOKEN`, `SECRET`,
`CREDENTIAL`, `CREDENTIALS`, `PASSWORD`, `PASSWD`) that is assigned or keyed to
a quoted string of 16 or more characters. It cannot tell a real credential
from a name. These tripped it:

- `const SERVICE_TOKEN_MODE = 'access_service_token'`
- `const SOURCE_TOKEN_SWITCH_KEY = 'ankka-mcp-gateway/source-token-switch/v1'`
- the object key `credential_required: 'source_credential_required'`, in the
  worker and in the built dashboard bundle

`writeReleaseCandidate` then reports only `output_not_signable`.

## Fix

Rename the identifiers so no segment is a credential word, and keep the
string values: `ACCESS_SERVICE_MODE`, `SOURCE_AUTH_SWITCH_KEY`, and the state
`service_auth_required`. Do not loosen the scan.

## Prevention

Before pushing a payload or dashboard change, run the installer test that
builds and signs a candidate:

```bash
npm run build:admin && npm run test --workspace @ankka/gateway-installer -- test/offline-two-release-origin-lifecycle.test.mjs
```

Name constants after what they hold (a mode, a key, a state), not after the
credential they relate to.
