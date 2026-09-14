# Fast local Worker feedback

Use the smallest loop that exercises the changed behavior:

| Command | Evidence |
| --- | --- |
| `npm run test:runtime` | Production bootstrap state and crypto code in workerd, with real SQLite Durable Object storage |
| `npm run dev:runtime` | The same synthetic fixture with local traces and an agent-readable inspection API |
| `npm run lifecycle -- run --job /private/job.json` | The unattended disposable lifecycle with an operator-managed credential: install, manage, update, interrupt, resume and remove through the production operations ([runner guide](AGENT_LIFECYCLE.md)) |
| `npm run validate:lifecycle:live -- --config /private/config.json` | The separately prepared signed, deployed gateway lifecycle with browser consent |

The runtime suite is part of `check:fast` and `test:apps`, so the existing CI
app-test job runs it. It uses Node's existing test runner and the exact Miniflare
version already locked for Wrangler. No additional test framework or production
dependency is required. Keep the direct Miniflare pin aligned when upgrading Wrangler.

## Runtime coverage

The fixture imports the production bootstrap transition functions, SQLite state
adapter, and base64 decoder. It verifies:

- State creation and one-time capability consumption.
- Authorization, convergence, finalizing, and READY transitions, including
  terminal rejection and removal of temporary session state.
- Persistence across disposal and recreation of the workerd process.
- Competing revision updates, SQLite transaction rollback, corrupted-state
  rejection, and deletion of the fixture's stored state.
- Release-sized decoding and blocked outbound fetches.
- Availability of captured Worker spans through the local inspection API.

This is a focused runtime integration fixture, not the deployed gateway router.
It simulates authorization inputs and does not contact Cloudflare, exchange OAuth
codes, upload a Worker, update a signed release, or remove provider resources.
Local success does not prove hosted CPU/memory limits or provider permissions.
Use the [live lifecycle guide](LIVE_LIFECYCLE.md) for those release checks.

## Local debugging for agents

Run `npm run dev:runtime`. It prints JSON containing the actual localhost origin,
state URL, Explorer UI, and OpenAPI endpoint. Ports are allocated automatically;
each process owns fresh temporary storage and unregisters nothing from other
development sessions. Ctrl-C stops the runtime and discards its state.

1. Read `GET /state`.
2. Send `POST /seed`, then `POST /advance` five times. Read `/state` after each
   step. These fixed operations take no body and use synthetic values only.
3. Query the printed Explorer API for spans and correlated logs. Discover its
   schema rather than assuming the endpoint path from a blog or another version.
4. Fix the code, stop the fixture, and rerun `test:runtime` to verify the change.

For the pinned version, the read-only trace query is:

```http
POST /cdn-cgi/local/explorer/api/local/observability/query
Content-Type: application/json

{"sql":"SELECT service, name, outcome, duration_ms FROM spans ORDER BY start_ms DESC LIMIT 20"}
```

Additional fixed POST actions are `/race` (competing updates after seeding),
`/rollback` (an intentionally aborted transaction), `/corrupt` (invalid fixture
state), and `/reset` (delete and reinitialize fixture state). Error output uses
fixed codes. The fixture never returns stored capability or session secrets.

The synthetic Worker blocks every outbound request. It loads no `.dev.vars`,
credentials, account configuration, remote bindings, or production Wrangler
configuration. Tracing is enabled only on this local fixture; installer and
gateway production logging policies remain unchanged. Do not enter live secrets
into Explorer or use this fixture as a real installer.

Cloudflare's [local tracing description](https://blog.cloudflare.com/local-tracing/)
explains the diagnostic API. The harness uses the Miniflare API shipped in this
repository's pinned toolchain, with a regression verifying that traces are queryable.

The gateway runtime fixture also runs the production bootstrap entrypoint and
its real AdminState Durable Object. It checks setup-page routing, unauthenticated
configuration rejection and status initialization. A deliberately failing DO
verifies that asynchronous dispatch failures produce safe JSON rather than an
opaque platform HTML error. This still does not cover every final gateway route.
