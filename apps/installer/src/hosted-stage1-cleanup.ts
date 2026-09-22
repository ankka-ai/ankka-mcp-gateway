import * as v from 'valibot';

import { boundaryValueSchema, type BoundaryValue } from './boundary';
import {
  setWorkerBootstrapSubdomain,
  verifyWorkerBootstrapSubdomain,
  type CloudflareManagementTransport,
} from './cloudflare-management-surface';
import {
  CloudflareDirectUploadError,
  inspectAdminStateDurableObjectNamespace,
} from './cloudflare-worker-direct-upload';
import { CLOUDFLARE_API_ORIGIN } from './constants';
import {
  exactCustomerBootstrapModule,
  exactCustomerBootstrapVersionBindings,
} from './customer-bootstrap-worker-readback';
import type { CustomerBootstrapPlainBindings } from './customer-bootstrap-worker-deployment';
import { DeployError } from './errors';
import { executeHostedBootstrapGrant } from './hosted-bootstrap-grant';
import {
  expectedCustomerBootstrapBindings,
  type HostedStage1Provision,
} from './hosted-stage1-bootstrap';
import type { HostedStage1Session } from './hosted-stage1-session';
import { readBoundedText, withDeadline } from './http';
import type { CloudflareOauthConfig, FetchTransport } from './oauth';
import type { VerifiedReleaseBundle } from './release';
import type { HostedDeployPlan } from './bootstrap-plan';
import { parseVerifiedReleaseBundle } from './verified-release-bundle';

/**
 * Deterministic lost-cookie cleanup for one recorded Stage 1 root.
 *
 * A fresh `workers-scripts.write` grant may remove exactly the Worker and
 * SQLite namespace the durable session recorded, and nothing else. Every
 * identity is re-read from the provider and compared with the recorded
 * provision, the frozen plan, and the signed release before any mutation.
 * Names alone are never ownership evidence. Any mismatch or ambiguity fails
 * closed with nothing sent. The grant is revoked by the wrapper on every path.
 */

const VERSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const COMPATIBILITY_DATE = '2026-08-08';
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_LIST_PAGES = 100;
const ABSENCE_ATTEMPTS = 8;
const RETIREMENT_MODULE_PATH = 'payload/worker-retirement/index.js';

const envelopeSchema = v.looseObject({
  success: v.literal(true),
  errors: v.nullish(v.array(boundaryValueSchema)),
  messages: v.nullish(v.array(boundaryValueSchema)),
  result: boundaryValueSchema,
  result_info: v.optional(v.looseObject({
    total_pages: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
    total_count: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
    per_page: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
  })),
});
const workerSchema = v.looseObject({
  id: v.string(),
  name: v.string(),
  tags: v.array(v.string()),
  tail_consumers: v.array(boundaryValueSchema),
});
const deploymentsSchema = v.looseObject({
  deployments: v.array(v.looseObject({
    id: v.pipe(v.string(), v.regex(VERSION_ID)),
    versions: v.array(v.looseObject({
      version_id: v.pipe(v.string(), v.regex(VERSION_ID)),
      percentage: v.number(),
    })),
  })),
});
const versionSchema = v.looseObject({
  id: v.pipe(v.string(), v.regex(VERSION_ID)),
  main_module: v.literal('index.js'),
  compatibility_date: v.literal(COMPATIBILITY_DATE),
  compatibility_flags: v.optional(v.array(v.string())),
  bindings: v.array(boundaryValueSchema),
  modules: v.array(v.looseObject({
    name: v.string(),
    content_type: v.string(),
    content_base64: v.string(),
  })),
});
const namespaceListSchema = v.array(v.looseObject({
  id: v.optional(v.string()),
  script: v.optional(v.string()),
  class: v.optional(v.string()),
}));
const scriptListSchema = v.array(v.looseObject({ id: v.optional(v.string()) }));

export type HostedStage1CleanupErrorCode =
  | 'invalid'
  | 'account_mismatch'
  | 'identity_mismatch'
  | 'ambiguous'
  | 'provider_rejected'
  | 'provider_unknown'
  | 'absence_not_proven';

export class HostedStage1CleanupError extends Error {
  constructor(readonly code: HostedStage1CleanupErrorCode, readonly stage: string) {
    super(code);
    this.name = 'HostedStage1CleanupError';
  }
}

export interface HostedStage1CleanupResult {
  readonly schemaVersion: 1;
  readonly accountId: string;
  readonly workerId: string;
  readonly workerName: string;
  readonly namespaceId: string;
  readonly retirementVersionId: string;
  readonly grantRevocation: 'confirmed';
  readonly verifiedAbsentAt: number;
}

export interface HostedStage1CleanupInput {
  readonly code: string;
  readonly verifier: string;
  readonly oauth: CloudflareOauthConfig;
  readonly transport: FetchTransport;
  readonly session: HostedStage1Session;
  readonly bundle: VerifiedReleaseBundle;
  readonly customerOauthClientId: string;
  readonly issuerKeyId: string;
  readonly issuerPublicKey: string;
  readonly now: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

interface ProviderCall {
  readonly accessToken: string;
  readonly transport: FetchTransport;
}

interface ProviderResponse {
  readonly status: number;
  readonly value: BoundaryValue;
  readonly totalPages: number;
}

/**
 * The recorded bootstrap surface. A null namespace name or version id means
 * that field was not in the installation record; the id, module, and binding
 * checks still have to match. Names alone are never enough.
 */
export interface ExactBootstrapRoot {
  readonly plan: HostedDeployPlan;
  readonly accountId: string;
  readonly bootstrapId: string;
  readonly bootstrapCallback: string;
  readonly bootstrapSecretCommitment: string;
  readonly capabilityExpiresAt: number;
  readonly workerId: string;
  readonly workerName: string;
  readonly namespaceId: string;
  readonly namespaceName: string | null;
  readonly versionId: string | null;
  readonly bootstrapSourceSha256: string;
  readonly expectedBindings: CustomerBootstrapPlainBindings;
  readonly retirementModule: Blob;
  /** Stage 1 turns workers.dev off before retirement. Stage 2 leaves that to Worker deletion so the progress page can still answer. */
  readonly disableSubdomain: boolean;
}

interface CleanupRoot {
  readonly plan: HostedDeployPlan;
  readonly provision: HostedStage1Provision;
}

const settingsSchema = v.looseObject({
  bindings: v.array(v.looseObject({
    type: v.string(),
    namespace_id: v.optional(v.string()),
    script_name: v.optional(v.string()),
    service: v.optional(v.string()),
  })),
});

function fail(code: HostedStage1CleanupErrorCode, stage: string): never {
  throw new HostedStage1CleanupError(code, stage);
}

function accountUrl(accountId: string, path: string): URL {
  return new URL(`/client/v4/accounts/${accountId}${path}`, CLOUDFLARE_API_ORIGIN);
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function providerRequest(
  call: ProviderCall,
  stage: string,
  url: URL,
  init: RequestInit,
  allowedStatuses: readonly number[],
): Promise<ProviderResponse> {
  let response: Response;
  let serialized: string;
  try {
    ({ response, serialized } = await withDeadline(async (signal) => {
      const raw = await call.transport(url, {
        ...init,
        headers: { accept: 'application/json', authorization: `Bearer ${call.accessToken}`, ...init.headers },
        redirect: 'manual',
        signal,
      });
      return { response: raw, serialized: await readBoundedText(raw, 'internal_error', MAX_RESPONSE_BYTES) };
    }, 'internal_error', 30_000));
  } catch {
    fail('provider_unknown', stage);
  }
  if (!allowedStatuses.includes(response.status)) {
    fail(response.status >= 500 ? 'provider_unknown' : 'provider_rejected', stage);
  }
  if (response.status === 404 || serialized === '') {
    return Object.freeze({ status: response.status, value: null, totalPages: 1 });
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    fail('provider_unknown', stage);
  }
  const envelope = v.safeParse(envelopeSchema, decoded);
  if (!envelope.success || (envelope.output.errors?.length ?? 0) !== 0) fail('provider_rejected', stage);
  const info = envelope.output.result_info;
  const derivedPages = info?.total_count !== undefined && info.per_page !== undefined
    ? Math.ceil(info.total_count / info.per_page) : 1;
  const totalPages = Math.max(1, info?.total_pages ?? derivedPages);
  if (totalPages > MAX_LIST_PAGES) fail('provider_unknown', stage);
  return Object.freeze({ status: response.status, value: envelope.output.result, totalPages });
}

function cleanupRoot(session: HostedStage1Session): CleanupRoot {
  if (session.phase !== 'cleanup_required' || session.plan === null || session.provision === null ||
      session.attempt === null || session.attempt.kind !== 'cleanup' || session.attempt.status !== 'exchanging') {
    fail('invalid', 'validate');
  }
  return Object.freeze({ plan: session.plan, provision: session.provision });
}

function exactRoot(root: CleanupRoot, evidence: {
  readonly expectedBindings: CustomerBootstrapPlainBindings;
  readonly retirementModule: Blob;
}): ExactBootstrapRoot {
  const { provision } = root;
  return Object.freeze({
    plan: root.plan,
    accountId: provision.accountId,
    bootstrapId: provision.bootstrapId,
    bootstrapCallback: provision.bootstrapCallback,
    bootstrapSecretCommitment: provision.bootstrapSecretCommitment,
    capabilityExpiresAt: provision.capabilityExpiresAt,
    workerId: provision.deployment.workerId,
    workerName: provision.deployment.workerName,
    namespaceId: provision.deployment.namespaceId,
    namespaceName: provision.deployment.namespaceName,
    versionId: provision.deployment.versionId,
    bootstrapSourceSha256: provision.deployment.sourceSha256,
    expectedBindings: evidence.expectedBindings,
    retirementModule: evidence.retirementModule,
    disableSubdomain: true,
  });
}

/** True when the recorded Worker is present and matches. False when it is already gone. */
async function readExactWorker(call: ProviderCall, root: ExactBootstrapRoot): Promise<boolean> {
  const response = await providerRequest(
    call, 'worker_read',
    accountUrl(root.accountId, `/workers/workers/${encodeURIComponent(root.workerName)}`),
    { method: 'GET' }, [200, 404],
  );
  if (response.status === 404) return false;
  const worker = v.safeParse(workerSchema, response.value);
  const expectedTags = ['ankka-mcp-gateway', 'ankka-stage1-bootstrap', `ankka-bootstrap-id:${root.bootstrapId}`];
  if (!worker.success || worker.output.id !== root.workerId ||
      worker.output.name !== root.workerName || worker.output.tail_consumers.length !== 0 ||
      [...worker.output.tags].sort().join('\n') !== [...expectedTags].sort().join('\n')) {
    fail('identity_mismatch', 'worker_read');
  }
  return true;
}

async function activeVersionId(call: ProviderCall, root: ExactBootstrapRoot, stage: string): Promise<string> {
  const response = await providerRequest(
    call, stage,
    accountUrl(root.accountId, `/workers/scripts/${encodeURIComponent(root.workerName)}/deployments`),
    { method: 'GET' }, [200],
  );
  const deployments = v.safeParse(deploymentsSchema, response.value);
  const active = deployments.success ? deployments.output.deployments.at(0) : undefined;
  const version = active?.versions.at(0);
  if (!deployments.success || active === undefined || active.versions.length !== 1 || version === undefined ||
      version.percentage !== 100) fail('identity_mismatch', stage);
  return version.version_id;
}

async function readExactVersion(call: ProviderCall, root: ExactBootstrapRoot, versionId: string): Promise<void> {
  if (root.versionId !== null && versionId !== root.versionId) fail('identity_mismatch', 'deployment_read');
  const response = await providerRequest(
    call, 'version_read',
    accountUrl(root.accountId, `/workers/workers/${root.workerId}/versions/${versionId}?include=modules`),
    { method: 'GET' }, [200],
  );
  const version = v.safeParse(versionSchema, response.value);
  if (!version.success || version.output.id !== versionId || (version.output.compatibility_flags ?? []).length !== 0) {
    fail('identity_mismatch', 'version_read');
  }
  if (!await exactCustomerBootstrapModule(version.output.modules, root.bootstrapSourceSha256) ||
      !exactCustomerBootstrapVersionBindings(version.output.bindings, root.expectedBindings, root.namespaceId)) {
    fail('identity_mismatch', 'version_read');
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', owned));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** True when the active version is the exact signed retirement module. */
async function retirementVersionActive(call: ProviderCall, root: ExactBootstrapRoot, versionId: string): Promise<boolean> {
  const response = await providerRequest(
    call, 'retirement_version_read',
    accountUrl(root.accountId, `/workers/workers/${root.workerId}/versions/${versionId}?include=modules`),
    { method: 'GET' }, [200, 404],
  );
  if (response.status === 404) return false;
  const version = v.safeParse(versionSchema, response.value);
  const module = version.success ? version.output.modules[0] : undefined;
  if (!version.success || version.output.id !== versionId || module === undefined ||
      module.content_type !== 'application/javascript+module') return false;
  let raw: string;
  try {
    raw = atob(module.content_base64);
  } catch {
    return false;
  }
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  const expected = new Uint8Array(await root.retirementModule.arrayBuffer());
  return await sha256Hex(bytes) === await sha256Hex(expected);
}

async function readExactNamespace(call: ProviderCall, root: ExactBootstrapRoot): Promise<void> {
  try {
    const locator = await inspectAdminStateDurableObjectNamespace({
      accountId: root.accountId,
      workerName: root.workerName,
      className: 'AdminState',
      storage: 'sqlite',
      expectedNamespaceId: root.namespaceId,
    }, { accessToken: call.accessToken, transport: (request: Request) => call.transport(request) });
    if (locator.namespaceId !== root.namespaceId ||
        (root.namespaceName !== null && locator.namespaceName !== root.namespaceName)) fail('identity_mismatch', 'namespace_read');
  } catch (error) {
    if (error instanceof HostedStage1CleanupError) throw error;
    if (error instanceof CloudflareDirectUploadError && error.code === 'recovery_ambiguous') fail('ambiguous', 'namespace_read');
    if (error instanceof CloudflareDirectUploadError && error.code === 'provider_mismatch') fail('identity_mismatch', 'namespace_read');
    fail('provider_unknown', 'namespace_read');
  }
}

async function namespacePresent(call: ProviderCall, root: ExactBootstrapRoot): Promise<boolean> {
  let totalPages = 1;
  let matches = 0;
  for (let page = 1; page <= totalPages; page += 1) {
    const response = await providerRequest(
      call, 'namespace_list',
      accountUrl(root.accountId, `/workers/durable_objects/namespaces?page=${page}&per_page=1000`),
      { method: 'GET' }, [200],
    );
    const items = v.safeParse(namespaceListSchema, response.value);
    if (!items.success) fail('provider_unknown', 'namespace_list');
    totalPages = response.totalPages;
    for (const item of items.output) {
      if (item.script === root.workerName && item.class === 'AdminState') {
        if (item.id !== root.namespaceId) fail('ambiguous', 'namespace_list');
        matches += 1;
      }
    }
  }
  if (matches > 1) fail('ambiguous', 'namespace_list');
  return matches === 1;
}

/** Another script that binds this namespace or Worker is a shared dependency. Nothing is deleted. */
async function foreignBindingsUnshared(call: ProviderCall, root: ExactBootstrapRoot): Promise<void> {
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page += 1) {
    const listing = await providerRequest(
      call, 'worker_bindings',
      accountUrl(root.accountId, `/workers/scripts?page=${page}&per_page=1000`),
      { method: 'GET' }, [200],
    );
    const scripts = v.safeParse(scriptListSchema, listing.value);
    if (!scripts.success) fail('provider_unknown', 'worker_bindings');
    totalPages = listing.totalPages;
    for (const item of scripts.output) {
      if (item.id === undefined) fail('provider_unknown', 'worker_bindings');
      if (item.id === root.workerName) continue;
      const settings = await providerRequest(
        call, 'worker_bindings',
        accountUrl(root.accountId, `/workers/scripts/${encodeURIComponent(item.id)}/settings`),
        { method: 'GET' }, [200],
      );
      const parsed = v.safeParse(settingsSchema, settings.value);
      if (!parsed.success) fail('provider_unknown', 'worker_bindings');
      const shared = parsed.output.bindings.some((binding) =>
        binding.namespace_id === root.namespaceId ||
        binding.service === root.workerName ||
        binding.script_name === root.workerName);
      if (shared) fail('ambiguous', 'worker_bindings');
    }
  }
}

async function disableWorkersDev(call: ProviderCall, root: ExactBootstrapRoot): Promise<void> {
  const managementTransport: CloudflareManagementTransport = (request) => call.transport(request);
  const common = { accessToken: call.accessToken, transport: managementTransport, accountId: root.accountId, plan: root.plan };
  try {
    await setWorkerBootstrapSubdomain({ ...common, enabled: false });
    await verifyWorkerBootstrapSubdomain({ ...common, expectedEnabled: false });
  } catch {
    fail('provider_unknown', 'workers_dev_disable');
  }
}

async function retirementModule(bundle: VerifiedReleaseBundle): Promise<Blob> {
  const parsed = parseVerifiedReleaseBundle(bundle);
  const records = parsed.manifest.components.workerRetirement.files;
  const record = records[0];
  if (records.length !== 1 || record === undefined || record.path !== RETIREMENT_MODULE_PATH) fail('invalid', 'retirement_module');
  const blob = parsed.payload.find((entry) => entry.path === record.path);
  if (blob === undefined || blob.sha256 !== record.sha256) fail('invalid', 'retirement_module');
  const bytes = new Uint8Array(await blob.bytes.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== record.sha256) fail('invalid', 'retirement_module');
  return new Blob([bytes], { type: 'application/javascript+module' });
}

/** Deploys the signed retirement module so the SQLite class is marked deleted and the namespace retires. */
async function retireNamespace(
  call: ProviderCall,
  root: ExactBootstrapRoot,
  wait: (milliseconds: number) => Promise<void>,
): Promise<string> {
  const metadata = {
    annotations: { 'workers/tag': `ankka-stage1-cleanup:${root.bootstrapId}` },
    bindings: [],
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: [],
    exports: { AdminState: { state: 'deleted', type: 'durable-object' } },
    main_module: 'index.js',
    observability: { enabled: false },
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  form.append('index.js', root.retirementModule, 'index.js');
  await providerRequest(
    call, 'retirement_upload',
    accountUrl(root.accountId, `/workers/scripts/${encodeURIComponent(root.workerName)}`),
    { method: 'PUT', body: form }, [200],
  );
  const retirementVersionId = await activeVersionId(call, root, 'retirement_deployment_read');
  if (root.versionId !== null && retirementVersionId === root.versionId) fail('provider_unknown', 'retirement_deployment_read');
  if (!await retirementVersionActive(call, root, retirementVersionId)) fail('identity_mismatch', 'retirement_deployment_read');
  for (let attempt = 0; attempt < ABSENCE_ATTEMPTS; attempt += 1) {
    if (!await namespacePresent(call, root)) return retirementVersionId;
    await wait(300 * (attempt + 1));
  }
  fail('absence_not_proven', 'namespace_retire');
}

async function deleteWorker(call: ProviderCall, root: ExactBootstrapRoot): Promise<void> {
  await providerRequest(
    call, 'worker_delete',
    accountUrl(root.accountId, `/workers/workers/${root.workerId}`),
    { method: 'DELETE' }, [200, 202, 204],
  );
}

async function proveWorkerAbsent(
  call: ProviderCall,
  root: ExactBootstrapRoot,
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < ABSENCE_ATTEMPTS; attempt += 1) {
    const byId = await providerRequest(
      call, 'worker_absence',
      accountUrl(root.accountId, `/workers/workers/${root.workerId}`),
      { method: 'GET' }, [200, 404],
    );
    const byName = await providerRequest(
      call, 'worker_absence',
      accountUrl(root.accountId, `/workers/scripts/${encodeURIComponent(root.workerName)}`),
      { method: 'GET' }, [200, 404],
    );
    if (byId.status === 404 && byName.status === 404) {
      let totalPages = 1;
      for (let page = 1; page <= totalPages; page += 1) {
        const listing = await providerRequest(
          call, 'worker_absence',
          accountUrl(root.accountId, `/workers/scripts?page=${page}&per_page=1000`),
          { method: 'GET' }, [200],
        );
        const scripts = v.safeParse(scriptListSchema, listing.value);
        if (!scripts.success) fail('provider_unknown', 'worker_absence');
        if (scripts.output.some((item) => item.id === root.workerName)) fail('absence_not_proven', 'worker_absence');
        totalPages = listing.totalPages;
      }
      if (await namespacePresent(call, root)) fail('absence_not_proven', 'worker_absence');
      return;
    }
    await wait(300 * (attempt + 1));
  }
  fail('absence_not_proven', 'worker_absence');
}

export interface ExactBootstrapRemovalResult {
  readonly retirementVersionId: string | null;
  readonly verifiedAbsentAt: number;
}

/**
 * Retires the exact AdminState namespace and deletes the exact Worker.
 * A later call reads the provider back first: an already-absent root is
 * success, and a retirement upload that landed is not sent again.
 */
export async function removeExactBootstrapRoot(input: {
  readonly accessToken: string;
  readonly transport: FetchTransport;
  readonly root: ExactBootstrapRoot;
  readonly now: () => number;
  readonly wait?: ((milliseconds: number) => Promise<void>) | undefined;
}): Promise<ExactBootstrapRemovalResult> {
  const call: ProviderCall = Object.freeze({ accessToken: input.accessToken, transport: input.transport });
  const wait = input.wait ?? defaultWait;
  const root = input.root;
  const present = await readExactWorker(call, root);
  if (!present) {
    if (await namespacePresent(call, root)) fail('identity_mismatch', 'worker_read');
    const verifiedAbsentAt = input.now();
    if (!Number.isSafeInteger(verifiedAbsentAt) || verifiedAbsentAt < 0) fail('invalid', 'result');
    return Object.freeze({ retirementVersionId: null, verifiedAbsentAt });
  }
  await foreignBindingsUnshared(call, root);
  const active = await activeVersionId(call, root, 'deployment_read');
  const retiring = root.versionId !== null && active !== root.versionId;
  let retirementVersionId = active;
  if (!retiring) {
    await readExactVersion(call, root, active);
    await readExactNamespace(call, root);
    if (!await namespacePresent(call, root)) fail('identity_mismatch', 'namespace_list');
    if (root.disableSubdomain) await disableWorkersDev(call, root);
    retirementVersionId = await retireNamespace(call, root, wait);
  } else {
    if (!await retirementVersionActive(call, root, active)) fail('identity_mismatch', 'deployment_read');
    if (await namespacePresent(call, root)) {
      let absent = false;
      for (let attempt = 0; attempt < ABSENCE_ATTEMPTS; attempt += 1) {
        if (!await namespacePresent(call, root)) { absent = true; break; }
        await wait(300 * (attempt + 1));
      }
      if (!absent) fail('absence_not_proven', 'namespace_retire');
    }
    if (root.disableSubdomain) await disableWorkersDev(call, root);
  }
  await deleteWorker(call, root);
  await proveWorkerAbsent(call, root, wait);
  const verifiedAbsentAt = input.now();
  if (!Number.isSafeInteger(verifiedAbsentAt) || verifiedAbsentAt < 0 || !VERSION_ID.test(retirementVersionId)) {
    fail('invalid', 'result');
  }
  return Object.freeze({ retirementVersionId, verifiedAbsentAt });
}

/**
 * Runs exact-root cleanup under a fresh Stage 1 grant. Read-back precedes
 * every mutation; the grant is revoked before the result is returned.
 */
export async function executeHostedStage1Cleanup(input: HostedStage1CleanupInput): Promise<HostedStage1CleanupResult> {
  const root = cleanupRoot(input.session);
  const wait = input.wait ?? defaultWait;
  let captured: HostedStage1CleanupError | null = null;
  let retirementVersionId = '';
  let result;
  try {
    result = await executeHostedBootstrapGrant({
      kind: 'cleanup',
      target: { accountId: root.provision.accountId, workerName: root.provision.deployment.workerName },
      code: input.code,
      verifier: input.verifier,
      config: input.oauth,
      transport: input.transport,
      deploy: async ({ accessToken, accountId }) => {
        try {
          if (accountId !== root.provision.accountId) fail('account_mismatch', 'account_reassert');
          const release = parseVerifiedReleaseBundle(input.bundle);
          const removed = await removeExactBootstrapRoot({
            accessToken,
            transport: input.transport,
            now: input.now,
            wait,
            root: exactRoot(root, {
              expectedBindings: expectedCustomerBootstrapBindings({
                accountId: root.provision.accountId,
                bootstrapCallback: root.provision.bootstrapCallback,
                customerOauthClientId: input.customerOauthClientId,
                issuerKeyId: input.issuerKeyId,
                issuerPublicKey: input.issuerPublicKey,
                plan: root.plan,
                release,
                capability: {
                  bootstrapId: root.provision.bootstrapId,
                  secret: '',
                  secretCommitment: root.provision.bootstrapSecretCommitment,
                  expiresAt: root.provision.capabilityExpiresAt,
                },
                workerName: root.provision.deployment.workerName,
              }),
              retirementModule: await retirementModule(input.bundle),
            }),
          });
          if (removed.retirementVersionId === null) fail('identity_mismatch', 'worker_read');
          retirementVersionId = removed.retirementVersionId;
          return Object.freeze({ retirementVersionId });
        } catch (error) {
          captured = error instanceof HostedStage1CleanupError ? error : new HostedStage1CleanupError('provider_unknown', 'cleanup');
          throw error;
        }
      },
    });
  } catch (error) {
    if (captured !== null) throw captured;
    if (error instanceof DeployError) throw error;
    fail('provider_unknown', 'grant');
  }
  const verifiedAbsentAt = input.now();
  if (!Number.isSafeInteger(verifiedAbsentAt) || verifiedAbsentAt < 0 || !VERSION_ID.test(retirementVersionId)) {
    fail('invalid', 'result');
  }
  return Object.freeze({
    schemaVersion: 1,
    accountId: result.accountId,
    workerId: root.provision.deployment.workerId,
    workerName: root.provision.deployment.workerName,
    namespaceId: root.provision.deployment.namespaceId,
    retirementVersionId,
    grantRevocation: result.grantRevocation,
    verifiedAbsentAt,
  });
}
