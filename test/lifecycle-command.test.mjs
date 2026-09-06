import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { openLifecycleRecord } from '../tools/lifecycle-record.mjs';

const command = fileURLToPath(new URL('../tools/lifecycle-command.mjs', import.meta.url));
const tools = fileURLToPath(new URL('../tools/', import.meta.url));
const ADMIN = 'administrator@example.com';

/** A stage script with the runner's argv contract: registers as the lock's child, records a start, waits, records a pass. */
async function fakeStageScript(directory) {
  const file = join(directory, 'fake-stage.mjs');
  await writeFile(file, `import { setTimeout as sleep } from 'node:timers/promises';
import { registerRunLockChild } from ${JSON.stringify(join(tools, 'lifecycle-lock.mjs'))};
import { openLifecycleRecord } from ${JSON.stringify(join(tools, 'lifecycle-record.mjs'))};
const [stage, , runDirectory] = process.argv.slice(2);
await registerRunLockChild(runDirectory, stage);
const record = await openLifecycleRecord(runDirectory, { holdLock: false });
await record.event(stage, 'started');
await sleep(Number(process.env.FAKE_STAGE_SLEEP_MS ?? '0'));
await record.stage(stage, { status: 'passed', code: null });
`, { mode: 0o600 });
  return file;
}

async function until(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error('condition not met in time');
}
async function recordOf(directory) {
  try { return JSON.parse(await readFile(join(directory, 'run', 'record.json'), 'utf8')); } catch { return null; }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function run(args, env = {}) {
  return spawnSync(process.execPath, [command, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ankka-lifecycle-command-'));
  await chmod(directory, 0o700);
  const pin = (release, artifact) => ({ schemaVersion: 1, channel: 'canary', controlPlaneOrigin: 'https://deploy.ankka.ai', release,
    keyId: 'release-test', publicKey: 'A'.repeat(43), artifactSha256: artifact.repeat(64) });
  await writeFile(join(directory, 'pin-a.json'), JSON.stringify(pin('gateway-v0.1.1', '1')), { mode: 0o600 });
  await writeFile(join(directory, 'pin-b.json'), JSON.stringify(pin('gateway-v0.1.2', '2')), { mode: 0o600 });
  const path = join(directory, 'job.json');
  await writeFile(path, JSON.stringify({
    schemaVersion: 1, jobId: 'lifecycle-command-test', scope: 'disposable_lifecycle',
    target: { accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), zoneName: 'example.com', prefix: 'cmd', gatewayName: 'Ankka cmd', adminEmail: ADMIN },
    releases: { a: { publishDirectory: join(directory, 'a'), pin: join(directory, 'pin-a.json') }, b: { publishDirectory: join(directory, 'b'), pin: join(directory, 'pin-b.json') } },
    source: { url: 'https://source.example.net/mcp', tool: 'synthetic_status' },
    credentials: { deployment: { env: 'ANKKA_TEST_DEPLOYMENT_TOKEN' }, management: { env: 'ANKKA_TEST_MANAGEMENT_TOKEN' } },
    operations: ['install'], runDirectory: join(directory, 'run'),
  }), { mode: 0o600 });
  return { directory, path };
}

test('help names the stages and result vocabulary; a bare invocation is a usage error', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /preflight, bootstrap, converge, verify, manage, update, remove-dependencies, remove-root, verify-absent/u);
  assert.match(help.stdout, /qualified is always false for customer-path claims/u);
  assert.equal(run([]).status, 2);
  assert.equal(run(['run']).status, 2);
});

test('an unapproved job never runs or reads a credential; approval and status work without network', async () => {
  const { directory, path } = await fixture();
  try {
    const refused = run(['run', '--job', path]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /job_not_approved/u);
    const wrongApprover = run(['approve', '--job', path, '--approved-by', 'someone@example.com']);
    assert.equal(wrongApprover.status, 2);
    assert.match(wrongApprover.stderr, /job_approver_not_administrator/u);
    const approved = run(['approve', '--job', path, '--approved-by', ADMIN]);
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(approved.stdout, /"approved":true/u);
    const missingCredential = run(['run', '--job', path]);
    assert.equal(missingCredential.status, 2);
    assert.match(missingCredential.stderr, /credential_unavailable \(env:ANKKA_TEST_DEPLOYMENT_TOKEN\)/u);
    assert.doesNotMatch(missingCredential.stdout + missingCredential.stderr, /lifecycle: preflight started/u);
    const noRecord = run(['status', '--job', path]);
    assert.equal(noRecord.status, 2);
    await mkdir(join(directory, 'run'), { mode: 0o700 });
    const record = await openLifecycleRecord(join(directory, 'run'), { create: true, holdLock: true, jobId: 'lifecycle-command-test', targetDigest: `sha256:${'0'.repeat(64)}` });
    await record.stage('preflight', { status: 'blocked', code: 'deployment_credential_rejected' });
    await record.close();
    const status = run(['status', '--job', path]);
    assert.equal(status.status, 0, status.stderr);
    const summary = JSON.parse(status.stdout);
    assert.equal(summary.qualified, false);
    assert.equal(summary.failedStage, 'preflight');
    assert.equal(summary.failureCode, 'deployment_credential_rejected');
    const cancel = run(['cancel', '--job', path]);
    assert.equal(cancel.status, 0, cancel.stderr);
    assert.match(cancel.stdout, /"cancelRequested":true/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('killing the parent leaves its stage child owning the run until it exits; resume then takes over the abandoned lock', async () => {
  const { directory, path } = await fixture();
  try {
    assert.equal(run(['approve', '--job', path, '--approved-by', ADMIN]).status, 0);
    const env = { ANKKA_LIFECYCLE_STAGE_BUNDLE: await fakeStageScript(directory), ANKKA_TEST_DEPLOYMENT_TOKEN: 'synthetic-deployment-token-value', FAKE_STAGE_SLEEP_MS: '8000' };
    const parent = spawn(process.execPath, [command, 'run', '--job', path], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    parent.stdout.resume();
    parent.stderr.resume();
    const lockPath = join(directory, 'run', 'run.lock');
    await until(async () => { try { return JSON.parse(await readFile(lockPath, 'utf8')).child?.stage === 'preflight'; } catch { return false; } });
    // A second parent meets a live owner.
    const held = run(['run', '--job', path, '--resume', '--from', 'bootstrap'], env);
    assert.equal(held.status, 2);
    assert.match(held.stderr, /run_lock_held/u);
    parent.kill('SIGKILL');
    await new Promise((resolve) => { parent.once('exit', resolve); });
    const child = JSON.parse(await readFile(lockPath, 'utf8')).child;
    assert.equal(alive(child.pid), true);
    // The orphaned stage child still owns the run: a new parent must wait for it rather than start beside it.
    const blocked = run(['run', '--job', path, '--resume', '--from', 'bootstrap'], env);
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /run_child_active \(preflight\)/u);
    await until(async () => !alive(child.pid));
    assert.equal((await recordOf(directory)).stages.preflight.status, 'passed');
    await stat(lockPath); // abandoned, and still there: nothing removed it
    const resumed = run(['run', '--job', path, '--resume', '--from', 'bootstrap'], { ...env, FAKE_STAGE_SLEEP_MS: '0' });
    assert.equal(resumed.status, 0, resumed.stderr);
    const final = await recordOf(directory);
    assert.deepEqual(['preflight', 'bootstrap', 'converge', 'verify'].map((stage) => final.stages[stage].status), ['passed', 'passed', 'passed', 'passed']);
    assert.ok(final.events.some((event) => event.stage === 'preflight' && event.status === 'started'));
    await assert.rejects(stat(lockPath)); // released by its owner at the end
    const status = JSON.parse(run(['status', '--job', path]).stdout);
    assert.match(String(status.executedSource?.commit), /^[0-9a-f]{40}$/u);
    assert.equal([true, false].includes(status.executedSource?.dirty), true);
    assert.equal(JSON.stringify(final).includes('synthetic-deployment-token-value'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
