# Agent instructions

Treat this as a public repository. Every commit, test fixture, comment, and Git
revision must be publishable.

## Product boundary

Ankka MCP Gateway is the self-hosted edge for your team's MCP sources, first
on Cloudflare. Runtime resources, policies, logs, and upstream credentials
belong to the team's account. Public source grants no deployment authority.

Keep private code, data, semantic content, history, signing material,
credentials, Cloudflare account/resource IDs, and generated releases out of
this repository. Explicitly documented non-secret service hostnames and OAuth
client identifiers are allowed. See [Contributing](CONTRIBUTING.md).

## Security invariants

- MCP source-provider credentials must never transit or be stored by Ankka.
  The distinct Cloudflare installer grant is operation-scoped: it exists only
  in the connected callback's request-local memory and, where a reviewed relay
  requires it, is forwarded once to the exact HMAC-authenticated gateway
  Worker. It is never persisted, logged, exposed to any other destination, or
  reused for another action.
- The distinct optional `ANKKA_MANAGEMENT_TOKEN` is an account-owned secret
  configured directly on the customer Worker. Only fixed routine source and
  Team operations may use it. Never send it through Ankka-hosted infrastructure,
  return it to a browser, or persist it in Durable Object state. Its account-wide
  provider authority must be disclosed; ownership checks constrain our code.
- Secrets must not appear in configuration files, logs, exceptions, telemetry,
  tests, snapshots, or deployment output.
- Self-hosted gateways send no telemetry to Ankka. The Ankka-hosted
  installer may collect documented, server-authored, session-scoped funnel
  events by default. Its exact fields, destination, retention, and user-facing
  notice must remain public; it must not add cookies, cross-session identifiers,
  account or user identifiers, IP or raw user-agent storage, provider-resource,
  credential, or free-form dimensions.
- The initial capability boundary is read-only with explicit tool allowlists.
- Prompts and tool names are not authorization boundaries; upstreams must also
  enforce the allowed operations.
- Do not introduce arbitrary credential forwarding or open-proxy behavior.

## Keep the work lean

- Preserve the security invariants with a few simple, auditable boundaries.
- Add dependencies, IAM, policy engines, approval steps, or audit infrastructure
  only for a current product need or demonstrated risk.

## Product language

- Address people as "you" and "your team" in product copy. Use "users" for
  people connecting through the gateway and "gateway operators" or
  "administrators" for the people managing it.
- Describe the deployment as "self-hosted" or "in your Cloudflare account";
  do not imply a commercial relationship with Ankka.
- Keep existing protocol fields, configuration values, routes, and published
  document paths stable when changing copy.

## Development

- Keep dependencies small. Record transferred material in `ORIGINS.md` and
  `THIRD_PARTY_NOTICES.md`.
- Use `npm run check:code` for quick feedback and `npm run check:fast` before
  a pull request. Run focused tests for the behavior you change. CI owns the
  full `npm run check` gate; it must pass before merge. Do not repeat passing
  checks without a relevant change or failure.
- Work on a branch. `main` accepts pull requests with a passing `check` status;
  merge with rebase or squash (`gh land` opens the PR and auto-merges).
- Never push private refs to `origin`. The clone may contain a private remote,
  local branches, and tags; only publish explicitly selected public refs.
- Use `npm run release -- --help` for release stages. Signing, publication,
  deployment, and activation remain distinct authorized actions. Production
  signing keys and deployment credentials stay outside this repository.
- Read [Contributing](CONTRIBUTING.md) for toolchain and public-history rules,
  and [Operations](docs/OPERATIONS.md) when changing release or deployment tools.
