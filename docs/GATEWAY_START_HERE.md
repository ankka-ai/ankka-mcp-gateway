# Start here

In Code Mode a model sees nothing but the connected servers' names before its
first tool search. Whatever you want it to know about your sources before that
search has exactly one slot: a source whose name says "read me first" and
whose single tool returns the page. Start here is that source.

It is built into the gateway release and installed like any other connector.
The text stays in your Cloudflare account. Nothing is sent to Ankka.

## Add the source

1. In **Sources**, choose **Add Start here**. It saves a draft for the
   gateway's own `/api/guide/mcp` endpoint with its one tool selected. Agents
   can do the same with `save_mcp_source_draft` and that URL. Set **Company**
   so the Portal lists it as, for example, **Company B · Start here**.
2. Install the draft. Each person signs in with their own gateway identity,
   as for the feedback source.
3. Assign the source in **Team** to everyone whose sessions should read it,
   which is normally everyone.

## What the tool returns

`get_source_map` takes no input and returns `text`, plus `authored`,
`updatedAt` and `updatedBy`. Until an operator writes the text, the gateway
returns a generated list of the installed connectors as the Portal names them,
with their tool counts, and says how to replace it.

The tool's description asks the model to call it first for any business or
data question. The server's `initialize` instructions say the same for clients
that pass them on. Neither forces a model to comply; the measurable test is to
ask a fixed question in a fresh session and see whether the map was read.

## Write the map

Operators write the text with `set_gateway_guide` on Gateway Management, up to
16,000 characters of plain text or Markdown, replaced whole each time.
`get_gateway_guide` reads it back with the author and time. Both tools appear
in an agent's list only after they are selected in **Edit tools** for the
management source.

Keep it short and keep it in one place. A good map names each source, what it
owns, what it is not for, and where the longer method and vocabulary live, in
your team's wiki or knowledge base. Do not copy tool descriptions or schemas
into it; those stay with the sources. Do not put ownership statements into
individual tool descriptions either: a pointer to this page is enough, and one
text is maintainable where fourteen copies are not.

## Storage and bounds

The text lives in the gateway's existing Durable Object state under one key,
with the author and time. It survives removing and reinstalling the source.
The bound is 16,000 characters; a longer text is refused, never truncated.

## When your team has a knowledge source

If your team controls a wiki or documentation server and connects it to the
client directly, put the map there and let that server's own instructions
carry the "use together with the gateway" rule; its instructions reach the
model at session start, which the Portal does not pass through. Start here
is then unnecessary. See [Curating a gateway](GATEWAY_CURATION.md).

## What it is not

It is not a Cloudflare Portal description, which is not proven to reach the
model, and not an MCP server instruction, which the Portal does not pass
through. It is an ordinary tool result, which every client delivers.

Local synthetic tests cover installation, per-user access, the generated
default, writing and reading the text, the bounds, and removal. They do not
prove that any particular client makes its model call the tool first.
