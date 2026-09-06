# Agent-operable lifecycle runner

The lifecycle runner is the supported entry point for development, CI and
operator automation over a disposable gateway. After one credential setup and
one approval per job it installs, manages, updates, interrupts, resumes and
removes a gateway in the test account without browser consent or a cached
human Access session, and it can finish removal after the gateway is gone.
It reuses the production operations; it is not a second implementation.

```sh
npm run lifecycle -- approve --job /private/job.json --approved-by <administrator email>
npm run lifecycle -- run --job /private/job.json
npm run lifecycle -- run --job /private/job.json --resume --from update
npm run lifecycle -- status --job /private/job.json
npm run lifecycle -- cancel --job /private/job.json
npm run lifecycle -- credentials --job /private/job.json
```

## Three separate concerns

| Concern | Where it lives | Lifetime |
| --- | --- | --- |
| Cloudflare credential | The operator's credential store (macOS keychain item or an environment variable in CI). The job carries a reference by name only. | Managed by the operator: expiry, rotation and revocation happen in Cloudflare. Finishing a job never revokes it. |
| Job approval | The job file. `approve` records who approved and a digest of the target, both release identities, the source, the operations and the credential references. | Until any of those values change. A changed target or release makes the runner stop with `job_target_changed`. |
| Execution state | The private run directory: `record.json` (events, stage results, the Durable Object storage the production code wrote, provider inventory, removal evidence) and `installation-secrets.json` (installation-owned key material). | Survives process restarts and the removal of the gateway. Never contains a Cloudflare credential. |

A process restart therefore reloads the job and the record, checks provider
state through the production reconciliation, and continues with the same
credential. Cancellation (`cancel`), a revoked or rejected credential, a
changed target and an ownership conflict stop execution with a fixed code.

## Credentials

| Credential | Purpose | Custody |
| --- | --- | --- |
| Deployment API token | The fixed lifecycle operations (`bootstrap`, `install`, `upgrade`, `uninstall`, `gateway-root-finalize`) under the catalogue's `operator-managed` credential lifecycle. | Account-owned token on the test account with an expiry. Read into the runner's processes only. Never installed into a gateway, never passed through Ankka-hosted services. |
| Management API token | The gateway's own routine source and Team operations. | Created by the operator with exactly the permissions in [Management token](MANAGEMENT_TOKEN.md); the runner installs it as the disposable gateway's encrypted Worker secret using the deployment token. Removing the gateway does not revoke it. |
| Access service token | Machine authentication to a gateway's protected management routes. | Reserved for the service-identity work; the job schema already carries its reference and public identifiers. |

The operation authority catalogue in
[cloudflare-operation-authority.ts](../apps/installer/src/cloudflare-operation-authority.ts)
declares this policy. The runner may execute only the listed fixed operations
with exactly their scopes, endpoint families, ownership states, mutations and
postconditions; the transport guard refuses any provider call outside the
current stage's families. Routine source and Team operations are not runner
operations: they run in the release payload's own management code with the
gateway's limited management credential.

## Stages

| Stage | Production operation | Evidence |
| --- | --- | --- |
| `preflight` | Read-only credential inventory, release pair validation, fresh-target check | families readable, releases distinct |
| `bootstrap` | Hosted Stage 1 (`provisionHostedStage1WithOperatorCredential`), readiness handoff, ownership acceptance | shell Worker deployed, ownership state accepted |
| `converge` | Stage 2 converger with the checkout payload in-process, one pass per chunk checkpoint; the signed release bundle is what it uploads | provider calls per pass (bounded to 45), handover armed |
| `verify` | Provider read-back of the final runtime and the management object | `workers.dev` disabled, final bindings, management state served |
| `manage` | Management token installed as the Worker secret; the same source and Team exercise the browser runner performs, over the payload's management object | source installed default-deny, synthetic member granted and removed, inventory captured |
| `update` | The gateway's updater with release B served from the local publish directory | release B active, management secret inherited |
| `remove-dependencies` | The payload's receipt-owned teardown commands (prepare, prove, apply, settle) and the signed handoff | dependencies absent by independent reads |
| `remove-root` | The hosted finalizer's fixed root steps over a record-backed job under the `operator-managed` policy | five steps verified, job `removed` with `not_attempted` revocation |
| `verify-absent` | Independent provider reads of every recorded resource | nothing owned remains; unrelated resources named |

Each stage runs in its own process over the shared record and exits with
`passed`, `verified`, `failed` or `blocked`. `blocked` names a condition only
the operator can change (an unapproved job, a missing or rejected credential,
an expired bootstrap capability, a held Stage 2 lease). `interrupted` is
recorded by the parent when a stage process dies. `not_run` marks stages after
a stop. `qualified` is always `false`: nothing here is customer-path evidence.

## Interruption and recovery

`--interrupt-after <stage>:<n>` terminates the stage process with `SIGKILL`
immediately after the n-th mutating provider response arrives and before any
journal records it. The production code has already armed the mutation in the
record, so `--resume --from <stage>` enters the same reconciliation path the
gateway uses: the Stage 2 journal resumes from `send_armed`, the teardown
installation object resolves its pending deletion boundary by an exact read,
the root job resumes its pending step, and the updater reads the active
release before deciding whether an upload is still needed. No mutation is
retried blindly and no second installation is created.

Uncertain provider outcomes stay uncertain: a missing permission, an
authentication failure or an ambiguous ownership read stops the stage instead
of being read as absence.

## What a runner-installed gateway is and is not

The Worker, Durable Object namespace, Access applications and policies, MCP
Portal, DNS record, custom domain and the signed update are real. The
gateway's ownership identity, Stage 2 journal, receipts and management state
live in the runner's record, because only code running inside the deployed
Durable Object could write its storage and the only credential entry into
the deployed shell is its OAuth callback. Consequently the deployed
management routes of a runner-installed gateway answer "unavailable", and the
runner exercises the management code in-process instead. That in-process
Durable Object code is the checkout's hand-authored `payload/worker/index.js`,
the file every release bundles; the deployed Worker runs the signed release
bundle, so the two differ by whatever `main` changed since that release.

Coverage that stays outside the runner, by design:

- browser onboarding, real OAuth permissions and consent screens;
- the deployed Durable Object's update handover and its hosted removal job;
- restricted-user OAuth behaviour (an API-token run is not evidence for it);
- signed-release publication and the hosted control plane (release B is read
  from the signer's local publish directory).

Use the [live lifecycle command](LIVE_LIFECYCLE.md) for that layer, and
[local runtime tests](LOCAL_RUNTIME.md) for fast regressions against
production state code.

## Job file

The job is a private JSON file outside the checkout with mode `0600`.

```json
{
  "schemaVersion": 1,
  "jobId": "lifecycle-20260906-a",
  "scope": "disposable_lifecycle",
  "target": { "accountId": "…", "zoneId": "…", "zoneName": "example.com", "prefix": "run1", "gatewayName": "Ankka run1", "adminEmail": "you@example.com" },
  "releases": { "a": { "publishDirectory": "/private/releases/A/publish", "pin": "/private/releases/A/pin.json" },
                "b": { "publishDirectory": "/private/releases/B/publish", "pin": "/private/releases/B/pin.json" } },
  "source": { "url": "https://synthetic.example.net/mcp", "tool": "synthetic_status" },
  "credentials": { "deployment": { "keychain": { "service": "ankka-lifecycle-runner", "account": "deployment-token" } },
                   "management": { "keychain": { "service": "ankka-lifecycle-runner", "account": "management-token" } } },
  "operations": ["install", "manage", "update", "remove"],
  "runDirectory": "/private/runs/lifecycle-20260906-a"
}
```

The management hostname is `manage<prefix>.<zone>` and the Portal hostname is
`mcp<prefix>.<zone>`; a job with a used prefix stops at `preflight`. The
approver must be the gateway's administrator email. A credential reference is
either a keychain item (`security find-generic-password -s <service> -a
<account>`) or an environment variable whose name starts with `ANKKA_`.

## What this replaced

The four token-mode harnesses under `apps/installer/test-live`, their vitest
configuration, `tools/provider-cycle-command.mjs` (`npm run test:live`) and
`tools/live-test-record.mjs`. Their bodies became the stages above; the
faked OAuth token endpoint and faked account list are gone, replaced by the
declared operator-managed credential path in the hosted Stage 1 and root
removal executors.

## Orchestration

The runner is a small parent process over a file record: one lock, atomic
writes, one child process per stage. Cloudflare Workflows would replace the
parent's sequencing and the record's event log with durable steps, but not the
reconciliation, ownership checks or credential custody. It is evaluated after
the first milestone in a bounded prototype over the same stage functions and
adopted only if it removes more coordination code than it adds. It is
reconsidered earlier only if the runner starts accumulating orchestration
machinery of its own.
