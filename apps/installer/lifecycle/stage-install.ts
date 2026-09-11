import * as v from 'valibot';

import type { BoundaryValue } from '../src/boundary';
import { canonicalJson } from '../src/canonical-json';
import { issueCloudflareGatewayOwnershipCertificate } from '../src/cloudflare-gateway-ownership-proof';
import { base64UrlEncode, sha256Hex } from '../src/crypto';
import { prepareCustomerBootstrapClaimFromPlan } from '../src/customer-bootstrap-request';
import {
  acceptCustomerGatewayOwnershipHandoff,
  initializeCustomerGatewayOwnershipState,
  readCustomerGatewayOwnershipState,
} from '../src/customer-gateway-ownership-state';
import { CUSTOMER_INSTALL_OAUTH_CALLBACK_PATH } from '../src/customer-install-paths';
import { CUSTOMER_STAGE2_CHUNK_CHECKPOINTS, convergeCustomerStage2, CustomerStage2ConvergerError } from '../src/customer-stage2-converger';
import type { CustomerStage2JournalPort } from '../src/customer-stage2-durable-state';
import { CustomerStage2JournalError } from '../src/customer-stage2-journal';
import {
  completeHostedStage1Handoff,
  createHostedStage1Secrets,
  expectedCustomerBootstrapBindings,
  parseHostedStage1Provision,
  provisionHostedStage1WithOperatorCredential,
  type HostedStage1Provision,
} from '../src/hosted-stage1-bootstrap';
import { buildStaticDeployPlan, parseDeploySelection, parseStaticDeployPlan, withDeployServiceAccess, type StaticDeployPlan } from '../src/schema';
import { inventoryDeploymentCredential } from '../../../tools/lifecycle-credentials.mjs';
import {
  installationSecretsSchema,
  ownershipStorage,
  payloadEnvironment,
  readRecordValue,
  recordJournalPort,
  requireStage,
  wait,
  LifecycleStageError,
  type InstallationSecrets,
  type LifecycleContext,
  type PayloadBindings,
} from './context';

/**
 * Installation stages: the exact hosted Stage 1 and shell-side Stage 2
 * operations run in this process with the operator-managed credential. The
 * gateway's ownership identity, Stage 2 journal and Durable Object state
 * land in the runner's record; the Worker, Access, Portal, DNS and signed
 * runtime are real.
 */
const ISSUER_KEY_ID = 'lifecycle-runner-issuer-v1';
const HANDOFF_DEADLINE_MS = 4 * 60_000;
const MAX_CONVERGER_PASSES = 8;
const MAX_PROVIDER_CALLS_PER_PASS = 45;

const installRecordSchema = v.looseObject({
  plan: v.optional(v.any()),
  provision: v.optional(v.any()),
  handoffAccepted: v.optional(v.boolean()),
  ownershipCertificate: v.optional(v.string()),
  bindings: v.optional(v.record(v.string(), v.string())),
  target: v.optional(v.strictObject({ accountId: v.string(), zoneId: v.string(), zoneName: v.string() })),
  converged: v.optional(v.boolean()),
});

function selection(context: LifecycleContext) {
  const base = parseDeploySelection({
    schemaVersion: 1,
    basics: {
      gatewayName: context.job.target.gatewayName,
      zoneName: context.job.target.zoneName,
      adminEmail: context.job.target.adminEmail,
      additionalAdminEmails: [],
      managementHostname: context.hostnames.management,
      portalHostname: context.hostnames.portal,
    },
    firstSource: null,
  });
  // A job that names a service credential opts the gateway into that one identity; the hosted installer never does.
  const service = context.job.credentials.service;
  return service === undefined ? base : withDeployServiceAccess(base, { clientId: service.clientId, tokenId: service.tokenId });
}

export async function installedPlan(context: LifecycleContext): Promise<StaticDeployPlan> {
  const install = readRecordValue(context.record.state.install, installRecordSchema, 'install_record_invalid');
  requireStage(install.plan !== undefined, 'install_plan_missing');
  return parseStaticDeployPlan(install.plan);
}

export async function installedProvision(context: LifecycleContext): Promise<HostedStage1Provision> {
  const install = readRecordValue(context.record.state.install, installRecordSchema, 'install_record_invalid');
  requireStage(install.provision !== undefined, 'install_provision_missing');
  return parseHostedStage1Provision(install.provision);
}

export function installedTarget(context: LifecycleContext) {
  const install = readRecordValue(context.record.state.install, installRecordSchema, 'install_record_invalid');
  requireStage(install.target !== undefined, 'install_target_missing');
  return install.target;
}

export function installedBindings(context: LifecycleContext): PayloadBindings {
  const install = readRecordValue(context.record.state.install, installRecordSchema, 'install_record_invalid');
  requireStage(install.bindings !== undefined, 'install_bindings_missing');
  // SAFETY: the converger recorded the final runtime's plain-text bindings by their fixed names.
  return install.bindings as PayloadBindings;
}

async function requireSecrets(context: LifecycleContext): Promise<InstallationSecrets> {
  const secrets = await context.readInstallationSecrets();
  if (secrets === null) throw new LifecycleStageError('installation_secrets_missing', 'blocked');
  return secrets;
}

async function issuerKey(secrets: InstallationSecrets): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', secrets.issuer.privateKeyJwk, { name: 'Ed25519' }, false, ['sign']);
}

/** The shell environment the converger's in-process payload runs under, exactly as the shell would deploy it. */
async function shellBindings(context: LifecycleContext, plan: StaticDeployPlan, provision: HostedStage1Provision, secrets: InstallationSecrets) {
  const release = await context.release('a');
  const workerName = plan.managementResources.find((resource) => resource.kind === 'management_worker')?.name;
  requireStage(workerName !== undefined, 'plan_worker_missing');
  const expected = expectedCustomerBootstrapBindings({
    accountId: context.job.target.accountId, bootstrapCallback: provision.bootstrapCallback,
    customerOauthClientId: secrets.publicClientId, issuerKeyId: secrets.issuer.keyId, issuerPublicKey: secrets.issuer.publicKey,
    plan, release: release.parsed, capability: secrets.capability, workerName,
  });
  return { expected, workerName, environment: Object.freeze({
    ...expected, ANKKA_BOOTSTRAP_NONCE: secrets.bootstrapNonce, ANKKA_GATEWAY_OWNERSHIP_WRAP_KEY: secrets.ownershipWrapKey,
  }) };
}

export async function preflightStage(context: LifecycleContext): Promise<BoundaryValue> {
  const inventory = await inventoryDeploymentCredential({
    token: context.credentials.deploymentToken, accountId: context.job.target.accountId, zoneId: context.job.target.zoneId,
    transport: context.probeTransport,
  });
  const denied = inventory.families.filter((family) => family.outcome !== 'readable').map((family) => `${family.family}:${family.outcome}`);
  if (inventory.identity.status === null) throw new LifecycleStageError('deployment_credential_rejected', 'blocked');
  if (denied.length > 0) throw new LifecycleStageError('deployment_credential_families_denied', 'blocked', denied.join(','));
  const [a, b] = await Promise.all([context.release('a'), context.release('b')]);
  requireStage(a.pin.release !== b.pin.release && a.pin.artifactSha256 !== b.pin.artifactSha256 && a.pin.keyId === b.pin.keyId, 'release_pair_invalid');
  await context.provider.assertFresh();
  return { credential: inventory.identity.kind, expiresOn: inventory.identity.expiresOn, families: inventory.families.length, releases: [a.pin.release, b.pin.release] };
}

export async function bootstrapStage(context: LifecycleContext): Promise<BoundaryValue> {
  const install = readRecordValue(context.record.state.install, installRecordSchema, 'install_record_invalid');
  const release = await context.release('a');
  let secrets = await context.readInstallationSecrets();
  if (secrets === null) {
    // SAFETY: Ed25519 generateKey always yields a key pair; the union only exists for symmetric algorithms.
    const issuer = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    const generated = await createHostedStage1Secrets({ now: context.now() });
    secrets = v.parse(installationSecretsSchema, {
      schemaVersion: 1, capability: generated.capability, bootstrapNonce: generated.bootstrapNonce, ownershipWrapKey: generated.ownershipWrapKey,
      issuer: { keyId: ISSUER_KEY_ID, publicKey: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', issuer.publicKey))),
        privateKeyJwk: await crypto.subtle.exportKey('jwk', issuer.privateKey) },
      publicClientId: base64UrlEncode(crypto.getRandomValues(new Uint8Array(24))).replaceAll(/[^A-Za-z0-9]/gu, 'x').slice(0, 32),
    });
    await context.writeInstallationSecrets(secrets);
  }
  let plan: StaticDeployPlan;
  if (install.plan === undefined) {
    plan = await buildStaticDeployPlan(selection(context), release.parsed.manifest, context.now() + 60 * 60_000);
    await context.record.set('install', 'plan', JSON.parse(canonicalJson(plan)));
  } else {
    plan = parseStaticDeployPlan(install.plan);
  }
  const privateKey = await issuerKey(secrets);
  let provision: HostedStage1Provision;
  if (install.provision === undefined) {
    if (secrets.capability.expiresAt <= context.now()) throw new LifecycleStageError('bootstrap_capability_expired', 'blocked');
    await context.record.event('bootstrap', 'provisioning');
    provision = await provisionHostedStage1WithOperatorCredential({
      credential: { kind: 'operator-managed', accessToken: context.credentials.deploymentToken },
      transport: context.transport, bundle: release.bundle, plan, secrets: {
        capability: secrets.capability, bootstrapNonce: secrets.bootstrapNonce, ownershipWrapKey: secrets.ownershipWrapKey,
      },
      customerOauthClientId: secrets.publicClientId, issuerKeyId: secrets.issuer.keyId, issuerPublicKey: secrets.issuer.publicKey,
      issuerPrivateKey: privateKey, now: context.now,
    });
    // A static-plan provision carries an undefined zone list, which the strict canonical encoder refuses; the record needs plain JSON.
    await context.record.set('install', 'provision', JSON.parse(JSON.stringify(provision)));
    await context.record.event('bootstrap', 'provisioned', { recovery: provision.deployment.recovery });
  } else {
    provision = parseHostedStage1Provision(install.provision);
  }
  context.allowOrigin(new URL(provision.bootstrapOrigin).origin, ['GET']);
  if (install.handoffAccepted !== true) {
    if (secrets.capability.expiresAt <= context.now()) throw new LifecycleStageError('bootstrap_capability_expired', 'blocked');
    const started = context.now();
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        await completeHostedStage1Handoff({
          provision, plan, capabilitySecret: secrets.capability.secret, customerOauthClientId: secrets.publicClientId,
          issuerKeyId: secrets.issuer.keyId, issuerPublicKey: secrets.issuer.publicKey, issuerPrivateKey: privateKey,
          transport: context.transport, now: context.now,
        });
        break;
      } catch (error) {
        const failure = v.safeParse(v.looseObject({ code: v.string() }), error);
        if (!(failure.success && failure.output.code === 'bootstrap_not_ready') || context.now() - started > HANDOFF_DEADLINE_MS) throw error;
        await wait(3_000);
      }
    }
    await context.record.event('bootstrap', 'shell_ready', { attempts });
    const { workerName } = await shellBindings(context, plan, provision, secrets);
    const storage = ownershipStorage(context.record.storage('ownership'));
    const customerKey = await initializeCustomerGatewayOwnershipState({ storage, wrappingKey: secrets.ownershipWrapKey });
    const gatewayCallback = `https://${plan.gatewayConfiguration.managementHostname}${CUSTOMER_INSTALL_OAUTH_CALLBACK_PATH}`;
    const certificate = install.ownershipCertificate ?? await issueCloudflareGatewayOwnershipCertificate({
      accountId: context.job.target.accountId, installId: plan.managementOwnershipMarker,
      worker: { name: provision.deployment.workerName, providerId: provision.deployment.workerId },
      adminStateNamespaceId: provision.deployment.namespaceId, bootstrapCallback: provision.bootstrapCallback, gatewayCallback,
      publicClientId: secrets.publicClientId, ownershipPublicKey: customerKey.publicKey,
      handoffSha256: `sha256:${await sha256Hex(provision.handoff)}`, issuedAt: context.now(), keyId: secrets.issuer.keyId,
    }, privateKey);
    await context.record.set('install', 'ownershipCertificate', certificate);
    await acceptCustomerGatewayOwnershipHandoff({
      storage,
      config: {
        accountId: context.job.target.accountId, installId: plan.managementOwnershipMarker, workerName,
        plan: { id: plan.planId, hash: plan.planHash }, release: { id: plan.releaseId, artifactSha256: plan.releaseArtifactSha256 },
        bootstrapSecretCommitment: secrets.capability.secretCommitment, bootstrapExpiresAt: secrets.capability.expiresAt,
        bootstrapCallback: provision.bootstrapCallback, gatewayCallback, publicClientId: secrets.publicClientId,
        pinnedIssuerPublicKey: secrets.issuer.publicKey, issuerKeyId: secrets.issuer.keyId,
      },
      serializedHandoff: provision.handoff, serializedPlan: canonicalJson(plan), ownershipCertificate: certificate, now: context.now(),
    });
    await context.record.set('install', 'handoffAccepted', true);
  }
  return { installId: plan.managementOwnershipMarker, workerName: provision.deployment.workerName, recovery: provision.deployment.recovery };
}

/** The Stage 2 lease term; a dead attempt's lease can only be taken over after it. */
const STAGE2_LEASE_TTL_MS = 5 * 60_000;

/**
 * An interrupted attempt leaves its lease in the journal, and the journal's
 * contract lets a successor take it over only after expiry. The run lock
 * already proves the holder is gone, so the stage waits out the remainder
 * instead of reporting a conflict.
 */
async function waitOutAbandonedLease(context: LifecycleContext, port: CustomerStage2JournalPort): Promise<void> {
  const current = await port.read();
  if (current === null || current.completedAt !== null || current.lease === null) return;
  const remaining = current.lease.expiresAt - context.now();
  if (remaining <= 0) return;
  requireStage(remaining <= STAGE2_LEASE_TTL_MS, 'stage2_lease_invalid');
  await context.record.event('converge', 'lease_wait', { seconds: Math.ceil(remaining / 1000) });
  await wait(remaining + 1000);
}

export async function convergeStage(context: LifecycleContext): Promise<BoundaryValue> {
  const install = readRecordValue(context.record.state.install, installRecordSchema, 'install_record_invalid');
  requireStage(install.handoffAccepted === true, 'bootstrap_not_completed');
  if (install.converged === true) return { alreadyConverged: true };
  const secrets = await requireSecrets(context);
  const plan = await installedPlan(context);
  const provision = await installedProvision(context);
  const release = await context.release('a');
  const payload = await context.payload();
  const { expected, environment: shellEnvironment } = await shellBindings(context, plan, provision, secrets);
  const ownership = ownershipStorage(context.record.storage('ownership'));
  await readCustomerGatewayOwnershipState(ownership);
  const journal = recordJournalPort(context.record);
  await waitOutAbandonedLease(context, journal);
  const attemptId = `attempt_${base64UrlEncode(crypto.getRandomValues(new Uint8Array(18)))}`;
  const passes: number[] = [];
  let result: Awaited<ReturnType<typeof convergeCustomerStage2>>;
  for (;;) {
    const callsBefore = context.record.state.trace.length;
    try {
      result = await convergeCustomerStage2({
        accessToken: context.credentials.deploymentToken, attemptId, storage: ownership, journal,
        runtime: { controlPlaneOrigin: release.bundle.manifest.controlPlaneOrigin, updateChannel: release.bundle.channel === 'stable' ? 'stable' : 'canary', updateKeyId: release.bundle.keyId, updatePublicKey: release.bundle.publicKey },
        bootstrap: { nonce: secrets.bootstrapNonce, expectedBindings: expected },
        finalRuntimeSource: release.finalRuntimeSource,
        payload: {
          bootstrap: async (request, { target, bindings }) => {
            const installationEnvironment = payloadEnvironment(payload, context.record, { ...shellEnvironment, CLOUDFLARE_ZONE_ID: target.zoneId, CLOUDFLARE_ZONE_NAME: target.zoneName, ZERO_TRUST_READY: 'true' });
            const claimText = await request.clone().text();
            const response = await payload.processBootstrap(request, installationEnvironment, context.record.storage(`object:v1:${plan.managementOwnershipMarker}`));
            if (response.status !== 200) return response;
            const managementBindings = { ...shellEnvironment, ...bindings, CLOUDFLARE_ZONE_ID: target.zoneId, CLOUDFLARE_ZONE_NAME: target.zoneName, ZERO_TRUST_READY: 'true' as const };
            const managementEnvironment = payloadEnvironment(payload, context.record, managementBindings);
            const managementObject = new payload.AdminState({ storage: context.record.storage('object:v1:management') }, managementEnvironment);
            const published = await payload.publishBootstrapCompletion(
              JSON.parse(claimText), JSON.parse(await response.clone().text()), managementEnvironment, context.now(), (internal) => managementObject.fetch(internal),
            );
            if (published !== true) {
              return new Response(JSON.stringify({ schemaVersion: 1, error: 'management_publication_failed', retryable: false }), {
                status: 409, headers: { 'content-type': 'application/json; charset=utf-8' },
              });
            }
            await context.record.set('install', 'bindings', JSON.parse(JSON.stringify(bindings)));
            await context.record.set('install', 'target', { accountId: target.accountId, zoneId: target.zoneId, zoneName: target.zoneName });
            return response;
          },
          verifyReady: async ({ accessToken, plan: renewed, target }) => {
            const claim = await prepareCustomerBootstrapClaimFromPlan({ plan: renewed, target, nowMs: context.now() });
            const installationEnvironment = payloadEnvironment(payload, context.record, { ...shellEnvironment, CLOUDFLARE_ZONE_ID: target.zoneId, CLOUDFLARE_ZONE_NAME: target.zoneName, ZERO_TRUST_READY: 'true' });
            return payload.verifyBootstrapReceiptProviderStateWithReason(
              { ...claim, cloudflareAccessToken: accessToken }, installationEnvironment, context.record.storage(`object:v1:${plan.managementOwnershipMarker}`), context.now(),
            );
          },
        },
        transport: context.transport, now: context.now, checkpoints: CUSTOMER_STAGE2_CHUNK_CHECKPOINTS,
        handover: async () => { await context.record.event('converge', 'final_runtime_upload_armed'); },
      });
    } catch (error) {
      if (error instanceof CustomerStage2ConvergerError) {
        const status = error.code === 'journal_conflict' ? 'blocked' : 'failed';
        throw new LifecycleStageError(`converge_${error.code}`, status, error.reason);
      }
      if (error instanceof CustomerStage2JournalError) throw new LifecycleStageError(`converge_journal_${error.code}`, error.code === 'conflict' ? 'blocked' : 'failed');
      throw error;
    }
    const calls = context.record.state.trace.length - callsBefore;
    passes.push(calls);
    const stop = result.verified ? 'complete' : 'paused' in result ? `${result.checkpoint.action}:${result.checkpoint.phase}` : 'handed_over';
    await context.record.event('converge', 'pass', { pass: passes.length, providerCalls: calls, stop });
    requireStage(calls <= MAX_PROVIDER_CALLS_PER_PASS, 'converge_pass_budget_exceeded', String(calls));
    if (result.verified || 'handedOver' in result) break;
    requireStage(passes.length < MAX_CONVERGER_PASSES, 'converge_pass_limit');
  }
  await context.record.set('install', 'converged', true);
  return { passes, handedOver: !result.verified };
}

export async function verifyStage(context: LifecycleContext): Promise<BoundaryValue> {
  const install = readRecordValue(context.record.state.install, installRecordSchema, 'install_record_invalid');
  requireStage(install.converged === true, 'converge_not_completed');
  const provision = await installedProvision(context);
  const target = installedTarget(context);
  const payload = await context.payload();
  const bindings = installedBindings(context);
  await context.provider.assertWorker({ installId: provision.installId, workerName: provision.deployment.workerName, bootstrapOrigin: provision.bootstrapOrigin });
  const account = `/client/v4/accounts/${context.job.target.accountId}`;
  const subdomain = await providerJson(context, `${account}/workers/scripts/${provision.deployment.workerName}/subdomain`);
  const enabled = v.safeParse(v.looseObject({ result: v.looseObject({ enabled: v.boolean() }) }), subdomain);
  requireStage(enabled.success && enabled.output.result.enabled === false, 'workers_dev_still_enabled');
  const settings = await providerJson(context, `${account}/workers/scripts/${provision.deployment.workerName}/settings`);
  const names = v.safeParse(v.looseObject({ result: v.looseObject({ bindings: v.array(v.looseObject({ name: v.string() })) }) }), settings);
  requireStage(names.success, 'worker_settings_unreadable');
  const bound = names.output.result.bindings.map((binding) => binding.name);
  requireStage(bound.includes('CF_ACCESS_AUD') && !bound.includes('ANKKA_BOOTSTRAP_NONCE'), 'final_runtime_bindings_unexpected');
  const environment = payloadEnvironment(payload, context.record, { ...bindings, CLOUDFLARE_ZONE_ID: target.zoneId, CLOUDFLARE_ZONE_NAME: target.zoneName, ZERO_TRUST_READY: 'true' });
  const management = new payload.AdminState({ storage: context.record.storage('object:v1:management') }, environment);
  for (const path of ['/status', '/sources', '/management-control']) {
    const response = await management.fetch(new Request(`https://admin-state.invalid${path}`));
    requireStage(response.status === 200, 'management_object_unavailable', path);
  }
  return { workerName: provision.deployment.workerName, bindings: bound.length };
}

/** One authenticated provider read through the guarded transport; the body is parsed, never logged. */
export async function providerJson(context: LifecycleContext, path: string): Promise<BoundaryValue> {
  const response = await context.transport(`https://api.cloudflare.com${path}`, {
    method: 'GET', headers: { authorization: `Bearer ${context.credentials.deploymentToken}`, accept: 'application/json' },
    redirect: 'manual', signal: AbortSignal.timeout(30_000),
  });
  requireStage(response.status === 200, 'provider_read_rejected', String(response.status));
  return await response.json();
}
