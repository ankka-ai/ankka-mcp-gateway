# Management-token release boundary

Issue #123 introduces the optional `ANKKA_MANAGEMENT_TOKEN` customer Worker
secret in the exact signed release contract. It does not revive the retired
`ANKKA_TEAM_MANAGEMENT_TOKEN` contract or its OAuth relay.

## Fresh installation

Earlier runtimes verify a different exact contract and cannot accept this
candidate through an ordinary in-dashboard update. While pre-users, qualify
this release on a fresh installation. A transition for existing installations
requires a separately reviewed bridge; this change does not silently broaden
old signature or contract verification. Do not manually overwrite a live Worker
to bypass its ownership state or release checks.

## Updates after setup

Compatible updates accept the optional management binding only as `secret_text`
and preserve it through Cloudflare's strict secret inheritance. They never read
its value. Unknown bindings and plaintext substitutes are rejected. The target
release must match the new exact signed contract, so rollback to an incompatible
older contract is unavailable. Existing lifecycle floors remain enforced.

## Replacing and removing credentials

Create the replacement account token directly in Cloudflare, replace the Worker
secret, verify management access in Settings, then revoke the old token.
Deleting a secret or Worker does not revoke its API token. Historical Worker
versions may retain old bindings, so revoke at the provider to remove authority.
The gateway has no token-creation or token-revocation permission.

Do not delete pending operation journals or original receipts as a recovery
shortcut. Restoring a credential does not prove a previous write was undone.
