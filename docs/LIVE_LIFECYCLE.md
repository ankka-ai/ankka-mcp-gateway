# Live lifecycle validation

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
This check uses a temporary browser, needs no operator token, and creates no journal
or cloud resources. It does not qualify the lifecycle.

The runner reads the cached Access token into memory and installs a secure,
host-only `CF_Authorization` cookie in its own browser context. Browser navigation
and API calls share that context, preserving the application's CSRF and callback
cookies. It checks the configured administrator email and expiry locally;
Cloudflare verifies the token's signature, audience and policy. Tokens never enter
command arguments, logs, or the journal. Authentication failure stops before
installer deployment. An expired cache requires another normal-browser login.
For the new gateway, the first read redirected to Access can start a quiet
`cloudflared` login in your normal browser. Writes are never retried for login.

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
The command does not attach to your everyday
browser, export cookies, or save browser traces. A configured profile retains login
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
