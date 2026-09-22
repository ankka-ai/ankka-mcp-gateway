# Agent-authored API sources

An agent reads API documentation, writes JavaScript, tests it, and activates
ordinary MCP tools through Gateway Management. The API need not provide MCP or
an OpenAPI document. JavaScript handles pagination, joins, branching and response
transformation; Ankka supplies isolation, a bounded authenticated HTTP capability,
durable source versions and the MCP endpoint.

The runtime is built into every new gateway release. It runs in your gateway
Worker, using the existing `AdminState` SQLite namespace and the fixed
`API_LOADER` binding. There is no feature flag, separate deployment, or extra
service binding. Each configured connection has its own source definition,
revision, and ordinary MCP endpoint.

The built-in runtime starts with `gateway-v0.2.0`. Existing v0.1 gateways need a
fresh installation because their updater rejects the new signed binding contract.

Installation includes the runtime; updates recreate its loader and inherit the
account-owned connection secret without reading it. Gateway removal deletes the
Worker, its secrets, and the existing storage namespace. Source removal uses the
ordinary receipt-owned lifecycle to remove its Portal mapping, server, and Access
applications/policies. Removing a source revokes calls; its saved definition and
account-configured connection remain available for reuse until you remove them
or remove the gateway.

## Agent workflow

Assign the relevant tools on the Gateway Management
source. Existing management allowlists are not expanded automatically.

1. Call `get_api_source_runtime` to list configured connections and the authoring
   guide. Call it with `connectionKey` to read that source’s code and revision. Read the API's documentation with the agent's existing tools.
2. Call `save_api_source_draft` with `connectionKey`, `revision` and `definitionJson` (a JSON string).
   This saves the candidate without changing the active source.
3. Call `test_api_source_draft` with `connectionKey`, the returned revision, `tool` and
   `argumentsJson`. It executes real reads against the configured upstream.
   Inspect the returned data, correct the code, and repeat. Every edit invalidates
   previous test markers. A failed retest clears that tool's successful marker.
4. Call `activate_api_source` with `connectionKey` and the tested revision. Every declared tool must
   have passed a test against that draft and connection. Tests establish example
   behavior, not semantic correctness or proof that an API is read-only.
5. Add the returned `/api/api-sources/<connectionKey>/mcp` URL with the existing `save_mcp_source_draft` and
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

Configure `ANKKA_API_CONNECTIONS` as a **secret directly on your gateway Worker**
in your team’s Cloudflare account. It is a JSON object keyed by connection name
(lowercase letters, digits and hyphens, starting with a letter, up to 32 characters).
Each entry contains `connection` and `credential`. For example, the non-secret
connection portion of an `inventory` entry is:

```json
{
  "origin": "https://api.example.com",
  "upstreamEnforcesReadOnly": true,
  "authHeader": "authorization",
  "authPrefix": "Bearer "
}
```

Put the actual provider credential in the entry’s `credential` field using your
account’s secret setup workflow. Keep it out of agent conversations, management
MCP, repository files, source definitions and Ankka-hosted services. The secret
pairs the fixed origin and authentication format with the credential, so the
agent cannot redirect a saved credential to a different origin. Management MCP
returns only connection names and non-secret connection settings.

An empty gateway returns an empty connection list and setup instructions; the
API authoring tools are always available. Up to 32 configured connections share
the gateway’s existing storage, with independent source state. The secret is
limited to 32 KiB. `authHeader` accepts `authorization`, `x-api-key`, or `api-key`;
`authPrefix` accepts empty, `Bearer ` or `Basic `.

Use only an independently verified provider identity whose permissions reject
mutations, or an account-owned upstream enforcing that boundary. The
`upstreamEnforcesReadOnly` flag records this prerequisite; it cannot establish
those permissions. Neither GET nor an agent’s declaration proves read-only
behavior.

Registering the returned endpoint through the ordinary source lifecycle creates
its dedicated Access application and Portal policy. Team changes synchronize both
policies. The endpoint checks the exact source audience, current receipt-owned
assignment, and enabled tool names on every call. Data-source access does not
grant Gateway Management access. The gateway’s existing management credential is
required for these live policy checks. Source-provider credentials are never
forwarded to Cloudflare’s control plane by the API executor.

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

## Validation

```sh
npm run test --workspace @ankka/api-source-runtime
npm run build --workspace @ankka/api-source-runtime
node --test apps/installer/test-runtime/api-source.test.mjs
npm run check:fast
```

The runtime suite uses synthetic credentials/data, real isolated execution, SQLite
and signed synthetic Access JWTs. Provider requests are intercepted locally.

Local tests cover isolated execution, per-connection state, ordinary source
installation, exact audience/tool checks, Team assignment and revocation,
receipt-owned source removal, and secret inheritance during updates. A deployed
Cloudflare canary is still needed to qualify real Managed OAuth/Portal syncing
and hosted resource limits. Synthetic tests do not establish those properties.
