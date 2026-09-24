# Pending source installations

This describes the source-action status and recovery contract. It is not a
deployment claim or authorization to recover an existing live action.

The Sources page reads the retained action journal from the authenticated
customer gateway. Reloading, opening another tab, and returning from consent
do not require a saved authorization URL. A source installation and a gateway
update are separate actions; a completed update does not establish the result
of a later source installation.

| Displayed state | Meaning and available next step |
| --- | --- |
| Waiting for Cloudflare | The existing authorization is pending. Complete consent in its original tab, or cancel if the server permits it. |
| Applying and verifying | The gateway has claimed execution. Wait and check status; cancellation is unavailable. |
| Installation completed | The journal records verified completion. The page refreshes installed sources. This does not itself grant member access or verify upstream authentication. |
| Authorization expired before work began | The retained journal proves execution did not start. Its initiating administrator can cancel, then start a fresh authorization from the saved draft. |
| Authorization closed | The attempt has ended without retained write evidence. Review the saved draft before a new authorization. |
| Recovery required | The journal is retained. After the previous approval expires, its initiating administrator can renew consent when the gateway can safely reconcile the recorded resources. Otherwise review ownership in Cloudflare. |
| Connect your source | Use **Authorize source** to approve your provider's consent. Use Cloudflare for manual setup, keeping Require user auth off. A sign-in source installed without tools is not resumed yet: its tools are chosen first. |
| Sync source tools | Sync capabilities in Cloudflare and resolve any connection error before renewing consent. |
| Review source tools | The synced catalogue lacks a selected tool. Restore the reviewed tools upstream before resuming, or, for a sign-in source, choose again from its real list; the saved selection is never broadened. |
| Choose tools | The sign-in source is connected and synced, and nothing is enabled. Its initiating administrator chooses from the real list below the status. |
| Finish installation | A tool choice is saved. Resume to attach the source with exactly those tools. |

The page checks a blocking action every five seconds for at most 60 automatic
checks. It then leaves the status and **Check status** control visible. A manual
check or returning to the tab reads current state without replaying consent.
Pausing checks does not cancel execution. Status-read failures keep Apply
disabled until status can be read again.

## Authenticated protocol

`GET /api/source-actions` returns only safe summaries and an optional blocking
action pointer. Each summary includes the existing action ID, source ID,
recorded status, expiry and fixed failure code, plus its issue time, derived
display state and actor-specific `canCancel` and `canRenew`. Older responses may
omit `canRenew`, which clients treat as unavailable. The pointer identifies a source,
runtime, teardown or Team action without exposing the initiating identity,
Cloudflare resource identifiers, authorization URL, action key or grant.
An intentional connection pause also includes an optional `connectionUrl` to
the recorded server's configuration page on `dash.cloudflare.com`. This link
contains the installed account and server identifiers, but no OAuth state,
credential, or permission to administer the server. Cloudflare authenticates
the operator independently. Clients validate the exact dashboard URL shape.
Collection reads are available during execution; mutations remain serialized.
The existing by-ID GET and DELETE response shapes remain unchanged.

Source preparation retains the existing `source_action_conflict` error code and
adds a bounded reason when known: `draft_changed`, `source_pending`,
`lifecycle_pending`, or `recovery_required`. A safe action pointer accompanies
action conflicts. Older clients can continue to use the original error code;
new clients can distinguish revision conflicts from an action that needs review.
WebMCP exposes the same collection and cancellation checks.

Cancellation is a separate authenticated, same-origin mutation. The server
rechecks the initiating administrator, execution status and all retained write
evidence when processing it. It also permits cancellation after expiry when
execution provably never started. If execution wins the race, cancellation
cannot erase it. If cancellation wins, the old callback cannot start execution.
The user must separately authorize any replacement attempt.

**Remove source** discards an unused draft instead of keeping it for another
attempt. The same-origin `DELETE /api/sources` takes `schemaVersion: 1`, the
displayed source `revision`, and `sourceId`. The gateway checks the revision,
actor, source and lifecycle journals, and any retained BigQuery bridge evidence
inside its serialized mutation. A storage transaction removes the draft, all
of its authorizations and its empty bridge record together. Removal works for
failed or cancelled attempts with no write evidence, and for approvals the
actor can cancel. Installed sources and any provisioning evidence require
resource cleanup; this operation cannot discard their receipts.

Connection-paused installations with complete receipts and no outstanding
write offer confirmed cleanup through `DELETE /api/sources/<source-id>`.
The initiating administrator uses the management token to remove the recorded
resources without finishing provider sign-in or tool selection. This keeps
the draft and installation action until the durable removal journal verifies
cleanup. See [Removing a source](SOURCE_REMOVAL.md) for its recovery behavior.

An unrelated source action does not block deleting an unused draft. The
transaction advances unchanged actions bound to the previous source-collection
revision, preserving their source identity and receipts for recovery.

For a BigQuery bridge that failed before any source resources or Portal
attachment, `POST /api/bigquery/remove` takes the same source revision and ID.
It rotates the existing action key and starts a gateway-local `bigquery-remove`
approval. The retained `source_removal_required` marker disables installation
resumption. Each signed cleanup pass re-enters the management object and checks
the bridge against a source-specific deletion journal. Only verified completion
removes the source, action, bridge record and cleanup journal atomically. The
callback revokes its temporary grant and returns `sourceRemovalResult`; retries
require fresh consent and never require a Google key upload.

Expiry never clears an armed write, resource receipt, Portal update or uncertain
execution. An absent resource in the Cloudflare dashboard does not prove that a
request was never armed or sent. Credentials remain request-local under the existing
one-action contract.

## Renewing a recorded installation

**Renew consent and resume** posts to
`/api/source-actions/<actionId>/renew` with the saved source ID and revision.
The gateway requires the initiating administrator, a same-origin request, an
expired approval, the current default-deny source profile, an unchanged source,
and no other blocking lifecycle action. The serialized check preserves the
action ID, source hash, resource receipts, pending write and Portal desired hash.
It issues a new action key and ten-minute approval window; the old key cannot
be used again. Only the key hash and a renewal timestamp are saved. The runtime
compatibility floor advances before saving the renewed journal.

An intentional connection pause can renew immediately: all three source
receipts must be retained, with no pending resource or Portal write. The
executor first verifies the Portal baseline, then reads the server's
authentication status and synced catalogue. It pauses before Portal attachment
if authentication is required, synchronization is incomplete, or an exact
selected tool is missing. These fixed failure codes use the existing retained
`recovery_required` journal status; only their displayed guidance differs.
Unknown outcomes and other recovery failures still wait for approval expiry.
Renewal does not authenticate the upstream or retain its credentials.

The browser completes a fresh `source-add` consent through the same gateway
operation page. The executor verifies every retained resource, reconciles a
recorded pending write, and accepts only the recorded Portal baseline or exact
desired mapping before continuing. It never grants Team access as part of
recovery. Concurrent renewals cannot create two valid approval windows, and
cancellation still cannot erase retained write evidence.

A source Access application whose creation was armed but returned no provider
ID remains blocked. Cloudflare stores these applications at account level,
while the operation grant's zone listing can omit them. That listing cannot
prove absence, so renewal must not create a second application. Legacy source
policy profiles and drift also require separate review. Denying or abandoning
a renewed consent retains the journal; check status after its approval expires
to renew again when eligible.

## Choosing the tools of a sign-in source

A source that needs sign-in may list tools publicly before its operator has
connected it. Its draft is still saved, and installed, with none: the server is
created without any tool override, its Access application denies everyone, and
it is not attached to the Portal. That is the connection pause above. Two more
fixed reasons use it: `source_tools_required` (connected and synced, nothing
chosen) and `source_tools_chosen` (a choice is saved). With nothing chosen a
resume pauses again; the gateway never attaches a source with nothing enabled.

`GET /api/source-actions/<actionId>/tools` answers the real list for one paused
installation: `{ schemaVersion, actionId, sourceId, state, tools }`. `state` is
`connection_required`, `sync_required`, `unsupported` (more than 500 tools, a
repeated name, or a name the gateway refuses) or `ready`; `tools` is empty
unless it is `ready`. Cloudflare types a synced tool as an untyped map, so only
`name` is required: `title`, `description` and the three hints are passed on
within the discovery bounds when the record carries them and are `null`
otherwise. Nothing is derived, and no provider text is returned.

`POST /api/source-actions/<actionId>/tools` with
`{ schemaVersion, revision, sourceId, enabledTools }` saves the choice and
answers `{ schemaVersion, actionId, sourceId, revision, enabledTools }`. It is
its own revision-bound step, not an edit of a running action. Inside the
management object's serialized queue the gateway requires the initiating
administrator, the current default-deny profile, no other blocking lifecycle
action, an installation that is exactly connection-paused (all three receipts,
no pending resource write, no Portal write), a sign-in draft that still hashes
to the action's `sourceHash`, the current draft revision, and one to 500 sorted
names that all exist in the synced list. It then writes, in one atomic
multi-key put, the draft at the next revision with the chosen tools and the
action re-bound to it: `sourceRevision`, `sourceHash`, and the server receipt's
`desiredHash`, which covers the tool policy and which removal re-derives from
the installed source. Status, action key and provider locators do not change,
so the renewal above resumes it at once and the executor attaches exactly that
allowlist. Both routes spend one provider read and no provider write; neither
is open to the service identity.

A lost response is safe to repeat: the repeat carries the revision the client
last saw and is refused with `draft_changed`, and the saved draft and recorded
action show the choice. The same choice on the bound revision writes nothing.
A different choice is accepted while the installation is still exactly paused
and refused (`source_tools_unavailable`) once a resume has recorded a Portal
write. An installation paused under the earlier flow, whose draft names typed
tools, resumes unchanged; its administrator may also correct a name from the
real list with this step.

## Provider authorization from Sources

The initiating administrator can use **Authorize source** on a connection-paused
OAuth draft. `POST /api/source-actions/<actionId>/authorize` takes
`{ schemaVersion: 1, revision, sourceId }` and returns a provider authorization
URL and expiry. It requires a human Access identity, a same-origin JSON request,
the current draft and installation, the gateway's management token, and an owned
Cloudflare source. Service identities cannot start or finish this flow.

For the exact Meta Ads endpoint, include the public numeric `metaAppId` in that
JSON request. Meta refuses automatic registration for custom clients, so the
gateway uses this pre-registered App ID with PKCE and the displayed callback.
The parameter is rejected for every other provider. App secrets and manually
supplied provider tokens are never accepted. See [Meta Ads](META_ADS.md).

The gateway discovers RFC 9728 resource metadata on the source's origin and
RFC 8414 authorization metadata for its advertised issuer. This first path
requires HTTPS public hostnames, same-issuer-origin authorization/token/registration
endpoints, dynamic registration of a public client (`none`) and PKCE S256.
Redirects, secret-bearing clients and unsupported metadata are refused; the
Cloudflare link remains available. Manual OAuth and BigQuery restrictions are
unchanged. This does not establish compatibility for an untested provider.

For the exact Gorgias MCP endpoint, this flow requests only `tickets:read` and
advertised identity/session scopes (`openid`, `email`, `profile`, `offline`).
Registration must not expand those scopes. Before import, the token response
must explicitly include `tickets:read` and no unrequested scope; an omitted
scope is refused even though OAuth can otherwise permit omission. Cloudflare
receives only the selected scope set in the refresh configuration. Synthetic
tests cover this restriction and restart/replay; live Gorgias enforcement and
Cloudflare refresh still require an isolated provider canary.

The callback is `https://<management-hostname>/__ankka/source-oauth/callback`.
One five-minute attempt binds a state hash and a Secure, HttpOnly, SameSite=Lax
browser-cookie hash to the initiating administrator, action hash and source
revision. The Durable Object retains the PKCE verifier and public OAuth
metadata, never a provider token or management token. An expired attempt is
unusable; its single retained record is deleted on a matching callback or
replaced by another start. No cleanup alarm competes with lifecycle alarms.
The callback checks the issuer when supplied (and requires it if advertised),
consumes the attempt in the mutation queue before exchange, rechecks ownership
and lifecycle state, exchanges the code, then imports the resulting grant
directly into the exact Cloudflare source. Cloudflare owns storage and refresh.

The import writes `auth_credentials` as a JSON string containing `tokens`,
`config` and `registration_info`. This is an **undocumented dashboard contract**,
separate from the documented manual-client configuration. The
[disposable OAuth proof](../fixtures/mcp-oauth-proof/README.md) verified import,
refresh and two identities sharing one administrator grant; production route
tests additionally cover Access/browser binding, drift, failures and SQLite
restart/replay behavior. They do not prove arbitrary provider compatibility.

After import the gateway requests a capability sync and returns a fixed result
to `/sources?source_oauth=connected|sync_pending|cancelled|failed`; codes and
provider error text are not reflected. The page clears that query and reloads
the actual tool catalogue. If sync is delayed, use **Check again**, then the
Cloudflare link if necessary. A lost callback response cannot exchange twice;
check the source before starting again. Connection alone does not select tools,
attach the source to the Portal, or grant Team access.

## Authorization on the gateway

Preparing a source installation returns a handoff to the gateway's own
`/__ankka/operation` page on the management origin, with the one-time action
key in the URL fragment. That page posts the fragment to the gateway, which
checks the claim against its own identity and the retained action, records
one attempt (identifiers, a state hash, and expiries only), and starts a
Cloudflare consent for exactly the `source-add` scopes through the public
OAuth client and callback that the ownership trust certified at install. The
PKCE verifier and the action key travel only in one HttpOnly cookie.

On the callback the gateway exchanges the code itself, confirms the grant
reaches the installed account by reading that account's MCP portals (an
operation grant cannot list accounts), submits the HMAC-signed apply claim to its own action route in
process, revokes the grant, and sends the browser back to
`/sources?sourceAction=<id>&sourceActionResult=<result>`. The result is
`applied`, `denied` (consent refused; the page cancels the untouched action),
`failed` (the gateway refused or could not finish the apply; read the action
status), or `revocation_unconfirmed` (installed, but the temporary grant could
not be confirmed revoked), with a bounded `sourceActionReason` word (a grant
error, the apply route's error code, or an update stage) when the gateway can
name what stopped it. No control-plane page, token, or callback is involved;
Ankka's hosted installer never sees the grant. Runtime updates take the same
route with an `upgrade` grant (see [Updates](UPDATES.md)); rollback and
teardown handoffs are not yet served by it.

## Operational limits and release review

Uncertain ownership and drift remain blocked for separate review. Renewal adds
no automatic cleanup or permanent management credentials. It does not change
source allowlists, default-deny installation,
Team permissions or the separation between administrators and approved members.
While Team editing is deferred, manage the approved members' shared read-only
access directly in Cloudflare under a separate operational authorization.

Before releasing, run the full pinned-toolchain `npm run check` on the integrated
candidate, then use the existing reviewed release process. Resolve overlapping
dashboard or lifecycle changes by retaining both their checks and this source
journal boundary. Signing, publication, deployment, live policy changes and
live action recovery require their own authorization. Local tests and synthetic
previews are not evidence that a customer's pending action has recovered.
