import assert from 'node:assert/strict';
import test from 'node:test';
import { installReadyGateway } from '../../../test/payload-lifecycle.mjs';
import { createRuntime } from './runtime.mjs';

test('source removal commits draft, authorization and empty bridge deletion in real SQLite', async () => {
  const active = await createRuntime({ sourceRemoval: true });
  try {
    assert.equal((await active.runtime.dispatchFetch('http://localhost/seed', { method: 'POST' })).status, 200);
    const removed = await active.runtime.dispatchFetch('http://localhost/remove', { method: 'POST' });
    assert.equal(removed.status, 200);
    assert.deepEqual((await removed.json()).sources, []);
    const state = await (await active.runtime.dispatchFetch('http://localhost/state')).json();
    assert.equal(state.sources.revision, 2);
    assert.deepEqual(state.sources.sources, []);
    assert.deepEqual(state.actions.actions, []);
    assert.equal(state.hasBridge, false);
    assert.equal((await active.runtime.dispatchFetch('http://localhost/remove', { method: 'POST' })).status, 409);
    assert.equal(active.blockedRequests(), 0);
  } finally { await active.dispose(); }
});


test('bridge cleanup re-enters the same DO and commits its signed passes in SQLite', async () => {
  const gateway = await installReadyGateway();
  const storage = gateway.objects.get('v1:management').storage;
  const env = Object.fromEntries(Object.entries(gateway.env).filter(([key]) => key !== 'ADMIN_STATE'));
  const active = await createRuntime({ sourceRemoval: true });
  const post = (path, body) => active.runtime.dispatchFetch(`http://localhost${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const seeded = await post('/seed-bridge', { ...Object.fromEntries(await storage.list()),
      'fixture-env': env, 'fixture-installation-id': env.ANKKA_INSTALL_ID });
    assert.equal(seeded.status, 200);
    const { sourceId } = await seeded.json();
    const prepared = await post('/prepare-bridge', { schemaVersion: 1, revision: 2, sourceId });
    assert.equal(prepared.status, 200, await prepared.clone().text());
    const handoff = await prepared.json();
    const claim = JSON.parse(Buffer.from(new URL(handoff.handoffUrl).hash.slice(1), 'base64url').toString());
    const command = { actionId: claim.actionId, actionKey: claim.actionKey, actorEmail: claim.actorEmail,
      actionExpiresAt: claim.expiresAt, accessToken: 'synthetic-cleanup-grant-never-store' };
    const removed = await post('/remove-bridge', command);
    assert.equal(removed.status, 200, await removed.clone().text());
    assert.equal((await removed.json()).status, 'succeeded');
    const state = await (await active.runtime.dispatchFetch('http://localhost/bridge-state')).json();
    assert.deepEqual(state['ankka-mcp-gateway/management-sources/v1'].sources, []);
    assert.deepEqual(state['ankka-mcp-gateway/source-actions/v1'].actions, []);
    assert.ok(!Object.keys(state).some(key => key.includes('/bigquery-')));
    assert.ok(!JSON.stringify(state).includes(command.accessToken));
    assert.ok(!JSON.stringify(state).includes(command.actionKey));
    assert.equal((await post('/remove-bridge', command)).status, 409);
    assert.equal(active.blockedRequests(), 0);
  } finally { await active.dispose(); }
});
