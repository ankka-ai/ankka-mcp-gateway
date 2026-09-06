import * as v from 'valibot';

import type { BoundaryValue } from '../src/boundary';
import { CustomerRuntimeUpdateError, runCustomerRuntimeUpdate } from '../src/customer-runtime-update';
import { installedBindings, installedProvision, installedTarget, providerJson } from './stage-install';
import { readRecordValue, requireStage, LifecycleStageError, type LifecycleContext, type PayloadBindings } from './context';

/**
 * The gateway's own updater, run here with the operator-managed credential
 * against the real installed Worker. Release B is read from the local publish
 * directory through the control-plane routes the updater already speaks; the
 * signed envelope and every payload digest are verified by the updater. The
 * update journal and handover alarm of the deployed Durable Object are not
 * exercised here; that remains browser-layer and workerd-regression coverage.
 */
const bindingsSchema = v.looseObject({ result: v.looseObject({ bindings: v.array(v.looseObject({
  name: v.string(), type: v.string(), text: v.optional(v.string()),
})) }) });

export interface ActiveWorkerRelease {
  readonly release: string | null;
  readonly artifactSha256: string | null;
  readonly secretNames: readonly string[];
}

export async function activeWorkerRelease(context: LifecycleContext, workerName: string): Promise<ActiveWorkerRelease> {
  const settings = await providerJson(context, `/client/v4/accounts/${context.job.target.accountId}/workers/scripts/${workerName}/settings`);
  const parsed = v.safeParse(bindingsSchema, settings);
  requireStage(parsed.success, 'worker_settings_unreadable');
  const bindings = parsed.output.result.bindings;
  const plain = (name: string) => bindings.find((binding) => binding.name === name && binding.type === 'plain_text')?.text ?? null;
  return Object.freeze({
    release: plain('ANKKA_GATEWAY_RELEASE'),
    artifactSha256: plain('ANKKA_GATEWAY_RELEASE_SHA256'),
    secretNames: bindings.filter((binding) => binding.type === 'secret_text').map((binding) => binding.name),
  });
}

const installedReleaseSchema = v.looseObject({ installedRelease: v.optional(v.picklist(['a', 'b'])), managementCredentialInstalled: v.optional(v.boolean()) });

export function installedRelease(context: LifecycleContext): 'a' | 'b' {
  return readRecordValue(context.record.state.install, installedReleaseSchema, 'install_record_invalid').installedRelease ?? 'a';
}

/** The final runtime's environment as the installed release runs it: recorded plain-text bindings, zone, and the active release identity. */
export async function gatewayEnvironmentBindings(context: LifecycleContext): Promise<PayloadBindings> {
  const which = installedRelease(context);
  const release = await context.release(which);
  const target = installedTarget(context);
  return {
    ...installedBindings(context),
    ANKKA_GATEWAY_RELEASE: release.pin.release,
    ANKKA_GATEWAY_RELEASE_SHA256: `sha256:${release.pin.artifactSha256}`,
    ANKKA_UPDATE_CHANNEL: release.pin.channel,
    ANKKA_UPDATE_KEY_ID: release.pin.keyId,
    ANKKA_UPDATE_PUBLIC_KEY: release.pin.publicKey,
    CLOUDFLARE_ZONE_ID: target.zoneId,
    CLOUDFLARE_ZONE_NAME: target.zoneName,
    ZERO_TRUST_READY: 'true',
  };
}

export async function updateStage(context: LifecycleContext): Promise<BoundaryValue> {
  const provision = await installedProvision(context);
  const install = readRecordValue(context.record.state.install, installedReleaseSchema, 'install_record_invalid');
  const [a, b] = await Promise.all([context.release('a'), context.release('b')]);
  const workerName = provision.deployment.workerName;
  const target = { release: b.pin.release, artifactSha256: `sha256:${b.pin.artifactSha256}` };
  const before = await activeWorkerRelease(context, workerName);
  const credentialExpected = install.managementCredentialInstalled === true;
  const verify = async (): Promise<BoundaryValue> => {
    const after = await activeWorkerRelease(context, workerName);
    requireStage(after.release === target.release && after.artifactSha256 === target.artifactSha256, 'update_not_verified', after.release);
    requireStage(!credentialExpected || after.secretNames.includes('ANKKA_MANAGEMENT_TOKEN'), 'management_credential_not_inherited');
    await context.record.set('install', 'installedRelease', 'b');
    return { from: a.pin.release, to: b.pin.release, managementCredentialInherited: after.secretNames.includes('ANKKA_MANAGEMENT_TOKEN') };
  };
  if (before.release === target.release && before.artifactSha256 === target.artifactSha256) {
    await context.record.event('update', 'already_active');
    return verify();
  }
  requireStage(before.release === a.pin.release, 'installed_release_unexpected', before.release);
  await context.record.event('update', 'started', { from: a.pin.release, to: b.pin.release });
  try {
    const result = await runCustomerRuntimeUpdate({
      accessToken: context.credentials.deploymentToken,
      accountId: context.job.target.accountId,
      workerName,
      controlPlaneOrigin: b.bundle.manifest.controlPlaneOrigin,
      channel: b.pin.channel,
      updateKeyId: b.pin.keyId,
      updatePublicKey: b.pin.publicKey,
      target,
      transport: (input, init) => context.transport(input, init),
      control: async (command) => {
        await context.record.event('update', `control_${command.command}`, command.command === 'progress' ? { stage: command.stage } : {});
        return true;
      },
      armHandover: async ({ fromVersionId }) => {
        await context.record.set('install', 'updateHandover', { fromVersionId, to: b.pin.release, armedAt: context.now() });
      },
    });
    await context.record.event('update', 'uploaded', { fromVersionId: result.fromVersionId });
  } catch (error) {
    if (error instanceof CustomerRuntimeUpdateError) throw new LifecycleStageError(`update_${error.code}`, 'failed', error.stage);
    throw error;
  }
  return verify();
}
