# Gateway Management source

Gateway Management exposes fixed gateway operations through the team's existing
Cloudflare MCP Portal. Add it in **Sources**, install the draft, and assign it in
**Team** like any other source. The person who adds it receives the initial
assignment. Other people receive no management access until explicitly assigned.
There is no additional MCP administrator role.

Source code can be ahead of the signed release in your account. This implementation
has synthetic provider tests; it still requires deployed Cloudflare qualification.

## Operations and consent

The source exposes status, URL-source discovery and installation, tool selection,
source removal, Team assignments, source OAuth diagnostics, signed update and
rollback review and consent handoffs. It calls the same handlers, ownership
checks, revision checks, action journals, and recovery rules as the dashboard.
It has no arbitrary HTTP, Cloudflare API, shell, account-selection, or credential
input tool. Connector-specific provisioning, including BigQuery setup, continues
to use its existing dashboard workflow.

Provider sign-in remains a browser step. `authorize_mcp_source` returns a customer
gateway URL. Opening it and selecting **Continue to provider** starts the existing
PKCE flow. The code exchange and credential import run in the team's Worker and
Cloudflare account. Agents then read the recorded action, select actual synced
tools, and resume that action. A handoff is not successful authorization.

Update and rollback require the exact reviewed release and artifact digest.
Preparation persists a bounded action and returns the existing customer-hosted
consent handoff. It does not execute a deployment.
Cloudflare authorization and the existing operation driver perform that work.

Full gateway removal continues through the dashboard. Removing the management
source's Access application during teardown would cut off an assigned person's
browser progress page before the final cleanup handoff. A future extension must
preserve that consent-bound progress route through removal without retaining
ordinary MCP authority after source revocation.

## Access boundary

The built-in source has reserved ID `source-616e6b6b616d6370` and endpoint
`https://<management-hostname>/mcp`. Its Access application covers `/mcp` and the
existing customer operation consent paths. Each person authenticates with their
own identity; this source is registered in the Portal with `on_behalf: true`.
Ordinary upstream OAuth sources retain their shared team connection behavior.
The dashboard's administrator policy remains a separate recovery entry point.

On each MCP request the Worker reconstructs the source from ownership receipts,
reads its live Access application and sole source policy, and verifies the signed
Access assertion against that application's audience. Issuer, signature, expiry,
email, and current source assignment must match. Membership is not cached.
Service identities, an administrator token for a different audience, an unassigned
identity, a missing assertion, and changed resource shapes are rejected. Calling
the Worker directly does not bypass this check. Stored tool allowlists constrain
both `tools/list` and `tools/call`.

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

1. Read `list_mcp_sources` and `list_mcp_source_actions` to identify the saved
   source, its revision, and the unfinished action.
2. Call `diagnose_mcp_source` with that source ID. Diagnostics retain a fixed
   stage, status, HTTP status when available, and observation time. Discovery,
   dynamic client registration, and token exchange failures are distinguishable.
3. Start or retry provider sign-in using the browser handoff. Do not replay a
   provider write with an unknown outcome; follow the recorded recovery action.
4. Read the action and real tool list, choose the intended tools, and resume.

Diagnostics never include authorization codes, access or refresh tokens, client
secrets, raw provider bodies, or arbitrary error messages. Missing older evidence
is reported as unknown. These diagnostics help locate the failure; they do not
by themselves establish its cause or fix an incompatible provider.

## Release qualification

The local regression suite covers assignment and revocation with real signed
synthetic JWTs, wrong audiences, origin rejection, tool allowlists, source
installation/removal, browser consent, diagnostic redaction, and consent handoff
preparation. The runtime suite exercises production state and crypto in workerd.

Before declaring the integration ready in a deployed gateway, verify the actual
Portal's per-person OAuth flow and source app assertion forwarding, tool sync
while installation is paused, direct-origin rejection, a non-administrator's
assignment and revocation, provider consent return, and lifecycle consent return.
These checks need the target team's Cloudflare account and signed release. A
passing local suite is not evidence that those provider behaviors were observed.
