import * as v from 'valibot';

/**
 * The customer shell's token-free install status answer, shared by the shell
 * that writes it and the hosted runtime that reads it during the Stage 1
 * readiness check, so the two cannot drift apart again.
 *
 * `failure` names the last Stage 2 outcome with a fixed code and a
 * secret-free reason; it is optional so a hosted runtime can still read a
 * shell from a release that predates the field.
 *
 * `managementCredential` is one fixed word about the management credential
 * step of setup, never the value: `held` while the owning object keeps a
 * pasted value in memory for the final runtime upload, `installed` once that
 * upload carried it, `skipped` when the customer continued without one, and
 * `dropped` when a provided value is no longer in memory (the object
 * restarted or the hold ran out), so the install finishes without it. The
 * shell omits the key until the customer has chosen: a freshly deployed shell
 * answers exactly as before, and a hosted runtime that predates the key still
 * reads it during the readiness check, which happens before anyone can choose.
 */
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const INSTALL_ID = /^acg-[a-f0-9]{24}$/u;
const RELEASE_ID = /^gateway-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const FAILURE_REASON = /^[a-z][a-z0-9_]{0,159}$/u;

export const customerManagementCredentialWordSchema = v.picklist(['held', 'installed', 'skipped', 'dropped']);

export type CustomerManagementCredentialWord = v.InferOutput<typeof customerManagementCredentialWordSchema>;

export const customerInstallStatusSchema = v.strictObject({
  schemaVersion: v.literal(1),
  role: v.literal('customer-gateway-bootstrap'),
  status: v.picklist(['INCOMPLETE', 'CONVERGING', 'READY']),
  installId: v.pipe(v.string(), v.regex(INSTALL_ID)),
  release: v.pipe(v.string(), v.regex(RELEASE_ID)),
  ownershipPublicKey: v.pipe(v.string(), v.regex(TOKEN)),
  failure: v.optional(v.union([
    v.null(),
    v.strictObject({
      code: v.pipe(v.string(), v.regex(FAILURE_CODE)),
      reason: v.union([v.null(), v.pipe(v.string(), v.regex(FAILURE_REASON))]),
    }),
  ]), null),
  managementCredential: v.optional(customerManagementCredentialWordSchema),
});

export type CustomerInstallStatus = v.InferInput<typeof customerInstallStatusSchema>;
