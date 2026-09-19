import assert from 'node:assert/strict';
import test from 'node:test';
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
