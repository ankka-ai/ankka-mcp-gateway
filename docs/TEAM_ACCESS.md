# Team access

Team reads current Cloudflare membership and displays its observation time.
With the [customer-owned management token](MANAGEMENT_TOKEN.md) configured,
administrators save source assignments directly in the gateway. The token stays
in your Cloudflare account. New data sources start denied to everyone until an explicit Team grant.

To give someone full dashboard access, open **Team → Access** beside their
email, select **Dashboard administrator**, and save. They can manage connectors,
team access (including dashboard access), settings, updates and removal.
Deployment administrators always retain dashboard access for recovery. New team
members start without it; connector assignments do not grant it.

The option requires a gateway release with dashboard-access support and its
verified installation record. Changes use the customer-owned management token
and the existing Team write journal. The Worker verifies both the saved grant
and the live, installation-owned dashboard policy on every delegated dashboard
request. Revoking the grant rejects later requests even with an unexpired login
token; it does not cancel an operation already accepted. Missing credentials or
unverifiable policy state deny delegated access; deployment administrators can
still sign in for recovery. Only dashboard administrators can change these
grants. Service identities and source-only management assignees cannot grant
themselves dashboard access. Dashboard grants do not assign MCP sources.
Cloudflare approval is still required for operations that already require it.
The Team API uses the optional member field `dashboardAccess`: `true` grants
access, `false` revokes it, and omission preserves an existing grant for older
clients. Deployment administrators cannot be removed or demoted here.

The optional [Gateway Management source](GATEWAY_MANAGEMENT_MCP.md) initially
assigns its creator and uses ordinary Team assignments thereafter. People assigned
its Team-write tool can manage assignments from their agents without becoming
dashboard administrators. The backend reads the live source policy on every MCP
request, so removing that assignment rejects even an otherwise unexpired token.

A missing credential leaves the saved snapshot available, clearly unverified.
Provider failures or unexpected policy shapes block verified reads and writes.
Refresh before editing after an external change; stale revisions are rejected.
An interrupted save retains its exact proposal and write journal for explicit
resume. Do not replace it with a different proposal or delete its state.

Each Team load reads, in one overlapping round, the account's Access
applications with their policies, the Portal, the management token and each
team's Access group, and accepts membership only after every read succeeds.
Cloudflare's application list carries each application's policies exactly as
the per-application reads return them, current immediately after a write, so
loads and saves read policies from it and make no request per source. Policy
writes and their verification keep their ordered journal.
Only the public Access signing keys are cached in Worker memory, for up to five
minutes per issuer. A new key ID triggers a refresh, and failed refreshes never
reuse expired keys. Every request still verifies its signature, issuer, audience,
expiry and the authorized dashboard or service identity. Membership and
management credentials are not cached.

The manual procedures below remain useful for provider-side inspection and
session revocation. Historical canary observations are not proof that the new
account-token flow has been qualified live.

## Revocation qualification

Removing an email from a source policy does not by itself prove that an
already-connected client has lost access. Canary qualification keeps Portal
admission and the operator's source access unchanged while removing only the
test member's source assignment:

| Connection | Observed result |
| --- | --- |
| Existing Portal grant | Direct and Code Mode calls still succeeded more than five minutes after the policy removal was verified. |
| Fresh client authorization started after removal | The browser stopped at **No allowed servers available** before issuing an OAuth code or token. |
| Existing grant refreshed after removal | Refreshes at 15, 60, 180, and 300 seconds succeeded; source discovery and direct and Code Mode reads still worked. |

The fresh-client result proves admission denial, not a tool-call test using a
new token. These observations do not establish a provider defect or indefinite
access. Cloudflare marks
[email selectors](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/#cloudflare-access-selectors)
as checked at login, not continuously. The
[Portal authorization grant](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#session-lifecycle)
retains authentication, server selection, and upstream OAuth state.

Cloudflare's
[Managed OAuth documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/#managed-oauth-settings)
says Access policies are reevaluated on refresh, but does not explicitly define
whether refreshing Portal admission reevaluates every linked source policy.
Do not infer a source-access expiry bound from the Portal access-token lifetime.

### Qualified procedure for existing Portal sessions

A separate canary test removed the member's source assignment and then invoked
Cloudflare's application-token revocation for the exact Portal application.
The same client had first passed source discovery and harmless reads:

- At the first check, 15 seconds after Cloudflare accepted revocation, the old
  access token received HTTP 401 for both `tools/list` and `tools/call`, in
  direct mode and Code Mode.
- A refresh attempt 90 seconds after revocation received HTTP 400
  `invalid_grant`; no replacement access token was issued.
- The original source assignment was restored after the test, and both source
  and Portal policies were read back and verified.

This qualifies application-token revocation for the tested Portal workflow.
The observed timing is not a propagation guarantee. Restoring a source policy
does not restore revoked client credentials.

When you need to remove existing access:

1. Remove the person's assignment from the relevant source policy and verify
   the saved audience. For departure from the team, also remove Portal admission.
2. Identify the exact Portal Access application from the installation receipt.
   Cloudflare's
   [application-token revocation](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/revoke_tokens/)
   uses `POST /accounts/{account_id}/access/apps/{app_id}/revoke_tokens`.
   **This revokes every session for that Portal**, including other team members;
   account for their need to reconnect before invoking it.
3. Verify that the previously authorized client cannot list or call source
   tools, and that its refresh token cannot renew access. Verify that a fresh
   authorization cannot select the removed source. A successful revocation API
   response alone is not proof of denied access.

Cloudflare also documents
[user session revocation across applications](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#revoke-user-sessions).
That broader operation was not tested. The qualified application-level
procedure does not establish a way to revoke only one person's session for one
source. A source policy update alone must not promise immediate disconnection.

## Why V1 does not use an API token

Cloudflare support confirmed that both account-owned (`cfat_...`) and user-owned
API tokens can select resources only at User, Account, or Zone level. An API
token with **Access: Policies Write** for one account can therefore update every
Access policy in that account. It cannot be restricted to the reusable policy
owned by one Ankka installation.

Per-policy **Cloudflare Access Policy Admin** scoping exists in Cloudflare's
human/member IAM model. Cloudflare also confirmed that this resource-scoped
role is still beta for OAuth: individual policy API requests can currently be
evaluated differently from the resource-scoped list endpoints. That provider
gap explains the qualified `403`; widening the grant or substituting an
account-wide token would not preserve the intended isolation.

The V1 decision is therefore to keep the editor disabled instead of presenting
account-wide authority as policy-scoped.

<a id="customer-owned-management-credential"></a>

## No V1 Team credential

Do not create an API token for the gateway Team page and do not add a Team
management secret to the Worker. The normal release contract does not declare,
inherit, or consume one. Adding an undeclared secret manually does not enable
Team editing.

The management dashboard authenticates administrators through Cloudflare
Access, but that browser session is not authority for the Worker to rewrite
Access policies. V1 does not fall back to a hosted Team OAuth flow.

## Manage membership in Cloudflare

Use the Cloudflare dashboard to change the reusable Access policies protecting
the Ankka Portal and installed source applications. Keep the following
boundaries intact:

1. Confirm you are in the exact account that owns the gateway.
2. Identify the receipt-owned Ankka Access applications and reusable policies;
   do not select resources by a similar display name alone.
3. Preserve the fixed gateway administrators and review each source audience
   explicitly. Joining the team must not imply access to every source.
4. Keep an unassigned source default-deny. Do not replace an empty audience with
   an Allow-everyone or Bypass policy.
5. Do not change the Portal's shared tool allowlists or upstream authentication
   while performing a membership-only change.
6. Verify one intended identity and one denied identity with harmless read-only
   calls. Hiding a tool from a list is not enforcement proof.

The gateway checks membership at the displayed observation time. It cannot
promise continuously fresh state or represent the effective permissions of an
already-connected client.

<a id="named-teams"></a>

## Named teams

A team is a name, the people on it, and the connectors it grants. Saving a team
does not replace anyone's direct connector grants. Effective access is the
combination of those direct grants and every team that includes both that
person and the connector. Removing someone from one team leaves their direct
grants and their other teams in place. Existing installations are not
converted: direct grants stay until you choose **Move covered direct grants
into this team**, which drops only the direct grants that team already covers.
The page shows the draft before you save, and effective access does not change.

**All installed connectors** selects every connector installed now. A connector
you add later stays closed until you add it to the team. There is no wildcard.

A team with no members has no Cloudflare Access group and appears on no policy.
The first member creates one group. Its provider name is
`ankka-<installation id>-<team id>`, not the name you see in the gateway.
Renaming a team does not call Cloudflare. Groups are never chosen by display
name. A group whose id, stable name, account, or include rules do not match is
drift.

The Portal policy includes a group for every team that has members, so a later
membership edit updates that one group and does not rewrite the Portal or each
connector policy. Changing which connectors a team grants updates only the
policies whose audience changed. An empty audience stays a deny policy.

A team can include the Gateway Management connector. That grants the connector
the same way a direct assignment does. It does not make someone a dashboard
administrator. Administrators stay on the fixed administrator list. On every
request, the Worker reads the team's group from Cloudflare. It accepts only a
group this gateway created for one of its teams, with its stable name; any
other group on that connector's policy is drift. Built-in API connectors are
checked the same way.

Creating, updating, and deleting a group is journaled like a policy write.
If a create response is lost, resume lists groups and adopts the one exact
stable name. Policy updates finish before a group is deleted.

Group writes need Access group permission in your Cloudflare account. The
[management token template](MANAGEMENT_TOKEN.md#the-template-link) does not
request it. A refused group call is `team_access_group_permission_missing`.
Apps and Policies Edit does not include that permission. See
[Customer-owned management credential](MANAGEMENT_TOKEN.md). Cloudflare refuses
the call before changing anything, and group writes come before policy writes,
so no policy has changed. Add the permission to the same token and resume the
recorded change, or cancel it.

Removing a connector drops it from every team; the team and its group stay.
Removing the gateway does not delete team groups, so it waits until no team has
members. Delete your teams on the Team page first; that removes their groups
from each policy and then deletes the groups. Until then, removal is refused
with `teardown_teams_present` before anything is recorded or deleted.

A membership change still does not end an existing Portal session by itself.
Use [Session and acceptance limits](#revocation-and-acceptance) when someone
must lose access immediately.

<a id="recovery-and-lifecycle-limits"></a>

## Recovery and lifecycle limits

Keep original receipts and pending write journals. Resume only the exact
recorded change after restoring the token or reconciling unexpected provider
state. An ambiguous write is not undone by revoking its credential. Lifecycle
floors continue to block incompatible rollback and legacy removal paths.

Each save attempt has a 60-second provider deadline. Every ownership check reads
the application list and the Portal together; policy writes remain serial, are
recorded before sending, and are checked before and after. A retry verifies the
complete policy graph, skips policies already confirmed at the recorded target,
and checks the complete graph again before completing. Saving Team access does
not download a source's MCP tool catalogue.

The retired `ANKKA_TEAM_MANAGEMENT_TOKEN` binding is not reused. Revoke any old
preview token and remove its binding. See [Upgrade boundary](TEAM_UPGRADE.md)
for the new contract and fresh-install requirement.

<a id="revocation-and-acceptance"></a>

## Session and acceptance limits

An Access policy change is not a promise that every existing session terminates
immediately. Test a fresh session and an already-connected session over a
bounded observation window, and report the delay observed. Application-token
revocation and user revocation have broader effects and are not substitutes for
a narrowly reviewed person/source policy change.

Keep real identities, account and policy IDs, source results, authorization
URLs, and credentials out of repository fixtures and support evidence.
