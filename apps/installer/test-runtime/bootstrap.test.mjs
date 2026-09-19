import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { createRuntime } from './runtime.mjs';

async function request(runtime, path, status = 200) {
  const response = await runtime.dispatchFetch(`http://localhost${path}`, {
    method: ['/state', '/decode', '/outbound'].includes(path) ? 'GET' : 'POST',
  });
  assert.equal(response.status, status);
  return response.json();
}

test('bootstrap transitions survive runtime restart and erase temporary state at READY', { timeout: 30_000 }, async () => {
  const storage = await mkdtemp(join(tmpdir(), 'ankka-runtime-'));
  let active;
  try {
    active = await createRuntime({ storage });
    assert.equal((await request(active.runtime, '/state')).status, null);
    assert.deepEqual(await request(active.runtime, '/seed'), { committed: true });
    assert.deepEqual(await request(active.runtime, '/seed'), { committed: false });
    for (const phase of [null, 'authorizing', 'exchanging', 'finalizing']) {
      assert.deepEqual(await request(active.runtime, '/advance'), { committed: true });
      const state = await request(active.runtime, '/state');
      assert.equal(state.oauthPhase, phase);
      assert.equal(state.containsSyntheticSecrets, false);
    }
    const before = await request(active.runtime, '/state');
    assert.equal(before.revision, 5);
    await active.dispose();
    active = await createRuntime({ storage });
    assert.deepEqual(await request(active.runtime, '/state'), before);
    assert.deepEqual(await request(active.runtime, '/advance'), { committed: true });
    assert.deepEqual(await request(active.runtime, '/state'), {
      status: 'READY', revision: 6, capabilityUnused: false,
      sessionPresent: false, oauthPhase: null, containsSyntheticSecrets: false,
    });
    assert.deepEqual(await request(active.runtime, '/advance', 409), { code: 'final' });
    assert.deepEqual(await request(active.runtime, '/reset'), { reset: true });
    assert.equal((await request(active.runtime, '/state')).status, null);
    assert.equal(active.blockedRequests(), 0);
  } finally {
    await active?.dispose();
    await rm(storage, { recursive: true, force: true });
  }
});

test('real SQLite rejects stale writes, rolls back failures, and refuses corrupted state', { timeout: 30_000 }, async () => {
  const { runtime, dispose, blockedRequests } = await createRuntime();
  try {
    await request(runtime, '/seed');
    const race = await request(runtime, '/race');
    assert.equal(race.committed.filter(Boolean).length, 1);
    const before = await request(runtime, '/state');
    assert.equal(before.revision, 2);
    assert.equal(before.containsSyntheticSecrets, false);
    assert.deepEqual(await request(runtime, '/rollback'), { rolledBack: true });
    assert.deepEqual(await request(runtime, '/state'), before);
    await request(runtime, '/corrupt');
    assert.deepEqual(await request(runtime, '/state', 409), { code: 'conflict' });
    assert.equal(blockedRequests(), 0);
  } finally { await dispose(); }
});

test('release-sized decoding runs in workerd and outbound requests cannot reach providers', { timeout: 30_000 }, async () => {
  const { runtime, dispose, blockedRequests } = await createRuntime();
  try {
    assert.deepEqual(await request(runtime, '/decode'), { length: 6 * 1024 * 1024, first: 97, last: 97 });
    assert.equal(blockedRequests(), 0);
    assert.deepEqual(await request(runtime, '/outbound', 502), { code: 'outbound_disabled' });
    assert.equal(blockedRequests(), 1);
  } finally { await dispose(); }
});

test('synthetic dev runtime exposes request traces through the local API', { timeout: 30_000 }, async () => {
  const { runtime, dispose, blockedRequests } = await createRuntime({ diagnostics: true });
  try {
    await request(runtime, '/seed');
    const origin = (await runtime.ready).origin;
    const schema = await fetch(`${origin}/cdn-cgi/local/explorer/api`);
    assert.equal(schema.status, 200);
    let rows = [];
    for (let attempt = 0; attempt < 50 && rows.length === 0; attempt++) {
      const response = await fetch(`${origin}/cdn-cgi/local/explorer/api/local/observability/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: "SELECT name, outcome FROM spans WHERE service = 'ankka-synthetic-bootstrap' LIMIT 5" }),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.success, true);
      rows = result.result.rows;
      if (rows.length === 0) await setTimeout(100);
    }
    assert.ok(rows.length > 0, 'the agent must be able to retrieve a captured Worker span');
    assert.equal(blockedRequests(), 0);
  } finally { await dispose(); }
});
