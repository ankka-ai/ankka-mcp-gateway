# Customer-owned management credential

Issue #123 replaces repeated Cloudflare consent for routine source installation
and Team policy management with one account-owned API token. Deployment, DNS,
Worker updates, teardown, and upstream-provider authentication retain their
separate authority. This does not turn MCP tools into write-capable tools.

## Credential custody

The administrator creates an account-owned token in Cloudflare and adds it
as the `ANKKA_MANAGEMENT_TOKEN` encrypted secret on the installed gateway Worker,
using Cloudflare's dashboard or local Wrangler. No token-entry form is served
by Ankka. The token never passes through Ankka-hosted infrastructure, and the
gateway never returns it to the dashboard or records it in Durable Object state.

The token needs the Access application/policy and MCP Portal permissions used
by the fixed operations below. It must not include Worker deployment, DNS,
or token-creation authority. Cloudflare's token scope is broader than one
installation: a stolen Access-policy credential can affect other policies in
its selected account. Gateway ownership checks constrain our code, not the
provider authority of a stolen token.

## Setup and verified endpoint permissions

1. In Cloudflare, open **Manage Account → Account API Tokens → Create Token**.
   This requires a Super Administrator. Use an account-owned token, not a user
   OAuth grant or Global API Key. See [Cloudflare's account-token guide](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/).
2. For the selected account, use **Access: Apps and Policies
   Write** and **MCP Portals Write**. These passed the endpoint check below,
   including both account and zone Access routes. Do not add unrelated permissions
   to make a failing test pass.
3. Add the value directly as the encrypted Worker secret `ANKKA_MANAGEMENT_TOKEN`.
   Do not put it in a plaintext variable, command argument, repository or support
   message. Alternatively use the local interactive `wrangler secret put
   ANKKA_MANAGEMENT_TOKEN` prompt with your private gateway configuration.
4. Open **Settings → Verify management access**. This checks account-token
   validity and reads owned Team policies; it does not prove source-create or
   policy-write permissions. Complete the disposable-account qualification below.

| Fixed operations | Verified permission set |
| --- | --- |
| GET account token verification | The account token itself; no token-management permission requested |
| GET account/zone Access apps, exact app and attached policies; POST source app/policy; PUT attached Team policy | Access: Apps and Policies Write |
| GET/POST MCP servers; GET/PUT the exact owned Portal | MCP Portals Write |

Cloudflare documents [Apps and Policies Write for attached policy updates](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/subresources/policies/methods/update/)
and [MCP Portals Write for server creation](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/ai_controls/subresources/mcp/subresources/servers/methods/create/).
This permission set passed the real-provider endpoint check below. The existing
source executor uses zone-scoped Access routes and account MCP routes; the Team
executor uses account-scoped Access routes. This is not full gateway release
qualification or proof that every narrower permission combination fails.

## Operations

- Sources: retain the existing draft revision, exact allowlist, default-deny
  audience, ownership receipts, and recovery journal. Execute the prepared
  source action inside the customer gateway without management OAuth.
- Team: read current owned Access policies, expose a verified read time, and
  save only a revision-bound batch. Validate resource ownership before writes;
  retain ambiguous writes for explicit recovery. Policy membership is not a
  claim about effective access or immediate session revocation.
- Administrator identity and same-origin checks apply to every management
  mutation. There is no caller-selected Cloudflare URL or credential forwarding.
- Managed BigQuery provisioning requires broader Worker authority and retains
  its existing separate setup flow.

## Lifecycle

Validate the credential against the account token verification endpoint and
validate actual resource access before changing anything. Missing, expired,
revoked, or rejected credentials disable management with fixed safe errors.
Replace the secret directly in Cloudflare, verify the replacement, then revoke
the old token. Deleting a Worker secret or uninstalling the gateway does not
revoke the token; the administrator revokes it separately in Cloudflare.

The signed release contract declares the optional customer-managed binding.
Updates preserve it only as a secret binding; unsupported older contracts must
not silently inherit or expose it. Deployment and bootstrap must never receive
its value from Ankka.

## Qualification

The implementation must test administrator/origin rejection, foreign resource
rejection, lost write responses, live-policy drift, source consent separation,
credential isolation, and update binding preservation. A disposable-account
live check must verify the precise minimum permissions for the API endpoints
used before this feature is described as live-qualified. Local fixtures alone
do not establish Cloudflare token compatibility.

Use a fresh disposable gateway under the [release boundary](TEAM_UPGRADE.md).
Install a synthetic public MCP source, verify its deny-Everyone policy, assign
and remove a synthetic Team member, then change membership directly in
Cloudflare and refresh. Repeat a write after revoking the token, replace it,
and resume any recorded operation. Verify updates preserve the secret and
removal requires separate authority. Keep a secret-free result matrix naming
operations and permission labels only; never capture request authorization,
identities, resource IDs or provider bodies in publishable evidence. Release
qualification remains pending until these real-provider checks succeed.


### Real-provider endpoint check

A disposable-account check for issue #123 passed with one account-owned token
carrying only **Access: Apps and Policies Write** and **MCP Portals Write**.
No Worker deployment, DNS or token-management permissions were added.

| Operation | Observed result |
| --- | --- |
| Account-token verification; account/zone Access app lists; Portal list | HTTP 200 |
| Create and read synthetic MCP server | HTTP 201 / 200 |
| Create zone-scoped MCP Access app and deny-Everyone attached policy | HTTP 201; exact deny audience read back |
| Read that policy through its account-scoped route | HTTP 200 |
| Assign synthetic email, then restore deny-Everyone through account-scoped policy updates | HTTP 200; both audiences read back |
| Create/read disposable Portal; update/read its source mapping and tool allowlist | HTTP 201 / 200; source mapping read back |
| Delete only receipt-recorded test resources | Every resource subsequently returned HTTP 404 |
| Revoke test token in Cloudflare, then retry verification and account/zone/Portal reads | Every request returned HTTP 401 |

The first mapping attempt used the wrong synthetic tool name and returned a
validation error. The repeat used the fixture's actual advertised tool and
passed with unchanged permissions. Both attempts left no recorded resources.
The test token was revoked after qualification.

This first check exercised real API endpoints directly. The deployed checks
below provide separate evidence for the browser-to-gateway flow. Neither API
fixtures nor a direct endpoint check establish signed-update behavior.

### Deployed gateway validation

A fresh disposable gateway was installed from signed canary `gateway-v0.1.62`,
built reproducibly from public commit
`7e2b5cd06a26886226b0abacbea023ec5ee3a1e6`.

- The final runtime reached Ready. Before secret setup, source installation
  and Team mutations were disabled.
- The scoped account token was entered directly as the customer Worker's
  encrypted `ANKKA_MANAGEMENT_TOKEN` secret. Settings verified the token and
  current owned Team policies.
- The dashboard inspected the synthetic fixture's single read-only tool, saved
  a draft, and installed the source without an OAuth redirect. The gateway
  reported installation verified.
- The Team editor assigned a synthetic member to the source and verified the
  change. Independent provider reads confirmed membership in both source and
  Portal policies.
- A direct edit removed that synthetic source membership. Saving an older
  dashboard draft failed closed on policy drift. The recorded change was
  cancelled before any gateway write, and a fresh read advanced the revision
  and reflected the external removal.
- Removing the synthetic Team member through the dashboard was verified;
  provider reads confirmed its absence from both policies and the source's
  restored deny-Everyone audience.
- Removing the management secret disabled Team mutations while preserving saved
  state. The same test secret was then restored directly to the Worker.

The original bootstrap progress page did not automatically open the management
page during this run; opening the reviewed management address reached the Ready
dashboard. This observation is separate from management-token operation.

The real runtime-update API harness upgraded the gateway to signed canary
`gateway-v0.1.63`, built from the same public commit. Provider metadata confirmed
the new release and inherited management secret; the dashboard subsequently
verified the token and current policies. The harness used separate deployment
API authority and a stand-in operation journal. This proves signed updater and
secret inheritance behavior, not the complete browser update workflow.

The built-in removal flow ([tracked separately](https://github.com/ankka-ai/ankka-mcp-gateway/issues/139))
failed twice with a fresh-authorization recovery
message after partial progress. Cleanup therefore used separate deployment
authority through an API fallback that checked exact installation ownership
and shared-resource references before deletion. Independent provider reads
confirmed the test Worker, Durable Object namespace, Access applications,
Portal, source, custom domain, and both DNS names were absent. The scoped test
token was separately revoked; token verification and account/zone Access and
Portal reads all returned HTTP 401. Its temporary local credential file was
removed. This is successful cleanup, not a passing built-in teardown test.

Restoring the same secret does not prove rotation to a different token.
Revocation was checked after cleanup, not during a recorded gateway write.
Ambiguous-write recovery remains covered by local fault-injection tests rather
than this live run. These remaining scenarios and the teardown failure prevent
this report from claiming the entire live qualification procedure passed.

## Diagnosing interrupted qualification

Record management operations, signed update, and cleanup as separate outcomes.
A passing source or Team test does not establish successful cleanup. An API-token
update harness does not establish browser consent or durable handover behavior.

The gateway removal callback reports a fixed failure stage on its recovery page:
authorization, account access, resource removal, stalled progress, expiry,
per-attempt limit, or grant revocation. These labels describe the stage reached,
not a provider root cause. Raw provider errors, credentials, and resource IDs
are never included. Old recovery links still show a generic recovery message.

For resource-removal or stalled-progress failures, inspect the receipt-bound
saved state before retrying. An interrupted attempt can already have deleted
resources. Reuse the existing resume path and ownership checks; do not start a
second installation to recover the first. For expiry or a per-attempt limit,
review removal again to continue under a fresh operation-scoped grant.

Run `npm run validate:lifecycle` for the fixed offline qualification sequence:
installation checkpoints, source and Team operations, signed release discovery
and runtime update, then interrupted dependency and root removal. It builds the
admin fixture once, stops at the first failed stage, and reports later stages as
not run. `--help` describes its scope; additional arguments are rejected.

Recovery regressions discard runtime instances after both applied and unapplied
lost deletion responses, then reload durable state, settle the old attempt, and
resume under a fresh grant. They check resource absence and prevent repeated
successful deletes. These are synthetic provider tests, not evidence that a
particular Cloudflare cleanup failure has been repaired.

The live installation and update harnesses are not chained by this command:
their in-process journals and substituted handover callbacks do not establish
a deployed lifecycle. Live qualification still requires a disposable target,
prepared signed releases, real durable handover, provider read-back, and
receipt-bound cleanup. Report that separately from this offline result.

`npm run validate:lifecycle:live -- --help` describes the separate interactive
live command. It uses an isolated signed release pair and its own Chrome session,
then checks installation, token-managed source and Team changes, signed update,
lost-callback recovery, receipt import, and provider-confirmed removal. See
[Live lifecycle validation](LIVE_LIFECYCLE.md) for preparation and recovery.


Access application and policy DELETE responses with HTTP 202 now leave a
submitted deletion boundary. Only a subsequent read confirming absence records
successful removal. If the resource is still present, the attempt stops;
restarting the runtime does not resend that deletion under the same grant.
Fresh authorization rechecks ownership and can resume. This change is limited
to Access teardown and does not broaden accepted create/update responses.
