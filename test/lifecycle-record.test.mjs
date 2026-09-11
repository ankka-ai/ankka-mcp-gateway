import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  openLifecycleRecord, readInstallationSecrets, requestLifecycleCancel, summarizeLifecycleRecord, writeInstallationSecrets,
} from '../tools/lifecycle-record.mjs';

const identity = { jobId: 'lifecycle-test', targetDigest: `sha256:${'0'.repeat(64)}` };

test('the record persists every write atomically, holds one lock, and reopens with its identity checked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ankka-lifecycle-record-'));
  await chmod(directory, 0o700);
  try {
    const parent = await openLifecycleRecord(directory, { create: true, holdLock: true, ...identity });
    await assert.rejects(openLifecycleRecord(directory, { create: true, holdLock: false, ...identity }), { code: 'record_exists' });
    await assert.rejects(openLifecycleRecord(directory, { holdLock: true, ...identity }), { code: 'run_lock_held' });
    const child = await openLifecycleRecord(directory, { holdLock: false, ...identity });
    const storage = child.storage('object:v1:management');
    await storage.put('ankka-mcp-gateway/management-control/v1', { installationId: 'acg-x' });
    assert.deepEqual(await storage.get('ankka-mcp-gateway/management-control/v1'), { installationId: 'acg-x' });
    assert.equal(await storage.get('missing'), undefined);
    // The payload commits control, sources and the action journal in one multi-key put.
    await storage.put({ 'ankka-mcp-gateway/management-sources/v1': { revision: 2 }, 'ankka-mcp-gateway/source-actions/v1': { revision: 3 } });
    assert.deepEqual(await storage.get('ankka-mcp-gateway/source-actions/v1'), { revision: 3 });
    assert.deepEqual([...(await storage.list({ prefix: 'ankka-mcp-gateway/management-' })).keys()],
      ['ankka-mcp-gateway/management-control/v1', 'ankka-mcp-gateway/management-sources/v1']);
    assert.equal(Object.hasOwn(storage.snapshot(), '[object Object]'), false);
    await child.event('converge', 'pass', { pass: 1 });
    await child.stage('converge', { status: 'passed', code: null, detail: { passes: 1 } });
    await child.set('removal', 'handoff', 'signed-handoff');
    await child.trace({ method: 'GET', family: 'workers-scripts', status: 200, ms: 3 });
    // The parent writes after a child died: its own copy is stale, the child's evidence must survive the write.
    await parent.stage('converge', { status: 'interrupted', code: 'process_sigkill' });
    await Promise.all([child.event('converge', 'a'), child.event('converge', 'b'), storage.put('k', 1)]);
    const clobberCheck = JSON.parse(await readFile(join(directory, 'record.json'), 'utf8'));
    assert.equal(clobberCheck.stages.converge.status, 'interrupted');
    assert.deepEqual(clobberCheck.events.map((event) => event.status), ['pass', 'a', 'b']);
    assert.equal(clobberCheck.trace.length, 1);
    assert.equal(clobberCheck.removal.handoff, 'signed-handoff');
    assert.equal(clobberCheck.storage['object:v1:management'].k, 1);
    await child.stage('converge', { status: 'passed', code: null, detail: { passes: 1 } });
    const onDisk = JSON.parse(await readFile(join(directory, 'record.json'), 'utf8'));
    assert.equal(onDisk.storage['object:v1:management']['ankka-mcp-gateway/management-control/v1'].installationId, 'acg-x');
    assert.equal(onDisk.stages.converge.status, 'passed');
    assert.equal((await stat(join(directory, 'record.json'))).mode & 0o077, 0);
    await assert.rejects(child.stage('converge', { status: 'done' }), { code: 'stage_status_invalid' });
    await assert.rejects(child.set('storage', 'x', 1), { code: 'record_section_invalid' });
    await child.close();
    await parent.close();
    await assert.rejects(openLifecycleRecord(directory, { holdLock: false, jobId: 'other-job' }), { code: 'record_job_mismatch' });
    const reopened = await openLifecycleRecord(directory, { holdLock: true, ...identity });
    assert.equal(reopened.state.stages.converge.status, 'passed');
    const summary = summarizeLifecycleRecord(reopened.state);
    assert.equal(summary.qualified, false);
    assert.equal(summary.removalHandoffAvailable, true);
    assert.equal(summary.customerPathCoverage, 'not_claimed');
    assert.doesNotMatch(JSON.stringify(summary), /signed-handoff|acg-x/u);
    await reopened.close();
    await chmod(directory, 0o755);
    await assert.rejects(openLifecycleRecord(directory, { holdLock: false, ...identity }), { code: 'private_run_directory_required' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cancellation is a marker the record reads; installation secrets live in a separate private file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ankka-lifecycle-record-'));
  await chmod(directory, 0o700);
  try {
    const record = await openLifecycleRecord(directory, { create: true, holdLock: true, ...identity });
    assert.equal(await record.cancelRequested(), false);
    await requestLifecycleCancel(directory);
    assert.equal(await record.cancelRequested(), true);
    assert.equal(await readInstallationSecrets(directory), null);
    await writeInstallationSecrets(directory, { schemaVersion: 1, bootstrapNonce: 'nonce-value-never-in-record' });
    assert.deepEqual(await readInstallationSecrets(directory), { schemaVersion: 1, bootstrapNonce: 'nonce-value-never-in-record' });
    assert.equal((await stat(join(directory, 'installation-secrets.json'))).mode & 0o077, 0);
    assert.doesNotMatch(await readFile(join(directory, 'record.json'), 'utf8'), /nonce-value/u);
    assert.doesNotMatch(JSON.stringify(summarizeLifecycleRecord(record.state)), /nonce-value/u);
    await record.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
