import * as v from 'valibot';
import { canonicalJson } from './canonical-json';

import { boundaryValueSchema, type BoundaryValue } from './boundary';
import { CLOUDFLARE_API_ORIGIN } from './constants';
import { assertExactReleaseBundleIdentity } from './exact-release-bundle';
import type { GatewayTeardownJobPort } from './gateway-teardown-durable-state';
import type { GatewayTeardownTrust, VerifiedGatewayTeardownHandoff } from './gateway-teardown-handoff';
import {
  GATEWAY_ROOT_REMOVAL_STEPS, armGatewayRootRemoval, verifyGatewayRootRemoval,
  verifyGatewayTeardownJobAuthority, type GatewayRootRemovalStep, type GatewayTeardownJob,
} from './gateway-teardown-job';
import { readBoundedText, withDeadline } from './http';
import type { FetchTransport } from './oauth';
import { verifySignedReleaseEnvelope, type VerifiedReleaseBundle } from './release';

const COMPATIBILITY_DATE = '2026-08-08';
const RETIREMENT_PATH = 'payload/worker-retirement/index.js';
const envelopeSchema = v.looseObject({
  success: v.literal(true), errors: v.optional(v.nullable(v.array(boundaryValueSchema))),
  result: v.optional(boundaryValueSchema),
  result_info: v.optional(v.looseObject({
    total_pages: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(100))),
    total_count: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  })),
});
const namedWorkerSchema = v.looseObject({ id: v.string(), name: v.string(), tail_consumers: v.optional(v.array(boundaryValueSchema)) });
// The listing carries each script's timestamps; a script last modified before the owner Worker existed cannot bind it.
const scriptSchema = v.looseObject({ id: v.string(), created_on: v.optional(v.string()), modified_on: v.optional(v.string()) });
const namespaceSchema = v.looseObject({ id: v.string(), script: v.string(), class: v.string(), use_sqlite: v.boolean() });
const domainSchema = v.looseObject({ id: v.string(), hostname: v.string(), service: v.string(), zone_id: v.string(), environment: v.optional(v.string()) });
const applicationSchema = v.looseObject({
  id: v.string(), name: v.string(), type: v.literal('self_hosted'), domain: v.string(), aud: v.string(),
  destinations: v.optional(v.array(v.looseObject({ type: v.literal('public'), uri: v.string() }))),
  self_hosted_domains: v.optional(v.array(v.string())),
});
const policySchema = v.looseObject({
  id: v.string(), name: v.string(), decision: v.literal('allow'), precedence: v.literal(1),
  include: v.pipe(v.array(v.strictObject({ email: v.strictObject({ email: v.pipe(v.string(), v.email()) }) })), v.minLength(1)),
  require: v.pipe(v.array(boundaryValueSchema), v.length(0)), exclude: v.pipe(v.array(boundaryValueSchema), v.length(0)),
  approval_required: v.optional(v.literal(false)), isolation_required: v.optional(v.literal(false)),
  purpose_justification_required: v.optional(v.literal(false)),
});
/** The receipt-owned Service Auth policy an opted-in installation declares: one service token, no identity. */
const servicePolicySchema = v.looseObject({
  id: v.string(), name: v.string(), decision: v.literal('non_identity'), precedence: v.literal(2),
  include: v.pipe(v.array(v.strictObject({ service_token: v.strictObject({ token_id: v.string() }) })), v.length(1)),
  require: v.pipe(v.array(boundaryValueSchema), v.length(0)), exclude: v.pipe(v.array(boundaryValueSchema), v.length(0)),
  approval_required: v.optional(v.literal(false)), isolation_required: v.optional(v.literal(false)),
  purpose_justification_required: v.optional(v.literal(false)),
});
const bindingSchema = v.looseObject({ type: v.string(), name: v.string(), namespace_id: v.optional(v.string()), script_name: v.optional(v.string()), service: v.optional(v.string()), class_name: v.optional(v.string()) });
const settingsSchema = v.looseObject({ bindings: v.array(bindingSchema) });
const deploymentsSchema = v.looseObject({ deployments: v.array(v.looseObject({
  versions: v.array(v.looseObject({ version_id: v.string(), percentage: v.number() })),
})) });
// Secrets outlive a deployment: the retirement upload sends no bindings, yet
// the Worker's inherited secrets stay attached to the retirement version until
// the Worker itself is deleted. Any binding of another type is a foreign version.
const versionSchema = v.looseObject({
  id: v.string(), main_module: v.literal('index.js'), compatibility_date: v.literal(COMPATIBILITY_DATE),
  compatibility_flags: v.optional(v.pipe(v.array(v.string()), v.length(0))),
  bindings: v.array(v.looseObject({ type: v.literal('secret_text'), name: v.string() })),
  modules: v.pipe(v.array(v.looseObject({ name: v.literal('index.js'), content_type: v.string(), content_base64: v.string() })), v.length(1)),
});
const SCRIPT_NAME = /^[A-Za-z0-9_-]{1,128}$/u;

export class GatewayTeardownProviderError extends Error {
  constructor(readonly stage: string, readonly code: 'identity_mismatch' | 'foreign_dependency' | 'provider_unknown' | 'provider_rejected' | 'absence_not_proven' | 'job_conflict' | 'budget_exhausted') {
    super(`teardown_${stage}_${code}`);
    this.name = 'GatewayTeardownProviderError';
  }
}
function fail(stage: string, code: GatewayTeardownProviderError['code']): never { throw new GatewayTeardownProviderError(stage, code); }

/**
 * The secret-free reason word a stopped attempt records. A budget stop is
 * the one fixed resumable word: the pending step stays armed, and the next
 * consent continues from the verified progress.
 */
export function gatewayTeardownFailureReason(error: GatewayTeardownProviderError): string {
  return error.code === 'budget_exhausted' ? 'budget_exhausted' : `${error.stage}_${error.code}`;
}

/** Provider and Durable Object calls one attempt may spend, matched to the smallest per-invocation subrequest allowance. */
export const GATEWAY_TEARDOWN_CALL_BUDGET = 50;
/**
 * Calls kept back from the budget so the callback that owns the attempt still
 * fits the same invocation: the two journal calls that consume the callback,
 * the validity read before the exchange, the grant revocation, and the two
 * journal calls that settle the attempt after it.
 */
export const GATEWAY_TEARDOWN_SETTLEMENT_RESERVE = 6;

/**
 * Counts every provider and Durable Object call of one attempt and stops the
 * attempt cleanly, before the invocation's cap, with the resumable
 * `budget_exhausted` reason. Arming is durable before any write is sent, so
 * a stop at any call leaves the pending boundary for the next consent.
 */
export class GatewayTeardownCallBudget {
  #spent = 0;

  constructor(readonly limit = GATEWAY_TEARDOWN_CALL_BUDGET - GATEWAY_TEARDOWN_SETTLEMENT_RESERVE) {}

  get spent(): number { return this.#spent; }

  charge(stage: string): void {
    if (this.#spent >= this.limit) fail(stage, 'budget_exhausted');
    this.#spent += 1;
  }

  /** The job port with every read and write charged before it is made. */
  port(port: GatewayTeardownJobPort): GatewayTeardownJobPort {
    return {
      read: async () => { this.charge('journal'); return port.read(); },
      compareAndSet: async (expectedRevision, job) => { this.charge('journal'); return port.compareAndSet(expectedRevision, job); },
    };
  }
}

interface Call {
  readonly accessToken: string;
  readonly transport: FetchTransport;
  readonly authority: VerifiedGatewayTeardownHandoff;
  readonly wait?: (milliseconds: number) => Promise<void>;
  /** Charged before each provider call; absent for an uncounted attempt. */
  readonly budget?: GatewayTeardownCallBudget;
}
function account(call: Call, path: string): URL {
  return new URL(`/client/v4/accounts/${call.authority.certificate.statement.accountId}${path}`, CLOUDFLARE_API_ORIGIN);
}
function applicationUrl(call: Call, suffix = ''): URL {
  const management = call.authority.statement.management;
  return new URL(`/client/v4/zones/${management.zoneId}/access/apps/${management.applicationId}${suffix}`, CLOUDFLARE_API_ORIGIN);
}

// A read mutates nothing, so a transient provider error (a 5xx or a timeout) is retried this many times.
const READ_RETRY_DELAYS_MS = Object.freeze([400, 1_200]);

async function requestOnce(call: Call, stage: string, url: URL, init: RequestInit, missing: boolean) {
  // Charged before the deadline wrapper, which turns anything thrown inside it into a transport error.
  call.budget?.charge(stage);
  try {
    return await withDeadline(async (signal) => {
      const response = await call.transport(url, { ...init, signal, redirect: 'manual',
        headers: { accept: 'application/json', authorization: `Bearer ${call.accessToken}` } });
      const serialized = await readBoundedText(response, 'internal_error', 16 * 1024 * 1024);
      if (response.status === 404 && missing) return { absent: true, value: null, pages: 1, count: undefined };
      if (!response.ok) fail(stage, response.status >= 500 ? 'provider_unknown' : 'provider_rejected');
      // A successful deletion may answer 204, or 200 with no body (custom-domain detachment does); reads always carry an envelope.
      if (init.method === 'DELETE' && (response.status === 204 || serialized === '')) return { absent: false, value: null, pages: 1, count: undefined };
      const parsed = v.safeParse(envelopeSchema, JSON.parse(serialized));
      if (!parsed.success || (parsed.output.errors?.length ?? 0) !== 0) fail(stage, 'provider_unknown');
      return { absent: false, value: parsed.output.result ?? null,
        pages: parsed.output.result_info?.total_pages, count: parsed.output.result_info?.total_count };
    }, 'internal_error', 30_000);
  } catch (error) {
    if (error instanceof GatewayTeardownProviderError) throw error;
    fail(stage, 'provider_unknown');
  }
}

/**
 * A write is sent at most once: a rejected or unknown response leaves its boundary
 * pending for a fresh consent, never a silent retry that might apply twice. A read
 * mutates nothing, and a transient provider error (a 5xx or a timeout, surfaced as
 * provider_unknown) is no evidence of any resource, so a read is retried a bounded
 * number of times before it is judged. A 4xx rejection and every deterministic
 * mismatch (foreign_dependency, identity_mismatch) still fail at once.
 */
async function request(call: Call, stage: string, url: URL, init: RequestInit = {}, missing = false) {
  const method = init.method ?? 'GET';
  const delays = method === 'GET' || method === 'HEAD' ? READ_RETRY_DELAYS_MS : [];
  const wait = call.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestOnce(call, stage, url, init, missing);
    } catch (error) {
      if (attempt >= delays.length || !(error instanceof GatewayTeardownProviderError) || error.code !== 'provider_unknown') throw error;
      await wait(delays[attempt] ?? 0);
    }
  }
}

/** No truncated or ambiguous provider list can establish absence. */
async function list(call: Call, stage: string, url: URL): Promise<BoundaryValue[]> {
  const values: BoundaryValue[] = [];
  let pages = 1;
  let count: number | undefined;
  for (let page = 1; page <= pages; page += 1) {
    const target = new URL(url);
    target.searchParams.set('page', String(page));
    target.searchParams.set('per_page', '100');
    const response = await request(call, stage, target);
    if (!Array.isArray(response.value)) fail(stage, 'provider_unknown');
    if (response.pages === undefined && response.value.length >= 100) fail(stage, 'provider_unknown');
    const observedPages = Math.max(1, response.pages ?? 1);
    if (page > 1 && (pages !== observedPages || count !== response.count)) fail(stage, 'provider_unknown');
    pages = observedPages;
    count = response.count;
    values.push(...response.value);
  }
  if (count !== undefined && count !== values.length) fail(stage, 'provider_unknown');
  return values;
}

async function workerPresent(call: Call): Promise<boolean> {
  const expected = call.authority.certificate.statement.worker;
  const byName = await request(call, 'worker_read', account(call, `/workers/workers/${expected.name}`), {}, true);
  const byId = await request(call, 'worker_read', account(call, `/workers/workers/${expected.providerId}`), {}, true);
  if (byName.absent !== byId.absent) fail('worker_read', 'identity_mismatch');
  if (byName.absent) return false;
  for (const value of [byName.value, byId.value]) {
    const parsed = v.safeParse(namedWorkerSchema, value);
    if (!parsed.success || parsed.output.id !== expected.providerId || parsed.output.name !== expected.name ||
        (parsed.output.tail_consumers?.length ?? 0) !== 0) fail('worker_read', 'identity_mismatch');
  }
  return true;
}

async function namespacePresent(call: Call): Promise<boolean> {
  const owner = call.authority.certificate.statement;
  const values = await list(call, 'namespace_list', account(call, '/workers/durable_objects/namespaces'));
  let found = 0;
  for (const value of values) {
    const parsed = v.safeParse(namespaceSchema, value);
    if (!parsed.success) fail('namespace_list', 'provider_unknown');
    const item = parsed.output;
    if (item.script === owner.worker.name || item.id === owner.adminStateNamespaceId) {
      if (item.script !== owner.worker.name || item.id !== owner.adminStateNamespaceId || item.class !== 'AdminState' || !item.use_sqlite) {
        fail('namespace_list', 'foreign_dependency');
      }
      found += 1;
    }
  }
  if (found > 1) fail('namespace_list', 'identity_mismatch');
  return found === 1;
}

interface ListedScript { readonly name: string; readonly createdOn: string | undefined; readonly modifiedOn: string | undefined }

/** The account's scripts by name; a malformed or duplicated entry is no listing at all. */
async function listedScripts(call: Call): Promise<readonly ListedScript[]> {
  const values = await list(call, 'worker_list', account(call, '/workers/scripts'));
  const seen = new Set<string>();
  const scripts: ListedScript[] = [];
  for (const value of values) {
    const parsed = v.safeParse(scriptSchema, value);
    if (!parsed.success || !SCRIPT_NAME.test(parsed.output.id) || seen.has(parsed.output.id)) fail('worker_list', 'provider_unknown');
    seen.add(parsed.output.id);
    scripts.push({ name: parsed.output.id, createdOn: parsed.output.created_on, modifiedOn: parsed.output.modified_on });
  }
  return scripts;
}

/**
 * Whether a foreign script's settings must be read: a script last modified
 * before the owner Worker was created cannot bind its namespace or name.
 * A missing or unreadable timestamp on either side means read it.
 */
export function foreignScriptNeedsRead(modifiedOn: string | undefined, ownerCreatedOn: string | undefined): boolean {
  if (modifiedOn === undefined || ownerCreatedOn === undefined) return true;
  const modified = Date.parse(modifiedOn);
  const created = Date.parse(ownerCreatedOn);
  if (!Number.isFinite(modified) || !Number.isFinite(created)) return true;
  return modified >= created;
}

/**
 * No other script may bind the namespace or the Worker. Scanned once per
 * attempt: only scripts modified at or after the owner Worker's creation are
 * read, the rest cannot have bound it. The owner's own listing entry must
 * agree with its direct read.
 */
async function foreignScriptsUnshared(call: Call, rootPresent: boolean): Promise<void> {
  const owner = call.authority.certificate.statement;
  const scripts = await listedScripts(call);
  const ownerEntry = scripts.find((script) => script.name === owner.worker.name);
  if ((ownerEntry !== undefined) !== rootPresent) fail('worker_list', 'identity_mismatch');
  for (const script of scripts) {
    if (script.name === owner.worker.name || !foreignScriptNeedsRead(script.modifiedOn, ownerEntry?.createdOn)) continue;
    const response = await request(call, 'worker_bindings', account(call, `/workers/scripts/${script.name}/settings`));
    const settings = v.safeParse(settingsSchema, response.value);
    if (!settings.success) fail('worker_bindings', 'provider_unknown');
    if (settings.output.bindings.some((binding) =>
      binding.type === 'service' && binding.service === owner.worker.name)) fail('worker_bindings', 'foreign_dependency');
    if (settings.output.bindings.some((binding) => binding.type === 'durable_object_namespace' &&
      ((binding.namespace_id === undefined && binding.script_name === undefined) ||
        binding.namespace_id === owner.adminStateNamespaceId || binding.script_name === owner.worker.name))) {
      fail('worker_bindings', 'foreign_dependency');
    }
  }
}

/** Whether the owner Worker still appears in the account's script listing. */
async function ownerListed(call: Call): Promise<boolean> {
  const owner = call.authority.certificate.statement;
  return (await listedScripts(call)).some((script) => script.name === owner.worker.name);
}

/**
 * Whether the owner Worker's own settings agree with the namespace listing.
 * Returns false only while settling, when the just-written script does not
 * yet answer, or its bindings or active version do not yet match the write.
 */
async function ownerScriptConsistent(call: Call, namespaceExists: boolean, retirementSha256: string, settling: boolean): Promise<boolean> {
  const owner = call.authority.certificate.statement;
  let response;
  try {
    response = await request(call, 'worker_bindings', account(call, `/workers/scripts/${owner.worker.name}/settings`), {}, settling);
  } catch (error) {
    // A just-written owner Worker can answer its settings read with a transient provider
    // error (5xx or timeout) while the upload settles. Inside the caller's bounded settling
    // loop this is re-read, not judged; the strict read still throws.
    if (settling && error instanceof GatewayTeardownProviderError && error.code === 'provider_unknown') return false;
    throw error;
  }
  if (response.absent) return false;
  const settings = v.safeParse(settingsSchema, response.value);
  if (!settings.success) fail('worker_bindings', 'provider_unknown');
  const bindings = settings.output.bindings.filter((binding) => binding.type === 'durable_object_namespace');
  if (namespaceExists && bindings.length === 0) {
    // The deployment can be visible before the namespace listing catches
    // up. Only the exact signed retirement module explains this gap.
    return retiredVersion(call, retirementSha256, settling);
  }
  if (namespaceExists ? bindings.length !== 1 ||
      bindings[0]?.namespace_id !== owner.adminStateNamespaceId || bindings[0]?.class_name !== 'AdminState'
    : bindings.length !== 0) {
    if (!settling) fail('worker_bindings', 'identity_mismatch');
    return false;
  }
  return true;
}

/** Whether a listed or read domain is the exact management domain; any other use of its id, hostname or service is foreign. */
function managementDomainMatches(call: Call, value: BoundaryValue): boolean {
  const expected = call.authority.statement.management;
  const owner = call.authority.certificate.statement;
  const result = v.safeParse(domainSchema, value);
  if (!result.success) fail('domain_read', 'provider_unknown');
  const item = result.output;
  if (item.id !== expected.domainId && item.hostname !== expected.hostname && item.service !== owner.worker.name) return false;
  if (item.id !== expected.domainId || item.hostname !== expected.hostname || item.service !== owner.worker.name ||
      item.zone_id !== expected.zoneId || (item.environment !== undefined && item.environment !== 'production')) fail('domain_read', 'foreign_dependency');
  return true;
}

/** The management domain by its id alone: the identity re-read before its deletion. */
async function domainPresentById(call: Call): Promise<boolean> {
  const byId = await request(call, 'domain_read', account(call, `/workers/domains/${call.authority.statement.management.domainId}`), {}, true);
  if (byId.absent) return false;
  if (!managementDomainMatches(call, byId.value)) fail('domain_read', 'identity_mismatch');
  return true;
}

/** The management domain in the account listing and by id, which must agree. */
async function domainPresent(call: Call): Promise<boolean> {
  const values = await list(call, 'domain_list', account(call, '/workers/domains'));
  const count = values.filter((value) => managementDomainMatches(call, value)).length;
  const present = await domainPresentById(call);
  if (count > 1 || (count === 1) !== present) fail('domain_read', 'identity_mismatch');
  return present;
}

/** The management Access application by its id: the identity re-read before its deletion. */
async function applicationPresent(call: Call): Promise<boolean> {
  const expected = call.authority.statement.management;
  const response = await request(call, 'application_read', applicationUrl(call), {}, true);
  if (response.absent) return false;
  const result = v.safeParse(applicationSchema, response.value);
  if (!result.success || result.output.id !== expected.applicationId || result.output.name !== expected.applicationName ||
      result.output.aud !== expected.applicationAud || result.output.domain !== expected.hostname ||
      result.output.destinations?.some((destination) => destination.uri !== expected.hostname) ||
      result.output.self_hosted_domains?.some((domain) => domain !== expected.hostname)) fail('application_read', 'identity_mismatch');
  return true;
}

/** The administrators' policy by its id alone: the identity re-read before its deletion. */
async function policyPresentById(call: Call): Promise<boolean> {
  const expected = call.authority.statement.management;
  const byId = await request(call, 'policy_read', applicationUrl(call, `/policies/${expected.policyId}`), {}, true);
  if (byId.absent) return false;
  const policy = v.safeParse(policySchema, byId.value);
  if (!policy.success || policy.output.id !== expected.policyId || policy.output.name !== expected.policyName) fail('policy_read', 'identity_mismatch');
  return true;
}

/**
 * The administrators' policy in the application's policy listing and by id,
 * which must agree. The listing may carry only the administrators' policy
 * and, when the handoff declares one, the receipt-owned Service Auth policy;
 * the latter is removed with the application, never on its own. Anything
 * else is foreign.
 */
async function policyPresent(call: Call): Promise<boolean> {
  const expected = call.authority.statement.management;
  const policies = await list(call, 'policy_list', applicationUrl(call, '/policies'));
  const declaredId = (item: BoundaryValue): string | null => {
    const admin = v.safeParse(policySchema, item);
    if (admin.success) return admin.output.id === expected.policyId && admin.output.name === expected.policyName ? admin.output.id : null;
    const service = v.safeParse(servicePolicySchema, item);
    if (!service.success || expected.servicePolicyId === undefined) return null;
    return service.output.id === expected.servicePolicyId && service.output.name === expected.servicePolicyName ? service.output.id : null;
  };
  const declaredIds = policies.map(declaredId);
  if (declaredIds.some((id) => id === null) || new Set(declaredIds).size !== declaredIds.length) fail('policy_list', 'foreign_dependency');
  const listed = declaredIds.includes(expected.policyId);
  const present = await policyPresentById(call);
  if (present !== listed) fail('policy_read', 'identity_mismatch');
  return present;
}

async function managementPresent(call: Call): Promise<{ application: boolean; policy: boolean }> {
  const application = await applicationPresent(call);
  return { application, policy: application && await policyPresent(call) };
}

/** The read stage at which the active version is not the exact signed retirement module, or null when it is. */
async function retirementMismatch(call: Call, expectedSha256: string): Promise<'retirement_deployment' | 'retirement_version' | null> {
  const owner = call.authority.certificate.statement;
  const response = await request(call, 'retirement_deployment', account(call, `/workers/scripts/${owner.worker.name}/deployments`));
  const deployments = v.safeParse(deploymentsSchema, response.value);
  const active = deployments.success ? deployments.output.deployments[0] : undefined;
  const versionId = active?.versions[0]?.version_id;
  if (active?.versions.length !== 1 || active.versions[0]?.percentage !== 100 ||
      versionId === undefined || !/^[a-f0-9-]{36}$/u.test(versionId)) return 'retirement_deployment';
  const versionResponse = await request(call, 'retirement_version', account(call, `/workers/workers/${owner.worker.providerId}/versions/${versionId}?include=modules`));
  const version = v.safeParse(versionSchema, versionResponse.value);
  if (!version.success || version.output.id !== versionId) return 'retirement_version';
  const module = version.output.modules[0];
  if (module === undefined || module.content_type !== 'application/javascript+module') return 'retirement_version';
  try {
    const raw = atob(module.content_base64);
    const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('') === expectedSha256 ? null : 'retirement_version';
  } catch { return 'retirement_version'; }
}

/**
 * Whether the active version is the exact signed retirement module. Outside
 * a settling window any other version is a foreign one and stops removal;
 * while settling, the deployment listing may still show the previous version
 * after the namespace listing has dropped the class, so the caller re-reads.
 */
async function retiredVersion(call: Call, expectedSha256: string, settling: boolean): Promise<boolean> {
  const mismatch = await retirementMismatch(call, expectedSha256);
  if (mismatch === null) return true;
  if (settling) return false;
  fail(mismatch, 'identity_mismatch');
}

interface Inventory { retire_namespace: boolean; management_domain: boolean; management_policy: boolean; management_application: boolean; worker: boolean }

/**
 * The complete strict ownership preflight, once per attempt: every owned
 * resource by identity, the foreign-script scan, and the proof that no
 * verified step's resource is back.
 */
async function inventory(call: Call, job: GatewayTeardownJob): Promise<Inventory> {
  const worker = await workerPresent(call);
  const namespace = await namespacePresent(call);
  if (namespace && !worker) fail('namespace_read', 'identity_mismatch');
  await foreignScriptsUnshared(call, worker);
  if (worker && !await ownerScriptConsistent(call, namespace, job.retirementModuleSha256, false)) fail('preflight', 'identity_mismatch');
  const domain = await domainPresent(call);
  const management = await managementPresent(call);
  if (!namespace && worker) await retiredVersion(call, job.retirementModuleSha256, false);
  const present = { retire_namespace: namespace, management_domain: domain,
    management_policy: management.policy, management_application: management.application, worker };
  if (job.verifiedSteps.some((step) => present[step])) fail('preflight', 'identity_mismatch');
  return present;
}

/**
 * The strict identity re-read of the one resource about to be deleted,
 * right before its deletion: the namespace beside its Worker, the domain,
 * the policy or application on the management application, or the Worker.
 */
async function stepPresent(call: Call, job: GatewayTeardownJob, step: GatewayRootRemovalStep): Promise<boolean> {
  switch (step) {
    case 'retire_namespace': {
      const worker = await workerPresent(call);
      const namespace = await namespacePresent(call);
      if (namespace && !worker) fail('namespace_read', 'identity_mismatch');
      if (!namespace && worker) await retiredVersion(call, job.retirementModuleSha256, false);
      return namespace;
    }
    case 'management_domain':
      return domainPresentById(call);
    case 'management_policy':
      return policyPresentById(call);
    case 'management_application':
      return applicationPresent(call);
    default:
      return workerPresent(call);
  }
}

/**
 * Whether the write just sent has settled into absence, read from the
 * owner-side resources that write touched and nothing else. False means the
 * provider's listings do not agree yet and the caller re-reads.
 */
async function stepAbsent(call: Call, job: GatewayTeardownJob, step: GatewayRootRemovalStep): Promise<boolean> {
  switch (step) {
    case 'retire_namespace': {
      // Provider listings settle in no fixed order after the retirement upload: the namespace
      // listing can drop the class before the deployment listing shows the retirement version.
      const namespace = await namespacePresent(call);
      const owner = await ownerScriptConsistent(call, namespace, job.retirementModuleSha256, true);
      if (namespace || !owner) return false;
      return retiredVersion(call, job.retirementModuleSha256, true);
    }
    case 'management_domain':
      return !await domainPresent(call);
    case 'management_policy':
      return !await policyPresent(call);
    case 'management_application':
      return !await applicationPresent(call);
    default:
      return !await workerPresent(call) && !await ownerListed(call);
  }
}

async function retirementModule(job: GatewayTeardownJob, bundle: VerifiedReleaseBundle): Promise<Blob> {
  assertExactReleaseBundleIdentity(bundle, job.release);
  await verifySignedReleaseEnvelope(canonicalJson(bundle.envelope), job.release.channel,
    { [job.release.keyId]: job.release.publicKey }, await Promise.all(bundle.payload.map(async (entry) => ({
      path: entry.path, bytes: new Uint8Array(await entry.bytes.arrayBuffer()),
    }))));
  const files = bundle.manifest.components.workerRetirement.files;
  const file = files[0];
  const entry = bundle.payload.find((item) => item.path === RETIREMENT_PATH);
  if (files.length !== 1 || file?.path !== RETIREMENT_PATH || file.sha256 !== job.retirementModuleSha256 ||
      entry === undefined || entry.sha256 !== file.sha256) fail('retirement_module', 'identity_mismatch');
  return new Blob([await entry.bytes.arrayBuffer()], { type: 'application/javascript+module' });
}

async function remove(call: Call, step: GatewayRootRemovalStep, module: Blob): Promise<void> {
  const owner = call.authority.certificate.statement;
  const management = call.authority.statement.management;
  if (step === 'retire_namespace') {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({
      bindings: [], compatibility_date: COMPATIBILITY_DATE, compatibility_flags: [],
      exports: { AdminState: { state: 'deleted', type: 'durable-object' } },
      main_module: 'index.js', observability: { enabled: false },
    })], { type: 'application/json' }), 'metadata.json');
    form.append('index.js', module, 'index.js');
    await request(call, step, account(call, `/workers/scripts/${owner.worker.name}`), { method: 'PUT', body: form });
    return;
  }
  const url = step === 'management_domain' ? account(call, `/workers/domains/${management.domainId}`)
    : step === 'management_policy' ? applicationUrl(call, `/policies/${management.policyId}`)
    : step === 'management_application' ? applicationUrl(call)
    : account(call, `/workers/workers/${owner.worker.providerId}`);
  await request(call, step, url, { method: 'DELETE' }, true);
}

/**
 * One attempt's provider mutations, with the credential the caller holds;
 * this port persists only evidence. Reads are bounded: the complete
 * ownership preflight and the foreign-script scan run once, each deletion
 * is preceded by an identity re-read of its own resource, and a settling
 * write is re-read on the owner-side resources it touched.
 */
export async function executeGatewayRootRemoval(input: {
  readonly port: GatewayTeardownJobPort; readonly trust: GatewayTeardownTrust;
  readonly bundle: VerifiedReleaseBundle; readonly attemptId: string;
  readonly accessToken: string; readonly authorizedAccountId: string;
  readonly transport: FetchTransport; readonly now: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  /** The job as the caller just read it from the same port, so the attempt reads it once. */
  readonly current?: GatewayTeardownJob;
  /** Charged before each provider call; absent for an uncounted attempt. */
  readonly budget?: GatewayTeardownCallBudget;
}): Promise<GatewayTeardownJob> {
  let job = input.current ?? await input.port.read();
  if (job === null || job.phase !== 'exchanging' || job.attempt?.id !== input.attemptId || job.attempt.expiresAt <= input.now()) fail('start', 'job_conflict');
  const authority = await verifyGatewayTeardownJobAuthority({ job, trust: input.trust });
  if (authority.certificate.statement.accountId !== input.authorizedAccountId) fail('account', 'identity_mismatch');
  const wait = input.wait ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const call: Call = input.budget === undefined
    ? { authority, accessToken: input.accessToken, transport: input.transport, wait }
    : { authority, accessToken: input.accessToken, transport: input.transport, wait, budget: input.budget };
  const module = await retirementModule(job, input.bundle);
  const commit = async (previous: GatewayTeardownJob, next: GatewayTeardownJob): Promise<GatewayTeardownJob> => {
    if (!await input.port.compareAndSet(previous.revision, next)) fail('persist', 'job_conflict');
    return next;
  };
  // Complete ownership preflight once, before the first destructive boundary.
  const present = await inventory(call, job);
  let fresh = true;
  for (const step of GATEWAY_ROOT_REMOVAL_STEPS.slice(job.verifiedSteps.length)) {
    // The preflight just read this resource; every later deletion re-reads its
    // own resource to notice a concurrent manual policy/domain change.
    const resourcePresent = fresh ? present[step] : await stepPresent(call, job, step);
    fresh = false;
    if (job.pendingStep === null || resourcePresent) {
      job = await commit(job, armGatewayRootRemoval({ job, attemptId: input.attemptId, step, now: input.now() }));
    }
    if (resourcePresent) {
      // Arming is durable before sending. A rejected/unknown response leaves
      // this boundary pending; only a fresh consent can try the write again.
      if (job.attempt === null || job.attempt.expiresAt <= input.now()) fail('send', 'job_conflict');
      await remove(call, step, module);
      // An owner-side disagreement is re-read, not judged.
      let absent = false;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (await stepAbsent(call, job, step)) { absent = true; break; }
        await wait(300 * (attempt + 1));
      }
      if (!absent) fail(step, 'absence_not_proven');
    }
    job = await commit(job, verifyGatewayRootRemoval({ job, attemptId: input.attemptId, step, now: input.now() }));
  }
  return job;
}
