# Access service-token sources

A connector whose endpoint sits behind a self-hosted Cloudflare Access
application in your own account can reach it with an Access service token,
instead of a shared operator sign-in. A shared sign-in to such an endpoint is a
Managed OAuth grant that Access ends a fixed time after sign-in (14 days by
default); refreshing does not extend it, and every user loses the connector
until an operator signs in again. A service token belongs to no person, lasts
as long as you set it to (a year by default), and Cloudflare can notify you a
week before it expires.

You create the token and write it into Cloudflare. Your gateway never asks for,
receives, stores or logs it.

## When the mode is available

The gateway offers **Use an Access service token** only when the endpoint is
covered by a self-hosted Access application in the gateway's own Cloudflare
account. It reads your account's Access applications with the management token
to check this, when you inspect the endpoint and again before it creates
anything. Hostnames of the gateway itself never qualify. This keeps the
credential to an Access service token for an Access-protected origin in the
same account: the mode is not a general way to send a bearer token to any server.

An endpoint whose Access application has Managed OAuth turned off cannot be
inspected without the token. Inspection then reports that it needs a service
token, and its tools are listed once the token works.

## What you do in Cloudflare

1. In Zero Trust, go to **Access controls → Service credentials → Service
   Tokens** and create a token for this one connector. Store the client ID and
   secret straight away; Cloudflare shows the secret once.
2. On the self-hosted Access application in front of the endpoint, add a policy
   with the action **Service Auth** that includes exactly that token. Add it to
   that application only, not to a reusable policy other applications share.
3. If your origin verifies the Access assertion, accept a service-token
   assertion only for that token's client ID (its `common_name` claim). A
   service-token assertion has no email.
4. Write the token into the connector's server record from your own shell, as
   the dashboard shows when it asks for the credential. With
   `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` and your own
   `CLOUDFLARE_API_TOKEN` (with MCP Portals Write) set:

   ```bash
   jq -n '{auth_credentials: ({headers: {"cf-access-client-id": env.CF_ACCESS_CLIENT_ID, "cf-access-client-secret": env.CF_ACCESS_CLIENT_SECRET}} | tojson)}' | curl -sS -X PUT -H @<(printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$CLOUDFLARE_API_TOKEN") "https://api.cloudflare.com/client/v4/accounts/<account id>/access/ai-controls/mcp/servers/<server id>" --data @- | jq '{success, status: .result.status, auth_type: .result.auth_type}'
   ```

   Only `jq` sees the token, through its environment, and the API token travels
   in a header file, so neither appears in the command line or shell history.
   The request carries nothing but `auth_credentials`. Do not use the gateway's
   management token for this.

Cloudflare never returns `auth_credentials` once written.

## Adding a new connector

1. Inspect the endpoint, choose the service token, name the connector and save
   the draft. It has no tools yet.
2. Install it. The gateway creates the connector's Cloudflare server record with
   `auth_type: "bearer"`, its ownership marker and no credentials, with nothing
   enabled and nobody assigned, and does not attach it to the Portal. It then
   pauses with **Write the service token**, showing the server ID and the command.
3. Write the token, then resume. The gateway asks Cloudflare to sync that one
   record and reads it back. It continues only when the record still has the
   shape it created and Cloudflare reports it Ready. A missing, wrong or expired
   token keeps the installation paused; it is never read as an empty tool list.
4. Choose the tools from the synced list and resume. The gateway attaches the
   connector with exactly those tools, `on_behalf: false` and `default_disabled`,
   like any connector, and nobody is assigned until you grant access in Team.

## Switching a connector from a shared sign-in

An installed connector that uses your shared operator sign-in
(**Operator-connected OAuth**) can move to a service token without losing its
allowed tools or Team assignments. Open the connector in **Sources** and choose
**Switch to service token**.

Cloudflare cannot change a server record's type, so the switch creates a second
record:

1. The gateway creates the new bearer record with the connector's current tool
   allowlist and no credentials, then pauses. Your team keeps using the shared
   sign-in meanwhile.
2. You write the token into the new record and choose **Continue**. The gateway
   checks the record's shape, including that its tool overrides are unchanged,
   and that Cloudflare reports it Ready with every allowed tool.
3. The gateway removes the connector from the Portal, points the connector's
   Team Access application at the new record, and adds it back with the same
   allowlist, `on_behalf: false` and the same default. It never leaves a mapped
   record without its Team application, so for a few seconds the connector is
   absent rather than open to everyone admitted to the Portal. The application
   update names every policy the application has, the Team policy included, so
   they stay attached. Each step is read back before the next one.
4. It saves the new record as the connector's own, then deletes the old record.

The connector's tool names in your Portal start with its server record's ID,
`{server_id}_{tool_name}`. The new record keeps the `mcp-source-<id>` prefix
but ends in a different suffix, so every tool name of the connector changes
once. Update anything that refers to the old names, such as a source map or a
saved prompt. Code Mode clients find the new names with `codemode.tools()`.

Every step is journaled. If a step cannot be confirmed, the switch stops and the
connector shows **Continue** and **Roll back**. Continue resumes from what
Cloudflare currently reports. Roll back reverses the same steps and deletes the
new record, for as long as the old sign-in record exists; your shared sign-in
must still be valid for the connector to work after a rollback. Before the move
starts, **Cancel switch** deletes only the new record.

While a switch is open, other connector changes, Team saves, updates and
gateway removal wait. Finish or roll back the switch first.

## Health, drift and renewal

- The connection check shows **Service token rejected** when Cloudflare Access
  refuses the token (a refusal or a redirect to sign in), with the server ID
  and the command to write a valid token. There is no **Sign in again** or
  **Reconnect** for this mode.
- The gateway accepts a bearer server record only for a service-token
  connector. A record whose type, ownership marker, endpoint or callback setting
  differs from what the gateway created is configuration drift.
- To renew a token before it expires, refresh it in Cloudflare; the client ID
  and secret stay the same. To rotate it, rotate in Cloudflare with a grace
  period and write the new secret into the record with the same command.

## Unverified Cloudflare behaviour

This mode was built and tested against a synthetic Cloudflare, not a live
account. It relies on behaviour Cloudflare's API reference describes but that
has not been observed here:

1. A server record created with `auth_type: "bearer"` and no `auth_credentials`
   is accepted, and becomes usable once credentials are written into it.
2. An update that carries only `auth_credentials` leaves every other field of
   the record unchanged, including its tool overrides (`updated_tools`).
3. Updating an MCP Access application with its existing policies named by ID
   keeps them attached.

The gateway does not trust these. It reads the record back after every step and
continues only from an exact, recognised state, so a difference stops the
switch before the connector is moved, or before it is attached for a new
connector:

- If Cloudflare refuses a bearer record without credentials, starting the
  switch stops with **source_switch_recovery_required** and nothing else has
  changed. **Cancel switch** deletes whatever was created.
- If the record never reports Ready after the token is written, the switch
  keeps waiting. Nothing has moved; **Cancel switch** deletes the new record.
- If the credential write changed the record's tool overrides or any other
  setting the gateway checks, **Continue** stops with **source_switch_drift**
  before the move. **Cancel switch** deletes the new record and the connector
  stays on its sign-in record.
- If Cloudflare refuses the application update, the connector is briefly
  unmapped but nothing is exposed. **Roll back** maps it again on its sign-in
  record and deletes the new one.

## First switch on a live gateway

Take one rarely used, read-only connector through the switch first:

1. Renew its shared sign-in with **Sign in again**. A rollback returns to the
   sign-in record, which then has to work.
2. Choose **Switch to service token**. Check that the new record exists with
   `auth_type: "bearer"`, for example with `cf mcp servers list`.
3. Create the token and its Service Auth policy, write the token with the
   command, and choose **Continue**. Before anything moves, the gateway checks
   assumptions 1 and 2 against the live record.
4. After the switch, have an assigned person call one of the connector's tools,
   check that a person who is not assigned does not see it, and check the Access
   log for a service-token request to the origin.

If step 3 stops, cancel the switch: the connector never left its sign-in
record. Once the switch has completed, the old record is gone; to go back, add
the connector again with sign-in.
