# Curating a gateway

A gateway with a dozen sources and several hundred tools answers a question
well only when the model opens the right source first and keeps the numbers
from different sources apart. This page is the practice that gets a gateway
there and keeps it there. It is generic; the examples are synthetic.

The practice has two channels, and the main decision is what goes into which.

## Two channels

**The gateway** carries what the model sees while it discovers tools: source
names with a Company prefix, tool names and aliases, tool descriptions,
allowlists, and the built-in [feedback source](GATEWAY_FEEDBACK.md). Everything
here is short, per tool or per source, and replaced whole when edited.

**A knowledge source your team controls**, such as a wiki or documentation
server, carries the map of which source owns which facts, the method for a
question that spans several sources, and the team's vocabulary. Connect it to
the client directly rather than through the gateway when you can: its tools
then stay plain tools outside Code Mode, its server instructions reach the
model at session start, and it can serve skills through the
[Skills over MCP extension](https://modelcontextprotocol.io/extensions/skills/overview)
as soon as a client supports that. The gateway's role is to point at it.

Without such a source, the built-in [Start here source](GATEWAY_START_HERE.md)
holds the map as a tool result. With one, Start here is unnecessary; the
knowledge source's own instructions carry the "use together" rule.

## What goes where

| Content | Where it lives | Why |
| --- | --- | --- |
| Which company a source serves | Gateway: Company on every source | It is in the server name the model sees before any search. |
| What a tool does, its arguments, its limits | The upstream source | Schemas and descriptions belong to the implementation. |
| Which source owns which facts, joins, freshness, caveats | Knowledge source: one map page | One text to maintain instead of a copy per tool. |
| How to work a cross-source question | Knowledge source: one method page | Stable across sources; the model loads it on demand. |
| Team vocabulary (campaign names, periods, segments) | Knowledge source: one page | Words the questions use and no API knows. |
| A pointer from a tool to the map | Gateway: one sentence on a source's entry tools | Enough to route; never ownership paragraphs in descriptions. |
| What misled a session | Gateway feedback source | Reports reach the operator with source and tool attached. |

## The pass

Run it when a gateway goes to a team, after a source changes its tools, and a
few times a year regardless.

1. **Measure.** Count servers and tools per source. In Code Mode, run the
   Portal's own search for the five words your team's questions use most and
   note how many tools each returns. A noisy result is the problem to fix.
2. **Remove only what nobody uses.** Ask. A source nobody needs leaves the
   Team assignment; a tool family nobody uses leaves the allowlist. Keep the
   rest, including write tools: the model's selection problem is solved with
   context, not subtraction, and allowlists are not a permission boundary.
3. **Write the map once.** For every source: owns, not here, entry tools,
   rules, joins, freshness. Record which numbers are measured by your own
   systems, which a platform attributes to itself, and which describe
   behaviour; most wrong answers mix those three.
4. **Set Company on every source** and reconnect a client to confirm the
   prefix appears in the connected-server list.
5. **Add the pointer.** On each third-party source's two or three entry tools,
   append one sentence naming the map page. Use the installed-tool editor;
   the override replaces the upstream text, so keep the upstream text and add
   the sentence. For sources your own team builds, change the description at
   the source instead, and file a feedback report to ask for it.
6. **Collect representative questions.** Ten real questions the dashboards do
   not answer, written the way people ask them. They are the test set. Keep
   them with the map.
7. **Verify routing, not answers.** In a fresh session with both the gateway
   and the knowledge source connected, ask each question and record which
   source the model opens first, whether it read the map before touching
   data, and whether it labelled measured, attributed and behavioural
   numbers. Fix the map or a pointer, not the question.
8. **Read the feedback.** Open reports name the source and tool that misled a
   session. A report about a third-party source becomes an override; a report
   about your own source goes to its owner; a report about routing goes into
   the map.

## Rules that held up

- One map in one place. The moment ownership text appears in a tool
  description it has a second copy to maintain, and a third.
- Pointer, not paragraphs. A tool description says what the tool does and
  where the map is, and nothing about other sources.
- Third-party sources get gateway overrides; self-built sources get fixed
  upstream, with a feedback report as the request.
- Measured, attributed and behavioural numbers are three things. Say which
  one a number is before comparing it with another.
- Check the latest available date per source before trusting recent days.
- Descriptions guide selection. Allowlists and upstream permissions enforce
  it. Nothing on this page changes what a session is allowed to do.

## What this does not do

It does not prove that a client makes its model read the map first. The only
evidence is the fresh-session check in step 7, repeated per client and per
connection mode. Keep the questions, the map and the results in your own
account or wiki; this repository holds the practice, not any team's content.

See [MCP context choices](MCP_CONTEXT.md) for which gateway field reaches the
model when, and [Customize installed tools](TOOL_METADATA.md) for the editor.
