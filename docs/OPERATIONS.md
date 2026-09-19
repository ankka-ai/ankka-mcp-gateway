# Development and releases

## Everyday work

| Command | Use |
| --- | --- |
| `npm run dev:ui` | Synthetic dashboard and installer previews |
| `npm run check:code` | Lint and root typecheck while editing |
| `npm run test --workspace <app> -- <test-file>` | Focused app regression |
| `npm run check:fast` | Before opening a pull request |
| `npm run check` | Full offline gate; required in CI before merge |

The full gate includes exact toolchain verification, lint, all types and
builds, core and app tests, and public source/history checks. CI distributes
the same work across `check:code`, `check:apps`, `check:core`, and `check:public`.
The required `check` status passes only after every job succeeds. The fast gate
omits installer deployment builds, installer tests, and the history scan; run
focused installer tests when changing installer behavior.

Keep live credentials and generated release output outside the checkout.
Do not repeat successful checks on unchanged source. CI is the full merge gate;
an ordinary PR does not require running that whole gate locally first.

## Release stages

Use `npm run release -- <stage> --help` for exact options. This entrypoint
delegates to the existing tools and retains their validation and output formats.
It does not introduce another release format or state database.

| Stage | Input → result |
| --- | --- |
| `check` | Checkout → full offline gate result |
| `build` | Clean public commit and canonical origin → unsigned candidate |
| `sign` | Candidate and externally supplied seed → signed publication directory |
| `sbom` | Same public commit → source-bound SBOM |
| `publisher` | Signed directory → reviewed R2 publication tool |
| `installer` | Release pin and publication receipt → reviewed installer artifacts |
| `mirror` | Candidate, signed directory, receipt, and SBOM → GitHub publication plan |
| `lifecycle-test` | Synthetic fixtures → offline two-release lifecycle regression |
| `canary` | Enrolled profile → Portal preview or receipt-bound live run |

`lifecycle-test` is already covered by the full gate. Run it separately only
when iterating on that behavior. It is not evidence of a live Cloudflare run.

For example, prepare a candidate using one explicit source commit:

```sh
npm run release -- check
npm run release -- build \
  --source . --source-commit <public-commit> \
  --control-plane-origin <canonical-https-origin> \
  --release gateway-vX.Y.Z --out <external-directory>/candidate
npm run release -- sbom \
  --source . --source-commit <same-public-commit> \
  --release gateway-vX.Y.Z --out <external-directory>/sbom.cdx.json
```

Pipe the signing seed from the approved external secret tool directly to
`npm run release -- sign` with the signer's documented options. The entrypoint
never reads or buffers that input. Do not put the seed in arguments, files,
environment variables, or CI.

After each successful stage, keep its artifacts and continue at the next stage.
The underlying tools validate their inputs; a file's existence alone is not
proof of completion. Outputs remain create-only. After interruption, inspect
and validate output before retrying; use a new output directory for incomplete
preparation. Never blindly repeat publication or deployment.

The publisher and installer stages prepare artifacts. Execute the reviewed
invocation from each generated directory for the authorized live operation.
For GitHub, `mirror --validate-output-dir <directory>` checks the prepared plan;
`mirror --publish-output-dir <directory>` explicitly publishes it. Publication
does not automatically activate an installer or update a gateway.

## Live release qualification

Use the [first-party dogfood runbook](../deploy/cloudflare/FIRST_PARTY_DOGFOOD.md)
for the full signed gateway lifecycle. The short sequence is:

1. Prepare two signed releases from clean public commits with the same isolated
   origin, channel, key, and deployment target.
2. Publish release A and deploy its pinned isolated installer using the reviewed
   generated tools. Complete real Cloudflare consent and install the gateway.
3. Verify source authentication and allowed tool access through the Portal.
4. Publish release B and deploy its pinned installer. Update A → B from the
   gateway dashboard, verify health, then verify rollback and recovery.
5. Remove the gateway through receipt-bound removal and verify resource cleanup.

Record the commits, release digests, outcomes, and any failed step in the
operator's external run record. Keep credentials and infrastructure identifiers
out of public verification material. Do not call a release live-qualified until
all applicable steps have evidence. Signing and isolated publication are
prerequisites for this test; public activation or stable promotion follows it.

The `canary` stage exercises Portal resources. It does **not** cover signed
gateway update, rollback, or OAuth handover. Those still require the runbook's
deployed flow; no unattended equivalent is claimed here. Retired one-off
harnesses must not be used as release gates.

See [Release integrity](RELEASING.md) for the signing and publication contract,
and [Contributing](../CONTRIBUTING.md) for toolchain maintenance.
