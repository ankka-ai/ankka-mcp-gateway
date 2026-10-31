# Agent access

An agent is a hosted MCP client, such as a scheduled reports agent, that uses
your gateway's MCP Portal without a person present. It signs in with its own
Cloudflare Access service token instead of a person's sign-in, so it keeps
working when that person's session ends.

Agents are listed in **Team → Agents**. Each one names a service token you
created in your Cloudflare account, the connectors it may use, the tools it may
call through the [agent entrance](#agent-entrance), and an on/off switch. Your
gateway keeps only two non-secret references for each token: its **client ID**
and its **token ID**. The client secret stays in Cloudflare and in the agent's
own credential store. The gateway never asks for it and never stores or logs
it; the agent entrance holds it only for the request that carries it.

## How access works

Cloudflare authorizes a service-token session twice, as its
[MCP portal documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#connect-with-a-service-token)
describes. The Portal's Access application must admit the token, and each
connected server's Access application must admit it too, or that server's
tools stay hidden from the agent.

Your gateway therefore keeps one Service Auth policy (`decision: non_identity`)
on the Portal application and on the application of each connector an agent
reaches. Each names exactly the tokens of the enabled agents that reach that
application, one `service_token` rule per token, and nothing else: no email,
no group, no "any valid service token" rule. It sits beside the policy for
people and never replaces or changes it. Every agent policy carries the same
name, `ankka-<installation id>-agents`, on its own application.

These policies are receipt-owned like the people's policies. A Team save
plans them, records each write before sending it, reads each one back, and
remembers what it applied. Agent policies are never imported from Cloudflare.

- Saving a change to people or teams keeps every agent policy as it is.
- Removing an agent, or switching it off, takes its token off every policy
  and deletes a policy no enabled agent needs. People's access does not change.
- An agent that reaches no connector is on no policy, not even the Portal's.
- The gateway never creates, rotates, revokes or deletes a service token.
  Delete the token in Cloudflare when you no longer need it.

## Which connectors an agent can use

An agent can use a connector only when the Portal reaches it with its own
shared credential: Cloudflare excludes servers with **Require user auth**
(`on_behalf: true`) from service-token sessions, and service tokens do not
support per-user OAuth with upstream servers.

| Connector | For agents |
| --- | --- |
| Public, operator-connected OAuth, or Access service-token connector | Available |
| Connector with individual sign-in, including the gateway's Feedback, Start here and API sources | Not available: each person signs in for themselves |
| Gateway Management | Never available |
| This dashboard | Never reachable: it is not a Portal connector |

The Team page shows each connector's state. A save that names an unavailable
connector for an agent is refused with `team_agent_source_unsupported`. The
gateway does not change a connector's authentication to make it available.

An agent's connectors are either an explicit list, or **Follow** a named team.
A following agent gets that team's connectors as of each save, except the
ones agents cannot use. If the team gains a connector later, for example
through **All MCPs**, the agent gets it at your next Team save; the agent's row
says so in the meantime. A team an agent follows cannot be deleted from under
it (`team_agent_team_missing`).

Directly at the Portal, the tools an agent sees on a connector are that
connector's allowed tools, the same list people see. Through the
[agent entrance](#agent-entrance) it sees only the tools you choose for it.

## Set up an agent

1. **Create a service token** in Cloudflare Zero Trust under **Access
   controls → Service credentials → Service Tokens → Create Service Token**.
   Name it after the agent and choose a finite duration. Cloudflare shows the
   **Client ID** and **Client Secret** once: put the secret straight into the
   agent's credential store, never into the gateway, a repository or a chat.
   Creating a token needs **Access: Service Tokens Edit** in your account. See
   Cloudflare's [service token guide](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).
2. **Find the token ID**. It is the token's own `id`, a UUID, not its client
   ID. Creating the token through the API returns it as `id`. For a token
   created in the dashboard, list your tokens with
   `GET /accounts/{account_id}/access/service_tokens` (Access: Service Tokens
   Read) and take the `id` of the entry whose `client_id` matches.
3. **Add the agent** on the Team page: **Agents → Add agent**, with its name,
   client ID, token ID and connectors. Then **Save**. Your gateway writes the
   agent policies with its management token and verifies them.
4. **Connect the agent**, in one of two ways:
   - An agent that can send custom headers connects to the Portal URL
     `https://<portal hostname>/mcp` with `CF-Access-Client-Id` and
     `CF-Access-Client-Secret` on every request. On a Portal whose Code Mode is
     on by default, add `?codemode=off` to see each connector's tools directly.
   - An agent that can send only `Authorization: Bearer <token>`, such as a
     Claude Managed Agent, connects through the [agent entrance](#agent-entrance).

Only a person with dashboard access can add, change or remove an agent. The
gateway's own service identity cannot, Gateway Management's Team tool leaves
agents as they are, and the service token the gateway's deployment opted into
for management can never be registered as an agent.

<a id="agent-entrance"></a>

## Agent entrance

Some hosted agents can send only a bearer token. Cloudflare's own
single-header option for service tokens expects raw JSON in the header it
names, which collides with the Portal's OAuth bearer in `Authorization`. The
agent entrance closes that gap: one MCP address on its own hostname, outside
Access, that turns an agent's bearer back into Cloudflare's two service-token
headers and forwards the request to your Portal. Cloudflare still does the
authentication.

### Turn it on

In **Team → Agents → Agent entrance**, choose a hostname directly under your
gateway's zone (`agents.<zone>` is suggested) and select **Turn on**. Your
gateway attaches that hostname as a custom domain of its own Worker with the
management token, reads it back and records it; Cloudflare creates the DNS
record. This needs **Workers Scripts Edit**, which the
[template's](MANAGEMENT_TOKEN.md#the-template-link) **Workers: Editor** covers.
**Turn off** detaches and forgets it. The address is:

```text
https://<entrance hostname>/api/agents/mcp
```

The path sits under `/api/` because the gateway's signed asset routing hands
only `/api/` and `/__ankka/` paths to the Worker first; on any other path
Cloudflare's static assets answer before the Worker runs.

### The bearer

The bearer is the agent's service token: `ankka_agent_v1_` followed by
base64url, without padding, of the client ID, a colon and the client secret.
Client IDs contain dots but never a colon, so the first colon ends the ID.
Build it on your own machine and copy it straight into the agent's credential
store, for example on macOS:

```sh
read -r CLIENT_ID
read -rs CLIENT_SECRET
printf 'ankka_agent_v1_%s' "$(printf '%s:%s' "$CLIENT_ID" "$CLIENT_SECRET" | base64 | tr '+/' '-_' | tr -d '=\n')" | pbcopy
unset CLIENT_SECRET
```

The bearer is as secret as the client secret. Never paste it into the
gateway, a repository, a chat or a ticket.

### What the entrance does

For every request it:

1. Serves only `POST` and `DELETE` on `/api/agents/mcp`. Every other path on
   the entrance hostname, including every management route, answers 404.
2. Reads the bearer. A malformed bearer, or a client ID that is not an
   enabled agent on the Portal's agent policy, gets 401 without the Portal
   being contacted. Switching an agent off takes effect on its next request,
   from the moment the Team change is recorded.
3. Counts the agent's requests: at most 120 per minute, then 429 with
   `Retry-After`.
4. Accepts one JSON-RPC message of at most 256 KiB, and only the methods an
   agent needs: `initialize`, `ping`, `tools/list`, `tools/call`, and the
   notifications `notifications/initialized` and `notifications/cancelled`.
   Other methods get JSON-RPC error `-32601` without being forwarded; other
   notifications are accepted and dropped. `initialize` is forwarded without
   the client's own capabilities, so the Portal never sends the agent a
   request of its own.
5. Allows a `tools/call` only for a tool on the agent's list. Any other name
   gets JSON-RPC error `-32602` without being forwarded.
6. Forwards to `https://<portal hostname>/mcp?codemode=off` with
   `CF-Access-Client-Id` and `CF-Access-Client-Secret` from the bearer, plus
   the agent's `Mcp-Session-Id` and `Mcp-Protocol-Version`. Never its
   `Authorization` or cookies. Redirects are never followed: a redirect, 401
   or 403 from the Portal reaches the agent as 403 `portal_denied`.
7. Filters `initialize` to the tools capability and `tools/list` to the
   agent's tools, renamed, in JSON or server-sent events, page by page with
   `nextCursor` intact (8 MiB per page). A `tools/call` answer streams through
   as it arrives, up to 16 MiB, with a 100-second limit.

The Portal's Code Mode hides individual calls inside JavaScript, so the
entrance always uses direct mode: it can see and allow each call.

### Tools and their names

Each agent has its own tool list, chosen with **Tools** on its row from the
connectors it reaches. A connector without a selection starts with the tools
that describe themselves as read-only (`readOnlyHint`). That hint comes from
the connector, so review each tool before saving: hints are not permissions.
Gateway Management is never available to agents. A tool the connector no
longer allows, or on a connector the agent no longer reaches, is not offered.

The agent sees each tool as `<connector prefix>__<tool>`, for example
`klaviyo__get_campaigns`, instead of the Portal's `{server_id}_{tool}`. The
prefix comes from the connector's name, so it survives a change of its
Cloudflare server record, such as a switch to a service token; renaming the
connector renames its tools for agents. A tool alias set in **Edit tools**
replaces the tool part. Claude limits tool names to 64 characters, so keep
aliases short on connectors with long tool names.

### Audit and last use

Each `tools/call` through the entrance writes one line in your gateway: the
agent, the tool, the outcome (`ok`, `tool_error`, `rpc_error`, `refused`,
`portal_denied`, `portal_error`, `failed`, `too_large` or `cancelled`), its
duration and the size of the answer. No header, argument or result is kept.
The Team page shows each agent's last use and the most recent calls; the
gateway keeps the last 200 lines. Cloudflare's own Portal logs record each
call as well.

## Turn an agent off, or remove it

Switch the agent **Off** and save. Its token leaves every agent policy, so
Cloudflare refuses its next request, and the agent entrance refuses it as soon
as the change is recorded. Remove the agent to forget it as well. Neither
revokes the service token: delete or revoke it in Cloudflare.

Removing a connector that an agent uses is refused with
`source_removal_agents_assigned`. Take the connector off the agent, or off the
team it follows, and save first. Removing the gateway is refused with
`teardown_agents_present` until no agent policy is left and the agent
entrance is off: switch your agents off or remove them, and turn the entrance
off, first.

## Drift

A Team read compares every agent policy in Cloudflare with what was last
applied. When one no longer matches, the read stays unverified and names it:
`team_agent_policy_missing` or `team_agent_policy_changed`, with `policyKind`
(`portal_agents` or `source_agents`) and, for a connector, its `sourceId`.
A copy that uses the agent policy name counts as changed. People's assignments
still load. Every Team save is refused with `team_policy_drift` until the
policy matches again:

- **Changed**: restore its name and token list in Cloudflare exactly as saved,
  or delete the copy that uses its name, then refresh.
- **Deleted**: switch off or remove the agents that used it and save. Switch
  them on again afterwards to create a new policy.

Other Service Auth policies on the same applications, with other names, are
neither read nor changed, and do not count as agents.

## Permissions

The management token's existing **Access: Apps and Policies Edit** covers
every agent policy write: create, replace and delete an attached policy on the
Portal and connector applications. Turning the agent entrance on or off
attaches or detaches one custom domain of the gateway's own Worker, which
needs **Workers Scripts Edit** (the template's **Workers: Editor**). The
gateway needs no service-token permission because it never manages a token.
See [Management token](MANAGEMENT_TOKEN.md#setup-and-verified-endpoint-permissions).

## Limits and qualification

- Anyone who holds an agent's client ID and secret can use the Portal as that
  agent, within its connectors and their allowed tools. The entrance's tool
  list narrows what the agent calls through the entrance; it does not stop a
  leaked secret from being used at the Portal directly with every tool its
  connectors allow. Treat the secret like any other credential, give the token
  a finite duration, and switch the agent off if the secret may have leaked.
- The entrance runs in the gateway Worker, which also serves the dashboard's
  static files. On the entrance hostname, Cloudflare answers a browser's page
  request with the dashboard's public, data-free page before the Worker runs;
  every `/api/` and `/__ankka/` request there except the entrance gets 404.
- The entrance hostname is outside Access, so anyone can reach it. Requests
  without a valid agent bearer stop at 401 without reaching the Portal, but
  each one still runs your Worker. Add a Cloudflare WAF rate-limiting rule for
  the hostname if that matters to you.
- Tool names and descriptions are not an authorization boundary. Each
  upstream must still enforce what its credential may do.
- Cloudflare evaluates Service Auth policies before Block and Allow policies.
  A connector whose only people's policy is the default deny-everyone policy
  has not been qualified with an agent policy beside it. Qualify that case on a
  disposable deployment before relying on it.
- These changes are covered by synthetic tests against a simulated Cloudflare
  API and Portal. The supported flow still needs a live check on a disposable
  deployment: the entrance hostname attaches, an agent's bearer lists and calls
  a selected connector's tools in direct mode, cannot see an unselected one,
  and is refused after the agent is switched off. That check should also
  confirm that a service-token session sees every server whose application
  admits the token, without a per-session server selection.
