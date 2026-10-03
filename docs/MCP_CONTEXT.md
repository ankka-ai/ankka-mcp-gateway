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
