# Team connect pages

A connect page is a link you send to a team. At the top, it shows how to
connect an AI assistant to your gateway. Below that, it lists example
questions the team's connectors can answer. Turn it on in the dashboard under
**Connect pages**.

- `https://<dashboard host>/__ankka/connect` shows each person the connectors
  they can use, through any of their teams or their own assignments.
- `https://<dashboard host>/__ankka/connect/<team id>` shows one team's
  connectors. Only that team's members and dashboard administrators can open
  it. Anyone else is sent to their own page.

The **Connect pages** screen lists both kinds of link, each with **Copy link**.

## What the page shows

- **Connect your assistant.** One tab each for Claude, ChatGPT, Claude Code,
  Cursor and other remote MCP clients, with three steps each.
  - Claude and Cursor get a one-click link with the gateway's name and MCP URL
    filled in.
  - Claude Code gets the exact `claude mcp add` command.
  - Every tab shows the MCP URL with a copy button.
- **Ready-to-ask questions.** Your example questions as cards with the
  connectors' icons, with a category list to filter them: one category per
  connector, then **Across sources** and **General**.
  - Each card shows what the answer contains, when you describe it, so people
    know what kind of response to expect.
  - Each card has **Open in Claude**, which starts a new chat with the question
    filled in, and **Copy**.
  - Without any examples that a person can use, the page suggests one starter
    question per connector instead.

The page names the connectors a person can use and the signed-in email. It
grants nothing: tools stay behind the Portal and its Access policies.

## Example questions

You write the examples in the dashboard and tick the connectors each question
needs, up to four. Optionally, describe what the answer shows, for example "A
ranked table of campaigns with spend and return, and which one to scale". The
card shows it under the question.

An agent connected to [Gateway Management](GATEWAY_MANAGEMENT_MCP.md) can write
them too: `get_connect_examples` returns the examples, their revision, the
installed sources and each team's sources and link, and `set_connect_examples`
replaces the list at that revision. Both tools stay off until you select them
on the Gateway Management connector.

- A person sees an example only when they can use every connector it names.
- An example with no connectors is shown to everyone.
- The editor shows which teams will see each example.

Write them the way your team asks. The ten questions from
[Curating a gateway](GATEWAY_CURATION.md#the-pass) are a good start.

The gateway stores the examples in its own state, as one list with a revision.
Limits:

- at most 60 examples;
- 600 characters per question and 300 per answer description, without leading
  or trailing spaces;
- only installed connectors can be named.

When a connector is removed, examples that name it disappear from every page.
The editor flags them, and saving takes the removed connector off.

## Who can open a page

Turning the page on creates one Cloudflare Access application in your account,
`ankka-<installation id>-connect`. It covers only
`<dashboard host>/__ankka/connect` and has one policy, **Connect page viewers**,
that allows any identity your Access login methods accept.

The gateway Worker then decides what each visitor sees:

1. It verifies the Access token against this application's audience, its
   issuer, its expiry and its signature. A dashboard sign-in is not accepted
   here.
2. It serves the page itself to any verified visitor. The page holds no
   gateway data.
3. The page then asks for its view. The Worker looks the email up in the saved
   Team: someone who is not on the gateway gets `connect_not_member` and sees
   "You don't have access yet" and nothing else.
4. For a team link, it checks that the person is on that team or is a
   dashboard administrator.

The edge only requires a sign-in. Membership is checked by the gateway, from
the saved Team rather than a live Cloudflare read, so a change made directly in
Cloudflare shows after the next Team load. The saved Team is never changed by
this page, and Team saves never write to this application. If your account
allows one-time PIN sign-in for any email, anyone can reach the "no access"
answer; they still see no team, connector or example.

## How the page is built and served

The page is the dashboard build's second page: `apps/admin/team-connect.html`
and `apps/admin/src/connect/`, using the dashboard's theme and components. The
dashboard's own files sit behind the administrators' Access application, so
the Worker serves this page's copies under the page's own path:

| Route | What it serves |
| --- | --- |
| `/__ankka/connect`, `/__ankka/connect/<team id>` | The page from the build, with its links rewritten to the path below |
| `/__ankka/connect/assets/<file>` | The build's hashed scripts, styles and images, only with their expected type |
| `/__ankka/connect/view` | What this visitor may see; `?team=<team id>` for a team link |
| `/__ankka/connect/icons/<source id>` | A connector's icon, only for a connector the visitor can use |

The view names each connector by its displayed name and, for connectors whose
icon the build bundles, an icon key; connector URLs stay in the Worker. The page
and the view are `private, no-store` and `noindex`, with no framing or referrer.
The page's CSP allows scripts, styles, images and requests from the page's own
origin only.

To work on the page locally, run `npm run dev:ui` and open
`http://127.0.0.1:5730/team-connect.html?preview=team`. Other synthetic states:
`starters`, `empty`, `not-member`, `other-team` and `off`.

## Turning it on and off

**Turn on** needs the [management token](MANAGEMENT_TOKEN.md) and its
**Access: Apps and Policies Edit** permission.

1. The gateway records the attempt before each Cloudflare write.
2. It looks for an application with the exact name. If an earlier response was
   lost, it adopts that application instead of creating a second one.
3. Otherwise it creates the application, then its policy, and reads both back.

Any other application that claims the same name or path is a conflict. The
gateway never adopts or deletes it.

**Turn off** deletes only the gateway's own application, after checking that
its shape is unchanged. If it was edited in Cloudflare, the gateway stops and
says so. Restore the application, or delete it in Cloudflare, then turn the
page off again.

An interrupted or refused attempt keeps its record. The dashboard shows why it
stopped; **Try again** continues it, and **Turn off** cleans it up.

## Lifecycle limits

- **Removal:** gateway removal does not know this application. While the page
  is on, or an attempt is unfinished, removal is refused with
  `teardown_connect_page_present`. Turn the page off first, as you delete teams
  first.
- **Rollback:** turning the page on raises the gateway's minimum runtime
  release to the running one, the same floor native connectors set. Older
  releases cannot see the application, so they can neither run this gateway
  nor remove it.
- **Updates:** updates keep the page, its application and the examples.

## API

All routes are on the dashboard host, for dashboard administrators only. Writes
must be same-origin. The service identity is refused.

| Route | Purpose |
| --- | --- |
| `GET /api/connect` | Examples, their revision, page status (`off`, `enabling`, `on`, `disabling`) and the last failure code |
| `PUT /api/connect/examples` | `{ schemaVersion: 1, expectedRevision, examples: [{ id, prompt, answer?, sourceIds }] }` replaces the list |
| `POST /api/connect/page` | `{ schemaVersion: 1, enabled }` turns the page on or off |

Failure codes are fixed words: `connect_page_permission_missing`,
`connect_page_conflict`, `connect_page_drift`, `connect_page_unconfirmed` and
`connect_page_removal_pending`.

## Not verified live yet

The Worker, the Access application and the page are covered by tests against
synthetic Cloudflare state (`test/worker-connect-pages.test.mjs`), and the page
itself by `apps/admin/src/connect/ConnectApp.test.tsx`. Before relying on it,
check on a disposable gateway that:

- Cloudflare gives the path application precedence over the dashboard's
  domain-wide application;
- the sign-in reaches the Worker with this application's audience;
- the static assets binding serves `team-connect.html` at `/team-connect`;
- turning the page off removes the application.
