import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLiveTestRecord, providerDiagnostic } from '../tools/live-test-record.mjs';

test('private recovery record checkpoints storage and excludes concurrent or accidental fresh reruns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ankka-record-'));
  await chmod(dir, 0o700);
  try {
    const first = await openLiveTestRecord(dir);
    await first.put('receipt', { synthetic: true });
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'record.json'), 'utf8')).storage.receipt, { synthetic: true });
    assert.equal((await stat(join(dir, 'record.json'))).mode & 0o077, 0);
    await assert.rejects(openLiveTestRecord(dir, { recover: true }));
    await first.close();
    await assert.rejects(openLiveTestRecord(dir));
    const recovered = await openLiveTestRecord(dir, { recover: true });
    assert.deepEqual(recovered.state.storage.receipt, { synthetic: true });
    assert.equal(recovered.state.qualified, false);
    await recovered.close();
    await chmod(dir, 0o755);
    await assert.rejects(openLiveTestRecord(dir, { recover: true }), /private_run_directory_required/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('provider diagnostics never expose resource paths, query, credentials or bodies', () => {
  const request = new Request('https://api.cloudflare.com/client/v4/accounts/private-id/access/apps?email=private@example.com', {
    method: 'POST', headers: { authorization: 'Bearer secret-token' }, body: 'private-body',
  });
  assert.deepEqual(providerDiagnostic(request, 403, 12.8), { method: 'POST', family: 'access', status: 403, ms: 13 });
});

test('live command requires explicit private configuration; help never requires a token', async () => {
  const { spawnSync } = await import('node:child_process');
  const command = new URL('../tools/provider-cycle-command.mjs', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  const env = { ...process.env };
  delete env.ANKKA_LIVE_TOKEN;
  const help = spawnSync(process.execPath, [fileURLToPath(command), '--help'], { env, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--cleanup/u);
  const missing = spawnSync(process.execPath, [fileURLToPath(command)], { env, encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.doesNotMatch(missing.stdout + missing.stderr, /Bearer/u);
});
