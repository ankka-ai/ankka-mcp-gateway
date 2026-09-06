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
  everyday browser profile. Sign into this profile in ordinary Chrome first, then
  close that test window before the command opens it. This supports identity
  providers that refuse interactive sign-in in automation-controlled browsers.

Provide the already-authorized operator token through `CLOUDFLARE_API_TOKEN`.
It is used for isolated installer deployment and direct Cloudflare read-back.
The command never sends it to the installer or gateway. The distinct management
token is entered directly as the installed gateway's encrypted
`ANKKA_MANAGEMENT_TOKEN` secret in Cloudflare. The command never receives it.

The command opens its own Chrome window, temporary unless a dedicated profile is
configured. Complete login and review
the real Cloudflare consent pages there. It does not attach to your everyday
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
