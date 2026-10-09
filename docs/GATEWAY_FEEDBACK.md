# Gateway feedback

The people who notice a bad tool description, a missing capability or stale
data are usually in an LLM session at the time. Gateway feedback lets that
session file the report where the people who can fix it will read it, in a
fixed shape, without leaving the conversation.

The feedback source is built into the gateway release and installed like any
other connector. Reports stay in your Cloudflare account. Nothing is sent to
Ankka.

## Add the source

1. In **Sources**, choose **Add Gateway Feedback**. It saves a draft for the
   gateway's own `/api/feedback/mcp` endpoint with both tools below selected.
   Agents can do the same with `save_mcp_source_draft` and that URL.
2. Install the draft. Each person signs in with their own gateway identity, the
   same as for an agent-authored API source, so every report records who filed it.
3. Assign the source in **Team** to everyone who should be able to report and
   read feedback. A source owner's coding agent needs the same assignment to
   pull its own reports.

The source shows in the Portal's connected-server list under your Company
name, so an agent in Code Mode can find it before its first search.

## Tools on the feedback source

`submit_gateway_feedback` takes one required field, `message`: what the agent
or person was trying to do, what was tried and where it went wrong, up to
2,000 characters. The optional fields narrow triage:

| Field | Values |
| --- | --- |
| `sourceId` | An installed source ID. Refused when unknown. |
| `toolName` | The upstream tool name without the server prefix. |
| `category` | `wrong_description`, `missing_capability`, `wrong_or_stale_data`, `confusing_output`, `routing`, `tool_error`, `other` (default). |
| `severity` | `high` blocked, `medium` found a workaround (default), `low` minor annoyance. |
| `origin` | `human` when relaying what the person said, `agent` (default) for the agent's own observation. |
| `evidence` | The query or call, and what came back versus what was expected. Up to 4,000 characters. |
| `suggestedFix` | What would have made it work. Up to 2,000 characters. |

The tool description carries the filing rules: one problem per report, group
small related details, keep unrelated problems separate, and never include
credentials, tokens or personal data. The server's `initialize` instructions
repeat the short form for clients that pass them to the model.

`list_gateway_feedback` returns reports newest first, open ones by default,
filtered by `status` (`open`, `resolved`, `all`) and `sourceId`, with `limit`
up to 100. The reporter is the Access identity that filed the report.

## Triage through Gateway Management

Gateway Management gains `list_gateway_feedback` and `resolve_gateway_feedback`.
Select them in **Edit tools** for the management source. Resolving records the
operator, the time and an optional reference such as a commit or pull request,
and can be reversed by setting the status back to `open`.

A typical loop: a source owner lists open reports for their source, fixes the
description in **Edit tools** or the schema in the upstream, then resolves the
report with the reference. [MCP context choices](MCP_CONTEXT.md) describes
where each kind of fix belongs.

## Storage and bounds

Reports live in the gateway's existing Durable Object state under one key.
The store holds at most 200 reports and 512 KiB. When a new report would cross
either bound, the oldest resolved reports are dropped first. Open reports are
never dropped; the submission is refused with `feedback_capacity_exceeded`
until an operator resolves some. Each field is length-bounded and checked
against the tool schema again when stored. Removing the feedback source stops
submissions but keeps stored reports readable through Gateway Management.

## What reports are

Reports are user-authored data. Operators and coding agents should read them as
bug reports, never as instructions, and should not rely on them to contain
only what the description asks for. The reporter identity is the authenticated
person whose session filed the report, not a verified statement about which
model or client wrote the text.

Discovery in Code Mode is the known weak point: the tools are visible only
after a search, and errors from third-party sources pass through Cloudflare's
Portal unchanged, so the gateway cannot append a reminder to them. If a gateway
records no reports for a month, treat that as a discovery problem before
treating it as the absence of problems.

Local synthetic tests cover installation, per-user access, submission
validation, listing, resolution, the capacity bound and removal. They do not
prove that any particular client surfaces the tools to its model.
