# Gateway Management source

[Agent-authored API sources](../apps/api-source-runtime/README.md) are built into
the gateway release. Gateway Management always includes connection discovery,
draft, test, activate, disable and discard tools. The runtime shares the gateway
Worker and storage; no opt-in flag or separate service deployment is required.
Ordinary management authorization and explicit tool selection still apply.

Gateway Management exposes fixed gateway operations through the team's existing
Cloudflare MCP Portal. Add it in **Sources**, install the draft, and assign it in
**Team** like any other source. The person who adds it receives the initial
assignment. Other people receive no management access until explicitly assigned.
There is no additional MCP administrator role. Dashboard access is a separate
explicit grant in Team. Source assignment alone cannot grant or revoke dashboard
access; see [Team access](TEAM_ACCESS.md).

Source code can be ahead of the signed release in your account. This implementation
has synthetic provider tests; it still requires deployed Cloudflare qualification.

## Operations and consent

The source exposes status, URL-source discovery and installation, tool selection,
editing the allowlist of an installed connector, renaming an installed connector,
source removal, Team assignments,
source OAuth diagnostics, signed update and rollback review and consent handoffs.
`get_installed_source_tools`, `update_installed_source_tools`, and `rename_installed_source` use the same
handlers as Edit tools and Save name. They appear in an agent’s tool list only after the
installed Gateway Management allowlist includes them. The dashboard can edit
tools or rename a connector without that allowlist entry. The source calls the same handlers, ownership
checks, revision checks, action journals, and recovery rules as the dashboard.
`list_gateway_feedback` and `resolve_gateway_feedback` read and triage the reports
that sessions file through the built-in [feedback source](GATEWAY_FEEDBACK.md).
It has no arbitrary HTTP, Cloudflare API, shell, account-selection, or credential
input tool. Connector-specific provisioning, including BigQuery setup, continues
to use its existing dashboard workflow.

Shared management calls use the connected operator's identity; action records
therefore identify that operator, not the individual Portal caller. Browser
handoffs still authenticate the person completing the operation and enforce the
recorded actor binding. If that operation needs the connected operator's consent,
that operator must finish the handoff. Granting or revoking dashboard access is
always refused through the shared MCP connection, including indirect removal of
a dashboard administrator. Use the authenticated dashboard for those changes.

Provider sign-in remains a browser step. `authorize_mcp_source` returns a customer
gateway URL. Opening it and selecting **Continue to provider** starts the existing
PKCE flow. The code exchange and credential import run in the team's Worker and
Cloudflare account. Agents then read the recorded action, select actual synced
tools, and resume that action. A handoff is not successful authorization.
For Meta Ads, the browser handoff links to Connectors so you can enter your
public Meta App ID and configure the displayed callback before consent.

Update and rollback require the exact reviewed release and artifact digest.
Preparation persists a bounded action. With a management token that has the
Workers Editor role, the gateway then runs the operation itself and answers
`running` with the attempt; otherwise it returns the existing customer-hosted
consent handoff and does not execute a deployment. Either way the existing
operation driver performs the upload; see
[Updates without a browser](UPDATES.md#updates-without-a-browser).
`get_gateway_runtime_action` also returns `servingRelease` and
`journalPending`. `journalPending: true` means the target release already serves
and only the gateway's record of it is still `applying`; poll until `succeeded`
rather than retrying the update.

Full gateway removal continues through the dashboard. Removing the management
source's Access application during teardown would cut off an assigned person's
browser progress page before the final cleanup handoff. A future extension must
preserve that consent-bound progress route through removal without retaining
ordinary MCP authority after source revocation.

## Access boundary

The built-in source has reserved ID `source-616e6b6b616d6370` and endpoint
`https://<management-hostname>/api/mcp`. The `/api/` prefix uses the signed
deployment’s existing Worker-first routing, including browser consent pages.
Cloudflare uses two receipt-owned Access applications: a Portal source application
with only its MCP server destination, and a self-hosted application with Managed
OAuth covering `/api/mcp` and the existing customer operation consent paths.
Cloudflare rejects path destinations on MCP applications and rejects Portal
destinations on self-hosted applications. Team assignments synchronize both
policies through the existing journal; the UI still presents one source.

New installations use one operator OAuth connection, registered in the Portal
with `on_behalf: false`, like ordinary upstream OAuth sources. Cloudflare's Portal
source policy enforces Team membership before using that connection. The Worker
verifies the operator's signed Access assertion for the exact source audience;
it accepts the original connector operator and dashboard administrators, not
personal tokens belonging to ordinary Portal members. An operator credential
continues to authorize upstream calls independently of that operator's Portal
assignment, just as for an ordinary shared upstream connection. Credentials stay
in the team's Cloudflare account. Removing the source revokes its endpoint.

Older installations retain `on_behalf: true` until a dashboard administrator
selects **Use shared connection** under Gateway Management in Sources. This
one-way migration reuses the recoverable Portal edit journal, preserves every
Team assignment, policy, tool selection and override, and updates ownership
receipts atomically. A lost response is recovered by reading back the exact
Portal mapping. It raises the minimum compatible runtime before changing the
mapping. If the operator credential needs renewal, use **Reconnect** afterwards.
New drafts use shared mode; unfinished older installations keep their recorded
mode until completed and migrated.
Managed OAuth must allow the gateway’s `/__ankka/source-oauth/callback` and
`/api/mcp/oauth/callback` URLs, the shared Cloudflare callback, and the exact
Cloudflare dashboard callback for this account and server. New apps include these
callbacks automatically. The dashboard uses
`https://dash.cloudflare.com/<account-id>/one/access-controls/ai-controls/mcp-server/oauth-callback/<server-id>`
for the initial administrator sign-in, even when the shared callback is enabled.
A missing entry returns `invalid_request` with “Redirect URI not allowed by
application configuration.” The callback is scoped to the owned server; no
wildcard dashboard callback is needed.
The dashboard's administrator policy remains a separate recovery entry point.
The endpoint's authentication policy retains the installation's original audience
so administrators can complete browser recovery consent after unassigning
themselves. For legacy individual connections and interactive browser handoffs, the Worker
also requires the visitor's current source assignment. Shared MCP calls run as
the connected operator; Cloudflare enforces the calling person's Team access.

On each MCP request the Worker reconstructs the source from ownership receipts,
reads both live Access applications and their sole policies, and verifies the signed
Access assertion against the self-hosted application's audience. Issuer, signature, expiry,
email, and the appropriate operator or individual access boundary must match. Membership is not cached.
A [named team](TEAM_ACCESS.md#named-teams) assigns the source through a group
rule on both policies. The Worker reads that group on each request and accepts it
only when it is a group this gateway created for one of its teams, with its
stable name.
Service identities, an administrator token for a different audience, an identity outside the applicable operator or individual audience, a missing assertion, and changed resource shapes are rejected. Calling
the Worker directly does not bypass this check. Authenticated `tools/list` returns the available management catalogue, including
tools that are not selected. Stored tool allowlists constrain `tools/call`,
including calls made directly to the Worker. Cloudflare's Portal mapping also
keeps unselected tools disabled. Discovery does not grant execution permission.

After a gateway upgrade adds tools, open **Edit tools** in Ankka. Gateway
Management's catalogue comes directly from the installed release, so it does not
require a separate Cloudflare capability sync. Select **Check again** if the
editor was already open. New tools appear unchecked in manual mode.
The explicit All tools option (`allTools: true`) also allows future tools and
MCP prompts; `allTools: false` returns to the named selection. Native management
and API source execution honor the saved mode, while preserving actor and
upstream permission checks. Saving your exact selection
syncs the receipt-owned Cloudflare server when its catalogue is stale, verifies
the refreshed list, then updates the allowlist and Portal mapping. Team
assignments do not change. If Cloudflare is still syncing, permissions remain
unchanged; wait a moment and save the same selection again in Ankka. An expired
provider connection still requires reauthentication.

During installation only protocol initialization and tool discovery can use the
receipt-owned paused draft. Tool execution requires a completed installation.
Completed action journal eviction does not revoke a valid ownership receipt.
Removing the source stops management access, including access by its initial
assignee. The configured dashboard administrators can recover or reinstall it.

Assigning the full management tool list gives someone authority to change Team
assignments, including who else manages the gateway. This is a management
capability; it does not expand the read-only boundary of ordinary data sources.
Tool names and descriptions are not authority. Backend checks remain decisive.

Routine operations use `ANKKA_MANAGEMENT_TOKEN` only inside the customer's Worker.
Its account-wide provider authority and fixed operation constraints remain as
documented in [Management token](MANAGEMENT_TOKEN.md). Adding this source does
not introduce a new credential, role system, hosted relay, or telemetry stream.

## Debugging source authorization

For agent authentication, CLI commands and edge failures, start with
[Diagnostic access for agents](#diagnostic-access-for-agents) below.

1. Read `list_mcp_sources` and `list_mcp_source_actions` to identify the saved
   source, its revision, and the unfinished action.
2. Call `diagnose_mcp_source` with that source ID. Diagnostics retain a fixed
   stage, status, HTTP status when available, and observation time. Discovery,
   dynamic client registration, token exchange and provider permission check
   failures are distinguishable. Gateway refusals also carry a fixed `reason`;
   without a more specific one, it is the refusal code, such as
   `source_oauth_scope_unsupported` or `source_oauth_unavailable`, under stage
   `authorization_start` or `authorization_callback`.
   Token exchange failures may also include `oauthError`, restricted to standard
   OAuth error codes such as `invalid_grant` or `invalid_client`. Provider error
   descriptions and unrecognized codes are discarded.
3. Start or retry provider sign-in using the browser handoff. Do not replay a
   provider write with an unknown outcome; follow the recorded recovery action.
4. Read the action and real tool list, choose the intended tools, and resume.

An interrupted built-in management application creation with no returned ID can
be retried after the previous authorization expires. Recovery first requires a
successful account-wide application listing and exact ownership checks. An
unavailable listing, conflicting application, or changed resource leaves the
journal intact and does not trigger another creation.

Diagnostics never include authorization codes, access or refresh tokens, client
secrets, raw provider bodies, or arbitrary error messages. Missing older evidence
is reported as unknown. These diagnostics help locate the failure; they do not
by themselves establish its cause or fix an incompatible provider.

## Diagnostic access for agents

There are two separate APIs. Use each for the evidence it owns:

| Interface | Evidence | Authentication |
| --- | --- | --- |
| Cloudflare account API through `cf` | Access app configuration, MCP connection and sync status, Portal mappings, Access login events | The CLI's existing Cloudflare credentials and their permissions |
| Gateway Management MCP at `https://<management-hostname>/api/mcp` | Saved sources, actions and the sanitized OAuth diagnostic in the gateway's Durable Object | Access identity for the Management source, current assignment/operator checks and enabled tools |

Account API access does not authenticate gateway requests or expose its Durable
Object records. Do not send a Cloudflare API token or `ANKKA_MANAGEMENT_TOKEN`
as a gateway client credential. Prefer an already connected Management MCP client;
otherwise use the authenticated HTTP recipe below.

### Read provider state with the CLI

If `cf` is absent from PATH, locate the installed executable and existing
authentication setup, including the local npm cache, before falling back to UI.
Keep that machine-specific path outside this repository. Discover commands with
anonymous queries such as `cf cli search 'get MCP server details'`, then inspect
the selected command's `--help` and `cf schema` before unfamiliar operations.

Existing commands include:

```sh
cf mcp servers list --per-page 100
cf mcp servers read '<server-id>'
cf zero-trust access applications get '<application-id>'
```

Select the server by its exact source URL, not just its display name. Read
`authentication_status`, `status`, `error_details`, `modified_at`, `last_synced`
and `last_successful_sync`; absent fields are unknown. Do not substitute guessed
field names such as `updated_at` or `last_sync`. Select only relevant fields for
output; do not dump credentials, identities, IP addresses or complete provider
responses into logs or public artifacts. Read saved tool approvals and Portal
mappings when checking whether sync or permission drift explains the failure.

An Access login event with `allowed: true` proves only that Access admitted the
login. It does not prove provider consent, callback processing, token exchange,
credential import or successful MCP sync. Record event times with their timezone.

### Read the gateway diagnostic without exposing a session token

The deployed Management source must be installed and permit `list_mcp_sources`
and `diagnose_mcp_source` for your identity. A dashboard session for a different
Access audience is insufficient. Use the source ID returned by
`list_mcp_sources`; the Cloudflare server ID is a different identifier.

Use an existing `cloudflared` session for the exact Management endpoint. If one
is unavailable, this standard login opens the browser and keeps the JWT out of
terminal output:

```sh
cloudflared access login --quiet --auto-close --app 'https://manage.example.com/api/mcp'
```

The following read-only example captures the cached token in memory. Substitute
your trusted gateway origin and saved source ID. Never run the token command
by itself, enable shell tracing, print request headers, or follow redirects
with credentials attached.
To look up the source ID first, use the same authenticated request with tool
name `list_mcp_sources` and empty `arguments`, then select the source by URL.

```sh
GATEWAY_ORIGIN='https://manage.example.com' SOURCE_ID='source-0123456789abcdef' python3 - <<'PY'
import json, os, subprocess, urllib.error, urllib.request

origin = os.environ['GATEWAY_ORIGIN'].rstrip('/')
endpoint = origin + '/api/mcp'
session = subprocess.run(
    ['cloudflared', 'access', 'token', '--app', endpoint],
    capture_output=True, text=True, timeout=30,
)
if session.returncode or session.stdout.strip().count('.') != 2:
    raise SystemExit('Access login required; no diagnostic request sent')

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

request = urllib.request.Request(endpoint, data=json.dumps({
    'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
    'params': {'name': 'diagnose_mcp_source',
               'arguments': {'sourceId': os.environ['SOURCE_ID']}},
}).encode(), headers={
    'Content-Type': 'application/json', 'Accept': 'application/json',
    'Origin': origin, 'Cookie': 'CF_Authorization=' + session.stdout.strip(),
})
try:
    response = urllib.request.build_opener(NoRedirect()).open(request, timeout=20)
except urllib.error.HTTPError as failure:
    response = failure
print('HTTP status:', response.status)
if 'application/json' not in response.headers.get('content-type', ''):
    raise SystemExit('Non-JSON response; inspect authentication before retrying')
body = json.load(response)
if response.status != 200 or 'error' in body:
    # Fixed codes only; do not print arbitrary edge or provider response bodies.
    print(json.dumps({key: body.get(key) for key in ('error_code', 'error_name')}))
    error = body.get('error')
    print('Gateway/MCP error:', error.get('code') if isinstance(error, dict) else error)
    raise SystemExit(1)
rpc_result = body.get('result', {})
if rpc_result.get('isError') or 'structuredContent' not in rpc_result:
    raise SystemExit('MCP tool failed or returned no structured diagnostic')
result = rpc_result['structuredContent']
diagnostic = result.get('result', result)
print(json.dumps({'authorization': diagnostic.get('authorization'),
                  'status': diagnostic.get('status')}, indent=2))
PY
```

This is a cached **human Access session**, not unattended service-token access.
The existing `ANKKA_SERVICE_CLIENT_ID` support permits only its fixed management
REST routes; it does not currently include diagnostics, and Management MCP
rejects service identities. Creating a service token alone will not enable this
recipe. See [agent lifecycle credentials](AGENT_LIFECYCLE.md#credentials) for
the existing service-identity boundary.

### Identify the rejecting layer before retrying

| Observation | Meaning and next step |
| --- | --- |
| HTTP 403, Cloudflare error 1010 / `browser_signature_banned` | Browser Integrity Check rejected the client before the Worker. Changing Access credentials will not fix that layer. |
| Access login redirect or authentication challenge | Establish the correct endpoint's Access session; do not follow redirects with credentials. |
| Gateway refusal or MCP tool error | Check source installation, audience, assignment and tool selection; account API permissions do not replace them. |
| Provider consent reports an invalid nonce | Failure is on the provider consent endpoint. Do not replay the consent URL; a fresh attempt in the same browser can distinguish an old session from a recurring issue. |
| Gateway reports authorization failure; diagnostic says `authorization_callback` | Use the fixed `reason` when present, such as `attempt_expired`, `attempt_mismatch`, `issuer_mismatch` or `source_changed`, or a refusal code: `source_oauth_scope_unsupported` for a refused scope, `source_oauth_unavailable` typically when the gateway could not re-read or match the Cloudflare source record. Older releases record only this broad stage, which cannot establish the cause. |
| Diagnostic says `permission_check` | With reason `scope_unsupported`, the provider's permission read succeeded but the grant was refused; see [Meta Ads](META_ADS.md). Without a reason, the permission read itself failed; inspect the HTTP status. |
| Diagnostic says `token_response` | The exchange returned HTTP 200, but a credential field failed validation. The fixed `reason` names the field without retaining its value. |
| Diagnostic says `credential_import` with `provider_rejected` | Cloudflare rejected or did not confirm credential import; inspect the recorded HTTP status before retrying. |
| Diagnostic says `token_exchange` | Use its HTTP status and standard `oauthError`, when recorded, to investigate the exchange. Never retain raw token responses. |
| Provider still reports `stale` / `Preemptively needs reauth` | Cloudflare still requires authorization; this is not merely stale dashboard text. Compare the latest diagnostic and sync times before retrying. |

For an operator-authorized API compatibility change, Cloudflare supports a
configuration rule in the zone's `http_config_settings` phase with action
`set_config` and `action_parameters: {"bic": false}`. Limit its expression to
the management hostname, exact `/api/mcp` path and `POST` method. Inspect existing
rules first and preserve unrelated settings. Keep Access authentication, tool
authorization and other protections enabled; do not disable BIC zone-wide or
spoof a browser identity as the operational fix.

After applying a rule through `cf`, read it back, verify an authenticated
diagnostic succeeds and verify an unauthenticated request is still rejected.
This rule is an account configuration choice, not automatically installed by
the gateway. If propagation is uncertain, use bounded backoff; repeated identical
1010 responses are not evidence of a gateway callback failure.

References: [Cloudflare error 1010](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/),
[Browser Integrity Check](https://developers.cloudflare.com/waf/tools/browser-integrity-check/),
[configuration rules API](https://developers.cloudflare.com/rules/configuration-rules/create-api/),
and [agent authentication](https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/).

## Release qualification

The local regression suite covers assignment and revocation with real signed
synthetic JWTs, wrong audiences, origin rejection, tool allowlists, source
installation/removal, browser consent, diagnostic redaction, and consent handoff
preparation. The runtime suite exercises production state and crypto in workerd.

Before declaring the integration ready in a deployed gateway, verify the actual
Portal's shared operator OAuth flow (including refresh), Team grant/revocation enforcement and source app assertion forwarding, tool sync
while installation is paused, direct-origin rejection, a non-administrator's
assignment and revocation, provider consent return, and lifecycle consent return.
These checks need the target team's Cloudflare account and signed release. A
passing local suite is not evidence that those provider behaviors were observed.
