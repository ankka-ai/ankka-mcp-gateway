# Customer-owned management credential

Issue #123 replaces repeated Cloudflare consent for routine source installation
and Team policy management with one account-owned API token. Deployment, DNS,
Worker updates, teardown, and upstream-provider authentication retain their
separate authority. This does not turn MCP tools into write-capable tools.

## Credential custody

**The token never passes through anything Ankka hosts.** An administrator of
your Cloudflare account creates the account-owned token in Cloudflare, and it
reaches your gateway in one of two ways:

- **During setup**, on the setup page your own Worker serves before the second
  Cloudflare approval. The page links to Cloudflare's token page with both
  permissions and a name filled in, and has one field to paste the token
  into. The value goes from your browser to your own Worker and nowhere else.
- **On an installed gateway**, directly in Cloudflare: as the
  `ANKKA_MANAGEMENT_TOKEN` encrypted secret on the gateway Worker, using
  Cloudflare's dashboard or local Wrangler. A Settings flow that takes the
  same link and field, behind one Cloudflare approval, is planned
  ([issue #176](https://github.com/ankka-ai/ankka-mcp-gateway/issues/176));
  until it exists, these Cloudflare-side instructions are how an installed
  gateway gets, replaces, or rotates its token.

Neither `deploy.ankka.ai` nor `auth.ankka.ai` serves a token-entry form or
receives the value, and the gateway never returns it to a browser.

### What the setup page does with the value

The setup page already runs in the Durable Object that is about to hold your
install approval, which is broader (Workers, DNS, Access). The pasted token is
kept the same way, in the same memory, for the same minutes:

- The field is not echoed and is emptied as soon as it is read. The value is
  sent once, in the body of a same-origin POST under the setup session, and is
  never placed in a URL, a fragment, a cookie, or browser storage.
- Your Worker accepts only Cloudflare's two account-token forms (see
  [Accepted token forms](#accepted-token-forms)) and answers with one fixed
  word. A refused value gets one fixed error. No response, error, or log line
  carries the value.
- The value lives only in the object's memory, next to the install approval.
  It is never written to Durable Object storage, the install journal, a
  receipt, or the status route. Storage keeps one fixed word about your
  choice (`provided` or `skipped`) so the status can say what happened.
- The final runtime upload the install already makes writes it as the
  `secret_text` binding `ANKKA_MANAGEMENT_TOKEN`. That adds no Cloudflare API
  call. After the upload nothing in the object keeps the value.
- The step is locked while an approval or an install runs, so a running
  install uploads exactly what you chose before it started.
- While it waits for your approval the object keeps one alarm ahead of itself
  so Cloudflare does not evict it: a pending timer only prevents hibernation,
  and an idle object is otherwise evicted after one to two minutes. This tick
  never replaces an alarm the install has set, makes no Cloudflare API call,
  and runs an install pass only when the install already holds its approval,
  so it cannot disturb a callback that is still exchanging its code. The
  value is forgotten as soon as no approval can use it any more, and after
  thirty minutes at the latest.
- If Cloudflare restarts the object anyway, the value is lost. The install
  still completes, without the token, and the page that follows the install
  says so. Add the token afterwards as described for an installed gateway.

The install status route (`/__ankka/install/status`) carries one fixed word
about this step and never the value: `held`, `installed`, `skipped`, or
`dropped`. The key is absent until you have chosen.

Continuing without a token is allowed through an explicit control on the
setup page. Until the token exists, adding sources and managing team access
stay disabled; updates, rollback, and removal do not need it.

### The template link

```text
https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=<URL-encoded JSON>&name=<name>
```

The JSON is `[{"key":"access","type":"edit"},{"key":"mcp_portals","type":"edit"}]`
and the name is `Ankka gateway <management hostname>`, so the token can be
found again in Cloudflare later. This link was verified against the Cloudflare
dashboard on 2026-09-19: it pre-filled **Access: Apps and Policies Edit** and
**MCP Portals Edit**. `:account` is Cloudflare's own placeholder; the dashboard
asks which account when you have more than one. The link carries permission
keys and a name, never a credential. See Cloudflare's
[template link guide](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/).
The two keys live in one constant,
`CLOUDFLARE_MANAGEMENT_PERMISSION_GROUP_KEYS` in
[`customer-management-credential.ts`](../apps/installer/src/customer-management-credential.ts).

### Accepted token forms

The setup page accepts exactly the two forms Cloudflare documents for an
account API token in its
[token formats reference](https://developers.cloudflare.com/fundamentals/api/get-started/token-formats/):

| Form | Accepted value |
| --- | --- |
| Scannable, created or rolled since 2026 | `cfat_` followed by 40 to 64 alphanumeric characters (40 characters and Cloudflare's checksum) |
| Created before the scannable format | 40 characters: letters, digits, `-` and `_` |

Cloudflare documents the scannable form as `cfat_[40 characters][checksum]`
and says tokens in the earlier form "continue to work". It publishes neither
the checksum's length nor its algorithm for account tokens (the sibling Access
service-token secret of its
[2026-08-26 changelog](https://developers.cloudflare.com/changelog/post/2026-08-26-service-token-secret-format/)
uses eight characters), so the check allows 40 to 64 characters after the
prefix: it exists to catch a wrong paste, and Cloudflare alone judges the
token. Cloudflare calls
the earlier form a 40-character alphanumeric string; tokens issued in that
form also contain `-` and `_`, so both are accepted there. The checksum itself
is not recomputed: its algorithm is not published. Should Cloudflare issue an
account token in another form, the setup page refuses it with its fixed
message and the install continues without it; the token can then be added as
described for an installed gateway.

Everything else is refused before anything is kept, including a user API
token (`cfut_`), a Global API Key (`cfk_`), surrounding whitespace, and any
longer value. Setup does not verify the token against Cloudflare: the form
check costs no API call, and **Settings → Verify management access** checks
the installed token afterwards.

For disposable development gateways, the [lifecycle runner](AGENT_LIFECYCLE.md)
is a further, operator-controlled provisioning path: it reads the operator's
token from the operator's credential store and writes it as the Worker
secret with the operator's own deployment authority. The attended
[browser runner](LIVE_LIFECYCLE.md) does the same only when its private config
opts in with `managementToken`; without that field its operator installs the
secret in Cloudflare. The value still never passes through Ankka-hosted
services, and removing the gateway does not revoke it.

The token needs the Access application/policy and MCP Portal permissions used
by the fixed operations below. It must not include Worker deployment, DNS,
or token-creation authority. Cloudflare's token scope is broader than one
installation: a stolen Access-policy credential can affect other policies in
its selected account. Gateway ownership checks constrain our code, not the
provider authority of a stolen token.

## Setup and verified endpoint permissions

During installation, the setup page in your own Worker does steps 1 to 3 with
you: open its link, create the token, paste it. For a gateway that is already
installed:

1. In Cloudflare, open **Manage Account → Account API Tokens → Create Token**,
   or open the [template link](#the-template-link), which fills in step 2.
   This requires a Super Administrator or Administrator. Use an account-owned
   token, not a user OAuth grant or Global API Key. See [Cloudflare's account-token guide](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/).
2. For the selected account, use **Access: Apps and Policies
   Write** and **MCP Portals Write**. A template link names the same level
   `edit`, and the setup page says **Edit**. These passed the endpoint check below,
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
  source action inside the customer gateway without management OAuth. For a
  sign-in source, read the receipt's own MCP server once to offer its synced
  tools and once more to validate the choice; both are the existing `GET` of an
  MCP server, and neither adds a provider write or a permission.
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
its value from Ankka: during setup it comes from your browser to your own
Worker, and the hosted installer's uploads never carry it.

The install's exact read-backs follow the same rule. The read-back of the
final runtime version accepts `ANKKA_MANAGEMENT_TOKEN` as a `secret_text`
binding without a readable value exactly when the install supplied the token,
and refuses it, under any type, otherwise. Recovery in the final runtime
inspects the version it is itself running, so it expects the binding exactly
when its own environment carries it. The setup shell's read-back never
accepts it: the shell is uploaded by the hosted installer, which never holds
the value.

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
