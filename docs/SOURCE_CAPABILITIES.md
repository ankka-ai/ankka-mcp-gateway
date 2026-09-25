# Read and edit access

Connected MCP servers can expose read and edit tools through the gateway. In
**Sources**, connect the server, review its actual tool list, and select the
tools your team needs. For an installed source, use **Edit tools**. Saving the
selection updates the exact Cloudflare allowlist. Newly discovered tools remain
disabled until selected; a gateway update does not expand tool selections or
provider permissions.

An edit tool also needs permission at the provider. Authorize only the operations
and records you intend to share. Existing read-only grants and dedicated read-only
endpoints cannot acquire write authority merely by selecting another tool.
Provider credentials remain in your Cloudflare account.

## Who can edit

Everyone assigned to a source can use its entire selected tool list. Ordinary
OAuth sources use the operator's shared upstream connection. A tool selection is
shared across those people; Team access does not offer a separate reader/editor
role. Use separate source endpoints and appropriately scoped upstream identities
when different people need different authority. Per-user upstream authentication,
where supported, still relies on that provider to enforce each identity's access.

There is no extra gateway approval for each call. Tool names, descriptions,
`readOnlyHint`, and `destructiveHint` are source-authored review aids. An edit tool
may create, update, delete, or trigger other effects depending on its provider
implementation; selecting it does not mean the gateway limits it to updates.

## Configuration and compatibility

Declarative configuration accepts `policy.capabilityMode: "read_only"` and
`"read_write"`. Use `read_write` when your exact `enabledTools` list includes
edits. Existing `read_only` configuration remains valid and retains its previous
plan hashes. Both modes require exact names and reject wildcard tool selection.
The mode records the intended source capability; it does not inspect tool
arguments or prove that a tool is read-only. Enforce read-only intent with
upstream credentials or a dedicated read-only endpoint.

The dashboard runtime and new installer plans advertise `read_write` support.
This describes what connected MCP servers may expose, not the permissions of
every installed source. Legacy saved status is accepted, and reading it does not
rewrite it. Hosted installation resource hashes retain their historical
`read_only` labels so updates, ownership verification, recovery, and removal
continue to recognize existing receipts. These labels are not sent to Cloudflare
as authorization controls. The actual Cloudflare policy remains default-deny
with exactly the selected tools enabled.

Agent-authored API connectors, BigQuery and other dedicated readers, and
provider-specific read-only OAuth recipes retain their existing restrictions.
Read-only catalog recommendations remain read-only recommendations; allowing
generic MCP edits does not qualify a provider integration or broaden its scopes.

## Operation risks and verification

An agent mistake or malicious tool response can lead to an unwanted edit when
the caller has permission. The boundary is the assigned source, exact tool
selection, and provider-enforced authority. Review the actual operation and its
arguments against a synthetic or disposable provider account before enabling it
for your team. Verify that unselected tools and unauthorized records are denied.

A timeout or lost response does not establish that an edit failed. The gateway
does not add business-operation retries, rollback, or an exactly-once guarantee
to upstream calls. Check the provider's state before retrying an uncertain write;
use the provider's idempotency support when available. Gateway configuration
journals govern management changes, not arbitrary business-tool effects.

Local tests verify configuration acceptance, exact tool selection, unchanged
assignments, status compatibility, and disabled unselected tools using synthetic
providers. They do not establish a real provider's write behavior or a deployed
Cloudflare integration. No production source grant is changed by this code change.
