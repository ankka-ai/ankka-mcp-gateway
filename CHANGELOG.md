# Changelog

Notable public product and repository changes are recorded here.

## Unreleased

- Grant full dashboard management access from Team with the explicit Dashboard
  administrator option. Administrators can grant and revoke access for team
  members; revocation also rejects existing dashboard sessions. Initial
  installation administrators retain recovery access, and dashboard access stays
  separate from permissions to use MCP tools.

- Save Team changes with fewer than half the Cloudflare calls. A save checked
  each policy before and after writing it by listing the account's Access
  applications, reading that application and its policy again, and then
  reading the Portal, one call after another. With Access API calls taking
  about a second each, a save that changed eight or nine policies could run
  past its 60-second deadline and stop for recovery. Each check now reads the
  application list, which carries every policy, together with the Portal: a
  save that changes eight policies makes 45 calls instead of 109, about 29 of
  them in a row instead of 72. An application list entry without its policies
  is still read directly.

- Load the Team page with one round of Cloudflare reads. Each load listed the
  account's Access applications, then read every connector's application and
  its policy again, two connectors at a time, and then each team's Access
  group one after another. Access API calls take about a second each, and a
  gateway with nine policies waited on at least six of them in a row. The
  application list already carries each application's policies, exactly as the
  separate reads return them and current immediately after a write, so a load
  now uses the list and reads team groups alongside it. Saves still read each
  application they change directly.

- Let a gateway that updated to v0.2.2 or v0.2.3 read the install records an
  earlier release wrote. Those releases added an optional `cleanup` field to the
  install record and the Stage 2 journal, and their reads compared the parsed
  record, now carrying `"cleanup":null`, byte for byte with the stored one. Every
  record an earlier release stored therefore failed to read, so updates, source
  and BigQuery setup, token changes and removal all answered
  `recovery_unavailable` before reaching Cloudflare. Reads now require the stored
  bytes to be canonical, and still reject unknown fields. A gateway already on
  v0.2.2 or v0.2.3 cannot run the update that carries this fix, because the
  update is itself such an operation; its runtime has to be replaced once from
  outside, keeping its bindings, before it updates normally again.

- Release the lifecycle lock when a gateway removal stops before deleting
  anything. If an ownership check refused a resource after you authorized
  removal, for example because an Access policy was changed in Cloudflare, Team
  changes, source changes and updates stayed blocked indefinitely, so the
  change could not be corrected from the dashboard. Ending that attempt now
  marks the removal failed and returns the gateway to its installed state. A
  removal that armed or sent any deletion still needs a fresh authorization to
  continue.

- Let an interrupted Team save that created a team's Access group resume. A
  retry checked the policies it had already written against a plan without
  that group, so every resume reported `team_policy_drift` and the recorded
  change could neither finish nor be cancelled. Retries now check written
  policies against the recorded group ids, and skip one full policy read.

- Fix named teams on connectors the gateway serves itself, and on removal. A
  team that granted Gateway Management or a built-in API connector made that
  connector refuse everyone, including people assigned directly; the Worker now
  reads the team's own Access group on each request. Removing a connector that
  a team grants now works. Removing the gateway asks you to delete your teams
  first; before, it failed after authorization and then blocked Team changes.
  A team save refused for the missing Access group permission changes no
  policy, and you can now cancel it.

- Unify expand/collapse controls and checkboxes across connector tools, Team
  access and setup forms. Simplify Settings copy and release status, remove the
  redundant connector status button, and refresh the README introduction.

- Make Team access saves and retries faster by overlapping independent
  Cloudflare ownership reads and using verified progress from the saved change.
  Retrying an interrupted save advances to unfinished policies without replaying
  completed writes; the complete policy graph is still verified before success.

- Add the v0.1.82 compatibility bridge for built-in API sources. Existing gateways
  keep their configuration, credentials, sources and Team access while updating
  in two steps to v0.2.0; no fresh installation is required.

- Include agent-authored API sources in the gateway runtime by default. Gateway
  Management can save, test, activate and disable JavaScript tools for configured
  API connections; ordinary Portal source installation and Team access govern
  their use. Connections and credentials stay in your Cloudflare account. New
  installations and updates include the runtime without a separate deployment
  or feature flag.

- Accept Cloudflare server records up to 8 MiB, including large synced tool
  schemas, when reading source tools and verifying removal ownership. Sources
  whose records exceeded the previous 4 MiB limit can now finish removal.

- Allow removal of unfinished MCP sources waiting for sign-in, synchronization,
  or tool selection. Confirm cleanup from the installation details without
  completing connection first; saved resource receipts and removal progress
  remain available until cleanup is verified.
- Add or replace the gateway's management token from Settings. A gateway that runs without the token (setup skipped
  it, the pasted value was lost before it was saved, the token was revoked, or the gateway predates the setup step)
  had one documented way to get it: create it by hand and add it as a Worker secret in Cloudflare. **Settings → Add
  management token** now prepares one change inside your gateway, sends you to Cloudflare for one approval with
  exactly one scope (`workers-scripts.write`), and returns you to a page your own gateway serves, with the same
  pre-filled token link as setup and one paste field. Your gateway writes the token as its own
  `ANKKA_MANAGEMENT_TOKEN` secret with one Cloudflare call and revokes the approval. The token lives only inside that
  one request: never in storage, object memory, a journal, a log, an error, a URL, a cookie or a response, and it
  never passes through anything Ankka hosts. If the approval runs out before you paste, the page says so and you
  start again. **Replace management token** takes the same steps and says that the old token is yours to delete in
  Cloudflare, by its name. The change excludes, and is excluded by, an unfinished source installation, update,
  removal and Team change; only an administrator can prepare it. When the token is missing, Sources, Team and
  Settings show one card (what the token is for, what it can reach, why it is missing on this gateway, and the
  button) instead of a disabled page with a link, and after the flow Settings notices the token by itself. **Verify
  management access** now proves both permissions instead of reading only: it writes the gateway's own MCP Portal
  and the Portal's own Access policy back exactly as read, only when they match the receipts, in at most seven
  Cloudflare calls, and names a missing permission. This adds the fixed operation `management-credential` to the
  authority catalogue and to the relay at `auth.ankka.ai`, which must be redeployed for this one operation; every
  other operation's relay requests are unchanged.

- Keep "Removal in progress" and its way back on the dashboard for as long as a removal is unfinished. The notice
  followed the removal journal, which forgets an interrupted attempt once a later authorization replaces it or
  expires; the gateway now also reports, from the installation's own durable record, that deletion has begun.

- Let an unattended lifecycle job install the management token inside the install's final runtime upload
  (`managementCredentialAtInstall`), the path a customer's pasted token takes, so that path is proven against
  Cloudflare without a person. The manage stage's own secret write stays the default.

- Take the customer's path for the management token in the attended browser lifecycle runner. The setup page your
  own Worker serves now has a **Management token** step that keeps its Approve button hidden until it is answered.
  The runner gets through Stage 2 by that page's routes, so it now answers the step before it starts the approval:
  with the `managementToken` opt-in it reads the token from the operator's credential store and sends the request the
  page sends for "Use this token" (one `POST /__ankka/install/management-token` to the shell this run installed),
  and the install's final upload writes the secret; without the opt-in it sends "Continue without a token" and the
  operator is prompted as before. The value rides in that one request body only: it is never typed into a page, the
  browser port records no trace, HAR, video or screenshot, refusals leave as fixed codes, and a fresh run with the
  opt-in stops as `browser_debug_output_enabled` before anything is deployed while `DEBUG` or `PWDEBUG` is set,
  because Playwright's debug output prints request bodies. Writing the Worker secret through Cloudflare's API is now
  the fallback, made at most once: when the shell refused the value's form, when the shell's last word was `dropped`
  (read from the customer's own progress page's status polls, never from a poll of the runner's), when the gateway
  never reported the credential within the wait, or when there was no step to paste into (an older release, or
  `--resume-installed`). The operator token therefore no longer needs Workers Scripts Write in the normal case.
  `--status` and the failure report name the path that set the token (`pasted_at_setup`, `installed_by_runner`,
  `already_configured`, `operator`) and, as `managementTokenFallback`, why the customer's path did not.

- Document stable-channel availability: the hosted installer serves the stable release, canary releases are
  published for evaluation, and support is best-effort under the support policy.

- Say before an install starts that setup needs one account API token, who can create it, and that it is pasted into
  your own gateway, on the hosted installer's first screen, in its review step and in "How permissions work" (which
  still described adding the token by hand in Cloudflare). The last removal page now names the management token setup
  pre-filled for that gateway and links to the account's API tokens, because removing a gateway cannot revoke its
  token.

- Pick the tools of a sign-in source from its real list instead of typing exact names. A source whose endpoint
  answers discovery with a sign-in challenge cannot list its tools before it is connected, so the form asked for
  typed names, and a typo surfaced only after installation and connection. The form now says why the list is empty
  and what happens next, and saves the draft with no tools; the free-text box is gone, for catalog presets too. The
  gateway installs such a source with nothing enabled: no tool override on its server, a deny-Everyone policy, no
  Portal mapping. After the operator has connected it in Cloudflare, the paused installation lists the tools
  Cloudflare synced from it as the checkbox list public sources get (catalog recommendations that exist preselected,
  nothing preselected from a hint), and the choice is saved as a revision-bound step of its own that re-binds the
  paused installation atomically; resuming then attaches exactly the chosen tools. Cloudflare does not document
  what a synced tool record carries beyond its name, so a description or a hint is shown only when the record has
  one, and the page says when a list has none. With nothing chosen the installation stays paused with a fixed
  reason and is never attached. An installation already paused with typed names resumes as before, and a typed name
  can be corrected from the real list. An installation that waits for its operator is no longer shown as "The
  gateway request failed". Older releases cannot read a source saved without tools, so saving one makes rollback
  below this release unavailable, as installing any source does, and **Save draft** carries the rollback sentence
  while that is a real decision; every other draft still restricts nothing. Public sources are unchanged.
- Set up the gateway's management token inside setup. A freshly installed gateway could not add a source or manage
  team access until an administrator had created an account API token by hand and added it as a Worker secret in
  Cloudflare, and nothing in the installer said so. The setup page your own Worker serves before the second approval
  now has a **Management token** step: a link that opens Cloudflare's token page with **Access: Apps and Policies
  Edit**, **MCP Portals Edit** and a name containing your management hostname filled in (verified against the
  dashboard on 2026-09-19), one paste field, and an explicit control to continue without a token. The page says why
  the token is needed, that creating it takes a Super Administrator or Administrator, and that it can edit every
  Access policy in the account. The token never passes through anything Ankka hosts: it goes from your browser to
  your own Worker, which accepts only Cloudflare's two account-token forms, keeps it only in the owning Durable
  Object's memory beside the install approval, and saves it as the `ANKKA_MANAGEMENT_TOKEN` secret binding with the
  final runtime upload the install already makes, so no Cloudflare API call is added to any pass. It is never written
  to Durable Object storage, the journal, a receipt, a log line, an error, a URL or a response. If Cloudflare
  restarts the object first, the value is lost and the install still completes without it; the install status route
  and the page that follows the install say so with one fixed word (`held`, `installed`, `skipped` or `dropped`).
  The exact read-back of the final version accepts the secret binding exactly when the install supplied it. Adding
  or rotating the token on an installed gateway is unchanged for now: directly in Cloudflare.

- Show the rollback warning on Sources only when it is a real decision, in plain words. The permanent banner
  ("once source provisioning starts, rollback below this runtime release is unavailable…") is gone. Only when the
  gateway was updated, its earlier release can still be restored, and starting a source installation would end that,
  the control that starts or resumes the installation says "After this you can no longer roll back to `<release>`."
  The gateway reports that release as `installEndsRollbackTo` in the `/api/sources` answer; the dashboard never
  computes it. `/api/update` no longer offers a rollback that preparation then refuses: once the recorded minimum
  runtime excludes the retained release it answers
  `rollback: { available: false, reason: "minimum_runtime_release", release }`, and Settings says why that release
  can no longer be restored and shows no rollback button. A removal refused for unfinished work now asks to finish
  or cancel that work, or to wait for an open removal authorization to expire, instead of naming a receipt. The
  minimum-runtime rule itself is unchanged.

- Land on the new release's dashboard after an update or a rollback, without a manual reload. Cloudflare keeps
  serving the previous version, Worker and management assets alike, at an edge location for a short while after the
  upload, so the update page handed the browser to the previous release's dashboard. The page now waits, as its own
  step, until the release that serves its progress polls is the attempt's target on two answers in a row, for at most
  sixty seconds, after which it hands over anyway and says that a reload may be needed. The serving release is the
  stateless entrypoint's, which answers where the browser asks; the one management object restarts on the new version
  at once and would confirm too early. An attempt that was not applied hands over at once, as before. Both releases
  must carry the step: an update from an earlier release, or a rollback to one, still hands over at once.

- Give an interrupted removal a way back. Once a removal has begun deleting the
  gateway's connected resources, the dashboard shows **Removal in progress** on
  every page, and in place of the load failure screen, with one action that
  authorizes the removal again; the gateway resumes from its saved progress and
  signs a fresh receipt. The dashboard reads the state from the recorded
  removal action and now accepts its `gateway_removed` status. The installer's
  removal page no longer tells you to reload when no reload can help: an expired
  receipt names the gateway whose management page signs a new one, and an
  unverifiable receipt or a browser without an open removal says the same
  without a hostname. Failures a reload can get past keep the reload wording.

- Fix the dashboard refusing to load on gateway-v0.1.64 ("The gateway response could not be verified"). The gateway's
  status gained `serviceIdentity`, and source and Team actions gained `actorKind`, without the dashboard's strict
  response schemas learning them, so every status answer was rejected. The dashboard now accepts all three, and the
  dashboard's real client runs against the real gateway Worker in the core suite, so a field added on one side only
  fails there instead of in a customer's browser.

- Update the transitive `sharp` dependency from 0.35.2 to 0.35.4 to resolve
  the libheif advisories GHSA-g89c-p67h-r497 and GHSA-2jg2-4ch7-h545 reported
  as GHSA-rgj7-g3m4-5g8c. Miniflare pins the vulnerable version exactly, so
  the root manifest carries an npm override; the wrangler, esbuild, and
  Miniflare pins are unchanged.
- Run every consented operation behind a page of the gateway's or the
  installer's own instead of inside Cloudflare's authorize callback. The
  callback exchanges the code, keeps the grant only in the owning Durable
  Object's memory, and answers at once with a page that shows the steps live;
  the hosted root finalizer, the gateway's dependency removal and its update
  then run by alarm, one bounded pass per invocation. An object restart loses
  the grant and stops the attempt as recovery-required with an unconfirmed
  revocation; a fresh consent resumes from the durable receipts. No grant is
  ever persisted.

- Bound what one hosted root-removal attempt reads: scan other Workers once
  per attempt and only those modified since the gateway was created, re-read
  each resource by identity before its deletion, and re-read only the owner
  side while a write settles. Count every provider and journal call against a
  fixed budget and stop before the platform's cap with the resumable reason
  `budget_exhausted`, so the grant is still revoked and the next consent
  continues from the verified steps. No ownership check is weakened.

- Keep admin license generation working when npm loses development flags on
  optional TypeScript, lightningcss, and fsevents binaries. Retain license
  checks for other dependencies and the existing esbuild/rolldown notices.

- Use the selected zone's Access API for managed BigQuery setup and removal,
  matching the approved permission. Show the pending resource and bounded
  HTTP failure details while keeping uncertain creates blocked for review.

- Reopen the saved setup review after a final approval expires before token
  exchange. Request fresh consent within the original setup window, keep
  configuration edits locked, and preserve active or potentially applied work.
  Explain that full setup expiry may leave an unfinished gateway in Cloudflare.

- Verify large Worker modules during installation and updates without overflowing
  the base64 validator stack. Keep canonical encoding, byte bounds, and exact
  content hashes; allow self-update readback to fit the accepted source size.

- Show the saved, bounded failure reference when hosted setup stops. Do not
  claim that a failed provisioning attempt left no Cloudflare resources.

- Include gateway-managed BigQuery bridges in receipt-bound gateway removal.
  Verify resource identities and sharing before deletion; detach the bridge
  domain, delete its Worker and key, and remove Access protection last. Resume
  known partial setup and interrupted deletions with fresh consent, and keep
  unknown creates blocked for manual reconciliation. Bound bridge and ordinary
  source cleanup to separate signed invocations with durable progress so
  multiple sources fit Workers Free request limits without storing the grant.

- Raise the bounded local release publisher from 6 MB to 10 MB to accommodate
  signed gateway packages that embed the BigQuery bridge. Signature, digest,
  per-file, and generated-module checks remain enforced.

- Read the installation receipt from its separate Durable Object when preparing
  automated teardown. Keep the ownership key requirement on the management
  object and reject missing or invalid receipts before removal.

- Wait for the browser to reach a new workers.dev address securely before
  releasing the one-time setup handoff. The installer retries temporary TLS
  and connection failures on its progress page, verifies the expected Worker,
  and continues automatically once ready without requiring a manual reload.

- Allow the first Cloudflare approval to deploy gateway setup without a custom
  domain. Accounts with no active domains see a guide on their setup Worker,
  with example addresses and links to Cloudflare. Final gateway configuration
  still requires an active domain from the approved account.

- Add a gateway-hosted BigQuery setup flow: review project and datasets, approve
  Cloudflare, upload a dedicated Google key directly to your gateway, deploy the
  protected bridge, and resume its recorded Portal connection. The key becomes
  a Worker secret; drafts and recovery receipts contain no credentials.


- Support the Google-hosted BigQuery MCP bridge as a manually deployed,
  self-hosted source. Explicit `allowQueries: true` enables bounded read-only
  SQL with Google IAM controlling data access; existing deployments keep the
  constant connectivity probe. Query-byte ceilings are optional. Qualify useful
  aggregates, excluded-table denial, read-only enforcement, and Claude Desktop
  session continuity and reconnection. Link the setup guide from the dashboard
  and document bridge updates, rotation, and removal.

- Connect Settings to automated removal with two temporary Cloudflare approvals.
  The gateway verifies and removes its receipt-owned Portal and source resources;
  a signed handoff lets the hosted finalizer remove management resources, storage,
  and the Worker. Both phases retain progress for fresh-consent recovery after an
  interrupted request. Foreign dependencies stop deletion and unresolved grant
  revocation remains visible. Disposable live qualification is still required.

- Fetch an approved update or rollback release by its exact version and artifact
  digest, so moving the release channel no longer makes rollback unavailable.
  Serve retained signed releases from the existing bucket without a session or
  grant; keep the reviewed channel, origin, and signing key fixed and preserve
  runtime compatibility checks. Missing or invalid bytes stop before upload.

- Add an opt-in, credential-free BigQuery MCP capability probe with bounded
  discovery and fixed diagnostics. Record the hosted query-cost limitation and
  distinguish fresh authorization, refreshed grants, and Portal-wide revocation.
  Record Claude Desktop connectivity, session lifetime, and reconnection checks,
  plus a separate real-Google REST query-budget test. That initial qualification
  kept general hosted SQL disabled.

- Add ChatGPT and Cursor web OAuth callback defaults to newly created Portals
  alongside Claude. ChatGPT's variable callback is limited to its documented
  connector OAuth path. Keep local callbacks, existing Portal settings, and
  receipt hashes compatible; document manual additions and client qualification.

- Update the transitive `qs` dependency from 6.15.3 to 6.16.0 to resolve two
  upstream parsing and denial-of-service advisories. Existing dependency ranges
  and toolchain pins are unchanged.

- Accept Cloudflare One-time PIN providers with the empty name returned by the
  dashboard, so adding email-code login does not block installation. Document
  the Portal login-method prerequisite for team members outside the Cloudflare
  account; Portal and source allow rules remain separate requirements.

- Allow Claude's exact hosted OAuth callback when creating a Gateway Portal,
  including through the installer. Local MCP clients retain localhost and
  loopback support. Existing Portal settings and installation receipt hashes
  remain unchanged; older Portals can add the callback in Cloudflare.
- Recognize the runtime's complete source-installation receipt after a
  successful apply. The return notice now agrees with the verified action
  status instead of reporting `apply_response_invalid`; incomplete or
  mismatched receipts remain rejected.
- Add an initial experimental self-hosted bridge to Google's hosted BigQuery MCP.
  It exposes dataset-scoped table listing and metadata plus the exact constant
  query `SELECT 1 AS bridge_ok`. General SQL was initially disabled pending
  qualification; the existing budget-capped REST reader is unchanged. The setup
  guide covers direct secret configuration, the operator callback, and Portal checks.
- Pause source installation before Portal attachment when Cloudflare still
  needs operator authentication, tool synchronization, or a missing selected
  tool. The dashboard links to the recorded server and explains the next step.
  A completed connection check permits immediate fresh-consent renewal with
  the same receipts; uncertain writes still wait for the old approval to expire.
- Send identical `id` and `server_id` values in portal server mappings to
  accommodate Cloudflare's differing guide and API schema. Retained receipt
  hashes remain unchanged. Provider failures can name a field from a fixed
  validation vocabulary without returning or retaining provider message text.
- Let the initiating administrator renew an expired source installation with
  fresh Cloudflare consent. Renewal rotates the action key, retains the same
  journal and receipts, and resumes through the existing ownership checks.
  Unacknowledged Access application creation, legacy policy profiles, changed
  drafts, and conflicting lifecycle work remain blocked.
- Authorize source installations on the gateway itself. The dashboard's
  "Authorize and apply" handoff now opens the gateway's own
  `/__ankka/operation` page, which asks Cloudflare for a one-time `source-add`
  grant (Access applications and MCP portals only) through the public OAuth
  client and callback certified at install, applies the prepared action in
  place, and revokes the grant. The retired hosted `/manage` page is no
  longer navigated to, so source installs work again on two-stage gateways.
- Update the gateway from the gateway itself. A runtime update handoff opens
  the same operation page, asks for a one-time `upgrade` grant (Workers
  scripts only), downloads the pinned release from the control plane's new
  `/api/releases/<channel>/files/<path>` route, verifies every file against
  the signed manifest with the update key the install was made with, uploads
  the new version with the existing secrets inherited, and lets the new
  version's alarm finish the journal with a `finalize` command that proves
  the target release by its own bindings. Rollback and teardown handoffs are
  not yet served by this route.
- Name why a gateway-local operation stopped: the dashboard return carries a
  bounded reason word (grant, apply, or update stage) next to the result.
- Bind an operation grant to the installed account by reading one of that
  account's resources under the grant's own scope (the MCP portals for a
  source grant, the gateway Worker for an update) instead of listing
  accounts, which an operation grant cannot see. The first gateway-local
  source authorization had stopped with `grant_account_ambiguous_accounts_0`.
- Let the runtime-update journal follow a release the Worker received outside
  an action (an operator-run update or a Cloudflare-side rollback): once no
  action is in flight, the recorded current release becomes the rollback
  reference and the running release is current, so the next update no longer
  stops with `runtime_action_conflict`.
- Read a source's Access application back by id after creating it. Cloudflare
  stores an MCP-type application (no hostname of its own) with the account,
  and the zone listing never shows it, so the gateway created the application
  and then failed to see it, leaving the first real source installation in
  recovery-required after its MCP server and application existed. A baseline
  without a known id still consults the listings, the account listing
  included where the grant can read it; the writes stay on the zone paths
  the grant covers, and the portal application and both policies keep their
  listings so a competing policy is still seen.
- Clear a gateway-local operation's attempt record before a runtime update
  uploads the new version. The replaced version could not clear it afterwards,
  so every other operation on that gateway answered `operation_pending` for
  up to ten minutes after an update.
- Name the provider step that stopped a source installation. The apply
  route's rejection now carries the resource kind, the step, the outcome, the
  HTTP status and Cloudflare's numeric code (never provider text), and the
  dashboard's return reason repeats it, so a stalled installation says which
  call failed instead of only "recovery required".
- Retire the legacy hosted installer runtime, its Durable Object, journals,
  executors, management handoffs, and analytics sink. The two-stage runtime
  shipped in gateway-v0.1.21 is the only hosted mutation path.
- The hosted installer records no analytics; the former funnel documentation
  is removed and the architecture and security-model notes now say so.
- Repository references point at `ankka-ai/ankka-mcp-gateway`.

## gateway-v0.1.16 (canary)

- Keep the exact candidate-version override on the external update probe, but
  remove it before forwarding the authenticated probe to the retained Durable
  Object. Release, artifact, signature, expiry, and saved-action checks remain
  required; probe success still requires an explicit ready response.
- Preserve the v0.1.15 dashboard and existing-source-only Team permissions.
  New-source creation, including onboarding an empty gateway, remains paused.
  Administrators stay fixed, source write tools remain disabled, and armed Team
  changes still block automatic teardown and rollback to older releases.

## Unreleased

- Add the v0.1.82 compatibility bridge for built-in API sources. Existing gateways
  keep their configuration, credentials, sources and Team access while updating
  in two steps to v0.2.0; no fresh installation is required.

- Restore source onboarding with an exact deny-Everyone initial policy and no
  implicit Team assignments. Operator connection and a later explicit Team
  grant remain separate steps. Legacy source actions cannot bypass the new
  profile; new-profile creation conservatively disables automatic teardown
  and older-runtime rollback before its first provider mutation. Deployment
  and live shared-auth/permission qualification remain required.
- Show the runtime-update loader immediately after OAuth authorization, emit
  a terminal result only after execution and grant cleanup, and retry only an
  exact active-version propagation mismatch within a shared ten-second bound.
  Missing or malformed completion never means success or starts another update.
- Correct the release-verification note: published canary releases already
  carry the signing key identity and sanitized verification record, so the
  complete verification check applies to them today.
- Add an opt-in, disposable two-version Worker/Durable Object probe with
  synthetic state, bounded diagnostics, and verified cleanup. It is a platform
  diagnostic, not a gateway release or source-connection acceptance test.
- Add a minimal best-effort support policy: only the newest release of each
  channel receives fixes, no backports, canary as the evaluation channel, and
  stable as a maintainer recommendation rather than an SLA.
- Add documentation-only native provider setup guides to the Sources dashboard,
  with explicit compatibility, read-only grant, and release prerequisites.
  These guides do not create source drafts or approve catalog entries.
- Add an experimental self-hosted MCP v2 reader runtime with fixed provider
  operations, Cloudflare Access JWT validation, bounded outbound reads, and
  credentials held only in the deployment account. Initial API readers cover
  Notion, HubSpot, Zendesk, Gorgias, Search Console domain properties, and GA4;
  live provider and lifecycle qualification remain separate release gates.
- Add an experimental BigQuery reader to that runtime, mirroring the hosted
  BigQuery MCP read tools over Google's REST API with a read-only
  service-account identity, a mandatory dry-run SELECT gate, and a per-query
  maximumBytesBilled budget. The native hosted-endpoint manual-OAuth block is
  unchanged.
- Prepare the initial public preview source for Ankka MCP Gateway.
- Add secret-free configuration validation and deterministic offline planning.
- Add the self-hosted Cloudflare runtime and management dashboard.
- Add the optional fail-closed hosted installer and operation-scoped OAuth
  flow.
- Add signed release, update, rollback, recovery, and receipt-owned removal
  contracts.
- Add exact read-only source allowlists and synthetic end-to-end fixtures.
- Keep the Portal as the single employee authentication layer: newly added
  OAuth-protected sources are connected once by a gateway operator and mapped
  with `on_behalf: false`, while legacy source records remain readable for safe
  lifecycle handling.
- Raise repository-local contracts to a 500-tool bound and add a reproducible
  228-tool OpenAPI fixture, supplemental 224-tool workload and hostile-name
  coverage, simulated management lifecycle coverage, and searchable dashboard
  review.
- Add deterministic GET-only OpenAPI allowlist generation with check mode and
  an optional exact reviewed manifest for individually bound non-GET reads and
  wrapper-local synthetic tools; no method-wide non-GET switch is accepted.
- Add a signed, exact control-plane-origin contract and an unsupported
  first-party Cloudflare dogfood runbook covering two create-only releases,
  install, update, rollback, recovery, receipt-bound removal, and exact cleanup;
  live qualification remains pending.
- Document operator-owned audit logging with a minimal source-Worker fallback,
  large-source Code Mode qualification with an exact live-catalogue gate,
  per-source Access groups, a bounded live canary, and the post-preview
  governance roadmap.
- Document the source-credential custody boundary, no-telemetry runtime, and
  identifier-free hosted-installer analytics.
- Add public-source, license, history, and clean-build checks.
- Scope the public-history check to the publishable surface (checked-out
  history, origin refs, and tags) so private-history remotes in a working
  clone no longer fail the gate.
- Build each app once per `npm run check` and add `npm run check:fast` for
  local iteration.
- Warn on local toolchain drift instead of failing every npm command;
  continuous integration still enforces the exact pinned toolchain.
- Group Dependabot version updates into weekly combined pull requests
  (non-major npm updates together; action updates together).
- Extend hosted-installer analytics to a session-scoped funnel (schema v2):
  a page-view event plus an opaque per-session key, country, browser family,
  and page-view referrer host on every event — still with no cookies, no IP
  or raw user-agent storage, and no identifier that outlives the session.
  Self-hosted deployments continue to send nothing.
