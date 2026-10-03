# Customize installed tools

In your gateway, open a connector, choose **Edit tools**, then expand
**Customize name and description** beneath a selected tool. Save the tools and
reconnect your LLM client to refresh its cached definitions.

Use short domain-specific names and descriptions that say when to use a tool,
what data it covers, and what it cannot establish. Preserve the distinction
between observed attribution and estimates. Business-specific descriptions
belong in your account-owned gateway state, not this public repository.

The gateway writes Cloudflare Portal `updated_tools` entries with the original
`name`, `enabled: true`, and optional `alias` and `description`. Original names
remain the allowlist keys. Aliases must be 1–40 characters, using letters,
numbers and single underscore or hyphen separators. They cannot collide with
another synced original name or alias, including after Code Mode sanitization.
Descriptions are limited here to 2,000 characters. Empty editor fields restore
the upstream values; **Reset to upstream values** clears both overrides.

The existing installed-tools API accepts optional `toolMetadata`, an array of
`{name, alias?, description?}` for selected original names. Omission preserves
overrides for tools that remain selected; `[]` clears them. The API reads back
both saved and pending metadata. A lost provider response resumes the same
selection and metadata before other changes can start. Full Portal updates
preserve the other managed connector mappings. Provider drift is refused.

Metadata stays in your Cloudflare account. It does not change credentials,
upstream permissions, tool schemas or Team assignments. Once metadata is saved,
the existing compatibility floor prevents rollback to a runtime that cannot
read that saved state. This editor applies to installed managed connectors;
the declarative installation configuration is unchanged.

Cloudflare reference: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/

## Company context

**Company (optional)** is available on custom/catalog and BigQuery setup forms
and in an installed connector's details. It accepts up to 80 characters without
surrounding whitespace or control characters. The discovery name becomes
`Company B · Google Search Console`; clearing Company restores the connector
name. Team’s connector pickers show the company-qualified name too. Renaming
a connector also updates its Cloudflare MCP server name.

For each allowed tool, Ankka prepends `Company: "Company B".` to the explicit
custom description, or to a snapshot of the full upstream description. This
snapshot is separate from editable tool metadata, so changing Company cannot
accumulate prefixes or erase overrides. Resetting tool metadata still retains
Company context; clearing Company restores upstream description inheritance
where no explicit override exists. Snapshots are captured when Company is first
added and refreshed when an allowlist or tool-metadata edit is saved. Ordinary
no-op saves do not refresh upstream text.

`PUT /api/sources` accepts optional `source.company` on a draft.
`PUT /api/sources/:sourceId/label` accepts optional `company` alongside `label`
and the reviewed `revision`. Omission preserves an existing value; `""` clears
it. The management MCP and WebMCP tools expose the same optional field.
`GET /api/sources` returns Company but not the internal description snapshots.
The declarative installation configuration remains unchanged.

All context is stored in your Cloudflare account. Description snapshots are
bounded to 65,536 characters per selected tool and the existing 1 MiB source-state
limit. Oversized context is refused rather than silently truncated. The existing
2,000-character limit for operator-authored overrides still applies. Changes
use the existing source-edit journal, verify owned provider resources and their
readback, and resume after an uncertain write or restart. Other connector
mappings, ownership markers, tool selections and Team grants are preserved.

Company is routing guidance, not an access boundary. Cloudflare and the client
control what reaches the model. Reconnect and inspect the initial Code Mode
tool definitions before relying on pre-search routing. The local synthetic
checks cover provider payloads and recovery, not live client routing accuracy.
