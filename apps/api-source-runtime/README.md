# Agent-authored API sources (prototype)

An agent reads API documentation, writes JavaScript, tests it, and activates
ordinary MCP tools through Gateway Management. The API need not provide MCP or
an OpenAPI document. JavaScript handles pagination, joins, branching and response
transformation; Ankka supplies isolation, a bounded authenticated HTTP capability,
durable source versions and the MCP endpoint.

This is an opt-in, self-hosted prototype. The signed installer does **not** yet
provision it, preserve its extra service binding through updates, or remove its
resources. One runtime deployment serves one API source and one independently
configured connection; the prototype gateway binding manages one such runtime.
It has local workerd/SQLite tests, not deployed Cloudflare qualification.

## Agent workflow

After account-owned setup, assign the relevant new tools on the Gateway Management
source. Existing management allowlists are not expanded automatically.

1. Call `get_api_source_runtime` for the connection, authoring guide, code and
   current revision. Read the API's documentation with the agent's existing tools.
2. Call `save_api_source_draft` with `revision` and `definitionJson` (a JSON string).
   This saves the candidate without changing the active source.
3. Call `test_api_source_draft` with the returned revision, `tool` and
   `argumentsJson`. It executes real reads against the configured upstream.
   Inspect the returned data, correct the code, and repeat. Every edit invalidates
   previous test markers. A failed retest clears that tool's successful marker.
4. Call `activate_api_source` with the tested revision. Every declared tool must
   have passed a test against that draft and connection. Tests establish example
   behavior, not semantic correctness or proof that an API is read-only.
5. Add the returned `/mcp` URL with the existing `save_mcp_source_draft` and
   `apply_mcp_source` tools. Complete Managed OAuth sign-in, select the real synced
   tool names and grant the source through Team. New names need Portal sync and
   explicit selection; activation does not change Portal assignments or allowlists.

`discard_api_source_draft` preserves the active version. `disable_api_source`
stops new tool calls without deleting the Portal source. Already running reads
may finish. Read current state after an interrupted management call; revisions
prevent applying the same mutation twice. Activation changes existing tool
behavior for everyone assigned to this source, so management access is privileged.

Minimal `definitionJson`, shown expanded:

```json
{
  "label": "Inventory",
  "tools": [{
    "name": "getStock",
    "description": "Read available stock for a SKU.",
    "inputSchema": {
      "type": "object",
      "properties": { "sku": { "type": "string" } },
      "required": ["sku"],
      "additionalProperties": false
    },
    "requests": [{ "method": "GET", "path": "/inventory/{sku}" }],
    "code": "async (input) => { const data = await api.request({ method: 'GET', path: '/inventory/' + encodeURIComponent(input.sku) }); return { sku: input.sku, available: data.quantity }; }"
  }]
}
```

Each `code` is an async JavaScript function expression receiving the validated
input. `api.request({ method, path, query?, body? })` returns parsed JSON. Query
values are strings. It exposes no response headers, caller-supplied headers,
credential material, arbitrary origin, runtime state, management capabilities or
host environment. A `{parameter}` matches one path segment; the shared outbound
validator separately rejects traversal, encoded separators and redirects.
Use JavaScript to map unusual payloads and orchestrate several permitted reads.
There is no source-specific build, package installation or Worker deployment when
the agent edits a definition.

Input schemas must be object schemas supported by the pinned Zod JSON Schema
converter. The first version handles JSON HTTP APIs, static bearer/API-key/basic
credentials, and GET or POST reads. OAuth refresh, custom request signing, binary
responses and arbitrary npm packages are not supported. This is an executable
source contract, not a promise to connect every service automatically.

## Account-owned setup

An administrator deploys this Worker separately in their team's Cloudflare account
and configures a dedicated custom hostname protected by Cloudflare Access with
Managed OAuth. Set its `PUBLIC_ORIGIN`, `ACCESS_TEAM_DOMAIN` and exact `ACCESS_AUD`.
Use a dedicated application and source policy; everyone admitted to this endpoint
can read the connection's configured data. Keep the source's audience consistent
with Portal assignments, including direct endpoint access. This prototype does
not implement per-user upstream identities or automatic policy reconciliation.

Configure the non-secret `CONNECTION_JSON` directly on that Worker:

```json
{
  "origin": "https://api.example.com",
  "upstreamEnforcesReadOnly": true,
  "authHeader": "authorization",
  "authPrefix": "Bearer "
}
```

Install `PROVIDER_TOKEN` using the customer's own Cloudflare secret workflow.
Never pass it through management MCP, an agent conversation, source code,
configuration files or Ankka-hosted services. `authHeader` accepts `authorization`,
`x-api-key`, or `api-key`; `authPrefix` accepts empty, `Bearer ` or `Basic `.
Credentials are attached by trusted code only to this fixed origin. Use only an
independently verified provider identity whose permissions reject mutations, or
an account-owned upstream enforcing that boundary. The `upstreamEnforcesReadOnly`
flag records this prerequisite; it cannot establish or create those permissions.
Services without such an upstream read-only boundary are not qualified for this
prototype. Neither GET nor an agent's declaration proves read-only behavior.

Bind the gateway management Worker to the runtime's **named**
`ApiSourceManagement` entrypoint as `API_SOURCE_RUNTIME`. This is a trusted service
binding, not a public management endpoint. Only fixed API-source operations are
forwarded; no Cloudflare management token, browser assertion or provider secret
is forwarded. Do not give this binding to generated code or ordinary source clients.
The tools are hidden and calls are rejected when the binding is absent. Existing
Gateway Management assignment, live authorization and exact tool allowlists apply.

Do this only in a separately managed development/canary deployment until signed
release provisioning/update/removal support exists. Adding the binding manually to
a signed gateway is not a supported production setup; an update may remove it or
fail ownership verification. No production account was changed by the prototype.

## Execution and storage

The runtime uses the repository's pinned `@cloudflare/codemode` 0.5.1
`DynamicWorkerExecutor`, with `globalOutbound: null`, no host bindings or extra
modules, a 100 ms CPU limit and a 15-second executor/host deadline. Each invocation may
make at most 12 HTTP requests; the shared HTTP boundary limits individual request
and response sizes and time. Input is limited to 16 KiB, returned JSON to 64 KiB,
and the source definition to 24 KiB/16 tools. The HTTP command envelope also has
the shared 32 KiB inbound limit. Large definitions may need shorter code or fewer
tools to fit the escaped JSON envelope. Hosted CPU enforcement still requires a
Cloudflare canary; local workerd tests are not evidence of hosted resource limits.

SQLite stores only the active/draft definitions, connection identity, revision
and successful test names. It does not store test inputs, API responses, console
output, execution exceptions or credentials. Test outputs reach the invoking
manager and may contain private data; ordinary tool outputs reach authorized
source callers. Logging and tracing are disabled. Write source modules without
embedded private sample data or secrets. Known configured credential echoes are
rejected; this is not a general-purpose secret detector.

An edited draft cannot alter the active version. Optimistic revisions and storage
transactions reject stale saves/activation; a test finishing after a newer edit
cannot mark that edit tested. Changing the connection configuration makes old
active code unavailable and requires saving and testing a new draft.

## Relationship to durable Code Mode

Cloudflare's [durable runtime](https://developers.cloudflare.com/agents/tools/codemode/durable-runtime/)
provides search, execution history and reusable snippets. It can be hosted by an
MCP server without an AI SDK/chat application. Its connectors provide trusted
host capabilities; snippets compose them inside the sandbox.

We reuse its executor, while deliberately keeping source lifecycle state separate.
The documented durable runtime retains unmodified results even with
`transformResult`; enabling that storage would introduce a different data-retention
contract. We also need explicit input schemas, activation, source access and Portal
tool selection beyond saving a snippet. The API source exposes ordinary MCP tools,
so Portal Code Mode remains the model-facing orchestration layer. It does not
advertise an upstream `search`/`execute` Code Mode server.

## Validation and next deployment work

```sh
npm run test --workspace @ankka/api-source-runtime
npm run build --workspace @ankka/api-source-runtime
node --test apps/installer/test-runtime/api-source.test.mjs
npm run check:fast
```

The runtime suite uses synthetic credentials/data, real isolated execution, SQLite
and signed synthetic Access JWTs. Provider requests are intercepted locally.

Before production: add receipt-owned provisioning, connection/secret setup,
service-binding preservation, removal and multi-source routing to the signed
lifecycle; qualify real Access/Portal OAuth, tool synchronization and revocation;
verify hosted sandbox limits; and exercise an independently approved read-only API.
Do not treat passing synthetic tests as completion of these deployment requirements.
