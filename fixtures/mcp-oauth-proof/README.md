# Self-hosted MCP OAuth experiment

This opt-in proof tests the OAuth credential-import format observed in
Cloudflare's dashboard. It is separate from the gateway. The management UI now
uses the same import contract through its own
[administrator-bound authorization flow](../../docs/SOURCE_ACTION_RECOVERY.md#provider-authorization-from-sources).

The fixture is both a synthetic OAuth provider and its public OAuth client. It
grants access only to constant synthetic data. Its automatic consent endpoint
is **not a production identity provider**. It accepts one fixed callback,
resource and scope, uses PKCE, binds state to an HttpOnly browser cookie, consumes
state and authorization codes once, and rotates refresh tokens. Its two MCP
tools are read-only; the portal permits only one.

The client callback runs in your Cloudflare account. It exchanges the code and
imports `{tokens, config, registration_info}` as a JSON-encoded
`auth_credentials` value through the MCP server update API. The runner never
receives the upstream access or refresh tokens. That import format is an
**observed, undocumented contract**, not a supported API guarantee. The published
manual OAuth configuration API does not itself prove this behavior.

## Observed result — 2026-09-19

The deployed proof passed in a disposable customer-account environment:

| Check | Observed evidence |
| --- | --- |
| Self-hosted authorization callback | One authorization-code exchange and one credential import |
| Callback replay | Rejected without another exchange or import |
| Cloudflare tool discovery | Both synthetic upstream tools discovered |
| Refresh after natural access-token expiry | Refresh counter increased after the 90-second token expired; subsequent sync succeeded |
| Shared administrator grant | Two different Access service identities each completed a read, with one total code exchange |
| Tool allowlist | Disabled tool absent from discovery and rejected when called; zero upstream invocations |
| Cleanup | Source, portal, Access applications, service tokens, DNS record, Worker and namespace removed |

The final counters included one code exchange, one import, two refreshes and two
permitted reads. This establishes feasibility for the synthetic public-client
flow. It does not establish a stable supported Cloudflare import API or
interoperability with a real provider. No real provider consent was granted.

Local verification passed all six OAuth runtime tests, the complete
`npm run check:fast` gate with the pinned toolchain, and Wrangler's deployment
dry run. The proof uses the 2026 MCP per-request metadata and cache/result fields;
omitting them produced misleading upstream authentication errors during setup.

## Local verification

```sh
node --test apps/installer/test-runtime/mcp-oauth-proof.test.mjs
npm run check:fast
```

The local suite runs the Worker in workerd with real SQLite Durable Objects.
It checks state/cookie binding, PKCE, replay, source ownership drift, redirect
rejection, access expiry and refresh rotation. Outbound calls are restricted to
the synthetic provider and one mocked Cloudflare source. No live credentials are
loaded. The compatibility date matches the newest date supported by the pinned
local runtime; the toolchain is not upgraded for this experiment.

## Live verification

This creates a new Worker and namespace, MCP source, portal, DNS record, two
Access applications and two short-lived service tokens. It does not install a
gateway or change existing sources. Use `npm run lifecycle` for complete gateway
lifecycle testing instead.

Keep a job file outside every repository in a private directory, with file mode
`0600`. It has four fields:

| Field | Value |
| --- | --- |
| `accountId` | Your test Cloudflare account identifier |
| `zoneName` | An existing zone in that account for the disposable portal |
| `deploymentCredential` | An operator credential reference for provisioning and removal |
| `managementCredential` | An operator credential reference allowed to read and update MCP sources |

Credential references use the existing [operator credential loader](../../tools/operator-credential.mjs):
`{"env":"VARIABLE_NAME"}` or
`{"keychain":{"service":"SERVICE_NAME","account":"ITEM_NAME"}}`.
The values belong in your credential store, not the job file or shell arguments.

```sh
node tools/mcp-oauth-proof.mjs run /private/oauth-proof/job.json
node tools/mcp-oauth-proof.mjs cleanup /private/oauth-proof/job.json
```

The deployment credential stays in the local process. The management credential
is installed as an encrypted secret on the disposable customer Worker. It has
account-wide provider authority; the fixture narrows its own use to reading and
updating the randomly named source after checking its ownership marker and
exact hostname. It is never sent to Ankka-hosted infrastructure, returned to a
browser, stored in Durable Object state, or included in output.

The runner starts and follows the synthetic authorization redirects as an HTTP
client, retaining only the browser session cookie. It checks the callback's
destination and replay rejection, imports the grant, syncs tools, waits for the
90-second access token to expire and tests Cloudflare refresh. It then uses two
distinct Access service identities against a portal configured with
`on_behalf: false`, verifies both can read using the single grant, and verifies
the other read tool is unavailable. These service identities do not prove the
interactive Access login flow for two human users.

Output contains fixed stages and synthetic counters. The private receipt next
to the job contains resource locators for cleanup, with no credentials. Cleanup
runs after success or failure, discovers resources by the exact random ownership
marker, and verifies removal of the source, portal, Worker and namespace. After
a hard interruption, use the cleanup command before another run. Worker logging
and tracing are disabled. The fixture rejects requests after one hour even if
cleanup is interrupted; expiration is not a substitute for removal.

## Production boundary

The proof deliberately supports only a fixed synthetic OAuth provider and public
client. The gateway integration adds administrator and browser checks, bounded
OAuth discovery, current source/action binding, token validation and fixed error
handling. Production route tests and a separate SQLite restart test cover those
boundaries. Provider-specific interoperability checks remain necessary. Manual
clients and providers issuing client secrets are outside this proof and the
dashboard authorization path.

The dashboard journey is: **Authorize in your dashboard →
provider consent → callback to your customer Worker → Cloudflare stores the
grant → return to your dashboard.** Source credentials must stay between the
provider and your Cloudflare account throughout that journey.

## References

- [Cloudflare MCP portal API guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)
- [Cloudflare dashboard callback implementation observed for this experiment](https://dash.cloudflare.com/one/OAuthCallbackPage-D0DtdUtb.js)
- [Cloudflare Worker-to-Worker fetch configuration](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
- [MCP 2026 protocol wire and cache fields](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)

No third-party implementation was copied into this fixture. The dashboard was
inspected to identify the request contract; the proof is independently written.
