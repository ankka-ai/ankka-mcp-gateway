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
to additionally validate the signed release pair, read the target provider
inventory with the operator token and, when the config opts into the automatic
management-token step, check that its reference resolves and that the
environment would not print the step's request (see below). These checks cannot
prove that all future write permissions or consent steps will succeed.

After the Stage 1 consent the installer page hops to the new shell as soon as the
installer's own readiness probe passes, spending the one-time handoff on that
hop; an edge that does not serve the fresh Worker yet answers it 404 and the
shell never receives its session. The runner therefore answers the page's
handoff poll with the installer's own not-ready body until the shell answers
the runner from its vantage point, then lets the page hop.

The runner gets through Stage 2 by the setup page's routes, not by its
controls: it sends the requests that page sends (`/__ankka/install/setup`,
`/configuration`, `/management-token`, `/oauth/start`) through the test
browser's context, which holds the setup session, and the operator reviews only
the Cloudflare consent. The setup page's **Management token** step keeps the
Approve button hidden until it is answered, and the shell locks the step once
an approval runs, so the runner answers it before it starts the approval, as
the page would: with the `managementToken` opt-in it sends the token ("Use this
token"), without it the choice to go on ("Continue without a token"). Both are
described [below](#full-browser-lifecycle). A release whose setup page predates
the step offers none in its setup view and is asked nothing
(`management_token: step_not_offered`). The approval that follows has its own
checkpoint, `installation: approval_started`, so a stop while it waits is
reported as the installation's and not as the step's.

After the Stage 2 consent the shell creates a proxied placeholder record for
the new management hostname as its first write and releases it right before
the custom domain is attached, because Cloudflare refuses a custom domain over
an existing record; the record Cloudflare then creates for the custom domain
reaches the zone's authoritative nameservers minutes after the attachment, and
a resolver asked in that gap caches the negative answer for the zone's
negative TTL (30 minutes on Cloudflare zones). The runner therefore
answers that origin locally in the test tab and reads the provider until the
custom domain is attached before its first request to the hostname. It then
waits until the zone's authoritative nameservers serve the record, asking only
them (never a recursive resolver, whose negative answer would be cached), over
UDP and, where a network drops UDP port 53 to those servers, over TCP.

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
it proves three things in order, each recorded with the layer that answered.
The approved identity is admitted (`service_identity: passed`), the positive
control without which a refusal would prove nothing. When the section names a
`foreign` service token, that valid but unapproved identity is refused, and
the journal records whether the Access edge answered (a redirect to its login
page, `302`, or its own `401`/`403` page: `layer: access_edge`) or the gateway
did (its fixed JSON `401 access_required`: `layer: gateway`); the edge is
expected, because the receipt-owned policy admits exactly one token. Then the
gateway itself refuses the update and teardown action routes, source action
cancellation and update action reads to the approved identity
(`403 service_operation_denied`, `layer: gateway`), which is the Worker-level
check observed live. The journal records the actor as `service`.

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
whether a removal receipt is available, which path set the management token
and, once the service identity was
proven, its admission, the refused operations and the layer that refused the
foreign identity. It omits configuration, credentials, and the receipt itself.
`--resume-installed` continues a journal whose installation
passed but whose later stages did not run (for example a runner stop while waiting
for the management token), whose Stage 2 consent was given but whose first read
of the new gateway never succeeded (the provider confirms the installation, and
a negatively cached hostname is waited out with a notice), or whose last update
action failed terminally on the gateway or expired before anyone approved it
(the gateway admits a new action once the old one's window has closed), in
which case a new update action follows and both stay in the journal, or whose
removal did not finish: an
unauthorized or failed dependency-removal action expired without effect and the
interrupted removal starts over, while a succeeded one leaves only the root
removal. A journal with a saved removal receipt belongs to `--recover-removal`,
and the journal records every resume. A saved receipt supports `--recover-removal` with the full
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
- Optional `managementToken`: your opt-in to the automatic management-token
  step described below. It names the token by reference only, in the form
  `serviceAccess.secret` uses: `{ "keychain": { "service": "…", "account": "…" } }`
  for a macOS keychain item, or `{ "env": "ANKKA_…" }` for an environment
  variable. The config never holds the value. Without this field the runner
  continues setup without a token and you install the secret in Cloudflare
  when prompted, as before.
- Optional `browserProfile`: an absolute, dedicated Chrome profile directory outside
  the checkout, mode `0700`. Its `.ankka-lifecycle-profile` marker contains
  `Dedicated Ankka lifecycle test browser` followed by a newline. Never select your
  everyday browser profile. Close that test window before the command opens it.
  A profile retains application sessions; it does not guarantee that Google will
  allow new sign-ins from an automated browser.
- Optional `browserConnection`: `"chrome"` attaches to already running Chrome
  through its built-in remote debugging setting. This is mutually exclusive with
  `browserProfile`. Enable it explicitly at `chrome://inspect/#remote-debugging`
  and approve Chrome's connection prompt. The runner waits up to two minutes for this approval. An attach Chrome
  refuses, with remote debugging switched off or the prompt not allowed within
  that wait, stops the run as `browser_attach_failed`: the stop output adds the
  remedy (enable remote debugging there and allow the attach), and the journal
  holds the code only, never the browser's error text. It grants browser-session access, so use
  it only for a trusted local runner. The runner opens and closes only its new test
  tab, preserves existing tabs and the context, and disconnects on exit. Disable
  debugging after the test if you enabled it only for this run. It does not copy
  your profile or export stored cookies. After each approval leave the runner's
  tab alone: the installer page in it consumes the one-time handoff to the new
  shell, and a closed or navigated tab leaves the shell refusing the runner
  until its window expires. Turn Chrome's Memory Saver off
  (`chrome://settings/performance`) for an attended run, or keep the runner's
  tab active: a tab Chrome discards after minutes in the background is gone for
  the runner, which replaces it as described below but cannot recover what the
  discarded tab had in flight. A machine whose first resolver is a caching
  forwarder (Tailscale MagicDNS, for example) can cache the new management
  hostname's absence for the zone's negative TTL; take it out of the path for
  the run. A previous installation's installer session
  left in that browser is replaced through the installer's own new-session route
  before the run starts; a session still provisioning stops the run.

Provide the already-authorized operator token through `CLOUDFLARE_API_TOKEN`.
It is used for isolated installer deployment and direct Cloudflare read-back,
and, only as the fallback of the opt-in below, for one secret write. The
command never sends it to the installer or gateway.

Without `managementToken` in the config, the runner answers the setup page's
management step with "Continue without a token"
(`management_token: skipped_at_setup`). The distinct management token is then
entered directly as the installed gateway's encrypted `ANKKA_MANAGEMENT_TOKEN`
secret in Cloudflare when the command prompts, and the command never receives
that token; once the gateway reports it the journal records
`management_token: operator`.

With `managementToken`, the command takes the customer's path. Before it starts
the Stage 2 approval it reads the token from your credential store into memory
and enters it at the management step of the new gateway's own setup page, with
the request that page sends for "Use this token": one same-origin
`POST /__ankka/install/management-token` to the shell Worker this run
installed, under the setup session the test browser holds. The shell keeps the
value in its Durable Object's memory and the install's final runtime upload
writes it as the secret (see
[what the setup page does with the value](MANAGEMENT_TOKEN.md#what-the-setup-page-does-with-the-value)),
so in the normal case the operator token needs no Workers Scripts permission
for it. The journal records `management_token: started` before the request and
`management_token: pasted_at_setup`, with the shell's fixed word `held`, after
it. After the installation the run waits, as before, until the gateway itself
reports the credential and token-managed mode.

The value rides in that one request's body and nowhere else. It is never typed
into a page: the request is made by the test browser's API client with the
context's cookies, so no DOM, screenshot or browser network log holds it. It is
in no URL, header, command argument, output, notice, error message or journal
event; a refusal leaves as a fixed code and an HTTP status, and of the shell's
answer only its fixed word is kept. The browser port records no Playwright
trace, HAR or video and takes no screenshot. Playwright's debug output is the
one hook that would print it: with `DEBUG` enabling its `pw:channel` logger
Playwright prints every message it sends to its driver, request bodies
included, and `PWDEBUG` opens its inspector over each call. A fresh run with
the opt-in, and `--preflight`, therefore stop as `browser_debug_output_enabled`
before anything is deployed while `DEBUG` or `PWDEBUG` is set, and the browser
port refuses the paste once more; unset both for the run.

Writing the secret through Cloudflare's API
(`PUT /accounts/{account}/workers/scripts/{worker}/secrets`, with the operator
token, which needs Workers Scripts Write, Edit in the dashboard, on the account
for it) is the fallback, made at most once per run. It follows when:

- the shell refused the value's form (`management_token: refused_at_setup`).
  The setup page accepts only Cloudflare's two account-token forms and keeps
  nothing of a refused value; the runner then continues without a token, as a
  customer would;
- the shell's last word about the step was `dropped`
  (`management_token: dropped_at_setup`): its object restarted, or the hold ran
  out, and the install finished without the value. The runner reads that word
  from the status polls of the customer's own progress page in its test tab and
  adds no poll of its own, so it never keeps the shell's object awake where a
  customer's browser would not. The write then follows without the wait;
- the gateway did not report the credential within the wait
  (`management_token: not_reported`);
- the setup page offered no step, or the run is a `--resume-installed` one,
  which has no setup page to paste into: a gateway installed before this step
  existed is handled exactly as before.

The journal records `management_token: started` before the write and
`management_token: installed_by_runner` after it. The gateway's own view is
read first, and a gateway that already reports the credential (a resumed run,
or a token you installed by hand meanwhile) is recorded as `already_configured`
and not written again. A write Cloudflare refuses stops the run as
`management_token_write_rejected`, and one whose answer never arrives as
`management_token_write_unknown`; neither is retried, and `--resume-installed`
continues from the gateway's view. A paste whose answer never arrives, or that
the shell refuses for another reason than the value's form, stops the run like
the setup writes around it and is never sent again. A reference that does not
resolve stops a fresh run, and `--preflight`, as `credential_unavailable`
before anything is deployed. Removing the gateway does not revoke the token.

`--status` and the failure report show which path set the token as
`managementToken`, in fixed words: `pasted_at_setup`, `installed_by_runner`,
`operator`, or `already_configured` when a pass found the credential reported
and the journal names no earlier path. `managementTokenFallback` says why the
customer's path did not set it (`step_not_offered`, `refused_at_setup`,
`dropped_at_setup` or `not_reported`) and is null otherwise. On a release whose
setup page offers the step, `installed_by_runner` means the customer's path did
not set the token, and that word says why.

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
sessions locally; protect it and remove it when qualification is finished. When prompted (the
command prompts only without the `managementToken` opt-in), install and
activate the management secret directly in Cloudflare. No consent is expected
for the synthetic source installation or the grant and removal of
`qualification@example.com`. An OAuth handoff for those operations fails validation.

When the config carries `serviceAccess`, the service-identity proof described
above runs over the updated runtime after the update passes and before the
first removal write, so the journal holds the updated release's service binding
and the refusals of a gateway that is still whole beside the removal evidence.

After the signed A → B update, the command drops the gateway removal page's
hop to the installer's receipt page once the gateway has removed the
dependencies behind that page. It verifies that dependencies are absent, then
uses fresh consent to recover the saved completion. It saves the signed
removal receipt privately, clears only its hosted removal-session cookie, imports
that receipt, and finishes root removal. A passing result requires direct provider
checks for the captured resources, Worker, namespace, and exact hostnames.

Every write is preceded by a durable private checkpoint. Unknown writes stop the
sequence without automatic retry or blind cleanup. Reusing an existing journal for
a new run is refused. A saved final-removal receipt can be resumed with the same
config and `--recover-removal`. Recovery does not turn an incomplete lifecycle run
into a passing lifecycle result. Before a receipt exists, use the product's existing
setup/removal recovery flow and the recorded action references.

The gateway's removal page names `removed` in its own address just before it
hops to the installer with the receipt. For the runner that word means the
receipt is on its way: the round keeps waiting for the installer to hold it, and
only a recovery result ends the wait early. Each settled round also records what
answered the browser's navigation to the installer's receipt page in that
round, in fixed fields (HTTP status, `server` label, Cloudflare's mitigation
label), so an edge refusal can be told from the application's.

In the isolated fixture that hop can be refused by the edge, for a reason the
product's hop never meets. The gateway's hostname and the installer's hostname
are in the same zone under one certificate, so a browser that holds a live
connection to the gateway reuses it for its request to the installer (HTTP/2
connection reuse across the hostnames a certificate covers), and the edge
refuses a request whose TLS name differs from its Host: an empty `403` that
never reaches the installer, for which Chrome commits its own error page, so
the receipt page never imports the receipt (a run that had only the hop stopped
as `removal_receipt_unavailable`). A browser that still holds a connection of
the installer's own uses that one, and the hop succeeds. A customer's gateway never shares a zone with the hosted
installer, so its hop is not refused this way; an installation on the
installer's own zone would be. The runner handles the fixture's case in two
ways, and neither replaces the hop, which every round still exercises:

- Before each removal round's consent it loads the installer in its test tab,
  which opens a connection of the installer's own unless that load is itself
  reused onto the gateway's connection and refused. A load that fails never
  stops the run; the journal records it as `browser: installer_connection`
  with `loaded` and the answer's fixed fields. It loads the installer's root,
  never the receipt page, which an armed interception would spend itself on.
- When a settled round's landing is Chrome's error page, the hop was answered
  `403`, and the installer holds no receipt after the landing grace, the receipt
  travels without the browser. The runner reads the gateway's own record of the
  attempt through the removal page's progress route (the only lifecycle request
  that carries a query; the attempt comes from the removal page's address, is
  kept in memory for that one read, and is never journaled or printed), takes
  the signed receipt from the settled attempt's link to the receipt page, and
  imports it through the installer's API as that page would have. The round's
  checkpoint says so before the import is written, with
  `receiptImport: runner_after_edge_refusal`: the browser's hop was refused by
  the edge and the receipt travelled by API. When the gateway's record holds no
  receipt for the attempt, or keeps refusing the read, the checkpoint carries
  `unavailable_after_edge_refusal` and the next round opens as before. A
  recovery result, the installer's own page, or a hop that was not refused
  never takes this path. `--status` and the failure report show the last
  round's label as `lastReceiptImport`.

A browser can lose an installed Access session cookie while the cached token
is still valid (observed live: the cookie vanished from an attached Chrome
minutes after the runner had installed it). The Access edge then redirects the
runner's request to its login, which means the application never saw it; the
runner puts the cookie back from the cached token and sends the same request
once more, for a read and a write alike, and says so in its output. A second
refusal is handled as before. It never starts a login for the installer's
session.

Right after an installation the gateway's management Access application is
minutes old, and some edges still refuse a freshly installed session while its
policy propagates. For ten minutes after the runner installs that session, such
a refusal is retried like any other rejected read; a refusal after that window,
or any refusal of the installer's session, stops the run as
`access_session_rejected`.

A hosted OAuth callback exchanges the consent and answers at once with the
page that follows the operation; the operation itself runs behind that page in
the owning Durable Object, by alarm, so a closed tab no longer cuts its revoke
or settlement. Only the exchange is in flight during the callback. On a stop
the runner still leaves an attached Chrome's tab open while a callback is in
flight (it tells the operator to close it once the page has loaded), and an
owned browser waits for the callback to end before it closes.

A tab the browser discarded after minutes in the background (Chrome's Memory
Saver) or whose renderer crashed reads to the runner as a closed page: its next
navigation fails within a second. The runner classifies every failed navigation
in fixed labels, `closed` (the page or its target is gone), `crashed`, `timeout`
or `other`, never the browser's error text. For a closed or crashed tab it
opens a new tab in the same context, whether attached or owned, attaches to it
everything it attaches to a tab (the held-origin and handoff-hold routes, the
callback tracking, and the receipt-hop interception while it is armed and not
yet spent), records `browser: tab_reopened` with the label in the journal,
and retries the navigation once. A navigation that still fails, or a
replacement the browser refuses to open, stops the run as `navigation_failed`
with the label. What the lost tab still had in flight, such as a hosted
callback the browser cut with it, is not waited for on a stop. In an attached
Chrome the discarded tab's placeholder stays in the tab strip; leave it alone.

Before the removal phase the runner clears any hosted removal session its
browser still holds, so an earlier gateway's job is never read as this one's
receipt. A root removal passes only once the installer's job has settled
(`complete`): five verified steps whose attempt was cut before its revoke and
settlement, for example by a browser that gave up on a long callback, are
recorded as not verified and finish on the next authorization. The hosted job
counts every provider and journal call of an attempt against a fixed budget
and stops before the platform's cap with the reason word `budget_exhausted`,
its grant revoked and its pending step armed; the runner records that stop and
authorizes again, up to six consents, each resuming from the verified steps.

The gateway settles each consent attempt before the browser has followed the
callback's redirect, so a dependency-removal action reads `recovery_required`
moments before the receipt reaches the installer or the gateway's removal page
names its reason. A round therefore ends only once the tab has landed: the
runner waits up to a minute for the installer to hold the receipt or for that
page to show its `result` and `reason`, records the landing in the journal in
fixed labels (site, page, result word, reason word; never the fragment or any
other query value; Chrome's own error page, which it commits for an empty error
response, reads `page: error`), and only then opens the next round. `--status`
and the failure report summarize the rounds and the last landing.

Once the interrupted round is observed, the runner replaces its test tab before
the first recovery round. The gateway settles the cut action moments before the
lost callback's answer reaches the browser, where the interception spends itself
on that answer; the runner therefore waits up to a minute for the browser's
observation (stopping as `interruption_not_observed` otherwise, since a tab
replaced earlier would carry the armed interception into recovery), then opens
a new tab in the same context, attached like any other except for the spent
interception route, and closes the previous one, only ever its own tab. The
recovery rounds then run in a tab that never carried the interception, as they
do in a fresh `--resume-installed` process. The replacement was introduced when
the empty `403` that the receipt hop met in every recovery round was attributed
to the tab that had carried the interception. That attribution was wrong: the
refusal is the edge's answer to the reused connection described above, and a
fresh process escaped it only because it had loaded the installer moments
earlier and still held a connection of the installer's own. The replacement is
harmless and stays, so that a spent interception never rides into the recovery
rounds; it is not the remedy for that refusal. It is recorded as
`browser: tab_replaced` with the fixed reason `interruption_spent`; like a
reopen it is the runner's event, never the last stage, and `tabsReopened` does
not count it.

The gateway settles each consent attempt by alarm behind its removal page,
which then records the result word in its own address: `removed` before it hops
to the installer with the signed receipt, or `recovery_required` with the
reason word. A round therefore ends only once the tab has landed: the runner
waits up to a minute for the installer to hold the receipt or for that page to
show its `result` and `reason`, records the landing in the journal in fixed
labels (site, page, result word, reason word; never the fragment, the attempt
the page follows, or any other query value), and only then opens the next
round. `--status` and the failure report summarize the rounds and the last
landing.

A receipt the gateway hands over with its unconfirmed-revocation warning is
saved with that warning recorded; the root removal still runs and is verified,
and the run then stops as `root_removal_revocation_unconfirmed` rather than
passing. A receipt for a different hostname is refused.

An exclusive `.lock` file protects the journal while the command runs. If the
process is forcibly terminated, verify that it has exited before removing its stale
lock. Journal replacements are atomic and synced. Keep the journal and receipt until
cleanup is independently confirmed; they contain private configuration and resource
references and must never be committed. The command leaves the prepared installer,
relay, releases, and temporary setup tokens for separately authorized fixture cleanup.

### Failed-run evidence

A stopped run saves a `diagnostics` object beside its final journal event and
prints the same compact report. It names the failed stage, the last recorded
mutation stage, the fixed failure code, whether a removal receipt exists, and
the path that set the management token (`managementToken` and
`managementTokenFallback`, as in `--status`).
Once the hosted root job has answered, the report and `--status` also carry
its outcome under `rootRemoval`: the steps done out of five, the job's fixed
reason word when a step failed, and its revocation flag. The stop codes are
distinct: `root_removal_failed` when the job reports a reason word,
`root_removal_revocation_unconfirmed` when all five steps finished under an
unconfirmed grant revocation (independent absence is still checked first, and
the run is not a pass), and `root_removal_not_verified` for anything else.
A `navigation_failed` stop carries why under `navigation` (`closed`, `crashed`,
`timeout` or `other`), and `tabsReopened` counts the test tabs the runner
replaced, in the report and in `--status`.
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
