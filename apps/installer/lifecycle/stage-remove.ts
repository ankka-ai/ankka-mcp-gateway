import * as v from 'valibot';

import type { BoundaryValue } from '../src/boundary';
import { canonicalJson } from '../src/canonical-json';
import { randomBase64Url, sha256, sha256Hex } from '../src/crypto';
import { openCustomerGatewayOwnershipPrivateKey } from '../src/customer-gateway-ownership-state';
import { operationSignature } from '../src/customer-operation-secrets';
import { runGatewayRootRemovalAttempt } from '../src/gateway-teardown-grant';
import { createGatewayTeardownHandoff, type GatewayTeardownTrust } from '../src/gateway-teardown-handoff';
import {
  authorizeGatewayTeardownJob, consumeGatewayTeardownCallback, createGatewayTeardownJob, settleGatewayTeardownAttempt,
  type GatewayTeardownJob,
} from '../src/gateway-teardown-job';
import type { LiveGatewayInventory } from '../../../tools/live-gateway-provider.mjs';
import { installedPlan, installedProvision } from './stage-install';
import { gatewayEnvironmentBindings, installedRelease } from './stage-update';
import {
  ownershipStorage, payloadEnvironment, readRecordValue, recordJournalPort, recordTeardownJobPort, requireStage, LifecycleStageError,
  type DurableObjectStandIn, type InstallationSecrets, type LifecycleContext,
} from './context';

/**
 * Removal in the production order. Dependency removal drives the release
 * payload's receipt-owned teardown commands (prepare, prove, apply, settle)
 * over the record-backed management and installation objects with the
 * operator-managed credential, then signs the same handoff the gateway
 * signs. Root removal runs the hosted finalizer's fixed steps over a
 * record-backed job under the operator-managed policy. Both survive the
 * gateway's disappearance because authority and records live in the runner.
 */
const ACTION_TTL_MS = 10 * 60_000;
const MAX_REMOVAL_PASSES = 768;

const completionSchema = v.strictObject({
  schemaVersion: v.literal(1), actionId: v.string(), status: v.literal('gateway_removed'), installationId: v.string(),
  removedResourceCount: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  readyReceiptChecksum: v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/u)),
  dependencyResourcesHash: v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/u)),
});
const progressSchema = v.strictObject({ schemaVersion: v.literal(1), actionId: v.string(), status: v.literal('removing'), installationId: v.string(), progress: v.string() });
const actionSchema = v.looseObject({ actionId: v.string(), status: v.string(), expiresAt: v.string() });
const proofSchema = v.looseObject({ actionId: v.string(), status: v.literal('authorized'), receiptResourceKinds: v.array(v.string()) });
const removalRecordSchema = v.looseObject({
  actionId: v.optional(v.string()),
  completion: v.optional(completionSchema),
  handoff: v.optional(v.string()),
  dependenciesVerified: v.optional(v.boolean()),
  rootRemoved: v.optional(v.boolean()),
});
const inventorySchema = v.looseObject({
  schemaVersion: v.literal(1), accountId: v.string(), zoneId: v.string(),
  provision: v.looseObject({ installId: v.string(), workerName: v.string(), bootstrapOrigin: v.string() }),
  resources: v.array(v.looseObject({ path: v.string(), dependency: v.boolean() })),
});

function recordedInventory(context: LifecycleContext): LiveGatewayInventory {
  const parsed = v.safeParse(inventorySchema, context.record.state.inventory);
  if (!parsed.success) throw new LifecycleStageError('inventory_missing', 'blocked');
  return parsed.output;
}

async function requireSecrets(context: LifecycleContext): Promise<InstallationSecrets> {
  const secrets = await context.readInstallationSecrets();
  if (secrets === null) throw new LifecycleStageError('installation_secrets_missing', 'blocked');
  return secrets;
}

interface TeardownIdentity { readonly actionId: string; readonly actionKey: string; readonly expiresAt: number }

async function teardownCommand(
  context: LifecycleContext, management: DurableObjectStandIn, installationId: string,
  kind: 'prove' | 'apply' | 'settle', identity: TeardownIdentity, extra: { readonly requestId?: string; readonly cloudflareAccessToken?: string } = {},
): Promise<Response> {
  const body = canonicalJson({
    schemaVersion: 1, command: kind, actionId: identity.actionId, actionKey: identity.actionKey, actorEmail: context.job.target.adminEmail,
    accountId: context.job.target.accountId, installationId, issuedAt: context.now(), expiresAt: identity.expiresAt, ...extra,
  });
  return management.fetch(new Request(`https://admin-state.invalid/teardown-actions/${kind}-current`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ankka-teardown-action-signature': await operationSignature(identity.actionKey, body) }, body,
  }));
}

async function readAction(management: DurableObjectStandIn, actionId: string) {
  const response = await management.fetch(new Request(`https://admin-state.invalid/teardown-actions/${actionId}`));
  if (response.status !== 200) { await response.body?.cancel(); return null; }
  const parsed = v.safeParse(actionSchema, await response.json());
  return parsed.success ? parsed.output : null;
}

export async function removeDependenciesStage(context: LifecycleContext): Promise<BoundaryValue> {
  const removal = readRecordValue(context.record.state.removal, removalRecordSchema, 'removal_record_invalid');
  const inventory = recordedInventory(context);
  const provision = await installedProvision(context);
  const plan = await installedPlan(context);
  const secrets = await requireSecrets(context);
  const installationId = plan.managementOwnershipMarker;
  const payload = await context.payload();
  const bindings = await gatewayEnvironmentBindings(context);
  const environment = payloadEnvironment(payload, context.record, context.credentials.managementToken === null ? bindings : { ...bindings, ANKKA_MANAGEMENT_TOKEN: context.credentials.managementToken });
  const management = new payload.AdminState({ storage: context.record.storage('object:v1:management') }, environment);
  let completion = removal.completion;
  if (completion === undefined) {
    // An attempt this process did not finish stays armed in the management
    // object; settle it exactly as the gateway's callback would, then the
    // installation object resumes from its recorded deletion boundary.
    if (removal.actionId !== undefined && secrets.teardownActionKey !== undefined) {
      const stale = await readAction(management, removal.actionId);
      if (stale !== null && ['authorization_required', 'applying'].includes(stale.status) && Date.parse(stale.expiresAt) > context.now()) {
        const settled = await teardownCommand(context, management, installationId, 'settle', { actionId: stale.actionId, actionKey: secrets.teardownActionKey, expiresAt: Date.parse(stale.expiresAt) });
        await settled.body?.cancel();
        await context.record.event('remove-dependencies', 'stale_attempt_settled', { accepted: settled.status === 200 });
      }
    }
    const now = context.now();
    const identity: TeardownIdentity = { actionId: `action_${randomBase64Url(24)}`, actionKey: randomBase64Url(32), expiresAt: now + ACTION_TTL_MS };
    await context.writeInstallationSecrets({ ...secrets, teardownActionKey: identity.actionKey });
    await context.record.set('removal', 'actionId', identity.actionId);
    const prepared = await management.fetch(new Request('https://admin-state.invalid/teardown-actions/prepare-current', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: canonicalJson({ schemaVersion: 1, actionId: identity.actionId, actionKeyHash: `sha256:${await sha256Hex(identity.actionKey)}`,
        actorEmail: context.job.target.adminEmail, installationId, issuedAt: now, expiresAt: identity.expiresAt }),
    }));
    await prepared.body?.cancel();
    if (prepared.status !== 200) throw new LifecycleStageError('teardown_action_conflict', 'blocked', String(prepared.status));
    await context.record.event('remove-dependencies', 'action_prepared');
    const proofResponse = await teardownCommand(context, management, installationId, 'prove', identity);
    const proof = v.safeParse(proofSchema, proofResponse.status === 200 ? await proofResponse.json() : null);
    requireStage(proof.success && proof.output.actionId === identity.actionId, 'teardown_proof_rejected', String(proofResponse.status));
    await context.record.event('remove-dependencies', 'ownership_proven', { receiptResourceKinds: proof.output.receiptResourceKinds.length });
    const requestId = randomBase64Url(16);
    const seen = new Set<string>();
    let failure: string | null = null;
    for (let pass = 0; pass < MAX_REMOVAL_PASSES; pass += 1) {
      if (context.now() >= identity.expiresAt) { failure = 'teardown_expired'; break; }
      const response = await teardownCommand(context, management, installationId, 'apply', identity, { requestId, cloudflareAccessToken: context.credentials.deploymentToken });
      const body = response.status === 200 ? await response.json() : null;
      if (body === null) { await response.body?.cancel(); failure = `teardown_apply_rejected_${response.status}`; break; }
      const result = v.safeParse(v.union([completionSchema, progressSchema]), body);
      if (!result.success || result.output.actionId !== identity.actionId || result.output.installationId !== installationId) { failure = 'teardown_apply_invalid'; break; }
      if (result.output.status === 'gateway_removed') { completion = result.output; break; }
      if (seen.has(result.output.progress)) { failure = 'teardown_no_progress'; break; }
      seen.add(result.output.progress);
      await context.record.event('remove-dependencies', 'pass', { pass });
    }
    if (completion === undefined && failure === null) failure = 'teardown_pass_limit';
    const settled = await teardownCommand(context, management, installationId, 'settle', identity);
    await settled.body?.cancel();
    requireStage(settled.status === 200, 'teardown_settlement_failed');
    if (completion === undefined) throw new LifecycleStageError(failure ?? 'teardown_failed');
    await context.record.set('removal', 'completion', completion);
    await context.record.event('remove-dependencies', 'dependencies_removed', { removedResourceCount: completion.removedResourceCount });
  }
  if (removal.handoff === undefined) {
    const ownership = ownershipStorage(context.record.storage('ownership'));
    const certificate = v.parse(v.string(), context.record.state.install.ownershipCertificate);
    const journal = await recordJournalPort(context.record).read();
    requireStage(journal !== null, 'journal_missing');
    const privateKey = await openCustomerGatewayOwnershipPrivateKey({ storage: ownership, wrappingKey: secrets.ownershipWrapKey });
    const trust: GatewayTeardownTrust = { pinnedIssuerPublicKey: secrets.issuer.publicKey, expectedKeyId: secrets.issuer.keyId, expectedPublicClientId: secrets.publicClientId };
    const handoff = await createGatewayTeardownHandoff({
      certificate, privateKey, trust, plan, journal, actionId: completion.actionId, nonce: randomBase64Url(32),
      readyReceiptChecksum: completion.readyReceiptChecksum, dependencyResourcesHash: completion.dependencyResourcesHash,
      customerGrantRevocation: 'operator-managed', priorGrantRevocationUnconfirmed: false, now: context.now(),
    });
    await context.record.set('removal', 'handoff', handoff);
    await context.record.event('remove-dependencies', 'handoff_signed');
  }
  await context.provider.assertDependenciesAbsent(inventory);
  await context.record.set('removal', 'dependenciesVerified', true);
  return { removedResourceCount: completion.removedResourceCount, workerName: provision.deployment.workerName };
}

export async function removeRootStage(context: LifecycleContext): Promise<BoundaryValue> {
  const removal = readRecordValue(context.record.state.removal, removalRecordSchema, 'removal_record_invalid');
  requireStage(removal.handoff !== undefined && removal.dependenciesVerified === true, 'dependencies_not_removed');
  const secrets = await requireSecrets(context);
  const which = installedRelease(context);
  const release = await context.release(which);
  const retirement = release.bundle.manifest.components.workerRetirement.files[0];
  requireStage(retirement?.path === 'payload/worker-retirement/index.js', 'retirement_module_missing');
  const trust: GatewayTeardownTrust = { pinnedIssuerPublicKey: secrets.issuer.publicKey, expectedKeyId: secrets.issuer.keyId, expectedPublicClientId: secrets.publicClientId };
  const port = recordTeardownJobPort(context.record);
  let job: GatewayTeardownJob | null = await port.read();
  if (job === null) {
    const created = await createGatewayTeardownJob({
      handoff: removal.handoff, trust, retirementModuleSha256: retirement.sha256, now: context.now(), credentialPolicy: 'operator-managed',
      release: { schemaVersion: 1, channel: release.pin.channel, controlPlaneOrigin: release.pin.controlPlaneOrigin, release: release.pin.release,
        keyId: release.pin.keyId, publicKey: release.pin.publicKey, artifactSha256: release.pin.artifactSha256 },
    });
    requireStage(await port.compareAndSet(null, created), 'teardown_job_conflict');
    job = created;
  }
  const commit = async (previous: GatewayTeardownJob, next: GatewayTeardownJob): Promise<GatewayTeardownJob> => {
    requireStage(await port.compareAndSet(previous.revision, next), 'teardown_job_conflict');
    return next;
  };
  if (job.phase.startsWith('removed')) {
    await context.record.set('removal', 'rootRemoved', true);
    return { alreadyRemoved: true, verifiedSteps: job.verifiedSteps.length };
  }
  if (job.attempt !== null) {
    // The previous process died inside this attempt; settle it so the pending boundary is resumed, never resent.
    job = await commit(job, settleGatewayTeardownAttempt({ job, attemptId: job.attempt.id, revocation: 'not_attempted', reason: 'attempt_interrupted', now: context.now() }));
    await context.record.event('remove-root', 'interrupted_attempt_settled', { verifiedSteps: job.verifiedSteps.length, pendingStep: job.pendingStep });
  }
  const attemptId = `attempt_${randomBase64Url(18)}`;
  job = await commit(job, authorizeGatewayTeardownJob({ job, attemptId, stateHash: await sha256(randomBase64Url(32)), verifierHash: await sha256(randomBase64Url(32)), now: context.now() }));
  requireStage(job.attempt !== null, 'teardown_attempt_missing');
  job = await commit(job, consumeGatewayTeardownCallback({ job, attemptId, stateHash: job.attempt.stateHash, verifierHash: job.attempt.verifierHash, now: context.now() }));
  await context.record.event('remove-root', 'attempt_started', { verifiedSteps: job.verifiedSteps.length });
  const reason = await runGatewayRootRemovalAttempt({
    port, attemptId, trust, bundle: release.bundle, accessToken: context.credentials.deploymentToken,
    transport: (input, init) => context.transport(input, init), now: context.now,
  });
  const latest = await port.read();
  requireStage(latest !== null, 'teardown_job_missing');
  const settled = await commit(latest, settleGatewayTeardownAttempt({ job: latest, attemptId, revocation: 'not_attempted', reason, now: context.now() }));
  await context.record.event('remove-root', 'attempt_settled', { phase: settled.phase, verifiedSteps: settled.verifiedSteps.length, reason });
  if (settled.phase !== 'removed') throw new LifecycleStageError(`root_removal_${reason ?? 'incomplete'}`);
  await context.record.set('removal', 'rootRemoved', true);
  return { verifiedSteps: settled.verifiedSteps.length };
}

export async function verifyAbsentStage(context: LifecycleContext): Promise<BoundaryValue> {
  const removal = readRecordValue(context.record.state.removal, removalRecordSchema, 'removal_record_invalid');
  requireStage(removal.rootRemoved === true, 'root_not_removed');
  const inventory = recordedInventory(context);
  try {
    await context.provider.assertAllAbsent(inventory);
  } catch (error) {
    const failure = v.safeParse(v.looseObject({ code: v.string() }), error);
    throw new LifecycleStageError('owned_resource_still_present', 'failed', failure.success ? failure.output.code : null);
  }
  return {
    ownedResourcesChecked: inventory.resources.length,
    retained: [],
    preservedUnrelated: ['account workers.dev subdomain', 'synthetic source Worker', 'operator credentials'],
  };
}
