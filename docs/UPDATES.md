# Gateway updates and rollback

Gateway updates are operator-initiated and signed. They are deliberately
narrower than a general Cloudflare configuration deployment.

## What an ordinary update can change

An ordinary update changes:

- gateway Worker code; and
- gateway management assets.

The updater also records its action, installed release, rollback reference, and
public status in the existing Durable Object. This normal bookkeeping does not
replace application data, ownership receipts, saved audiences, or recovery
history. It is not a Durable Object migration or an out-of-band state rewrite.

It must not change:

- Access applications or policies;
- DNS or MCP Portal configuration;
- sources or tool allowlists;
- credentials;
- Cloudflare bindings or compatibility settings;
- the signing trust root; or
- application data, ownership receipts, saved audiences, or Durable Object
  migrations.

During the approved operation, the updater temporarily enables the existing
gateway Worker's `workers.dev` subdomain for a bounded, authenticated action
route. It disables and verifies that route before completion. The installer
reports unconfirmed route cleanup as a failure rather than success.

Changes outside this boundary require a separately designed and
operator-approved migration or a fresh installation.

The V1 release contract has no Team-management secret. A forward update may
recognize the retired preview binding only to omit it from the candidate; the
value is never read or inherited. Rollback into or out of a version carrying
that binding is refused. See the [retirement procedure](TEAM_UPGRADE.md).

## Release trust

Each installation receives a fixed release channel, an Ed25519 public key, and
one signed canonical HTTPS control-plane origin compiled into its Worker. The
gateway Worker fetches only that origin and channel's public descriptor and
verifies the signed channel, key identity, origin, manifest, deployment
contract, and payload digests. An update signed for a different origin fails
closed even when its signature is otherwise valid.

Release discovery is anonymous and sends no deployment account, hostname, user,
cookie, authorization, or referrer. A channel outage does not prevent source
management or an already available rollback.

Publishing a release does not install it. A gateway administrator must review
the release and approve a fresh, operation-scoped Cloudflare authorization.

## Update sequence

An update starts in the gateway dashboard and runs on the gateway itself:

1. The dashboard prepares the update and hands the browser to the gateway's
   own `/__ankka/operation` page, which asks Cloudflare for a one-time
   `upgrade` grant (Workers scripts write only) through the public OAuth
   client and callback certified at install.
2. The callback confirms the grant reaches the installed account by reading
   the gateway Worker. Behind the page, the management object reads the
   active Worker version and current bindings, then
   fetches the approved release descriptor from
   `/api/releases/<channel>/by-id/<release>/<artifact-sha256>` and its manifest
   files from that route's `/files/<path>` suffix, then verifies
   the signature and every digest with the update key it was installed with.
3. The callback answers at once with the gateway's own
   `/__ankka/operation/update` page, and the management object runs the
   update behind it in its own invocation: it uploads the new management
   assets, records a handover (the action, the target, and the action key
   sealed under the ownership wrap key), arms its own alarm, and uploads the
   new Worker version with the existing secrets and object namespace
   inherited. The upload activates at once and replaces the version that ran
   the update; the page shows the stages as they are reached.
4. The grant is revoked. Cloudflare keeps serving the previous version, its
   Worker and its management assets alike, at an edge location for a short
   while after the upload, so after an applied upload the page does not hand
   over yet. Every progress answer names the attempt's target release and the
   release that served the answer, and the page waits, as its own fifth step,
   until the two are equal on two answers in a row. It waits at most sixty
   seconds; past that it hands over anyway and says that the dashboard may
   need a reload. An attempt that was not applied hands over at once.
5. The page hands the browser to Settings, which polls the action. The new
   version's alarm finds itself running the target release and completes the
   journal with `finalize`; if the old version still runs after five minutes,
   it marks the action as needing recovery instead.

The serving release is the stateless entrypoint's own `ANKKA_GATEWAY_RELEASE`,
which it names on the progress request it forwards to the management object.
That is the version Cloudflare runs where the browser asks, and the same
version's assets answer the dashboard's navigation there. The management
object's own release cannot stand in for it: there is one object, it restarts
on the new version right after the upload wherever the browser is, and it
would confirm while that location still serves the previous dashboard. The
object's release proves something else: that the upload was applied, also when
the version that ran it was replaced before it could record its end.

Both releases must carry this step. The page a browser follows comes from the
release being replaced, so an update from a release without the step hands
over at once, as before. A rollback to such a release does too, because the
object that answers after the upload no longer names either release; the
update record keeps the fields that release reads, so its page still ends.

Gateway traffic is not gradually split between versions, and no candidate is
probed before activation: the bytes are the signed release the hosted
installer would deploy for a fresh install, verified on the gateway before
the upload. The grant lives only in the management object's memory for the
attempt and is never persisted; a restart before the upload loses it and the
page hands the browser to Settings without a result. The new version's
Cloudflare version id is not recorded, because the version that could learn
it no longer runs by then.

Anything that fails before the upload fails the action in the journal with
the stage and cause as its code and leaves the running version untouched.
An upload whose outcome is unknown is left to the handover: the alarm either
proves the new release or reports recovery-required.

## Rollback

A successful update retains the previous release reference and Cloudflare
version. Rollback is a new operator-approved action with a fresh Cloudflare
authorization. The gateway fetches the exact recorded release and artifact
digest through its own operation route, even after the channel advances.
The hosted release service reads the retained, immutable release from its
bucket using its reviewed channel, origin, and signing key. The gateway then
independently verifies the signature and every payload digest with its installed
trust key before uploading the old code and assets. It runs behind the same
page as an update and waits the same way before handing over; its target is
the release rolled back to.

The retained release must still be available under that trust key. Missing,
altered, mismatched, or untrusted release bytes stop the action before any
upload; the current channel is never substituted. Retrieving a retained
release does not depend on the promoted bundle loading successfully. The
existing channel descriptor and file routes remain available to older gateways,
which need a forward update before they gain this rollback behavior.

Offline qualification covers a newer promoted release with an older signed
rollback target, inherited secrets, and rejection before upload for unavailable
or invalid historical bytes. A live update-and-rollback cycle remains a release
qualification requirement.

The only persisted rollback changes are Worker code and management assets. It
does not roll back Durable Object data, sources, Access, DNS, Portal
configuration, or credentials. Releases must therefore remain compatible with
retained gateway state.

The original installation receipt remains the ownership authority for later
removal, even after updates.

A Worker can also change outside the journal: an operator-run update, or a
Cloudflare-side rollback to an earlier version. Once no action is in flight,
the journal follows the release the gateway actually runs and keeps the
recorded one as the rollback reference, so the next update starts from the
real installed release instead of refusing with a conflict.

Customer-local Team writes and default-deny source creation can establish a
minimum compatible runtime before their first provider mutation. An older
runtime cannot be restored below that recorded floor, and automatic teardown
remains unavailable. A merely prepared source action or saved draft does not
set the restriction, except the draft of a sign-in source saved without tools:
older releases cannot read that record, so the floor is set before it is
written. The optional Team-management secret also blocks rollback
when present on the current or target version. See [Team access](TEAM_ACCESS.md)
and [first-source qualification](FIRST_SOURCE_ONBOARDING.md); a normal code
update does not provision credentials, grant source access, or clear these
lifecycle restrictions.

The dashboard follows that recorded minimum instead of warning about it
permanently, and the gateway, never the dashboard, works out both answers:

- `GET /api/update` offers a rollback only while the minimum still allows the
  retained release. Once it does not, the answer is
  `rollback: { available: false, reason: "minimum_runtime_release", release }`.
  Settings then names that release, says that a source was installed or Team
  access was changed after the update and the older version cannot work with
  those changes, and offers no rollback button. `{ available: false }` alone
  still means that no previous release is recorded.
- `GET` and `PUT /api/sources` carry `installEndsRollbackTo`: the release that
  can be restored now and no longer could once a source installation starts on
  the running release, otherwise `null`. It is `null` on a fresh install, when
  the minimum already equals the running release or already excludes the
  retained release, when the retained release is not older than the running
  one, and whenever source installation is unavailable. Only when it names a
  release does Sources show one sentence, directly beside the control that
  starts or resumes an installation: "After this you can no longer roll back
  to `<release>`." **Save draft** carries the same sentence for a sign-in source,
  whose draft without tools is what sets the minimum; that save already answers
  `installEndsRollbackTo: null`.
