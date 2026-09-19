# Removing a source

Compatible releases offer **Sources → expand a source → Remove source**.
Review the named source and confirm. Removal stops your team's access through
this gateway, detaches the source from its Portal, and deletes the source's
owned MCP server registration, Access policy and Access application. Your
upstream service and its data are unchanged. Adding it again creates a new
installation with nobody assigned; old Team assignments do not return.

An unused draft also offers **Remove source**. It needs no management token and
makes no provider writes. If an installation is pending, cancel its unstarted
authorization or finish its recovery before deleting the source. A draft with
possible provider resources is never discarded as though it were unstarted.

Installed-source removal uses the [management token](MANAGEMENT_TOKEN.md)
inside your Worker. The browser sends only the source ID and the reviewed
source-list revision. It sends no Cloudflare locator or credential. The API
requires administrator authentication and same-origin proof; service-token
identities cannot invoke removal in this release.

Installed managed BigQuery bridges cannot yet be removed individually. Removing their
Worker and stored Google key needs broader, temporary Cloudflare authorization
than the routine management token has. The page explains this restriction;
Team can revoke source access, and full gateway removal cleans up the bridge.
Failed BigQuery setups retain their existing Cloudflare-authorized removal
and recovery flow. The runtime also checks the retained bridge receipt, even
if its old source installation action has been pruned.

The revision-bound endpoint is `DELETE /api/sources/<source-id>` with
`{ "schemaVersion": 1, "revision": <reviewed-source-list-revision> }`.
`GET /api/sources` advertises `removalEnabled`,
`removalCredentialConfigured` and the optional `pendingRemoval.sourceId`.
The source-actions snapshot names an unfinished removal as
`blockingAction.kind: "source_removal"`. Older runtimes without the capability
keep removal controls hidden.

## Interrupted removal

The source stays listed until every resource's absence is confirmed. If a
response is lost, use **Check status**, then **Continue removal**. Reloading the
page also finds the saved progress. Continuing first reads Cloudflare's state:
a verified successful delete is not sent again. An accepted asynchronous
delete is not treated as proof that the resource is gone.

Removal blocks source installation, draft saves, Team changes, runtime updates,
gateway teardown and management-token changes until completion. It also
advances the minimum compatible runtime before its first provider write, so
rollback cannot lose the removal journal or its ownership interpretation.

The executor checks immutable receipt hashes, the current Portal mappings,
resource identities, foreign policies and use by other Portals before writing.
It detaches the mapping first, then removes the server while Access protection
remains, followed by its policy and application. Each write is armed durably;
provider calls share a 30-second deadline. Drift or unknown results retain
progress. A resource reappearing after verified deletion stops recovery.
These checks cannot lock out simultaneous manual edits in Cloudflare.

Completion atomically updates source state, ownership, Team assignments and
the removal journal. Removing an original installation source keeps its
secret-free definition alongside management ownership so the immutable root
receipt can still be verified for later gateway teardown. That receipt is
never rewritten, and its retired resource locators cannot be reused as active
source ownership. Ordinary removed sources leave no active ownership entry.

## Local evidence

Worker tests use synthetic Cloudflare state to exercise ownership refusal,
interrupted writes and final storage commits, lifecycle exclusion, draft
removal, Team continuity and gateway teardown after removal. Dashboard tests
exercise confirmation, cancellation, recovery and capability restrictions.
`npm run check:fast` includes these and the workerd/SQLite runtime suite.
These tests do not qualify live provider permissions or deployed behavior;
release promotion still requires the provider/deployed checks described in
[Local runtime](LOCAL_RUNTIME.md).
