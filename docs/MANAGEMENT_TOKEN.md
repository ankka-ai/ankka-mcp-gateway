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
- **On an installed gateway**, from **Settings → Add management token** (or
  **Replace management token**): you approve one change in Cloudflare, and a
  page your own gateway serves afterwards has the same link and one field to
  paste the token into. Your gateway writes it as its own
  `ANKKA_MANAGEMENT_TOKEN` encrypted secret. This is the one way the product
  offers for a gateway that runs without the token, whether setup skipped it,
  lost it, or predates the step, and for replacing a token.

Neither `deploy.ankka.ai` nor `auth.ankka.ai` serves a token-entry form or
receives the value, and the gateway never returns it to a browser. The relay
at `auth.ankka.ai` sees what it sees for every operation: an authorization
code on its way to your gateway's certified callback, and nothing else.

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

### What the Settings flow does with the value

A gateway cannot write its own secrets outside the minutes of an operation
you approved. So the flow is one fixed operation, `management-credential`,
with exactly one Cloudflare scope, `workers-scripts.write`, and one mutation,
a Worker-secret write on the gateway's own Worker:

1. The card offers the [template link](#the-template-link) first. Create the
   token and copy it before you continue: Cloudflare's approval lasts only a
   few minutes, and a token created afterwards can outlive it. The paste page
   shows the link again for a token that was not created yet.
2. **Add management token** prepares the change inside your gateway. Only an
   administrator can, from the dashboard's own origin; the service identity
   cannot. It is refused while a source installation, update, removal or Team
   change is unfinished, and those are refused while it is open.
3. Your gateway's operation page sends you to Cloudflare for one approval.
4. Cloudflare returns you to a page **of your gateway**. It keeps the
   authorization code in script memory only, drops it from the address at
   once, and shows the [template link](#the-template-link) and one field. The
   field is not echoed, has no `name`, and is emptied as soon as it is read.
5. The page sends the value once, in the body of a same-origin POST, under
   the attempt's HttpOnly cookie, its state and its PKCE verifier, and only
   from the administrator who prepared the change. The page's policy allows
   connections to your gateway's own origin and nothing else, and no form
   submission.
6. Your gateway accepts only the two [account token forms](#accepted-token-forms).
   A wrong paste is refused before anything is spent, so the same approval
   takes the next paste. Then it exchanges the code, checks with one read that
   the approval covers this account's Worker, and writes the secret with
   **one** call:
   `PUT /accounts/{account}/workers/scripts/{worker}/secrets` with
   `{ "name": "ANKKA_MANAGEMENT_TOKEN", "text": …, "type": "secret_text" }`.
   HTTP 200 or 201 is success. The call is never retried and its answer is
   never read. It is the endpoint the [lifecycle runner](AGENT_LIFECYCLE.md)'s
   manage stage writes the same secret through, with the operator's authority
   instead of your approval.
7. It revokes the approval, as every operation does, and answers with fixed
   words.

The value exists only inside that one request. It is never written to Durable
Object storage, never kept in object memory between requests (there is no
holder and no keep-alive here: the paste comes after the approval), and never
placed in a journal, a log line, an error, a URL, a cookie or a response. The
gateway's record of the change holds who prepared it, until when, and how it
ended.

Approvals last a few minutes. If yours runs out before you paste the token,
the page says so, nothing is saved, and you start again from Settings. After
a successful write Cloudflare starts your Worker with the new secret within
about a minute; Settings watches for it by itself and then offers **Verify
management access**.

Replacing a token takes the same steps. Your gateway cannot delete the old
token: afterwards, delete it in Cloudflare under **Manage Account → Account
API Tokens**. Both carry the name `Ankka gateway <management hostname>`; the
old one has the earlier creation date.

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
message and the install continues without it. The Settings page applies the
same check, so such a token is accepted only once a release widens the
accepted forms.

Everything else is refused before anything is kept, including a user API
token (`cfut_`), a Global API Key (`cfk_`), surrounding whitespace, and any
longer value. The Settings flow applies the same check. Neither verifies the
token against Cloudflare: the form check costs no API call, and **Settings →
Verify management access** checks the installed token afterwards.

For disposable development gateways, the [lifecycle runner](AGENT_LIFECYCLE.md)
is a further, operator-controlled provisioning path: it reads the operator's
token from the operator's credential store and writes it as the Worker
secret with the operator's own deployment authority. The attended
[browser runner](LIVE_LIFECYCLE.md) takes the customer's path instead when its
private config opts in with `managementToken`: it enters the token at this
setup step, with the request the setup page sends, so the install's final
upload writes the secret and the operator token needs no Workers Scripts
permission for it. Writing the Worker secret itself is only its fallback, made
at most once: for a value the setup step refused or dropped, a gateway that
never reports it, a release without the step, or a resumed run. Without that
field the runner continues setup without a token and its operator installs the
secret in Cloudflare. The value still never passes through Ankka-hosted
services, and removing the gateway does not revoke it.

The token needs the Access application/policy and MCP Portal permissions used
by the fixed operations below. It must not include Worker deployment, DNS,
or token-creation authority. Cloudflare's token scope is broader than one
installation: a stolen Access-policy credential can affect other policies in
its selected account. Gateway ownership checks constrain our code, not the
provider authority of a stolen token.

## Setup and verified endpoint permissions

During installation, the setup page in your own Worker does these steps with
you; on an installed gateway, **Settings → Add management token** does:

1. Open the [template link](#the-template-link) the page shows. It opens
   **Manage Account → Account API Tokens → Create Token** with step 2 filled
   in. This requires a Super Administrator or Administrator. The token is
   account-owned, not a user OAuth grant or Global API Key. See [Cloudflare's account-token guide](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/).
2. For the selected account, the token carries **Access: Apps and Policies
   Write** and **MCP Portals Write**. A template link names the same level
   `edit`, and the pages say **Edit**. These passed the endpoint check below,
   including both account and zone Access routes. Do not add unrelated permissions
   to make a failing test pass.
3. Paste the value into the page of your own gateway. Do not put it in a
   plaintext variable, command argument, repository or support message.
4. Open **Settings → Verify management access** (see below).

### What verification proves

**Verify management access** proves both permissions on exactly the two
resources the gateway owns, without changing them:

| Check | Calls | Proves |
| --- | --- | --- |
| Account token verification | 1 read | The token is active for this account |
| The gateway's own MCP Portal: read, written back unchanged, read again | 2 reads, 1 write | **MCP Portals Edit** |
| The Portal's own Access application and its one policy: read, policy written back as read | 2 reads, 1 write | **Access: Apps and Policies Edit** |

That is at most **seven** Cloudflare API calls per verification. Each resource
is read first and must match what the receipts and the saved Team say, judged
the way every other check judges it: identifiers, names, markers, the exact
server mappings and the exact audience, never a timestamp. So a write of the
same content cannot look like drift afterwards. On any difference nothing is
written to that resource and the answer says **drift**; the page does not
reset it. The Portal is sent the body the gateway sends when it attaches a
source; the policy is sent the five fields a Team change sends, with the
values as read. Both write shapes passed the real-provider endpoint check
below. The answer is fixed words: the token is `active`, `missing`,
`rejected` or `unconfirmed`, and each permission is `verified`,
`permission_missing` (Cloudflare refused the token for that resource),
`drift`, `unconfirmed` or `not_checked`. Verification runs inside the
management object's queue, and is refused as `busy` while a source
installation, update, removal, Team change or token change is unfinished.

Identical writes of this kind have not been observed against the real
provider for side effects beyond the resource bodies (Cloudflare may advance
its own modification time, which nothing here reads). That observation
belongs to the disposable-account qualification below.

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
Replace the token from **Settings → Replace management token**, verify the
replacement, then delete the old token in Cloudflare by its name. Deleting a
Worker secret or uninstalling the gateway does not revoke the token; the
administrator revokes it separately in Cloudflare. The gateway cannot do it:
deleting a token needs token-management authority, which no part of Ankka
ever holds. The last removal page therefore names the token setup pre-filled
(`Ankka gateway <management hostname>`) and links to the account's API
tokens, and the hosted installer says before an install starts that setup
needs one account API token and who can create it.

A token change and an update exclude each other on purpose: the update reads
the Worker's bindings to decide whether the new version inherits the secret,
and the secret write gives the Worker a new version of its own.

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
