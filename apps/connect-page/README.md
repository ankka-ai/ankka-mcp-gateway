# MCP connection page

An optional, account-owned Worker that serves connection instructions when
someone opens the gateway's `/mcp` URL in a browser. It reuses Ankka's original
wordmark and includes a copy button and instructions for ChatGPT, Claude,
Cursor, Google Gemini, and other remote MCP clients. Client sections start
collapsed, with locally bundled icons. It has no runtime dependencies, storage,
analytics, external assets, or credential configuration.

**Status:** implemented and tested locally, including workerd. Cloudflare
managed Portal routing precedence has not been verified live. This Worker is
not part of the signed gateway release or the install/update/uninstall
lifecycle. Do not attach it to a production Portal until the disposable
deployment checks below pass. Installing it manually makes its route and
Worker separate resources that the gateway installer does not remove.

## Request handling

The Worker only handles HTTPS requests for its configured `MCP_HOSTNAME` and
the exact `/mcp` path. Other hosts and paths return 404 without a subrequest.

It serves HTML only for GET requests with no query string, an explicit
nonzero `text/html` Accept value, `Sec-Fetch-Mode: navigate`, and
`Sec-Fetch-Dest: document`. Requests carrying an Authorization header,
Cloudflare service-token headers, MCP protocol/session headers, a streaming
resume header, or JSON/SSE Accept values always go to the Portal. Browsers
that omit navigation metadata retain the Portal response.

Everything else on `/mcp` uses `fetch()` to the **unchanged request URL**.
This relies on Workers **Routes**, which fetch the existing origin. It must
not be deployed as a Custom Domain replacing the Portal. The proxied Portal
CNAME remains `gateway.agents.cloudflare.com`. Request bodies and response
streams are not buffered, decoded, logged, or changed. Redirects are returned
to the client without following them or forwarding credentials elsewhere.
OAuth metadata, authorization, registration, and token paths are outside the
Worker route. The page is public instructions; it does not grant tool access.

HTML responses use `private, no-store`, request-header variation, a per-response
CSP nonce, no framing, and no referrer. There are no secrets, private source
names, tool catalogues, or management links in the page. The displayed URL is
derived only from the validated deployment hostname.

## Local preview and checks

From the repository root:

```sh
npm run dev:connect
npm run build:connect
node --test test/connect-page.test.mjs
node --test apps/installer/test-runtime/connect-page.test.mjs
npm run check:fast
```

The preview prints a loopback URL, uses `connect.example.com` in the page,
and never makes network requests. Its non-page responses are synthetic.
The core tests cover request selection, authentication challenge preservation,
POST payloads, streaming, redirects, host/path restrictions, and CSP. The
workerd test bundles the actual page and Worker. These tests do not establish
Cloudflare Access/Portal/Workers route ordering.

## Disposable Cloudflare verification

Use an operator-owned disposable gateway in the intended Cloudflare zone;
follow `docs/AGENT_LIFECYCLE.md` for gateway lifecycle and credential custody.
Do not reuse an installer grant or the gateway management token to deploy this
optional Worker. Use your normal account-owned deployment session with Workers
Scripts and Workers Routes permissions, directly against Cloudflare.

Record the baseline browser response, unauthenticated MCP POST and streaming
GET challenges, OAuth metadata, and an authenticated client session first.
Check for an existing overlapping Worker route. Do not replace someone else's
route or change Portal DNS or Access policies.

Deploy from the repository root, replacing the synthetic hostname and Worker
name with the disposable target. No account ID or credential goes into the
checked-in configuration:

```sh
npx --no-install wrangler deploy \
  --config apps/connect-page/wrangler.jsonc \
  --name ankka-connect-page-disposable \
  --var MCP_HOSTNAME:connect.example.com \
  --route 'https://connect.example.com/mcp*'
```

The route's trailing wildcard includes MCP requests with query strings, which
pass through unchanged. Other paths starting with `/mcp` are refused. Never
use a hostname-wide route: it would intercept OAuth endpoints.

Verify the deployed behavior:

1. Open `/mcp` in a browser: 200 HTML, correct URL, copy button and instructions.
2. Send a GET accepting `text/event-stream` and a JSON-RPC POST without a token:
   the same Portal authentication challenge as the baseline, never HTML.
3. Connect with a real OAuth-capable MCP client: discovery, sign-in,
   initialization, tool listing, tool call, streaming and session cleanup work.
4. Verify that the Portal's OAuth endpoints and existing client sessions still
   work, and that the Worker has no logs, tail consumers, or telemetry enabled.
5. Remove the new route and confirm the baseline responses return. Delete the
   standalone Worker after the disposable run.

If Access or the managed Portal answers before the Worker, stop and remove the
route. Do not relax authentication to make the page visible. That deployment
needs a separately hosted guide or provider-supported browser routing instead.
Only after successful live verification should the same narrow route be
considered for an existing gateway. Rollback is removal of that route; the
original Portal and DNS remain in place.

## Reference material

- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Cloudflare Workers Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)
- [Cloudflare Portal homepage](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#portal-homepage)
- Client setup links are embedded in the page and were reviewed on 2026-10-08.

Cloudflare documents a connection homepage at the Portal root, but deployment
availability must be checked before depending on it. This Worker does not
redirect to that homepage.
