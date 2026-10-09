# Debugging and release operations

Agent and maintainer guidance for diagnosing failures, verifying deployed
changes, and running releases. [AGENTS.md](../AGENTS.md) points here instead of
loading this text on every turn. Known failure signatures live in
[solutions/](solutions/README.md); search them for the error text first.

- Optimize for the shortest reliable path from diagnosis to verified fix.
  Reuse existing commands and automation; do not introduce another framework,
  approval round, or blanket release gate to solve a narrow operational issue.
  Preserve the security invariants and required CI checks in AGENTS.md.
- Prefer the Cloudflare `cf` CLI and existing authenticated diagnostic APIs
  over browser inspection. The `cf` CLI is available in the local development
  environment. If it is not on the current shell's PATH, locate the installed
  CLI and its existing authentication setup before falling back to the browser;
  a failed `command -v cf` does not mean it is unavailable; it is the `cf` npm
  package, so `npx cf` runs it. Keep machine-specific paths and credentials out
  of this repository. Use the browser for consent or behavior that needs UI
  verification. Never broaden access or expose credentials to avoid a login.
- For connector authentication failures, follow the diagnostic runbook in
  [Gateway Management](GATEWAY_MANAGEMENT_MCP.md#diagnostic-access-for-agents).
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
