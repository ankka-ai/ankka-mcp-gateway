import { randomUUID } from 'node:crypto';
import { access, lstat, open, readFile, rename, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';

/**
 * The runner's durable execution state for one job: stage events and
 * results, the Durable Object storage the production operations write
 * (namespaced per object), the provider inventory, and removal evidence.
 * Every write lands atomically and fsynced before the caller continues, so
 * an abrupt termination leaves at most one armed-but-unrecorded mutation for
 * the production reconciliation to resolve. Credential values never enter
 * this record; installation-owned key material lives in a separate private
 * file that status and reports never read.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const MAX_TRACE_ENTRIES = 4000;
const STAGE_STATUSES = Object.freeze(['passed', 'verified', 'failed', 'blocked', 'interrupted', 'not_run']);

export class LifecycleRecordError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireCondition(value, code) { if (!value) throw new LifecycleRecordError(code); }

export async function privateRunDirectory(directory) {
  requireCondition(isAbsolute(directory), 'private_run_directory_required');
  let canonical;
  try { canonical = await realpath(directory); } catch { throw new LifecycleRecordError('private_run_directory_required'); }
  const stat = await lstat(directory);
  requireCondition(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 &&
    relative(root, canonical).startsWith('..'), 'private_run_directory_required');
  return canonical;
}

const recordSchema = v.looseObject({
  schemaVersion: v.literal(1), scope: v.literal('external_runner'), jobId: v.string(), targetDigest: v.string(),
  events: v.array(v.looseObject({ stage: v.string(), status: v.string(), at: v.string() })),
  stages: v.record(v.string(), v.looseObject({ status: v.picklist(STAGE_STATUSES) })),
  storage: v.record(v.string(), v.record(v.string(), v.any())),
});

async function atomicWrite(directory, name, text, mode = 0o600) {
  const pending = join(directory, `${name}.${randomUUID()}.tmp`);
  const file = await open(pending, 'wx', mode);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  await rename(pending, join(directory, name));
  const parent = await open(directory, 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}

/**
 * `create` starts a fresh record and refuses an existing one; otherwise the
 * existing record is reopened. `holdLock` takes the exclusive run lock (the
 * parent process); a stage child opened under a parent's lock passes false.
 */
export async function openLifecycleRecord(directory, { create = false, holdLock = true, jobId, targetDigest } = {}) {
  directory = await privateRunDirectory(directory);
  const path = join(directory, 'record.json');
  let lock = null;
  if (holdLock) {
    try { lock = await open(join(directory, 'run.lock'), 'wx', 0o600); } catch { throw new LifecycleRecordError('run_lock_held'); }
  }
  let state;
  try {
    if (create) {
      requireCondition(v.is(v.string(), jobId) && v.is(v.string(), targetDigest), 'record_identity_required');
      try { await access(path); throw new LifecycleRecordError('record_exists'); } catch (error) { if (error instanceof LifecycleRecordError) throw error; }
      state = { schemaVersion: 1, scope: 'external_runner', jobId, targetDigest, createdAt: new Date().toISOString(), qualified: false,
        events: [], stages: {}, storage: {}, trace: [], install: {}, inventory: null, removal: {} };
    } else {
      const stat = await lstat(path);
      requireCondition(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.size <= 64 * 1024 * 1024, 'record_required');
      state = JSON.parse(await readFile(path, 'utf8'));
      requireCondition(v.is(recordSchema, state), 'record_invalid');
      if (jobId !== undefined) requireCondition(state.jobId === jobId, 'record_job_mismatch');
      if (targetDigest !== undefined) requireCondition(state.targetDigest === targetDigest, 'record_target_mismatch');
    }
  } catch (error) {
    if (lock !== null) { await lock.close(); await unlink(join(directory, 'run.lock')); }
    throw error;
  }
  async function save() { await atomicWrite(directory, 'record.json', JSON.stringify(state)); }
  if (create) await save();
  return {
    directory,
    get state() { return state; },
    async event(stage, status, detail = {}) {
      state.events.push({ ...detail, stage, status, at: new Date().toISOString() });
      await save();
    },
    async stage(stage, result) {
      requireCondition(STAGE_STATUSES.includes(result.status), 'stage_status_invalid');
      state.stages[stage] = { ...result, at: new Date().toISOString() };
      await save();
    },
    async set(section, key, value) {
      requireCondition(['install', 'removal'].includes(section), 'record_section_invalid');
      state[section][key] = structuredClone(value);
      await save();
    },
    async setInventory(value) { state.inventory = structuredClone(value); await save(); },
    /** Durable Object storage stand-in for one named object; get and put only, persisted before returning. */
    storage(namespace) {
      state.storage[namespace] ??= {};
      const values = state.storage[namespace];
      return {
        async get(key) { return Object.hasOwn(values, key) ? structuredClone(values[key]) : undefined; },
        async list({ prefix = '', limit = 1000, startAfter = '' } = {}) {
          return new Map(Object.entries(values).filter(([key]) => key.startsWith(prefix) && key > startAfter)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).slice(0, limit)
            .map(([key, value]) => [key, structuredClone(value)]));
        },
        // Durable Object multi-key puts are atomic: every entry lands in one record write or none does.
        async put(key, value) {
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Storage API overload boundary: string key/value or a multi-key entries object.
          const entries = structuredClone(typeof key === 'string' ? [[key, value]] : Object.entries(key));
          for (const [entryKey, owned] of entries) values[entryKey] = owned;
          await save();
        },
        snapshot() { return structuredClone(values); },
      };
    },
    async trace(entry) {
      state.trace.push(entry);
      if (state.trace.length > MAX_TRACE_ENTRIES) state.trace.splice(0, state.trace.length - MAX_TRACE_ENTRIES);
      await save();
    },
    async cancelRequested() {
      try { await access(join(directory, 'cancel')); return true; } catch { return false; }
    },
    async close() {
      if (lock !== null) { await lock.close(); await unlink(join(directory, 'run.lock')); lock = null; }
    },
  };
}

/** Secret-free projection for status and reports. */
export function summarizeLifecycleRecord(state) {
  const stages = Object.fromEntries(Object.entries(state.stages).map(([stage, result]) => [stage, { status: result.status, code: result.code ?? null, at: result.at }]));
  const failed = Object.entries(state.stages).find(([, result]) => ['failed', 'blocked', 'interrupted'].includes(result.status));
  return {
    schemaVersion: 1, scope: state.scope, jobId: state.jobId, qualified: false,
    stages, lastEvent: state.events.at(-1) ? { stage: state.events.at(-1).stage, status: state.events.at(-1).status, at: state.events.at(-1).at } : null,
    failedStage: failed ? failed[0] : null, failureCode: failed ? failed[1].code ?? null : null,
    inventoryCaptured: state.inventory !== null,
    removalHandoffAvailable: v.is(v.string(), state.removal?.handoff),
    customerPathCoverage: 'not_claimed',
  };
}

export async function requestLifecycleCancel(directory) {
  directory = await privateRunDirectory(directory);
  await atomicWrite(directory, 'cancel', `${new Date().toISOString()}\n`);
}

/**
 * Installation-owned key material the production operations require across
 * resumes (the Stage 1 capability, bootstrap nonce, ownership wrap key, the
 * per-run issuer key, one-time action keys). Disposable with the
 * installation; never a Cloudflare credential; never read by status or
 * reports.
 */
const SECRETS_NAME = 'installation-secrets.json';
export async function readInstallationSecrets(directory) {
  directory = await privateRunDirectory(directory);
  const path = join(directory, SECRETS_NAME);
  try {
    const stat = await lstat(path);
    requireCondition(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'installation_secrets_invalid');
  } catch (error) { if (error instanceof LifecycleRecordError) throw error; return null; }
  return JSON.parse(await readFile(path, 'utf8'));
}
export async function writeInstallationSecrets(directory, value) {
  directory = await privateRunDirectory(directory);
  await atomicWrite(directory, SECRETS_NAME, JSON.stringify(value));
}
