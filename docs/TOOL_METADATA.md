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
