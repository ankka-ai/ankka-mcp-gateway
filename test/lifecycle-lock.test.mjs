import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acquireRunLock, processAlive, processIdentity, registerRunLockChild } from '../tools/lifecycle-lock.mjs';

async function privateDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'ankka-lifecycle-lock-'));
  await chmod(directory, 0o700);
  return directory;
}

/** A process that has already exited: its pid is dead although it existed a moment ago. */
function deadIdentity() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(Date.now() - process.uptime() * 1000))'], { encoding: 'utf8' });
  return { pid: child.pid, startedAt: Math.round(Number(child.stdout)), host: processIdentity().host };
}

const lockOf = async (directory) => JSON.parse(await readFile(join(directory, 'run.lock'), 'utf8'));

test('a live owner keeps the lock; an abandoned lock is taken over and confirmed, never removed blindly', async () => {
  const directory = await privateDirectory();
  try {
    const lock = await acquireRunLock(directory);
    await assert.rejects(acquireRunLock(directory), { code: 'run_lock_held' });
    assert.equal(await lock.release(), true);
    const stale = { schemaVersion: 1, token: 'stale', acquiredAt: 1, owner: deadIdentity(), child: null };
    await writeFile(join(directory, 'run.lock'), JSON.stringify(stale), { mode: 0o600 });
    assert.equal(await processAlive(stale.owner), false);
    const taken = await acquireRunLock(directory);
    const onDisk = await lockOf(directory);
    assert.equal(onDisk.owner.pid, process.pid);
    assert.notEqual(onDisk.token, 'stale');
    await taken.assertOwner();
    // Another parent replaced the lock meanwhile: this one has lost it and leaves the file to its new owner.
    await writeFile(join(directory, 'run.lock'), JSON.stringify({ ...stale, token: 'other', owner: processIdentity() }), { mode: 0o600 });
    await assert.rejects(taken.assertOwner(), { code: 'run_lock_lost' });
    await assert.rejects(taken.clearChild(), { code: 'run_lock_lost' });
    assert.equal(await taken.release(), false);
    assert.equal((await lockOf(directory)).token, 'other');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a dead owner with a live stage child still owns the run; a child registers only under its own live parent', async () => {
  const directory = await privateDirectory();
  try {
    const dead = deadIdentity();
    await writeFile(join(directory, 'run.lock'), JSON.stringify({ schemaVersion: 1, token: 't', acquiredAt: 1, owner: dead, child: { ...processIdentity(), stage: 'converge' } }), { mode: 0o600 });
    await assert.rejects(acquireRunLock(directory), { code: 'run_child_active', detail: 'converge' });
    await assert.rejects(registerRunLockChild(directory, 'verify'), { code: 'run_lock_lost' });
    await writeFile(join(directory, 'run.lock'), JSON.stringify({ schemaVersion: 1, token: 't', acquiredAt: 1, owner: processIdentity(), child: null }), { mode: 0o600 });
    await registerRunLockChild(directory, 'verify');
    const registered = await lockOf(directory);
    assert.equal(registered.child.pid, process.pid);
    assert.equal(registered.child.stage, 'verify');
    assert.equal(registered.token, 't');
    await rm(join(directory, 'run.lock'));
    await assert.rejects(registerRunLockChild(directory, 'verify'), { code: 'run_lock_missing' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
