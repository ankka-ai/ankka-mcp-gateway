import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  approvalDigest, assertLifecycleJobApproved, lifecycleHostnames, readLifecycleJob, stagesForJob, writeLifecycleJobApproval,
} from '../tools/lifecycle-job.mjs';

const ADMIN = 'administrator@example.com';
function pin(release, artifact) {
  return { schemaVersion: 1, channel: 'canary', controlPlaneOrigin: 'https://deploy.ankka.ai', release, keyId: 'release-test',
    publicKey: 'A'.repeat(43), artifactSha256: artifact.repeat(64) };
}

async function fixture(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ankka-lifecycle-job-'));
  await chmod(directory, 0o700);
  await writeFile(join(directory, 'pin-a.json'), JSON.stringify(pin('gateway-v0.1.1', '1')), { mode: 0o600 });
  await writeFile(join(directory, 'pin-b.json'), JSON.stringify(pin('gateway-v0.1.2', '2')), { mode: 0o600 });
  const job = {
    schemaVersion: 1, jobId: 'lifecycle-test', scope: 'disposable_lifecycle',
    target: { accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), zoneName: 'example.com', prefix: 'run1', gatewayName: 'Ankka run1', adminEmail: ADMIN },
    releases: { a: { publishDirectory: join(directory, 'publish-a'), pin: join(directory, 'pin-a.json') }, b: { publishDirectory: join(directory, 'publish-b'), pin: join(directory, 'pin-b.json') } },
    source: { url: 'https://source.example.net/mcp', tool: 'synthetic_status' },
    credentials: { deployment: { keychain: { service: 'ankka-lifecycle-runner', account: 'deployment-token' } }, management: { env: 'ANKKA_TEST_MANAGEMENT' } },
    operations: ['install', 'manage', 'update', 'remove'], runDirectory: join(directory, 'run'),
    ...overrides,
  };
  const path = join(directory, 'job.json');
  await writeFile(path, JSON.stringify(job), { mode: 0o600 });
  return { directory, path, job };
}

test('a job is read only from a private file outside the repository and names derived hostnames', async () => {
  const { directory, path } = await fixture();
  try {
    const job = await readLifecycleJob(path);
    assert.deepEqual(lifecycleHostnames(job), { management: 'managerun1.example.com', portal: 'mcprun1.example.com' });
    assert.deepEqual(stagesForJob(job), ['preflight', 'bootstrap', 'converge', 'verify', 'manage', 'update', 'remove-dependencies', 'remove-root', 'verify-absent']);
    assert.deepEqual(stagesForJob(job, { from: 'update' }), ['update', 'remove-dependencies', 'remove-root', 'verify-absent']);
    assert.deepEqual(stagesForJob(job, { stage: 'manage' }), ['manage']);
    assert.throws(() => stagesForJob({ ...job, operations: ['install'] }, { stage: 'manage' }), { code: 'stage_not_in_job' });
    await chmod(path, 0o644);
    await assert.rejects(readLifecycleJob(path), { code: 'job_file_required' });
    await assert.rejects(readLifecycleJob(new URL('../package.json', import.meta.url).pathname), { code: 'job_file_required' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('approval binds the exact target, release identities and operations; any change invalidates it', async () => {
  const { directory, path } = await fixture();
  try {
    const job = await readLifecycleJob(path);
    await assert.rejects(assertLifecycleJobApproved(job), { code: 'job_not_approved' });
    const digest = await approvalDigest(job);
    assert.match(digest, /^sha256:[a-f0-9]{64}$/u);
    await assert.rejects(writeLifecycleJobApproval(path, job, { approvedBy: 'someone@example.com', approvedAt: new Date().toISOString(), targetDigest: digest }),
      { code: 'job_approver_not_administrator' });
    const approved = await writeLifecycleJobApproval(path, job, { approvedBy: ADMIN, approvedAt: new Date().toISOString(), targetDigest: digest });
    assert.equal(await assertLifecycleJobApproved(approved), digest);
    const stored = await readLifecycleJob(path);
    assert.equal(stored.approval.targetDigest, digest);
    await assert.rejects(assertLifecycleJobApproved({ ...stored, target: { ...stored.target, prefix: 'run2' } }), { code: 'job_target_changed' });
    await assert.rejects(assertLifecycleJobApproved({ ...stored, operations: ['install'] }), { code: 'job_target_changed' });
    await writeFile(join(directory, 'pin-b.json'), JSON.stringify(pin('gateway-v0.1.2', '3')), { mode: 0o600 });
    await assert.rejects(assertLifecycleJobApproved(stored), { code: 'job_target_changed' });
    await writeFile(join(directory, 'pin-b.json'), JSON.stringify(pin('gateway-v0.1.1', '1')), { mode: 0o600 });
    await assert.rejects(assertLifecycleJobApproved(stored), { code: 'release_pair_invalid' });
    assert.doesNotMatch(await readFile(path, 'utf8'), /token-value|secret/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('credential references are names only and the schema refuses inline values or unknown fields', async () => {
  const { directory, path, job } = await fixture();
  try {
    await writeFile(path, JSON.stringify({ ...job, credentials: { ...job.credentials, deployment: { value: 'inline-token-value' } } }), { mode: 0o600 });
    await assert.rejects(readLifecycleJob(path), { code: 'job_invalid' });
    await writeFile(path, JSON.stringify({ ...job, extra: true }), { mode: 0o600 });
    await assert.rejects(readLifecycleJob(path), { code: 'job_invalid' });
    await writeFile(path, JSON.stringify({ ...job, runDirectory: 'relative/run' }), { mode: 0o600 });
    await assert.rejects(readLifecycleJob(path), { code: 'private_path_required' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
