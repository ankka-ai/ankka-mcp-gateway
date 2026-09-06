import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import * as v from 'valibot';

/**
 * Single-run ownership of a private run directory. The lock names the parent
 * process that owns the run and, once a stage child has registered, that
 * child. A process is alive when its pid exists on this host and started when
 * the lock says it did (a reused pid is a dead process). An abandoned lock
 * (owner dead, no live child) is taken over by atomic replacement and the
 * replacement is confirmed to be ours; nothing ever removes a lock blindly,
 * and a lock that turns out to belong to someone else is left to them.
 */
const execute = promisify(execFile);
const LOCK = 'run.lock';
/** `ps` reports start times to the second; the lock records milliseconds. */
const START_TOLERANCE_MS = 5_000;
const READ_ATTEMPTS = 5;

export class LifecycleLockError extends Error {
  constructor(code, detail = null) { super(code); this.code = code; this.detail = detail; }
}

const identitySchema = v.strictObject({
  pid: v.pipe(v.number(), v.safeInteger(), v.minValue(1)), startedAt: v.pipe(v.number(), v.safeInteger()), host: v.string(),
});
const lockSchema = v.strictObject({
  schemaVersion: v.literal(1), token: v.string(), acquiredAt: v.number(), owner: identitySchema,
  child: v.nullable(v.strictObject({ ...identitySchema.entries, stage: v.string() })),
});
const errorCode = (code) => v.looseObject({ code: v.literal(code) });

export function processIdentity() {
  return { pid: process.pid, startedAt: Math.round(Date.now() - process.uptime() * 1000), host: hostname() };
}

async function observedStart(pid) {
  try {
    const { stdout } = await execute('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
    const parsed = Date.parse(stdout.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch { return null; }
}

/** Alive: the pid exists on this host and started when recorded. Another host or an unreadable start time counts as alive. */
export async function processAlive(identity) {
  if (identity.host !== hostname()) return true;
  try { process.kill(identity.pid, 0); } catch (error) { return v.is(errorCode('EPERM'), error); }
  const started = await observedStart(identity.pid);
  return started === null || Math.abs(started - identity.startedAt) <= START_TOLERANCE_MS;
}

async function readLock(directory) {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    let text;
    try { text = await readFile(join(directory, LOCK), 'utf8'); } catch (error) {
      if (v.is(errorCode('ENOENT'), error)) return null;
      throw new LifecycleLockError('run_lock_unreadable');
    }
    try {
      const parsed = JSON.parse(text);
      if (v.is(lockSchema, parsed)) return parsed;
    } catch { /* an in-place update is in progress; read again */ }
    await sleep(50 * (attempt + 1));
  }
  throw new LifecycleLockError('run_lock_unreadable');
}

async function writeNew(path, content) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(content)); await handle.sync(); } finally { await handle.close(); }
}

/** Updates rewrite the lock in place; ownership is proven by the token, not by the file. */
async function writeInPlace(directory, content) {
  const handle = await open(join(directory, LOCK), 'r+');
  try { await handle.truncate(0); await handle.writeFile(JSON.stringify(content)); await handle.sync(); } finally { await handle.close(); }
}

export async function acquireRunLock(directory) {
  const path = join(directory, LOCK);
  const content = { schemaVersion: 1, token: randomUUID(), acquiredAt: Date.now(), owner: processIdentity(), child: null };
  try {
    await writeNew(path, content);
  } catch (error) {
    if (!v.is(errorCode('EEXIST'), error)) throw error;
    const existing = await readLock(directory);
    if (existing !== null) {
      if (await processAlive(existing.owner)) throw new LifecycleLockError('run_lock_held');
      if (existing.child !== null && await processAlive(existing.child)) throw new LifecycleLockError('run_child_active', existing.child.stage);
    }
    // Abandoned: replace it atomically, then confirm the replacement is ours. A concurrent taker is detected below, never raced past.
    const pending = join(directory, `${LOCK}.${randomUUID()}.tmp`);
    await writeNew(pending, content);
    await rename(pending, path);
  }
  const lock = {
    directory,
    async assertOwner() {
      const current = await readLock(directory);
      if (current === null || current.token !== content.token) throw new LifecycleLockError('run_lock_lost');
      return current;
    },
    async clearChild() {
      const current = await lock.assertOwner();
      if (current.child !== null) await writeInPlace(directory, { ...current, child: null });
    },
    /** Removes the lock only while it is still ours; a lost lock belongs to its new owner. */
    async release() {
      const current = await readLock(directory);
      if (current === null || current.token !== content.token) return false;
      await unlink(path);
      return true;
    },
  };
  await lock.assertOwner();
  return lock;
}

/** A stage child may run only under its own parent's lock and only while that parent is alive; it then names itself in the lock. */
export async function registerRunLockChild(directory, stage) {
  const current = await readLock(directory);
  if (current === null) throw new LifecycleLockError('run_lock_missing');
  const ownParent = current.owner.pid === process.ppid || current.owner.pid === process.pid;
  if (!ownParent || !await processAlive(current.owner)) throw new LifecycleLockError('run_lock_lost');
  await writeInPlace(directory, { ...current, child: { ...processIdentity(), stage } });
}
