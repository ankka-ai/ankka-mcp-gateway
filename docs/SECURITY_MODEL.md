# Security model

This document describes the intended security boundary of Ankka MCP Gateway.
The project is a canary preview and is not a substitute for reviewing Cloudflare,
each upstream MCP server, and the exact signed release before deployment.

## Trust boundaries

The deployment trusts:

- the team's Cloudflare account and its administrators;
- Cloudflare Workers, Access, MCP Portal, DNS, and OAuth services;
- the exact signed gateway release; and
- each explicitly approved upstream MCP server.

Open source makes the gateway implementation inspectable. It does not
remove those external trusts.

An optional Ankka MCP source has no special access to other sources or their
credentials.

## Credentials

MCP source-provider credentials must remain in the team's Cloudflare
account. Ankka does not ask for, store, relay, or log them.

The hosted installer's Cloudflare OAuth grants are separate from MCP source
credentials. The first grant is read-only: it is bound to the authorizing actor,
discovery purpose, and expiry, and is used to discover eligible accounts and
zones before the operator selects a target.

A later mutation grant is created only after the user reviews an exact action.
It is additionally bound to the selected account and target and is used only
for the approved provider calls or one exact authenticated gateway Worker
action.

Both grant types are held only in memory: in the callback request, or, for an
operation that runs behind a progress page, in the owning Durable Object for
one bounded attempt window. They are never written to Durable Object state,
logs, analytics, browser output, or support evidence, and are subject to
bounded revocation attempts before their local copies are discarded. An object
restart between passes loses such a grant and stops the attempt as
recovery-required with an unconfirmed revocation; a fresh consent resumes from
the durable step receipts.

Revocation is a provider operation and may be unconfirmed. Discarding a local
copy does not prove provider-side revocation.

Routine source installation and Team policy management use the optional
`ANKKA_MANAGEMENT_TOKEN` secret in the customer's Worker. An administrator of
the Cloudflare account creates this account-owned credential, and it never
passes through anything Ankka hosts. It is entered either into the customer's
own gateway, on the setup page that Worker serves before the second approval,
or directly in Cloudflare on an installed gateway. During setup the value is
held like the install grant: only in the owning Durable Object's memory,
until the final runtime upload the install already makes writes it as a
secret binding. It is never written to Durable Object storage, the install
journal, a receipt, a log line, an error, a URL, or any response; an object
restart loses it, and the install then completes without it. It is used only
with fixed Cloudflare API operations and is never returned to the browser.
Cloudflare cannot scope it to the gateway's own resources: it can edit every
Access policy in the account, and the setup page says so before asking for
it. Deployment, updates, DNS, teardown and upstream credentials retain
separate authority. See [Management token](MANAGEMENT_TOKEN.md).

An operator-controlled external runner executes the same fixed lifecycle
operations for disposable development gateways with an operator-managed
credential. The operation authority catalogue declares that lifecycle
separately: the credential lives in the operator's store, is never exchanged,
persisted or revoked by an operation, and never enters a gateway or an
Ankka-hosted service. Its runner records and signed removal handoffs are its
own; the hosted finalizer refuses a handoff that did not come from a revoked
gateway grant. See [the runner guide](AGENT_LIFECYCLE.md).

Cloudflare support confirmed that account-owned and user-owned API tokens can
scope resources only at User, Account, or Zone level. **Access: Policies
Write** on one account therefore authorizes every Access policy in that account;
it cannot be restricted to one reusable Ankka policy. Per-policy Access Policy
Admin scoping belongs to the human/member IAM model, whose resource-scoped OAuth
path currently has a beta gap for individual policy API requests. See
[Team access](TEAM_ACCESS.md) for policy and existing-session limitations.

## Authorization

The initial source boundary is read-only with exact tool allowlists. Wildcards
are rejected. Tool names, descriptions, and source-authored annotations are
untrusted review aids; the upstream and Cloudflare policy must independently
enforce allowed operations.

Browser requests cannot select arbitrary Cloudflare accounts or provider
resources. The installer binds discovery, configuration, plan approval, OAuth
state, and execution to one expiring session and target. CSRF, OAuth state, and
PKCE are purpose-separated.

Every provider write is preceded by an intent record. A successful result
requires fresh read-back of the expected resource shape. Unknown outcomes
remain pending and are not replayed blindly.

## Gateway dashboard

<a id="customer-dashboard"></a>

The management dashboard runs in the team's Cloudflare account on a
hostname separate from the MCP Portal. Cloudflare Access protects the origin,
and the Worker independently verifies the Access JWT issuer, audience,
signature, expiry, verified email, and deployment administrator allowlist.
Cross-origin API requests are rejected.

A gateway can additionally accept exactly one machine identity: the Access
service token whose client id its deployment configuration opted into. The
hosted installer never opts in, so customer installations accept only
administrators. The Worker verifies a service token exactly like an
administrator's token and then authorizes the exact `common_name` claim
(`type: app` appears on both kinds of token and distinguishes nothing): a
token with an email claim is an administrator or nothing, and a token without
one must carry no identity header and the configured client id. The service
identity acts only within a fixed method-and-route allowlist (status and
update reads, source discovery, draft and apply, Team read and save); update
and teardown action creation and source action cancellation are denied to it,
as is every other route. Action records name it `service:<client id>` and
public views expose the actor kind. A malformed opt-in fails closed for every
caller rather than widening access.

The opt-in is part of the plan's identity (ownership marker and plan hash).
It reaches the runtime as one optional binding and the Access application as
one more receipt-owned policy: a Service Auth policy that admits exactly the
named service token and no identity, created and verified by Stage 2 like the
administrators' policy and stated in the signed teardown handoff. The hosted
finalizer accepts exactly the policies the handoff declares; the Service Auth
policy leaves with the management application, and any other policy stays
foreign and stops removal.

The gateway Durable Object stores secret-free configuration, exact source
allowlists, action journals, release state, and ownership receipts. It must not
store Cloudflare OAuth grants, the management credential, or upstream tokens.
Of the management credential step of setup it stores one fixed word: whether
a token was provided or the step was skipped.

The Team page reads receipt-owned policies live and records an observation time.
A changed live audience advances the local revision before a new proposal can
be saved. Writes verify the exact owned application, sole policy, audience and
Portal mapping, then persist a send journal before each provider write. An
ambiguous response retains the exact proposal for recovery; it is not a rollback.
An unavailable or unrecognized live policy graph is never labeled verified.
Policy membership does not guarantee effective access or immediate revocation
of previously issued sessions.

The default-deny source-onboarding candidate creates each new source with one
exact deny-Everyone policy and verifies the complete policy list before Portal
attachment. No person, including an administrator, receives a new source
implicitly. Upstream operator authentication and a later Team grant are separate
steps. Existing receipt audiences remain immutable; only the exact historical
initial policy and the new empty-audience profile are recognized. Old prepared
source actions cannot silently become new-profile authorizations.

A source that needs sign-in is created with no tools: no tool override on its
server, the same deny-Everyone policy, and no Portal mapping. Its administrator
chooses from the list Cloudflare synced after the operator connection, as a
revision-bound step that re-binds the paused installation's source hash and
server receipt atomically and is refused in every state other than the exact
connection pause. The allowlist is enforced where it is for every source: the
Portal mapping, deny-by-default, with exactly the chosen names enabled and
proven by read-back. Nothing is attached while nothing is chosen. The synced
list is an untrusted review aid like any source-authored text, bounded and
never a provider body.

Legacy Team authorization and callbacks are refused by the installer before
OAuth code exchange. The relay and new Worker also reject the old Team grant
submission. Team management does not enable a temporary `workers.dev` route.
Other installer action callbacks retain their existing operation-scoped grant
handling.

## Ownership, recovery, and removal

Resource names and provider IDs are not deletion authority. Removal requires a
checksum-valid installation receipt, an exact target match, fresh provider reads,
and expected ownership markers.

The receipt and journal preserve recovery authority after interruptions. A
missing, corrupt, conflicting, or ambiguous record stops automatic mutation.
Only receipt-owned resources are removed, in reverse dependency order.

### Recovery of an interrupted dependency removal

Dependency removal journals a prefix of removed resources in removal order and
at most one pending deletion boundary (`send_armed`, `submitted`, or
`not_applied`). The compiled gateway performs one provider step per callback
pass and records its progress under the callback's request identity. The
synthetic-provider regression `test/worker-teardown-recovery.test.mjs` proves
these guarantees for an interruption at every pass boundary, an unknown
provider answer at a read or a DELETE, an Access deletion accepted with HTTP
202 that still reads present, a rejected DELETE, an ownership conflict, and a
foreign Portal mapping the gateway's server:

- Settling the interrupted attempt closes its action and leaves the receipt
  and the journal unchanged; a fresh consent can start at once, or after the
  unsettled action expires.
- A fresh consent rechecks Portal sharing and reads every resource before any
  mutation: removed resources must read absent, live resources must read
  exactly, and only the pending boundary may read either way.
- A resource that reads absent is recorded as removed and is never sent a
  DELETE. A pending boundary is re-read before any DELETE, so a lost or
  accepted-but-unfinished deletion is confirmed by reading, not repeated. A
  boundary that still reads present is deleted again only under the fresh
  grant; the grant that armed or submitted it never resends it.
- An unknown answer is never absence. A conflicting read or a shared server
  stops every consent without deleting anything until the resource reads
  exactly again or the server is unmapped. This is recovery-required by design.
- The journal is bound to the exact dependency graph: the ordered
  receipt-owned resources, the policy mode, and any partial bridge actions. It
  is not bound to the mutable management records, so a source draft saved
  between consents does not strand the recorded removal, while a journal
  recorded for another graph is never resumed.
- Completion records exactly one applied deletion per resource and leaves the
  installation receipt unchanged.
The hosted root finalizer bounds what one attempt reads without weakening
these checks: the complete ownership preflight and the scan of other Workers
in the account run once per attempt, and only Workers modified at or after
the gateway's creation are read (a missing timestamp means read it); each
deletion is preceded by an identity re-read of its own resource; a settling
write is re-read on the owner-side resources it touched. Every provider and
journal call counts against a fixed budget of fifty, and an attempt that would
exceed it stops before the platform's cap with the resumable reason
`budget_exhausted`, so its grant is still revoked and its pending step stays
armed for the next consent.

## Software supply chain

The repository contains no private signing key, production deployment
credential, generated signed release, or release-publication authority.

Release tooling requires a clean public source commit, deterministic payload
inputs, a complete manifest, one exact HTTPS control-plane origin, and an
external Ed25519 signature. The origin is compiled into the gateway Worker
before hashing. The installer verifies the signed channel, key identity,
origin, manifest, deployment contract, and every payload digest before use;
requests and gateway configuration cannot redirect that authority.

See [Release integrity](RELEASING.md) for publication and signing-key lifecycle
requirements.

Normal updates are limited to Worker code and management assets. Changes to
permissions, bindings, migrations, compatibility settings, signing keys, or
provider resources require a separately designed and approved release path.

The V1 signed release contract declares no Team-management secret. A forward
update may recognize the one retired preview binding only so it can omit that
binding from the new version; it never reads or inherits the value. Rollback
into or out of a version carrying the retired binding is refused. Anyone who
created the old API token must revoke it separately in Cloudflare because
removing a Worker binding does not revoke provider authority or erase historical
versions. See the preserved [retirement procedure](TEAM_UPGRADE.md).

The original teardown restrictions remain if a legacy Team policy write may
have occurred, even after token revocation or binding removal.
New-profile source creation uses the same conservative floor/removal safeguard
before its first provider mutation. Source discovery, draft saving, and action
review do not arm it. This restriction is disclosed before source authorization
and must be reviewed before release activation; it is not deletion authority.

## Logs and telemetry

Secrets, raw provider responses, account or user identifiers, and free-form provider
errors must not appear in application logs, errors, analytics, tests, or
support output.

Self-hosted gateways send no telemetry to Ankka. Their routine Ankka
request is anonymous signed-release discovery and carries no account,
hostname, user, cookie, authorization, or referrer.

The optional Ankka-hosted installer records no analytics: it keeps a
short-lived setup session and nothing that outlives it. Cloudflare separately
adds Network Error Logging headers to hosted-zone browser responses, and
browsers may send the resulting reliability reports to Cloudflare. Neither
mechanism is installed in the gateway.

Cloudflare and upstream providers may retain their own operational data under
the team's configuration and their policies. The no-Ankka-telemetry
guarantee does not claim that those providers process no metadata.

## Known limitations

- Signed canary releases are available; there is no stable,
  production-supported release yet. Review the exact
  [release](https://github.com/ankka-ai/ankka-mcp-gateway/releases), not only
  the current main-branch source.
- The default installer activation in the public source is disabled. A
  reviewed canary entrypoint uses an exact signed release pin and separately
  reviewed deployment configuration. Public source and the local UI preview
  do not confer live deployment or removal authority.
- Read-only tool policy depends on both gateway configuration and upstream
  enforcement.
- Worker rollback does not roll back Durable Object data.
- Automatic teardown is unavailable while a source, Team, update or removal
  action is unsettled, and for installations whose Team state was written
  under the retired legacy policy profile. The current receipt-owned executor
  accepts changed policy audiences. Revoking a retired preview token or
  restoring the original roster does not clear a recorded legacy restriction.
- Provider APIs can return ambiguous outcomes; the system stops for recovery
  instead of claiming success.
