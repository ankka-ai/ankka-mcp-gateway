# Live lifecycle validation

This command is the customer-path layer: browser onboarding, real OAuth
consent, the deployed Durable Object's handovers and the hosted removal job.
Unattended development runs use the [lifecycle runner](AGENT_LIFECYCLE.md)
instead; neither replaces the other's evidence.

The live command creates and removes a disposable gateway. It requires a prepared,
published pair of distinct signed releases and an isolated installer. It does not
use production signing keys or prepare accounts, billing, OAuth clients, or token
permissions for you. Those are setup prerequisites, not proof that validation passed.

Run the fixed offline regressions with `npm run validate:lifecycle`. For the live
run, use `npm run validate:lifecycle:live -- --config /private/path/config.json`.
The config file must be outside the checkout with mode `0600`; its journal directory
must have mode `0700`. Generated installer directories are validated against their
review records before each deployment. Both must target the same isolated installer,
account, signing public key, and zone. Production installer hosts are refused.

Install `cloudflared`, then authenticate to the isolated installer once using
`cloudflared access login --quiet --app <isolated-installer-origin>`. Complete this
login in your normal browser. Before any deployment, check the cached session with
`npm run validate:lifecycle:live -- --config /private/path/config.json --check-access`.
This check uses HTTP and the cached Access identity; it opens no browser, needs no
operator token, and creates no journal or cloud resources. It verifies the email
returned by Cloudflare's same-origin `/cdn-cgi/access/get-identity` endpoint.
It does not qualify the lifecycle or verify dashboard login. Use `--preflight`
to additionally validate the signed release pair and read the target provider
inventory with the operator token. These checks cannot prove that all future
write permissions or consent steps will succeed.

The runner reads the cached Access token into memory and installs a secure,
host-only `CF_Authorization` cookie in its own browser context. Browser navigation
and API calls share that context, preserving the application's CSRF and callback
cookies. It checks the configured administrator email and expiry locally;
Cloudflare verifies the token's signature, audience and policy. Tokens never enter
command arguments, logs, or the journal. Authentication failure stops before
installer deployment. An expired cache requires another normal-browser login.
For the new gateway, the first read redirected to Access can start a quiet
`cloudflared` login in your normal browser. Writes are never retried for login.

## Independent API checks

Use local `npm run validate:lifecycle` during development. It needs no account,
credentials, Chrome, or network. For source and Team changes, run the live management
exercise independently on an already installed disposable gateway:

```sh
npm run validate:lifecycle:live -- --config /private/path/management.json --management-api
```

The minimal config contains `schemaVersion: 1`, `managementOrigin`, `adminEmail`,
`journal`, and `source: { url, tool }`. The same private file and journal directory
permissions apply. No signed releases, browser profile, or infrastructure token
are needed. The gateway must already hold its management secret and have no sources
or members. Authenticate once with `cloudflared access login --quiet --app
<management-origin>` in your normal browser. The command only reads that cached
session; it never starts interactive login.

### As the service identity

An isolated installer deployed with `ANKKA_SERVICE_ACCESS_CLIENT_ID` and
`ANKKA_SERVICE_ACCESS_TOKEN_ID` opts every gateway it certifies into that one
Access service identity (the live config's `serviceAccess` section supplies
both, and the browser runner passes them as deployment variables; the hosted
installer never carries them). A management config with the same
`serviceAccess` section, holding the secret only by keychain or environment
reference, runs the exercise over the deployed protected routes as that
identity: no browser, no cached human session, no login. Before the exercise
it proves the gateway refuses the update and teardown action routes, source
action cancellation and update action reads to the service identity (`403`),
and, when the section names a `foreign` service token, that an unapproved
identity is refused before it reaches the gateway: the Access edge answers a
service token no policy admits with a redirect to its login page (recorded by
status, `302`; `401` and `403` also count). The journal records the actor as
`service`.

This mode uses the same management exercise as the full lifecycle: install the
synthetic source, verify default deny, grant synthetic membership, then remove it.
It leaves the source installed for subsequent product removal; it does not delete
the gateway or automatically undo an uncertain write. Keep its private journal and
use the existing product removal flow afterward. Do not run it against a gateway
currently reserved for a fresh full lifecycle run.

A management pass is recorded as `management_api`, with `qualified: false`.
Installation, signed update, OAuth callbacks, and teardown recovery still use the
full browser lifecycle below. There is no browserless full lifecycle qualification.

Inspect either kind of journal without network access:

```sh
npm run validate:lifecycle:live -- --config /private/path/config.json --status
```

The summary includes scope, passed stages, the last stage, a fixed failure code,
and whether a removal receipt is available. It omits configuration, credentials,
and the receipt itself. A saved receipt supports `--recover-removal` with the full
lifecycle config; earlier failures still require the recorded product recovery flow.

## Full browser lifecycle

The private config has these fields:

- `schemaVersion`: `1`.
- `accountId`, `zoneId`: the disposable account and its active zone.
- `installerOrigin`, `managementOrigin`: distinct HTTPS origins in that zone.
- `installerA`, `installerB`: absolute generated isolated installer directories,
  including their validated publication receipts and release pins.
- `releaseA`, `releaseB`: objects containing `release` and `artifactSha256`, exactly
  matching those pins. Both version names and artifact hashes must differ.
- `journal`: an absolute, new private JSON file path.
- `basics`: `gatewayName`, `zoneName`, `managementHostname`, `portalHostname`,
  `adminEmail`, and an empty `additionalAdminEmails` array.
- `source`: `url` and `tool` for a synthetic, public HTTPS MCP endpoint with no
  authentication and one read-only tool. The command adds only that tool.
- Optional `browserProfile`: an absolute, dedicated Chrome profile directory outside
  the checkout, mode `0700`. Its `.ankka-lifecycle-profile` marker contains
  `Dedicated Ankka lifecycle test browser` followed by a newline. Never select your
  everyday browser profile. Close that test window before the command opens it.
  A profile retains application sessions; it does not guarantee that Google will
  allow new sign-ins from an automated browser.
- Optional `browserConnection`: `"chrome"` attaches to already running Chrome
  through its built-in remote debugging setting. This is mutually exclusive with
  `browserProfile`. Enable it explicitly at `chrome://inspect/#remote-debugging`
  and approve Chrome's connection prompt. The runner waits up to two minutes for this approval. It grants browser-session access, so use
  it only for a trusted local runner. The runner opens and closes only its new test
  tab, preserves existing tabs and the context, and disconnects on exit. Disable
  debugging after the test if you enabled it only for this run. It does not copy
  your profile or export stored cookies.

Provide the already-authorized operator token through `CLOUDFLARE_API_TOKEN`.
It is used for isolated installer deployment and direct Cloudflare read-back.
The command never sends it to the installer or gateway. The distinct management
token is entered directly as the installed gateway's encrypted
`ANKKA_MANAGEMENT_TOKEN` secret in Cloudflare. The command never receives it.

The command opens its own Chrome window, temporary unless a dedicated profile is
configured. Review the real Cloudflare consent pages there. Access login through
`cloudflared` authenticates the protected installer and gateway; it does not
authenticate the Cloudflare dashboard or grant permission to deploy, update, or
remove infrastructure. If Google blocks dashboard login in this browser, stop:
the Access check can pass while the full consent flow remains blocked. Do not
disable browser security or count that check as a successful live lifecycle.
By default, the command uses a separate test browser. Only the explicit
`browserConnection` option attaches to your existing Chrome session. Neither
mode exports cookies or saves browser traces. A configured profile retains login
sessions locally; protect it and remove it when qualification is finished. When prompted, install and
activate the management secret directly in Cloudflare. No consent is expected
for the synthetic source installation or the grant and removal of
`qualification@example.com`. An OAuth handoff for those operations fails validation.

After the signed A → B update, the command discards the browser response from a
successful dependency-removal callback. It verifies that dependencies are absent,
then uses fresh consent to recover the saved completion. It saves the signed
removal receipt privately, clears only its hosted removal-session cookie, imports
that receipt, and finishes root removal. A passing result requires direct provider
checks for the captured resources, Worker, namespace, and exact hostnames.

Every write is preceded by a durable private checkpoint. Unknown writes stop the
sequence without automatic retry or blind cleanup. Reusing an existing journal for
a new run is refused. A saved final-removal receipt can be resumed with the same
config and `--recover-removal`. Recovery does not turn an incomplete lifecycle run
into a passing lifecycle result. Before a receipt exists, use the product's existing
setup/removal recovery flow and the recorded action references.

An exclusive `.lock` file protects the journal while the command runs. If the
process is forcibly terminated, verify that it has exited before removing its stale
lock. Journal replacements are atomic and synced. Keep the journal and receipt until
cleanup is independently confirmed; they contain private configuration and resource
references and must never be committed. The command leaves the prepared installer,
relay, releases, and temporary setup tokens for separately authorized fixture cleanup.

### Failed-run evidence

A stopped run saves a `diagnostics` object beside its final journal event and
prints the same compact report. It names the failed stage, the last recorded
mutation stage, the fixed failure code, and whether a removal receipt exists.
When a shell was recorded and the operator credential can query Workers
analytics, it includes numeric request/error counts and CPU/memory quantiles
from the preceding 30 minutes. Missing permissions, unavailable metrics, or a
failed diagnostic request do not hide the original failure. No extra permission
is required just to run the lifecycle.

Reports omit raw provider error messages, request URLs, headers, cookies,
credential values, account IDs, and resource IDs. Keep the full journal private:
it remains the authority for exact action and receipt recovery. A report never
retries an ambiguous write or authorizes broad cleanup.

The preflight also sends an unsigned empty request to the installer's signed
configuration endpoint. It must reach a JSON validation rejection. An Access
login redirect is reported before a fresh shell is created; changing that Access
rule remains an explicit operator action.
