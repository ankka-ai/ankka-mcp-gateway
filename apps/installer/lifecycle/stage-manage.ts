import * as v from 'valibot';

import { boundaryValueSchema, type BoundaryValue } from '../src/boundary';
import { canonicalJson } from '../src/canonical-json';
import { randomBase64Url, sha256Hex } from '../src/crypto';
import { operationSignature } from '../src/customer-operation-secrets';
import { LiveManagementQualificationError, qualifyLiveGatewayManagement, type LiveManagementRequest } from '../../../tools/live-gateway-management.mjs';
import { installedProvision, providerJson } from './stage-install';
import { activeWorkerRelease, gatewayEnvironmentBindings, installedRelease } from './stage-update';
import {
  payloadEnvironment, readRecordValue, requireStage, LifecycleStageError,
  type DurableObjectStandIn, type LifecycleContext, type ManagedSourceLike, type PayloadModule,
} from './context';

/**
 * Routine management with the gateway's own limited credential. The
 * operator-created management token is installed as the Worker secret with
 * deployment authority, then the same source and Team exercise the browser
 * runner performs drives the release payload's management object in-process:
 * the public route handlers are mirrored minus their Access verification
 * (the deployed routes of a runner-installed gateway hold no state), the
 * Durable Object routes and the provider writes are the production code.
 */
const MANAGEMENT_SECRET = 'ANKKA_MANAGEMENT_TOKEN';
const ACTION_ID = /^action_[A-Za-z0-9_-]{32}$/u;
const ACTION_TTL_MS = 10 * 60_000;

const managedSourceSchema = v.pipe(
  v.record(v.string(), boundaryValueSchema),
  v.check((value) => v.is(v.string(), value.url), 'source url required'),
);
const sourceSaveSchema = v.looseObject({ revision: v.pipe(v.number(), v.safeInteger()), source: managedSourceSchema });
const sourcesSchema = v.looseObject({
  revision: v.pipe(v.number(), v.safeInteger()),
  sources: v.array(v.pipe(managedSourceSchema, v.check((value) => v.is(v.string(), value.id) && v.is(v.string(), value.status), 'source identity required'))),
});
const snapshotSchema = v.looseObject({ blockingAction: v.optional(v.nullable(v.looseObject({ kind: v.string() }))) });
const sourceActionInputSchema = v.strictObject({ schemaVersion: v.literal(1), revision: v.pipe(v.number(), v.safeInteger(), v.minValue(1)), sourceId: v.string() });
const discoverInputSchema = v.strictObject({ url: v.string() });
const errorSchema = v.looseObject({ error: v.optional(v.string()) });

function managedSource(value: { readonly [field: string]: BoundaryValue }): ManagedSourceLike {
  const url = value.url;
  requireStage(v.is(v.string(), url), 'source_invalid');
  return { ...value, url };
}

async function readJson(response: Response, path: string): Promise<BoundaryValue> {
  const text = await response.text();
  let body: BoundaryValue = null;
  try { body = JSON.parse(text); } catch { body = null; }
  if (response.status !== 200) {
    const parsed = v.safeParse(errorSchema, body);
    throw new LifecycleStageError('management_api_rejected', 'failed', `${path}:${response.status}:${parsed.success ? parsed.output.error ?? 'unknown' : 'unknown'}`);
  }
  return body;
}

async function installManagementCredential(context: LifecycleContext, workerName: string): Promise<void> {
  const active = await activeWorkerRelease(context, workerName);
  if (active.secretNames.includes(MANAGEMENT_SECRET)) {
    await context.record.set('install', 'managementCredentialInstalled', true);
    return;
  }
  const token = context.credentials.managementToken;
  if (token === null) throw new LifecycleStageError('management_credential_unavailable', 'blocked');
  await context.record.event('manage', 'management_credential_install');
  const response = await context.transport(`https://api.cloudflare.com/client/v4/accounts/${context.job.target.accountId}/workers/scripts/${workerName}/secrets`, {
    method: 'PUT', redirect: 'manual', signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${context.credentials.deploymentToken}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ name: MANAGEMENT_SECRET, text: token, type: 'secret_text' }),
  });
  await response.body?.cancel();
  requireStage(response.status === 200, 'management_credential_install_rejected', String(response.status));
  const after = await activeWorkerRelease(context, workerName);
  requireStage(after.secretNames.includes(MANAGEMENT_SECRET), 'management_credential_not_bound');
  await context.record.set('install', 'managementCredentialInstalled', true);
  await context.record.event('manage', 'management_credential_installed');
}

/** The public management handlers, mirrored over the in-process management object without Access verification. */
export function inProcessManagementApi(input: {
  readonly context: LifecycleContext;
  readonly helpers: PayloadModule;
  readonly management: DurableObjectStandIn;
  readonly actorEmail: string;
  readonly managementToken: string;
}): LiveManagementRequest {
  const { context, helpers, management, actorEmail } = input;
  const stub = (path: string, init?: RequestInit) => management.fetch(new Request(`https://admin-state.invalid${path}`, init));
  const json = (body: string) => ({ headers: { 'content-type': 'application/json' }, body });
  const sourcesView = async (response: Response, path: string) => {
    const body = await readJson(response, path);
    return { ...v.parse(v.looseObject({}), body), applyMode: 'account_token', installationEnabled: true };
  };
  const verifySource = async (source: ManagedSourceLike) => {
    try { await helpers.verifyManagedSource(source); } catch (error) {
      const failure = v.safeParse(v.looseObject({ code: v.string() }), error);
      throw new LifecycleStageError('source_verification_failed', 'failed', failure.success ? failure.output.code : null);
    }
  };
  return async (path, options = {}) => {
    const method = options.method ?? 'GET';
    const body = options.body;
    if (method === 'GET' && path === '/api/sources') return sourcesView(await stub('/sources'), path);
    if (method === 'PUT' && path === '/api/sources') {
      const save = v.safeParse(sourceSaveSchema, helpers.parseSourceSave(body ?? null));
      requireStage(save.success, 'source_invalid');
      await verifySource(managedSource(save.output.source));
      return sourcesView(await stub('/sources', { method: 'PUT', ...json(canonicalJson({ schemaVersion: 1, revision: save.output.revision, source: save.output.source })) }), path);
    }
    if (method === 'POST' && path === '/api/sources/discover') {
      const discovered = await helpers.inspectMcpSource(v.parse(discoverInputSchema, body).url);
      const result = {
        schemaVersion: 1, status: discovered.authMode === 'oauth' ? 'authorization_required' : 'discovered',
        endpoint: discovered.endpoint, protocolVersion: discovered.protocolVersion, authentication: discovered.authMode,
        tools: discovered.tools,
      };
      return discovered.connectionBlock === undefined ? result : { ...result, connectionBlock: discovered.connectionBlock };
    }
    if (method === 'GET' && path.startsWith('/api/source-actions/')) {
      const actionId = path.slice('/api/source-actions/'.length);
      requireStage(ACTION_ID.test(actionId), 'source_action_id_invalid');
      return readJson(await stub(`/source-actions/${actionId}`, { headers: { 'x-ankka-actor-email': actorEmail } }), path);
    }
    if (method === 'POST' && path === '/api/source-actions') {
      const request = v.parse(sourceActionInputSchema, body);
      const snapshot = v.parse(snapshotSchema, await readJson(await stub('/source-actions', { headers: { 'x-ankka-actor-email': actorEmail } }), path));
      requireStage(snapshot.blockingAction === undefined || snapshot.blockingAction === null, 'source_action_conflict');
      const sources = v.parse(sourcesSchema, await readJson(await stub('/sources'), path));
      const found = sources.sources.find((candidate) => candidate.id === request.sourceId);
      requireStage(found !== undefined && sources.revision === request.revision && found.status === 'draft', 'source_draft_changed');
      const source = managedSource(found);
      await verifySource(source);
      const now = context.now();
      const expiresAt = now + ACTION_TTL_MS;
      const actionId = `action_${randomBase64Url(24)}`;
      const actionKey = randomBase64Url(32);
      const prepared = await stub('/source-actions', { method: 'POST', ...json(canonicalJson({
        schemaVersion: 1, actionId, sourceId: source.id, sourceRevision: sources.revision, actorEmail, issuedAt: now, expiresAt,
        actionKeyHash: `sha256:${await sha256Hex(actionKey)}`, sourceHash: await helpers.managedSourceHash(source),
      })) });
      await readJson(prepared, `${path}:prepare`);
      const claim = canonicalJson({ schemaVersion: 1, actionId, actionKey, actorEmail, accountId: context.job.target.accountId,
        issuedAt: now, expiresAt, cloudflareAccessToken: input.managementToken });
      const applied = await stub('/source-actions/apply', { method: 'POST', headers: {
        'content-type': 'application/json', 'x-ankka-source-action-signature': await operationSignature(actionKey, claim),
      }, body: claim });
      await readJson(applied, `${path}:apply`);
      return { schemaVersion: 1, actionId, status: 'succeeded', expiresAt: new Date(expiresAt).toISOString() };
    }
    if (method === 'GET' && path === '/api/team') return readJson(await stub('/team'), path);
    if (method === 'POST' && path === '/api/team-actions') {
      const now = context.now();
      return readJson(await stub('/team-actions', { method: 'POST', ...json(canonicalJson({
        request: body ?? null, actorEmail, actionId: `action_${randomBase64Url(24)}`,
        actionKeyHash: `sha256:${await sha256Hex(randomBase64Url(32))}`, issuedAt: now, expiresAt: now + ACTION_TTL_MS,
      })) }), path);
    }
    throw new LifecycleStageError('management_route_outside_exercise', 'failed', `${method} ${path}`);
  };
}

const manageRecordSchema = v.looseObject({ managementCredentialInstalled: v.optional(v.boolean()), source: v.optional(v.any()) });

export async function manageStage(context: LifecycleContext): Promise<BoundaryValue> {
  const provision = await installedProvision(context);
  const workerName = provision.deployment.workerName;
  await installManagementCredential(context, workerName);
  const token = context.credentials.managementToken;
  if (token === null) throw new LifecycleStageError('management_credential_unavailable', 'blocked');
  const install = readRecordValue(context.record.state.install, manageRecordSchema, 'install_record_invalid');
  const which = installedRelease(context);
  const payload = await context.payload(which);
  const helpers = await context.checkoutPayload();
  const environment = payloadEnvironment(payload, context.record, { ...await gatewayEnvironmentBindings(context), ANKKA_MANAGEMENT_TOKEN: token });
  const management = new payload.AdminState({ storage: context.record.storage('object:v1:management') }, environment);
  const request = inProcessManagementApi({ context, helpers, management, actorEmail: context.job.target.adminEmail, managementToken: token });
  if (install.source === undefined) {
    let result: Awaited<ReturnType<typeof qualifyLiveGatewayManagement>>;
    try {
      result = await qualifyLiveGatewayManagement({
        request, source: context.job.source,
        checkpoint: async (event) => {
          const detail: { [field: string]: BoundaryValue } = {};
          if (event.sourceId !== undefined) detail.sourceId = event.sourceId;
          if (event.actionId !== undefined) detail.actionId = event.actionId;
          await context.record.event('manage', `${event.stage}:${event.status}`, detail);
        },
      });
    } catch (error) {
      if (error instanceof LiveManagementQualificationError) throw new LifecycleStageError(`manage_${error.code}`);
      throw error;
    }
    await context.record.set('install', 'source', JSON.parse(JSON.stringify(result)));
  }
  const inventory = await context.provider.capture({ installId: provision.installId, workerName, bootstrapOrigin: provision.bootstrapOrigin });
  await context.record.setInventory(JSON.parse(JSON.stringify(inventory)));
  await context.record.event('manage', 'inventory_captured', { resources: inventory.resources.length });
  const settings = await providerJson(context, `/client/v4/accounts/${context.job.target.accountId}/workers/scripts/${workerName}/settings`);
  requireStage(v.is(v.looseObject({ result: v.looseObject({}) }), settings), 'worker_settings_unreadable');
  return { resources: inventory.resources.length, managementCredentialInstalled: true };
}
