# Agent instructions

Treat this as a public repository. Every commit, test fixture, comment, and Git
revision must be publishable.

## Product boundary

Ankka MCP Gateway is the self-hosted edge for a team's MCP sources.
The first deployment target is Cloudflare. Runtime resources, access policies,
logs, and upstream credentials belong to the team's Cloudflare account.

This repository may contain deployment tooling, the source for Ankka's hosted
installer, declarative configuration, gateway runtime code, public
protocol contracts, and synthetic examples. Public source does not carry
deployment authority: it must not contain private product code, private data,
internal semantic content, Cloudflare account or resource IDs, credentials,
private signing material, generated release output, or private repository
history. Public service hostnames and OAuth client identifiers are allowed when
they are explicitly documented as non-secret.

## Security invariants

- MCP source-provider credentials must never transit or be stored by Ankka.
  The distinct Cloudflare installer grant is operation-scoped: it exists only
  in memory, in the connected callback's request or in the owning Durable
  Object for one bounded attempt behind a progress page, and, where a reviewed
  relay requires it, is forwarded once to the exact HMAC-authenticated gateway
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
- Connected MCP sources may expose read and write tools through explicit tool
  allowlists by default. New tools stay disabled until selected, unless the
  operator explicitly enables All tools for that source, including future tools.
  Upgrades must preserve the saved mode and must not expand upstream grants. Dedicated read-only connectors retain
  their narrower boundaries.
- Prompts and tool names are not authorization boundaries; upstreams must also
  enforce the allowed operations.
- Do not introduce arbitrary credential forwarding or open-proxy behavior.

## Stage-appropriate engineering

- Keep implementation proportional to current users, requirements, and threat
  model. Preserve the security invariants above, but prefer a few simple,
  auditable boundaries over speculative enterprise machinery.
- Do not add generalized IAM, fine-grained RBAC, policy engines, approval
  workflows, or elaborate audit infrastructure without a current product need
  or demonstrated risk. Record a follow-up or narrow extension point instead.

## Product language

- Address people as "you" and "your team" in product copy. Use "users" for
  people connecting through the gateway and "gateway operators" or
  "administrators" for the people managing it.
- Describe the deployment as "self-hosted" or "in your Cloudflare account";
  do not imply a commercial relationship with Ankka.
- Keep existing protocol fields, configuration values, routes, and published
  document paths stable when changing copy.

## Brand presentation

- Use the existing Ankka wordmark prominently, large and centered, with a vertical
  gradient fading to transparent at the bottom. Preserve the original vector
  letterforms; this is the Ankka brand treatment.

## Development

- Use `npm run lifecycle` for unattended disposable gateway runs with an
  operator-managed credential (install, manage, update, interrupt, resume,
  remove); read `docs/AGENT_LIFECYCLE.md` for the job file, credential custody
  and what it does not prove.
- Use `npm run test:runtime` for bootstrap state, SQLite, and crypto runtime
  changes. `npm run dev:runtime` prints a synthetic localhost fixture and its
  inspection API; query traces before adding temporary logs. Read
  `docs/LOCAL_RUNTIME.md` for the local/provider/deployed test boundaries.
- Keep the dependency graph small.
- Record the origin and license of any transferred or vendored material in
  `ORIGINS.md` and `THIRD_PARTY_NOTICES.md`.
- Match local validation to the change; do not run checks by habit.
  For UI copy, comments, documentation, and simple styling or spacing changes
  that do not alter behavior, inspect the diff only. Do not add or run tests,
  typechecks, builds, or `check:fast` for these changes unless explicitly
  requested or a concrete concern requires a specific check. Use a visual
  check only when needed to judge layout.
- For behavior changes, run the smallest relevant tests or checks. Use
  `npm run check:fast` for changes spanning multiple components or when
  narrower checks cannot cover the affected behavior, not after every edit.
  Once relevant checks pass, do not broaden or repeat them without a new
  change, failure, or unresolved concern. The runtime checks required above
  still apply to bootstrap state, SQLite, and crypto runtime changes.
- Before pushing behavior changes to a shared component or API, search its
  callers and related tests for changed props, callback arguments, and copy.
  Run the affected test files together, including page-level caller tests;
  do not limit validation to the edited component's own test file.
- Application test commands must stop on the first failing suite. Run quick
  suites before the slower installer suite so failures are actionable promptly.
- The full `npm run check` release gate runs in continuous integration on
  every pull request and must pass before merge; do not duplicate that gate
  locally for low-impact changes.
- The toolchain is pinned by `.nvmrc`, `packageManager`, and `devEngines`.
  Local drift warns; `check:toolchain` enforces the exact versions in
  continuous integration and at the head of the full gate.
- `main` accepts only pull requests with a passing `check` status. Work on a
  branch; merge with rebase or squash (`gh land` opens the pull request and
  auto-merges when checks pass).
- A working clone may carry the intentionally private `private-history`
  remote, private local branches, and private tags. Never push private refs
  to `origin`. The public-history check audits the publishable surface only:
  `HEAD`, `origin` refs, and tags.
- Bumping wrangler moves reviewed toolchain pins: restate the version,
  lockfile path, and tool-file locations in
  `apps/installer/scripts/generate-reviewed-canary.mjs` and its test, and
  keep the esbuild pin aligned with wrangler's bundled esbuild.
- Never commit `.env`, `.dev.vars`, Cloudflare account/resource IDs, API tokens,
  Terraform state, private keys, or generated deployment output.
- Production deployment credentials, signing keys, and CI authority remain
  outside this repository even when the implementation they invoke is public.

## Debugging and release operations

- Optimize for the shortest reliable path from diagnosis to verified fix.
  Reuse existing commands and automation; do not introduce another framework,
  approval round, or blanket release gate to solve a narrow operational issue.
  Preserve the security invariants and required CI checks above.
- Prefer the Cloudflare `cf` CLI and existing authenticated diagnostic APIs
  over browser inspection. The `cf` CLI is available in the local development
  environment. If it is not on the current shell's PATH, locate the installed
  CLI and its existing authentication setup before falling back to the browser;
  a failed `command -v cf` does not mean it is unavailable. Keep machine-specific
  paths and credentials out of this repository. Use the browser for consent or
  behavior that needs UI verification. Never broaden access or expose credentials
  to avoid a login.
- For connector authentication failures, follow the diagnostic runbook in
  [Gateway Management](docs/GATEWAY_MANAGEMENT_MCP.md#diagnostic-access-for-agents).
  Distinguish `cf` account API reads from authenticated requests to the gateway's
  own API. Read the saved OAuth diagnostic before requesting another sign-in;
  a provider consent page or successful Access login does not prove reconnect.
  Report the rejecting layer and fixed error code, and do not repeatedly retry
  unchanged authentication or browser-signature failures.
- Collect only evidence relevant to the failure. For update issues, distinguish
  the provider deployment, running Worker and Durable Object, and stored release
  versions; include the update stage, timestamps and endpoint failure reason.
  Mark unavailable evidence as unknown; one version field does not prove all
  layers updated.
  For source or Team failures, compare saved tool approvals with the current
  Portal mappings and catalogue. Keep customer details out of public artifacts.
- Gather independent reads together and overlap independent checks when useful.
  Reuse evidence for unchanged code; do not repeatedly inspect the same state
  or rerun passing checks without a specific unresolved question.
- Use the existing release automation and exact-source CI check reuse. Do not
  recreate signing, publishing, or deployment steps by hand. Measure slow phases
  before optimizing them; parallelize independent tests before adding tooling.
- Reuse the release entry point and private runbook already identified in this
  session. Keep machine-specific paths and signing details outside this public
  repository. Do not repeat tooling discovery during the same release task.
- Match live verification to the failure being fixed. For deployed update or
  handover changes, use an isolated gateway and the relevant path documented in
  `docs/LIVE_LIFECYCLE.md`; the in-process lifecycle runner cannot prove a deployed
  Durable Object handover. Do not require a full live lifecycle for every change.
  If deployed evidence is unavailable, state the gap rather than claim coverage.
- An upload is not a verified update. Confirm the running target release, the
  completed update record, and the affected operation; for a Team fix, check
  that Team loads and editing is enabled. Use bounded waits with backoff during
  propagation, and diagnose an uncertain outcome before retrying a mutation.
- Keep progress reports brief: current phase, elapsed wait when relevant, and
  the next useful check. Turn recurring manual diagnosis into a small reusable
  command, extending existing tooling where possible; distinguish proposed
  automation from commands that actually exist.
