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

Both grant types are held only in request-local memory, are never written to
Durable Object state, logs, analytics, browser output, or support evidence, and
are subject to bounded revocation attempts before their local copies are
discarded.

Revocation is a provider operation and may be unconfirmed. Discarding a local
copy does not prove provider-side revocation.

Routine source installation and Team policy management use the optional
`ANKKA_MANAGEMENT_TOKEN` secret in the customer's Worker. The administrator
creates this account-owned credential and enters it directly in Cloudflare;
Ankka-hosted infrastructure never receives it. It is used only with fixed
Cloudflare API operations and is never persisted in Durable Object records or
returned to the browser. Deployment, updates, DNS, teardown and upstream
credentials retain separate authority. See [Management token](MANAGEMENT_TOKEN.md).

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

The gateway Durable Object stores secret-free configuration, exact source
allowlists, action journals, release state, and ownership receipts. It must not
store Cloudflare OAuth grants or upstream tokens.

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
