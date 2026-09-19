import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath, rename } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';

/**
 * The approved lifecycle job: one disposable target, one signed release
 * pair, the operations the operator approved, and references to credentials
 * held elsewhere. The file never carries a credential value. Approval binds a
 * digest of everything the runner will act on; a changed target, release or
 * operation set invalidates it.
 */
const root = fileURLToPath(new URL('../', import.meta.url));

export class LifecycleJobError extends Error {
  constructor(code, detail = null) { super(code); this.code = code; this.detail = detail; }
}
function requireCondition(value, code, detail = null) {
  if (!value) throw new LifecycleJobError(code, detail);
}

const text = v.pipe(v.string(), v.minLength(1));
const providerId = v.pipe(text, v.regex(/^[a-f0-9]{32}$/u));
const hostname = v.pipe(text, v.regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u));
const email = v.pipe(text, v.email(), v.maxLength(256));
const keychainName = v.pipe(text, v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u));
const digest = v.pipe(text, v.regex(/^sha256:[a-f0-9]{64}$/u));
const credentialReference = v.union([
  v.strictObject({ keychain: v.strictObject({ service: keychainName, account: keychainName }) }),
  v.strictObject({ env: v.pipe(text, v.regex(/^ANKKA_[A-Z0-9_]{2,60}$/u)) }),
]);
const releaseReference = v.strictObject({ publishDirectory: text, pin: text });
const pinSchema = v.strictObject({
  schemaVersion: v.literal(1), channel: v.picklist(['canary', 'stable']), controlPlaneOrigin: v.pipe(text, v.url()),
  release: v.pipe(text, v.regex(/^gateway-v\d+\.\d+\.\d+$/u)), keyId: text, publicKey: v.pipe(text, v.regex(/^[A-Za-z0-9_-]{43}$/u)),
  artifactSha256: v.pipe(text, v.regex(/^[a-f0-9]{64}$/u)),
});

export const LIFECYCLE_STAGES = Object.freeze([
  'preflight', 'bootstrap', 'converge', 'verify', 'manage', 'update', 'remove-dependencies', 'remove-root', 'verify-absent',
]);
export const LIFECYCLE_OPERATIONS = Object.freeze(['install', 'manage', 'update', 'remove']);
const STAGES_BY_OPERATION = Object.freeze({
  install: Object.freeze(['preflight', 'bootstrap', 'converge', 'verify']),
  manage: Object.freeze(['manage']),
  update: Object.freeze(['update']),
  remove: Object.freeze(['remove-dependencies', 'remove-root', 'verify-absent']),
});

export const approvalSchema = v.strictObject({
  approvedBy: email,
  approvedAt: v.pipe(text, v.isoTimestamp()),
  targetDigest: digest,
});

export const lifecycleJobSchema = v.strictObject({
  schemaVersion: v.literal(1),
  jobId: v.pipe(text, v.regex(/^[a-z0-9][a-z0-9-]{2,63}$/u)),
  scope: v.literal('disposable_lifecycle'),
  target: v.strictObject({
    accountId: providerId, zoneId: providerId, zoneName: hostname,
    prefix: v.pipe(text, v.regex(/^[a-z0-9]{1,12}$/u)),
    gatewayName: v.pipe(text, v.maxLength(64)),
    adminEmail: email,
  }),
  releases: v.strictObject({ a: releaseReference, b: releaseReference }),
  source: v.strictObject({ url: v.pipe(text, v.url()), tool: v.pipe(text, v.regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)) }),
  credentials: v.strictObject({
    deployment: credentialReference,
    management: credentialReference,
    service: v.optional(v.strictObject({
      // An Access service token's client id is the token's common name: 32 hex characters and the `.access` suffix.
      secret: credentialReference, clientId: v.pipe(text, v.regex(/^[a-f0-9]{32}\.access$/u)),
      tokenId: v.pipe(text, v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)),
    })),
  }),
  operations: v.pipe(v.array(v.picklist(LIFECYCLE_OPERATIONS)), v.minLength(1), v.maxLength(4)),
  runDirectory: text,
  approval: v.optional(approvalSchema),
});

/** Sorted-key JSON so a digest depends on content only. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && v.is(v.object({}), value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function outsideRepository(path, code = 'private_path_required') {
  requireCondition(isAbsolute(path), code);
  let canonical;
  try { canonical = await realpath(path); } catch { throw new LifecycleJobError(code); }
  requireCondition(relative(root, canonical).startsWith('..'), code);
  return canonical;
}

async function privateFile(path, code) {
  await outsideRepository(path, code);
  const stat = await lstat(path);
  requireCondition(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.size < 1024 * 1024, code);
}

export function lifecycleHostnames(job) {
  return Object.freeze({
    management: `manage${job.target.prefix}.${job.target.zoneName}`,
    portal: `mcp${job.target.prefix}.${job.target.zoneName}`,
  });
}

export function stagesForJob(job, options = {}) {
  const ordered = LIFECYCLE_STAGES.filter((stage) => job.operations.some((operation) => STAGES_BY_OPERATION[operation].includes(stage)));
  if (options.stage !== undefined) {
    requireCondition(ordered.includes(options.stage), 'stage_not_in_job', options.stage);
    return Object.freeze([options.stage]);
  }
  if (options.from !== undefined) {
    const index = ordered.indexOf(options.from);
    requireCondition(index >= 0, 'stage_not_in_job', options.from);
    return Object.freeze(ordered.slice(index));
  }
  return Object.freeze(ordered);
}

export function credentialReferenceLabel(reference) {
  return 'keychain' in reference
    ? `keychain:${reference.keychain.service}/${reference.keychain.account}`
    : `env:${reference.env}`;
}

export async function readReleasePin(path) {
  await privateFileOrPublic(path);
  const parsed = v.safeParse(pinSchema, JSON.parse(await readFile(path, 'utf8')));
  requireCondition(parsed.success, 'release_pin_invalid', path);
  return parsed.output;
}

async function privateFileOrPublic(path) {
  requireCondition(isAbsolute(path), 'private_path_required');
  const stat = await lstat(path);
  requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.size < 64 * 1024, 'release_pin_invalid');
}

/** What approval binds: every value the runner acts on, credential references by name only. */
export async function approvalStatement(job) {
  const [a, b] = await Promise.all([readReleasePin(job.releases.a.pin), readReleasePin(job.releases.b.pin)]);
  requireCondition(a.release !== b.release && a.artifactSha256 !== b.artifactSha256 &&
    a.keyId === b.keyId && a.publicKey === b.publicKey && a.channel === b.channel, 'release_pair_invalid');
  const credentials = {
    deployment: credentialReferenceLabel(job.credentials.deployment),
    management: credentialReferenceLabel(job.credentials.management),
  };
  if (job.credentials.service !== undefined) {
    credentials.service = { secret: credentialReferenceLabel(job.credentials.service.secret), clientId: job.credentials.service.clientId, tokenId: job.credentials.service.tokenId };
  }
  return Object.freeze({
    schemaVersion: 1, jobId: job.jobId, scope: job.scope, target: job.target,
    releases: { a: { release: a.release, artifactSha256: a.artifactSha256, keyId: a.keyId, channel: a.channel }, b: { release: b.release, artifactSha256: b.artifactSha256, keyId: b.keyId, channel: b.channel } },
    source: job.source, operations: job.operations, runDirectory: job.runDirectory, credentials,
  });
}

export async function approvalDigest(job) {
  return `sha256:${createHash('sha256').update(canonicalJson(await approvalStatement(job))).digest('hex')}`;
}

export async function readLifecycleJob(path) {
  await privateFile(path, 'job_file_required');
  let parsed;
  try { parsed = v.safeParse(lifecycleJobSchema, JSON.parse(await readFile(path, 'utf8'))); } catch { throw new LifecycleJobError('job_invalid'); }
  requireCondition(parsed.success, 'job_invalid', parsed.success ? null : parsed.issues.map((issue) => issue.path?.map((part) => part.key).join('.') ?? '').join(','));
  const job = parsed.output;
  requireCondition(isAbsolute(job.runDirectory), 'private_path_required');
  await outsideRepository(dirname(job.runDirectory));
  const hostnames = lifecycleHostnames(job);
  requireCondition(hostnames.management !== hostnames.portal, 'job_invalid');
  return job;
}

/** Refuses an unapproved job or one whose acted-on values changed since approval. */
export async function assertLifecycleJobApproved(job) {
  requireCondition(job.approval !== undefined, 'job_not_approved');
  requireCondition(job.approval.approvedBy === job.target.adminEmail, 'job_approver_not_administrator');
  const current = await approvalDigest(job);
  requireCondition(current === job.approval.targetDigest, 'job_target_changed');
  return current;
}

export async function writeLifecycleJobApproval(path, job, approval) {
  const parsed = v.parse(approvalSchema, approval);
  requireCondition(parsed.approvedBy === job.target.adminEmail, 'job_approver_not_administrator');
  await privateFile(path, 'job_file_required');
  const next = { ...job, approval: parsed };
  v.parse(lifecycleJobSchema, next);
  const pending = `${path}.${process.pid}.tmp`;
  const file = await open(pending, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(next, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
  await rename(pending, path);
  return next;
}
