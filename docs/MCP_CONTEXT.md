# MCP context choices

Use this guide to decide where to put information that helps an LLM choose the
right source, call its tools, and interpret the results. Keep company and service
coverage short and visible before discovery; load detailed definitions and
workflows when needed.

The LLM client decides what enters the model's context. A dashboard field is not
proof that the model receives it. Support below describes repository code and
provider documentation as of 2026-10-03, not every installed release or client.
Company examples are synthetic.

## Choose the context for the task

| Context | Who controls it and current support | Use it for |
| --- | --- | --- |
| **Gateway name** | Your gateway operator sets `gateway.name`, the Cloudflare Portal name. The person connecting may choose a separate client label. | Human identification: **Company B Marketing**. Model visibility depends on the client; do not rely on this name alone. |
| **Connected MCP name** | Your gateway operator supplies a source `label` and optional `company`. Ankka combines them in Cloudflare's display name, separately from its stable ID. | **Company B · Google Search Console**. Verify whether initial Code Mode descriptions include these names in each supported client. |
| **Tool name** | The upstream supplies the original name. Cloudflare supports aliases; Ankka's installed-tool editor supports them. | Make an operation recognisable, such as `search_performance_by_page`. Aliases change exposed names; original names remain the allowlist keys. |
| **Tool description** | The upstream supplies a description. Your gateway operator can override it in the same editor. | Explain when to use the tool, company/property scope, returned data and limitations. Example: organic clicks and impressions, with no sales attribution. |
| **Gateway description and instructions** | Cloudflare's portal description and MCP server instructions are distinct. Ankka has no business-summary delivery feature yet. | Companies and services available before discovery. Verify delivery to the model; a dashboard description alone is insufficient. |
| **Code Mode snippets or recipes** | Cloudflare's durable Code Mode SDK supports snippets, separately from managed MCP Portals. Ankka has no general saved-query library. | Reuse tested SQL or JavaScript, with explicit company, dates and other parameters. |
| **Skill files** | Your team can install a skill pack in a supporting client. Automatic delivery alongside gateway setup is a proposed integration. | Teach a multi-step process, such as investigating an organic-traffic decline. An MCP connection alone does not universally install or activate skills. |
| **Input and output schemas** | The upstream tool implementation defines them. Ankka's metadata editor does not change schemas. | Specify required arguments, allowed values and result structure. Put date formats and parameter meaning next to the relevant fields. |
| **Business knowledge and MCP resources** | Your team maintains the content. Cloudflare fetches resource listings from upstreams; clients decide how to use them. | Metrics, table relationships, timezones, freshness and known gaps. Retrieve relevant documents instead of repeating a full data dictionary in tool descriptions. |
| **MCP prompt templates** | Upstreams can expose parameterized prompts; Cloudflare supports selecting and renaming them. Client presentation varies. | Offer a starter request such as a weekly marketing review. Prompts are generally selected by a person, not automatically applied as standing instructions. |

See [Customize installed tools](TOOL_METADATA.md) for the existing name and
description editor. The declarative installation config still selects original
tool names; it does not declare those overrides.

## What the model sees and when

1. **Before choosing a source:** initial tool definitions and any supported server
   instructions should identify company and service scope.
2. **During discovery:** normal tools expose individual definitions; Code Mode
   exposes search and execute, then retrieves relevant upstream definitions.
   A company name buried only in an underlying tool description cannot help
   choose the gateway before that first search.
3. **During analysis:** retrieve relevant knowledge, recipes or skills. Results
   should identify period, currency, freshness, pagination and limitations.

Some clients also defer tool loading. Verify the actual model context. See
[Large sources and Code Mode](LARGE_SOURCES_AND_CODE_MODE.md).

## Company context

Set **Company (optional)** when adding a custom/catalog connector or BigQuery,
or expand an installed connector and choose **Save details**. For example,
`company: "Company B"` and `label: "Google Search Console"` produce the discovery
name **Company B · Google Search Console**. The underlying tool descriptions
begin with `Company: "Company B".` followed by their custom or upstream text.
Blank leaves an unscoped connector as it was; clearing an existing Company
removes the generated context and preserves explicit tool overrides.

The name is written to the Cloudflare MCP server so it can appear in the
Portal's initial Code Mode connected-server list, before a tool search.
Reconnect your client after saving and inspect its actual initial definitions.
Local tests cover the provider payloads, independent company mappings and
restart recovery; they do not prove live model routing in every client.
A source serving several companies must describe its real scope. Stable IDs,
original tool names, schemas, allowlists and permissions stay unchanged.
See [the storage and API contract](TOOL_METADATA.md#company-context).

A desired initial summary might be:

> Company B marketing data: Google Search Console, Google Ads and Meta Ads.
> Search this gateway for tools covering Company B's websites and campaigns.

This is proposed content, not a supported config field. Ankka uses the provider
portal description for ownership tracking; a business summary needs its own field.

## Keep recipes and skills separate

A **recipe** implements a calculation, such as comparing two periods and returning
the largest declines. Discover its description before loading its code. A saved
example still needs validation and parameters to become a reusable tool.

A **skill** explains an investigation: check freshness, examine drivers, validate
findings and state limitations. Supporting clients load its name and description
first, then detailed instructions when selected.

Our API source runtime reuses a Code Mode executor but does not enable the durable
runtime's general snippet/history storage. See its
[runtime relationship](../apps/api-source-runtime/README.md#relationship-to-durable-code-mode).

## Check whether the context works

Connect synthetic Company A GSC directly and Company B GSC through the gateway.
Ask for Company B's most-clicked site in a fixed week. Check:

- Whether company and service scope are visible before the first search.
- Whether the model first selects Company B's gateway and queries no Company A data.
- Whether discovered tools and results retain the correct company and property.
- Whether an ambiguous company request gets clarification instead of a guess.

Repeat in both modes and supported clients after refreshing cached definitions.
Measure routing accuracy separately from answer accuracy, latency and tokens.
Descriptions guide selection; upstream permissions and allowlists enforce access.

Sessions can report what did not work through the built-in
[feedback source](GATEWAY_FEEDBACK.md); open reports are a good starting point
for the next description pass.

## When an upstream changes its tools

The saved tool list records what your team approved. Cloudflare's synced
catalogue records what a source currently offers. Removing or renaming an
upstream tool must not invalidate Team access: existing approved tools keep
working, and newly discovered names remain disabled until selected.

Team reads, Team changes, connection checks and reconnects tolerate missing
tool mappings, including during an upstream outage. They still verify the
owned Portal and servers, default-disabled behavior, connection routing and
every exposed tool's approval and metadata. They do not rewrite tool mappings.

Subsequent Portal writes omit removed tools only when a valid, ready catalogue
confirms their absence. They retain saved approvals and custom metadata. An
unavailable, stale or malformed catalogue does not count as an empty catalogue.
A tool still offered upstream but disabled outside Ankka is not silently
re-enabled. Explicit tool selections must be applied in full; newly selected
tools cannot be silently dropped as unavailable.

There are two separate refresh steps:

1. **Source to Cloudflare:** Cloudflare documents background synchronization
   approximately every two hours for DCR servers. **Check connections** requests
   an immediate sync for eligible shared connections. New tools stay disabled;
   no upstream credential passes through Ankka. See
   [Cloudflare's synchronization behavior](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#synchronize-the-mcp-server).
2. **Cloudflare to the connected client:** ordinary MCP sessions terminate at
   Cloudflare's Portal. Its advertised `tools.listChanged` capability permits
   tool-list notifications, which supporting clients use to fetch updated
   definitions. Advertising the capability alone does not prove delivery for
   every catalogue change or that a client refreshes its model context.
   [MCP's notification contract](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture)
   depends on the negotiated protocol and is best effort. Refresh or reconnect
   clients that retain old definitions. Ankka does not add a second MCP proxy.

To verify propagation, use a disposable source with two connected clients.
Remove one approved tool, add an unapproved tool, then sync the source. Confirm
Team still loads, remaining tools execute, the removed tool disappears from
`tools/list`, and the new tool stays hidden. Record notification receipt and
the next `tools/list` response for both clients, in normal and Code Mode.
Test a client that ignores notifications separately. Local regression tests
prove the management behavior; they do not prove end-to-end notification
delivery. Do not replay a failed write tool automatically after a refresh.

Keep company-specific definitions, examples, recipes and results in your
Cloudflare account or your team's chosen client storage. This public repository
contains only generic guidance and synthetic fixtures.

## References

- [Cloudflare Portal names and descriptions](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/ai_controls/subresources/mcp/subresources/portals/methods/update/)
- [Cloudflare source names and descriptions](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/ai_controls/subresources/mcp/subresources/servers/methods/update/)
- [Cloudflare tool aliases and descriptions](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#rename-tools-and-prompts-with-aliases)
- [Cloudflare resource discovery](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#synchronize-the-mcp-server)
- [MCP server instructions](https://modelcontextprotocol.io/specification/2026-07-28/schema#discoverresult-instructions)
- [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources), and [prompts](https://modelcontextprotocol.io/specification/2026-07-28/server/prompts)
- [Cloudflare durable Code Mode runtime](https://developers.cloudflare.com/agents/tools/codemode/durable-runtime/)
- [Agent Skills and progressive loading](https://agentskills.io/specification#progressive-disclosure)
